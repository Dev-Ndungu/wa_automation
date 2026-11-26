// End-to-end test of multi-account campaign splitting through AccountService.
// The second account is marked connected in memory, so no WhatsApp session is
// opened and nothing is sent. Env vars must be set before importing config.

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = `/tmp/wa-account-campaigns-test-${process.pid}.db`;

const { bootstrapDatabase } = await import('../db/bootstrap.js');
const { db } = await import('../db/client.js');
const { AccountService } = await import('./service.js');
const { JoinQueueService } = await import('../joins/service.js');

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import test, { after, before } from 'node:test';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { campaigns, groups, whatsappAccounts } from '../db/schema.js';

const noop = () => {};
const loggerStub = { info: noop, error: noop, warn: noop, debug: noop, fatal: noop, trace: noop, silent: noop, child: noop } as unknown as FastifyBaseLogger;
const SECOND_ACCOUNT_ID = 'second-account';

async function addGroup(accountId: string, jid: string): Promise<void> {
  const timestamp = new Date().toISOString();
  await db.insert(groups).values({
    id: randomUUID(), accountId, whatsappGroupJid: jid, name: jid,
    description: null, isTarget: false, isScannerEnabled: true, isExcluded: false,
    lastCampaignSentAt: null, lastSyncedAt: timestamp, joinedAt: null,
    createdAt: timestamp, updatedAt: timestamp,
  });
}

before(async () => {
  await bootstrapDatabase();
  const timestamp = new Date().toISOString();
  await db.insert(whatsappAccounts).values({ id: SECOND_ACCOUNT_ID, name: 'Second account', phone: null, createdAt: timestamp, updatedAt: timestamp });
  await addGroup('main', 'split-one@g.us');
  await addGroup('main', 'split-two@g.us');
  await addGroup(SECOND_ACCOUNT_ID, 'split-two@g.us');
});

after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${process.env.DATABASE_PATH}${suffix}`, { force: true });
  }
});

test('creating a campaign splits targets across connected accounts', async () => {
  const accounts = new AccountService(loggerStub);
  const secondRuntime = await accounts.get(SECOND_ACCOUNT_ID);
  (secondRuntime.whatsapp as unknown as { getStatus: () => { state: string } }).getStatus = () => ({
    state: 'CONNECTED', phone: null, lastConnectedAt: null, qrDataUrl: null, error: null,
  });
  const mainRuntime = await accounts.get('main');
  const captured = await mainRuntime.campaigns.captureManualSource({ text: 'Split source', label: 'Split source' });

  const created = await accounts.createCampaign('main', {
    name: 'Split through AccountService',
    sourceMessageId: undefined,
    sourceMessageIds: [captured.sources[0].id],
    groupJids: ['split-one@g.us', 'split-two@g.us'],
    schedule: { type: 'ONCE' },
  }) as {
    id: string;
    distributionId: string | null;
    targets: Array<unknown>;
    accounts?: Array<unknown>;
    sourceContent?: { text: string } | null;
    editGroups?: Array<{ whatsappGroupJid: string }>;
  };

  assert.ok(created.distributionId, 'two connected accounts produce a distribution');
  assert.equal(created.targets.length, 2);
  assert.equal(created.accounts?.length, 2);
  assert.equal(created.sourceContent?.text, 'Split source');
  assert.deepEqual(created.editGroups?.map((group) => group.whatsappGroupJid).sort(), ['split-one@g.us', 'split-two@g.us']);

  const shards = await db.select().from(campaigns).where(eq(campaigns.distributionId, created.distributionId));
  assert.equal(shards.length, 2);
  assert.ok(shards.every((shard) => shard.sourceAccountId === 'main'));
  assert.deepEqual(shards.map((shard) => shard.accountId).sort(), ['main', SECOND_ACCOUNT_ID]);

  const listed = await accounts.listCampaigns();
  const card = listed.find((campaign) => campaign.distributionId === created.distributionId);
  assert.ok(card);
  assert.equal(card.targets.length, 2);
  assert.equal(card.accountId, 'main', 'the owner shard represents the combined card');

  await accounts.campaignAction(created.id, 'delete');
  const left = await db.select().from(campaigns).where(eq(campaigns.distributionId, created.distributionId));
  assert.equal(left.length, 0, 'deleting the combined campaign removes every shard');
});

test('creating an account runtime starts the join queue processor', async () => {
  const originalStart = JoinQueueService.prototype.start;
  let starts = 0;
  JoinQueueService.prototype.start = function (this: InstanceType<typeof JoinQueueService>) {
    starts += 1;
    return originalStart.call(this);
  };
  try {
    const accounts = new AccountService(loggerStub);
    await accounts.get('main');
    assert.equal(starts, 1);
  } finally {
    JoinQueueService.prototype.start = originalStart;
  }
});

test('a status campaign stays on the owner account and has no distribution', async () => {
  const accounts = new AccountService(loggerStub);
  const secondRuntime = await accounts.get(SECOND_ACCOUNT_ID);
  (secondRuntime.whatsapp as unknown as { getStatus: () => { state: string } }).getStatus = () => ({
    state: 'CONNECTED', phone: null, lastConnectedAt: null, qrDataUrl: null, error: null,
  });
  const mainRuntime = await accounts.get('main');
  const captured = await mainRuntime.campaigns.captureManualSource({ text: 'Owner status', label: 'Owner status' });
  const created = await accounts.createCampaign('main', {
    name: 'Owner status', sourceMessageId: undefined, sourceMessageIds: [captured.sources[0].id],
    groupJids: ['split-one@g.us'], deliveryMode: 'GROUP_STATUS', schedule: { type: 'ONCE' },
  }) as { distributionId: string | null; targets: Array<{ groupJid: string }> };
  assert.equal(created.distributionId, null);
  assert.deepEqual(created.targets.map((target) => target.groupJid), ['split-one@g.us']);
  const rows = await db.select().from(campaigns).where(eq(campaigns.name, 'Owner status'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].accountId, 'main');
});
