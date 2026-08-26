import type { WAMessage } from '@whiskeysockets/baileys';
import { and, asc, desc, eq, gte, inArray, like, or, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { randomUUID } from 'node:crypto';
import { db } from '../db/client.js';
import { appSettings, discoveredLinks, groups, linkOccurrences } from '../db/schema.js';
import { deduplicateInviteLinks, extractInviteLinks, type InviteLink } from './extract.js';
import { extractMessageText } from './message-text.js';

export const SCANNER_ENABLED_SETTING = 'scanner.enabled';
export const AUTO_JOIN_ENABLED_SETTING = 'scanner.autoJoinEnabled';
const timestamp = () => new Date().toISOString();

export type LinkStatus = 'NEW' | 'VIEWED' | 'USED' | 'ARCHIVED';
export type ListLinksOptions = { status?: LinkStatus; search?: string; groupJids?: string[]; since?: string; limit?: number; offset?: number };

export class ScannerService {
  private autoJoin: ((inviteCode: string) => Promise<void>) | null = null;
  public constructor(private readonly logger: FastifyBaseLogger, private readonly accountId = 'main') {}

  private settingKey(key: string): string { return `${this.accountId}.${key}`; }

  public setAutoJoinHandler(handler: (inviteCode: string) => Promise<void>): void { this.autoJoin = handler; }

  public async isEnabled(): Promise<boolean> {
    const setting = await db.query.appSettings.findFirst({ where: eq(appSettings.key, this.settingKey(SCANNER_ENABLED_SETTING)) });
    return setting ? setting.value === 'true' : true;
  }

  public async setEnabled(enabled: boolean): Promise<boolean> {
    const key = this.settingKey(SCANNER_ENABLED_SETTING);
    await db.insert(appSettings).values({ key, value: String(enabled), updatedAt: timestamp() })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: String(enabled), updatedAt: timestamp() } });
    return enabled;
  }

  public async isAutoJoinEnabled(): Promise<boolean> {
    const setting = await db.query.appSettings.findFirst({ where: eq(appSettings.key, this.settingKey(AUTO_JOIN_ENABLED_SETTING)) });
    return setting?.value === 'true';
  }

  public async setAutoJoinEnabled(enabled: boolean): Promise<boolean> {
    const key = this.settingKey(AUTO_JOIN_ENABLED_SETTING);
    await db.insert(appSettings).values({ key, value: String(enabled), updatedAt: timestamp() })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: String(enabled), updatedAt: timestamp() } });
    return enabled;
  }

  public async processIncomingMessage(message: WAMessage): Promise<number> {
    const groupJid = message.key.remoteJid;
    if (!groupJid?.endsWith('@g.us') || message.key.fromMe || !(await this.isEnabled())) return 0;

    const group = await db.query.groups.findFirst({ where: and(eq(groups.accountId, this.accountId), eq(groups.whatsappGroupJid, groupJid)) });
    if (!group || !group.isScannerEnabled || group.isExcluded) return 0;

    const links = deduplicateInviteLinks(extractMessageText(message).flatMap(extractInviteLinks));
    if (!links.length) return 0;
    const occurredAt = timestamp();
    const autoJoinEnabled = await this.isAutoJoinEnabled();
    for (const link of links) {
      const record = await this.recordSighting(link, {
      groupJid,
      groupName: group.name,
      messageId: message.key.id ?? null,
      occurredAt,
    });
      if (autoJoinEnabled && record.isNew && this.autoJoin) {
        try { await this.autoJoin(link.inviteCode); await this.deleteLink(record.id); }
        catch (error) { this.logger.warn({ err: error, inviteUrl: link.inviteUrl }, 'Automatic group join failed'); }
      }
    }
    this.logger.info({ groupJid, links: links.length }, 'WhatsApp group invite links discovered');
    return links.length;
  }

  /** Persist a single invite sighting. The link row is unique; sightings remain lightweight. */
  public async recordSighting(link: InviteLink, sighting: { groupJid: string; groupName: string; messageId: string | null; occurredAt?: string }): Promise<{ id: string; isNew: boolean }> {
    const occurredAt = sighting.occurredAt ?? timestamp();
    const existing = await db.query.discoveredLinks.findFirst({ where: and(eq(discoveredLinks.accountId, this.accountId), eq(discoveredLinks.inviteUrl, link.inviteUrl)) });
    const result = await db.insert(discoveredLinks).values({
      id: randomUUID(), accountId: this.accountId, inviteUrl: link.inviteUrl, inviteCode: link.inviteCode,
      sourceGroupJid: sighting.groupJid, sourceGroupName: sighting.groupName,
      firstSeenAt: occurredAt, lastSeenAt: occurredAt, timesSeen: 1, sourceMessageId: sighting.messageId,
      status: 'NEW', notes: null,
    }).onConflictDoUpdate({
      target: [discoveredLinks.accountId, discoveredLinks.inviteUrl],
      set: { lastSeenAt: occurredAt, timesSeen: sql`${discoveredLinks.timesSeen} + 1` },
    }).returning({ id: discoveredLinks.id });
    const linkId = result[0]?.id;
    if (!linkId) throw new Error('Unable to persist discovered WhatsApp invite link.');
    await db.insert(linkOccurrences).values({ id: randomUUID(), linkId, sourceGroupJid: sighting.groupJid, occurredAt });
    return { id: linkId, isNew: !existing };
  }

  public async listLinks(options: ListLinksOptions = {}) {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);
    const filters = [eq(discoveredLinks.accountId, this.accountId)];
    if (options.status) filters.push(eq(discoveredLinks.status, options.status));
    if (options.search?.trim()) {
      const term = `%${options.search.trim().replace(/[%_]/g, '\\$&')}%`;
      filters.push(or(like(discoveredLinks.inviteUrl, term), like(discoveredLinks.sourceGroupName, term))!);
    }
    if (options.groupJids?.length) filters.push(inArray(discoveredLinks.sourceGroupJid, options.groupJids));
    if (options.since) filters.push(gte(discoveredLinks.firstSeenAt, options.since));
    const where = filters.length ? and(...filters) : undefined;
    const [items, total] = await Promise.all([
      db.select().from(discoveredLinks).where(where).orderBy(desc(discoveredLinks.lastSeenAt)).limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(discoveredLinks).where(where),
    ]);
    return { items, total: Number(total[0]?.count ?? 0), limit, offset };
  }

  public async updateLink(id: string, changes: { status?: LinkStatus; notes?: string | null }) {
    const update: Partial<typeof discoveredLinks.$inferInsert> = {};
    if (changes.status) update.status = changes.status;
    if (changes.notes !== undefined) update.notes = changes.notes;
    if (!Object.keys(update).length) return null;
    const updated = await db.update(discoveredLinks).set(update).where(and(eq(discoveredLinks.id, id), eq(discoveredLinks.accountId, this.accountId))).returning();
    return updated[0] ?? null;
  }

  public async getLink(id: string) {
    const [link] = await db.select({ id: discoveredLinks.id, inviteCode: discoveredLinks.inviteCode, inviteUrl: discoveredLinks.inviteUrl })
      .from(discoveredLinks).where(and(eq(discoveredLinks.id, id), eq(discoveredLinks.accountId, this.accountId))).limit(1);
    return link ?? null;
  }

  public async deleteLink(id: string): Promise<void> { await db.delete(discoveredLinks).where(and(eq(discoveredLinks.id, id), eq(discoveredLinks.accountId, this.accountId))); }

  public async exportLinks() {
    return db.select({
      inviteUrl: discoveredLinks.inviteUrl,
      sourceGroup: discoveredLinks.sourceGroupName,
      firstSeen: discoveredLinks.firstSeenAt,
      lastSeen: discoveredLinks.lastSeenAt,
      timesSeen: discoveredLinks.timesSeen,
      status: discoveredLinks.status,
    }).from(discoveredLinks).where(eq(discoveredLinks.accountId, this.accountId)).orderBy(asc(discoveredLinks.firstSeenAt));
  }
}
