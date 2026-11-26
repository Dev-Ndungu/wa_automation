import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { resolve } from 'node:path';
import { assignTargets, combineCampaignShards, type CampaignShardLike } from '../campaigns/coordinator.js';
import { CampaignService, type CampaignInput } from '../campaigns/service.js';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { campaigns as campaignTable, groups, sourceMessages, whatsappAccounts } from '../db/schema.js';
import { JoinQueueService } from '../joins/service.js';
import { ScannerService } from '../scanner/service.js';
import { WhatsAppManager } from '../whatsapp/manager.js';

const MAIN_ACCOUNT_ID = 'main';
const ACTIVE_CAMPAIGN_STATUSES = ['DRAFT', 'QUEUED', 'RUNNING', 'PAUSED'];
const now = () => new Date().toISOString();

export type AccountRuntime = {
  id: string;
  scanner: ScannerService;
  whatsapp: WhatsAppManager;
  campaigns: CampaignService;
  joins: JoinQueueService;
};

export class AccountService {
  private runtimes = new Map<string, AccountRuntime>();

  public constructor(private readonly logger: FastifyBaseLogger) {}

  public async initialize(): Promise<void> {
    const accounts = await db.select().from(whatsappAccounts);
    for (const account of accounts) {
      const runtime = this.createRuntime(account.id);
      await runtime.campaigns.recover();
      // Start whenever a session exists — live or recoverable from a local
      // backup — so an interrupted process or a cleared live folder does not
      // silently lose the pairing and force a new QR scan.
      if (runtime.whatsapp.hasSavedSession() || runtime.whatsapp.hasRecoverableSession()) {
        void runtime.whatsapp.start().catch((error: unknown) => {
          this.logger.warn({ err: error, accountId: account.id }, 'Unable to start WhatsApp connection on boot');
        });
      }
    }
  }

  public async list() {
    const accounts = await db.select().from(whatsappAccounts).orderBy(whatsappAccounts.createdAt);
    return accounts.map((account) => ({ ...account, status: this.createRuntime(account.id).whatsapp.getStatus() }));
  }

  public async create(nameInput: unknown) {
    if (typeof nameInput !== 'string' || !nameInput.trim() || nameInput.trim().length > 80) {
      throw new Error('Account name must be between 1 and 80 characters.');
    }
    const name = nameInput.trim();
    const [existing] = await db.select({ id: whatsappAccounts.id }).from(whatsappAccounts).where(eq(whatsappAccounts.name, name)).limit(1);
    if (existing) throw new Error('An account with this name already exists.');
    const id = randomUUID();
    const createdAt = now();
    await db.insert(whatsappAccounts).values({ id, name, phone: null, createdAt, updatedAt: createdAt });
    const runtime = this.createRuntime(id);
    return { id, name, phone: null, createdAt, updatedAt: createdAt, status: runtime.whatsapp.getStatus() };
  }

  public async get(accountId: string | undefined): Promise<AccountRuntime> {
    const id = accountId || MAIN_ACCOUNT_ID;
    const [account] = await db.select({ id: whatsappAccounts.id }).from(whatsappAccounts).where(eq(whatsappAccounts.id, id)).limit(1);
    if (!account) throw new Error('WhatsApp account not found. Select an available account.');
    return this.createRuntime(id);
  }

  // ---- Campaign distribution across accounts -------------------------------

  private async accountNames(): Promise<Map<string, string>> {
    const rows = await db.select({ id: whatsappAccounts.id, name: whatsappAccounts.name }).from(whatsappAccounts);
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  private async shardRowsFor(id: string): Promise<Array<typeof campaignTable.$inferSelect>> {
    const [row] = await db.select().from(campaignTable).where(eq(campaignTable.id, id)).limit(1);
    if (!row) throw new Error('Campaign not found.');
    if (!row.distributionId) return [row];
    return db.select().from(campaignTable).where(eq(campaignTable.distributionId, row.distributionId)).orderBy(asc(campaignTable.createdAt));
  }

  /** Every campaign card across all accounts, with distributed shards merged. */
  public async listCampaigns(): Promise<CampaignShardLike[]> {
    const accounts = await db.select({ id: whatsappAccounts.id }).from(whatsappAccounts);
    const names = await this.accountNames();
    const all = (await Promise.all(accounts.map(async (account) => (await this.get(account.id)).campaigns.list()))).flat() as unknown as CampaignShardLike[];
    const byDistribution = new Map<string, CampaignShardLike[]>();
    const cards: CampaignShardLike[] = [];
    for (const campaign of all) {
      const distributionId = typeof campaign.distributionId === 'string' ? campaign.distributionId : null;
      if (!distributionId) { cards.push(campaign); continue; }
      const shards = byDistribution.get(distributionId) ?? [];
      shards.push(campaign);
      byDistribution.set(distributionId, shards);
    }
    for (const shards of byDistribution.values()) cards.push(combineCampaignShards(shards, names));
    return cards.sort((left, right) => String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')));
  }

  /** Full campaign detail plus the group list available while editing it. */
  public async getCampaign(id: string) {
    const rows = await this.shardRowsFor(id);
    const names = await this.accountNames();
    const details = (await Promise.all(rows.map(async (row) => (await this.get(row.accountId)).campaigns.get(row.id)))) as unknown as CampaignShardLike[];
    const campaign = rows.length === 1 && !rows[0].distributionId ? details[0] : combineCampaignShards(details, names);
    return { ...campaign, editGroups: await this.editGroupsFor(rows.map((row) => row.accountId)) };
  }

  /** Create the campaign on the owner and one shard per eligible member account. */
  public async createCampaign(ownerId: string, input: CampaignInput) {
    const owner = await this.get(ownerId);
    const plan = await owner.campaigns.plan(input, ownerId);
    // A group status must appear as authored by this account; splitting it
    // would change the author and multiply the daily budget across accounts.
    const statusDelivery = plan.deliveryMode === 'GROUP_STATUS';
    const participants = statusDelivery ? [ownerId] : await this.eligibleParticipantIds(ownerId);
    const memberships = await this.membershipsFor(participants, plan.groupJids);
    const distributionId = !statusDelivery && participants.length > 1 ? randomUUID() : null;
    const assignment = assignTargets(plan.groupJids, participants, memberships);
    let firstShardId: string | null = null;
    let ownerShardId: string | null = null;
    for (const accountId of participants) {
      const targetJids = assignment.get(accountId) ?? [];
      if (targetJids.length === 0) continue;
      const shard = await (await this.get(accountId)).campaigns.createFromPlan(plan, targetJids, { distributionId, sourceAccountId: ownerId });
      if (accountId === ownerId) ownerShardId = shard.id;
      firstShardId ??= shard.id;
    }
    if (!firstShardId) throw new Error('No linked account is a member of the selected groups.');
    return this.getCampaign(ownerShardId ?? firstShardId);
  }

  /** Re-split an existing distribution and apply the plan to every shard. */
  public async updateCampaign(id: string, input: CampaignInput) {
    const rows = await this.shardRowsFor(id);
    if (rows.length === 1 && !rows[0].distributionId) {
      const updated = await (await this.get(rows[0].accountId)).campaigns.update(id, input);
      return { ...updated, editGroups: await this.editGroupsFor([rows[0].accountId]) };
    }
    const participants = rows.map((row) => row.accountId);
    const sourceAccountId = await this.sourceAccountFor(input, rows[0].sourceAccountId ?? rows[0].accountId);
    const plan = await (await this.get(sourceAccountId)).campaigns.plan(input, sourceAccountId);
    if (plan.deliveryMode === 'GROUP_STATUS' && rows.length > 1) {
      throw new Error('Status campaigns cannot be distributed.');
    }
    const memberships = await this.membershipsFor(participants, plan.groupJids);
    const assignment = assignTargets(plan.groupJids, participants, memberships);
    let firstShardId: string | null = null;
    let sourceShardId: string | null = null;
    for (const row of rows) {
      const targetJids = assignment.get(row.accountId) ?? [];
      const service = (await this.get(row.accountId)).campaigns;
      if (targetJids.length > 0) {
        await service.updateFromPlan(row.id, plan, targetJids, sourceAccountId);
        if (row.accountId === sourceAccountId) sourceShardId = row.id;
        firstShardId ??= row.id;
      } else if (row.status === 'DRAFT' || row.status === 'QUEUED') {
        await service.delete(row.id);
      } else {
        await service.stop(row.id);
      }
    }
    if (!firstShardId) throw new Error('No linked account is a member of the selected groups.');
    return this.getCampaign(sourceShardId ?? firstShardId);
  }

  /** Apply one operator action to every shard of a campaign. */
  public async campaignAction(id: string, action: 'start' | 'run-now' | 'pause' | 'resume' | 'stop' | 'delete') {
    const rows = await this.shardRowsFor(id);
    for (const row of rows) {
      const service = (await this.get(row.accountId)).campaigns;
      try {
        if (action === 'delete') await service.delete(row.id);
        else if (action === 'start' && ['DRAFT', 'QUEUED', 'PAUSED'].includes(row.status)) await service.start(row.id);
        else if (action === 'run-now') await service.runNow(row.id);
        else if (action === 'pause' && row.status === 'RUNNING') await service.pause(row.id);
        else if (action === 'resume' && row.status === 'PAUSED') await service.resume(row.id);
        else if (action === 'stop' && ACTIVE_CAMPAIGN_STATUSES.includes(row.status)) await service.stop(row.id);
      } catch (error) {
        if (rows.length === 1) throw error;
        this.logger.warn({ err: error, campaignId: row.id, action }, 'A distributed campaign shard action failed');
      }
    }
    if (action === 'delete') return { deleted: id };
    return this.getCampaign(id);
  }

  public async stopAllCampaigns(): Promise<{ stopped: number }> {
    const accounts = await db.select({ id: whatsappAccounts.id }).from(whatsappAccounts);
    let stopped = 0;
    for (const account of accounts) {
      stopped += (await (await this.get(account.id)).campaigns.stopAll()).stopped;
    }
    return { stopped };
  }

  private async eligibleParticipantIds(ownerId: string): Promise<string[]> {
    const accounts = await db.select({ id: whatsappAccounts.id }).from(whatsappAccounts).orderBy(asc(whatsappAccounts.createdAt));
    const participants = [ownerId];
    for (const account of accounts) {
      if (account.id === ownerId) continue;
      const runtime = await this.get(account.id);
      // Only a live connection can deliver its shard. A linked but offline
      // account joins future campaigns once it is back online.
      if (runtime.whatsapp.getStatus().state === 'CONNECTED') participants.push(account.id);
    }
    return participants;
  }

  /** Which selected groups each account is already a member of. */
  private async membershipsFor(accountIds: string[], groupJids: string[]): Promise<Map<string, Set<string>>> {
    const memberships = new Map<string, Set<string>>();
    await Promise.all(accountIds.map(async (accountId) => {
      if (groupJids.length === 0) { memberships.set(accountId, new Set()); return; }
      const rows = await db.select({ jid: groups.whatsappGroupJid }).from(groups)
        .where(and(eq(groups.accountId, accountId), eq(groups.isExcluded, false), inArray(groups.whatsappGroupJid, groupJids)));
      memberships.set(accountId, new Set(rows.map((row) => row.jid)));
    }));
    return memberships;
  }

  /** Groups available when editing, merged across every account in the split. */
  private async editGroupsFor(accountIds: string[]) {
    if (accountIds.length === 0) return [];
    const rows = await db.select({ jid: groups.whatsappGroupJid, name: groups.name, isExcluded: groups.isExcluded, communityParentJid: groups.communityParentJid })
      .from(groups).where(inArray(groups.accountId, accountIds));
    const byJid = new Map<string, { whatsappGroupJid: string; name: string; isExcluded: boolean; isScannerEnabled: boolean; communityParentJid: string | null }>();
    for (const row of rows) {
      const existing = byJid.get(row.jid);
      if (!existing) {
        byJid.set(row.jid, { whatsappGroupJid: row.jid, name: row.name, isExcluded: row.isExcluded, isScannerEnabled: true, communityParentJid: row.communityParentJid });
      } else {
        if (!existing.communityParentJid && row.communityParentJid) existing.communityParentJid = row.communityParentJid;
        if (!row.isExcluded) {
          existing.isExcluded = false;
          existing.name = row.name;
        }
      }
    }
    return [...byJid.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  /** Find the account that owns the source messages in an edit payload. */
  private async sourceAccountFor(input: CampaignInput, fallback: string): Promise<string> {
    const raw = input.sourceMessageIds !== undefined ? input.sourceMessageIds : input.sourceMessageId;
    const ids = Array.isArray(raw)
      ? raw.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : typeof raw === 'string' && raw.trim().length > 0 ? [raw.trim()] : [];
    if (ids.length === 0) return fallback;
    const rows = await db.select({ accountId: sourceMessages.accountId }).from(sourceMessages).where(inArray(sourceMessages.id, ids));
    const owners = [...new Set(rows.map((row) => row.accountId))];
    if (owners.length > 1) throw new Error('Campaign source messages must belong to one account.');
    if (owners.length === 1 && rows.length === ids.length) return owners[0];
    return fallback;
  }

  private createRuntime(accountId: string): AccountRuntime {
    const existing = this.runtimes.get(accountId);
    if (existing) return existing;
    const authDir = accountId === MAIN_ACCOUNT_ID
      ? config.WHATSAPP_AUTH_DIR
      : resolve(config.WHATSAPP_AUTH_DIR, '..', 'accounts', accountId);
    const scanner = new ScannerService(this.logger, accountId);
    const whatsapp = new WhatsAppManager(this.logger, scanner, authDir, accountId);
    const campaigns = new CampaignService(whatsapp, this.logger, accountId);
    const joins = new JoinQueueService(whatsapp, this.logger, accountId);
    const runtime = { id: accountId, scanner, whatsapp, campaigns, joins };
    this.runtimes.set(accountId, runtime);
    // Queue processing runs in the background for the life of the process;
    // its timer is unref'd so it never holds the process open.
    joins.start();
    return runtime;
  }
}
