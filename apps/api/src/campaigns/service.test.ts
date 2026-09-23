// Integration tests for CampaignService's capture / create / send / delete
// paths, including the multi-file send with the video branch. Env vars must be
// set BEFORE anything that transitively loads config.js (db/client,
// db/bootstrap, campaigns/service), so the libsql database lands in a unique
// temp file for this process. The WhatsApp socket is stubbed — nothing is ever
// sent to a real WhatsApp account.
//
// Pacing is injected through the constructor's CampaignPacing seam: the shared
// service runs with instant gaps so the suite is deterministic and fast, and
// the concurrent-campaigns test uses its own service with a 2s floor. The
// production default (random 60-240s draws, see safety/limits.ts) never runs
// here.

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = `/tmp/wa-control-test-${process.pid}.db`;

const { bootstrapDatabase } = await import('../db/bootstrap.js');
const { db } = await import('../db/client.js');
const { CampaignService } = await import('./service.js');
const { SEND_DAILY_LIMIT } = await import('../safety/limits.js');

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import test, { after, before } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { actionLog, campaignSources, campaignTargets, campaigns, groups, operationalLogs, sourceMessages } from '../db/schema.js';
import type { WhatsAppManager, WhatsAppStatus } from '../whatsapp/manager.js';

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const TINY_VIDEO = 'data:video/mp4;base64,AAAA';

type SentCall = { jid: string; content: Record<string, unknown> };
const sentCalls: SentCall[] = [];
// Delivery times kept in lockstep with sentCalls, for pacing assertions.
const sendTimes: number[] = [];
const noop = () => {};

// Stub socket: every send is recorded in sentCalls, in delivery order.
const whatsappStub = {
  getSocket: () => ({
    sendMessage: async (jid: string, content: Record<string, unknown>) => {
      sentCalls.push({ jid, content });
      sendTimes.push(Date.now());
    },
  }),
  getStatus: () => ({ state: 'CONNECTED', phone: null, lastConnectedAt: null, qrDataUrl: null, error: null }),
  subscribe: () => noop,
  subscribeGroupJoined: () => noop,
} as unknown as WhatsAppManager;

const loggerStub = {
  info: noop, error: noop, warn: noop, debug: noop, fatal: noop, trace: noop, silent: noop, child: noop,
} as unknown as FastifyBaseLogger;

// One service instance shared by all tests, bound to the 'main' account. The
// pacing seam replaces the production random draws (60-240s gaps, 30-120s
// warm-up) with instant values so the send loop is deterministic.
// dailyBudgetResetMs stands in for "the time until the next UTC midnight" so the
// budget auto-resume can be observed inside a test instead of waiting for a real
// day boundary.
const service = new CampaignService(whatsappStub, loggerStub, 'main', {
  minSendGapSeconds: 0,
  sendGapSeconds: () => 0,
  warmupSeconds: () => 0,
  reconnectSettleMs: () => 0,
  dailyBudgetResetMs: () => 300,
  // Sends are gated to 06:00-23:00 EAT in production; the suite must not depend
  // on the hour it runs at, so the window is always open here.
  sendWindowDelayMs: () => 0,
});

before(async () => {
  await bootstrapDatabase();
});

after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${process.env.DATABASE_PATH}${suffix}`, { force: true });
  }
});

async function insertGroup(jid: string, name: string, extra?: { joinedAt?: string | null; lastCampaignSentAt?: string | null }): Promise<void> {
  const timestamp = new Date().toISOString();
  await db.insert(groups).values({
    id: randomUUID(),
    accountId: 'main',
    whatsappGroupJid: jid,
    name,
    description: null,
    lastSyncedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    joinedAt: extra?.joinedAt ?? null,
    lastCampaignSentAt: extra?.lastCampaignSentAt ?? null,
  });
}

async function waitForTargetsSent(campaignId: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await db.select({ status: campaignTargets.status }).from(campaignTargets)
      .where(eq(campaignTargets.campaignId, campaignId));
    if (rows.length === 2 && rows.every((row) => row.status === 'SENT')) return;
    if (Date.now() >= deadline) {
      assert.fail(`campaign ${campaignId} targets did not reach SENT within ${timeoutMs}ms. Current statuses: ${JSON.stringify(rows)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForCampaignStatus(campaignId: string, expected: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [campaign] = await db.select({ status: campaigns.status }).from(campaigns)
      .where(eq(campaigns.id, campaignId)).limit(1);
    if (campaign?.status === expected) return;
    if (Date.now() >= deadline) {
      assert.fail(`campaign ${campaignId} did not reach status ${expected} within ${timeoutMs}ms; last status: ${campaign?.status ?? 'missing row'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Poll until the single target is parked as WAITING with a future scheduledAt
 *  (group grace period or cooldown). */
async function waitForParkedTarget(campaignId: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [target] = await db.select({ status: campaignTargets.status, scheduledAt: campaignTargets.scheduledAt })
      .from(campaignTargets).where(eq(campaignTargets.campaignId, campaignId)).limit(1);
    if (target?.status === 'WAITING' && target.scheduledAt && Date.parse(target.scheduledAt) > Date.now()) return;
    if (Date.now() >= deadline) {
      assert.fail(`campaign ${campaignId} target did not park as WAITING with a future scheduledAt: ${JSON.stringify(target)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Poll until the campaign is PAUSED with the budget pauseReason. */
async function waitForPause(campaignId: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [campaign] = await db.select({ status: campaigns.status, pauseReason: campaigns.pauseReason })
      .from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (campaign?.status === 'PAUSED' && campaign.pauseReason?.includes('Daily send limit')) return;
    if (Date.now() >= deadline) {
      assert.fail(`campaign ${campaignId} did not auto-pause on the budget: ${JSON.stringify(campaign)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('multi-file capture sends image, video, image in order to every target', async () => {
  sentCalls.length = 0;

  await insertGroup('groupa@g.us', 'Group A');
  await insertGroup('groupb@g.us', 'Group B');

  const captured = await service.captureManualSource({
    text: 'Test caption A',
    label: 'Test files',
    files: [
      { kind: 'image', dataUrl: TINY_PNG },
      { kind: 'video', dataUrl: TINY_VIDEO },
      { kind: 'image', dataUrl: TINY_PNG },
    ],
  });
  assert.equal(captured.sources.length, 3, 'one sourceMessages row per file');
  assert.deepEqual(captured.sources.map((source) => source.kind), ['image', 'video', 'image']);

  const campaign = await service.create({
    name: 'Multi-file send',
    // sourceMessageId: undefined satisfies the (required) input type while
    // keeping the legacy single-message fallback unused.
    sourceMessageId: undefined,
    sourceMessageIds: captured.sources.map((source) => source.id),
    groupJids: ['groupa@g.us', 'groupb@g.us'],
    schedule: { type: 'ONCE' },
    // The default shuffleOrder is true; this test asserts a deterministic
    // delivery order, so it opts out explicitly.
    shuffleOrder: false,
  });

  await service.runNow(campaign.id);
  await waitForTargetsSent(campaign.id);
  // The worker marks the campaign COMPLETED only after the last target is sent,
  // so this also proves the send loop finished and no further sends can occur.
  await waitForCampaignStatus(campaign.id, 'COMPLETED');

  assert.equal(sentCalls.length, 6, `expected 6 sends, got ${sentCalls.length}: ${JSON.stringify(sentCalls.map((call) => call.jid))}`);
  for (const [base, jid] of [[0, 'groupa@g.us'], [3, 'groupb@g.us']] as const) {
    // First file: image payload re-encoded via sharp and sent as a JPEG.
    assert.equal(sentCalls[base].jid, jid);
    assert.ok(Buffer.isBuffer(sentCalls[base].content.image), `call ${base} must carry an image Buffer`);
    assert.equal(sentCalls[base].content.caption, 'Test caption A');
    assert.equal(sentCalls[base].content.mimetype, 'image/jpeg');
    const thumbnail = sentCalls[base].content.jpegThumbnail;
    assert.equal(typeof thumbnail, 'string', 'image call must include a thumbnail');
    assert.ok(Buffer.from(thumbnail as string, 'base64').length > 0, 'image call must include a non-empty base64 thumbnail');

    // Second file: the video branch fires — raw buffer, no thumbnail.
    assert.equal(sentCalls[base + 1].jid, jid);
    assert.ok(Buffer.isBuffer(sentCalls[base + 1].content.video), `call ${base + 1} must carry a video Buffer`);
    assert.equal(sentCalls[base + 1].content.mimetype, 'video/mp4');
    assert.equal(sentCalls[base + 1].content.caption, 'Test caption A');
    assert.ok(!('jpegThumbnail' in sentCalls[base + 1].content), 'video branch must not attach a thumbnail');

    // Third file: image again, closing the ordered multi-file sequence.
    assert.equal(sentCalls[base + 2].jid, jid);
    assert.ok(Buffer.isBuffer(sentCalls[base + 2].content.image), `call ${base + 2} must carry an image Buffer`);
  }
});

test('delete removes the campaign rows and keeps shared source messages', async () => {
  const captured = await service.captureManualSource({ text: 'Delete me', label: 'Delete test' });
  assert.equal(captured.sources.length, 1);
  assert.equal(captured.sources[0].kind, 'text');

  // 'groupb@g.us' was inserted by the first test; a fresh campaign id makes the
  // unique campaign_targets(campaignId, groupJid) index safe.
  const campaign = await service.create({
    name: 'Delete me campaign',
    // sourceMessageId: undefined — see the multi-file test for the rationale.
    sourceMessageId: undefined,
    sourceMessageIds: [captured.sources[0].id],
    groupJids: ['groupb@g.us'],
    schedule: { type: 'ONCE' },
  });

  assert.deepEqual(await service.delete(campaign.id), { deleted: campaign.id });

  await assert.rejects(service.get(campaign.id), /Campaign not found\./);

  const targets = await db.select().from(campaignTargets).where(eq(campaignTargets.campaignId, campaign.id));
  assert.equal(targets.length, 0, 'campaign_targets must be removed by the FK cascade');
  const sourceRows = await db.select().from(campaignSources).where(eq(campaignSources.campaignId, campaign.id));
  assert.equal(sourceRows.length, 0, 'campaign_sources must be removed by the FK cascade');

  const kept = await db.select().from(sourceMessages).where(eq(sourceMessages.id, captured.sources[0].id));
  assert.equal(kept.length, 1, 'source_messages are shared across campaigns and must never be deleted');
});

test('combined capture refreshes the originals in place and appends new files', async () => {
  const first = await service.captureManualSource({
    text: 'Old caption',
    label: 'Originals',
    files: [
      { kind: 'image', dataUrl: TINY_PNG },
      { kind: 'video', dataUrl: TINY_VIDEO },
    ],
  });
  assert.equal(first.sources.length, 2);
  assert.deepEqual(first.sources.map((source) => source.kind), ['image', 'video']);

  const combined = await service.captureManualSource({
    text: 'New caption',
    label: 'Combined',
    updateSourceIds: first.sources.map((source) => source.id),
    files: [{ kind: 'image', dataUrl: TINY_PNG }],
  });

  assert.equal(combined.sources.length, 3);
  assert.deepEqual(
    combined.sources.map((source) => source.id).slice(0, 2),
    [first.sources[0].id, first.sources[1].id],
    'the originals keep their rows, in the given order',
  );
  assert.ok(!first.sources.some((source) => source.id === combined.sources[2].id), 'the new file must be a fresh row');
  assert.deepEqual(combined.sources.map((source) => source.kind), ['image', 'video', 'image']);

  const payloads = new Map<string, Record<string, unknown>>();
  for (const id of combined.sources.map((source) => source.id)) {
    const [row] = await db.select({ payload: sourceMessages.payload }).from(sourceMessages).where(eq(sourceMessages.id, id));
    assert.ok(row, `source message ${id} must still exist`);
    payloads.set(id, JSON.parse(row.payload) as Record<string, unknown>);
  }
  const originalImage = payloads.get(first.sources[0].id)!;
  const originalVideo = payloads.get(first.sources[1].id)!;
  const newRow = payloads.get(combined.sources[2].id)!;

  assert.equal(originalImage.caption, 'New caption', 'image row caption must be refreshed in place');
  assert.equal(typeof originalImage.imageDataUrl, 'string', 'image row must keep its stored media');
  assert.equal(originalVideo.caption, 'New caption', 'video row caption must be refreshed in place');
  assert.equal(typeof originalVideo.videoDataUrl, 'string', 'video row must keep its stored media');
  assert.equal(newRow.caption, 'New caption', 'new row must carry the combined caption');
  assert.equal(typeof newRow.imageDataUrl, 'string', 'new row must be the captured image file');
});

test('cooldown parks a recently sent group as WAITING until the cooldown passes', async () => {
  const jid = `cooldown-${randomUUID()}@g.us`;
  await insertGroup(jid, 'Cooldown Group', { lastCampaignSentAt: new Date().toISOString() });

  const captured = await service.captureManualSource({ text: 'Cooldown probe', label: 'Cooldown' });
  const campaign = await service.create({
    name: 'Cooldown campaign',
    // sourceMessageId: undefined — see the multi-file test for the rationale.
    sourceMessageId: undefined,
    sourceMessageIds: [captured.sources[0].id],
    groupJids: [jid],
    schedule: { type: 'ONCE' },
    shuffleOrder: false,
  });

  sentCalls.length = 0;
  await service.runNow(campaign.id);
  // The cooldown is drawn from the frozen 18-48h range in safety/limits.ts —
  // deliberately not injectable, so any send since now parks the group.
  await waitForParkedTarget(campaign.id);

  // stop() must resolve promptly: it wakes the sleeping worker instead of
  // leaving it to wait out its chunked sleep.
  await service.stop(campaign.id);
  const [after] = await db.select({ status: campaigns.status }).from(campaigns).where(eq(campaigns.id, campaign.id));
  assert.equal(after.status, 'STOPPED');
  assert.equal(sentCalls.length, 0, 'no message may be sent to a group in cooldown');
});

test('grace period parks a newly joined group as WAITING until the grace passes', async () => {
  const jid = `grace-${randomUUID()}@g.us`;
  // joinedAt set, lastCampaignSentAt left null: only the grace period applies.
  await insertGroup(jid, 'Grace Group', { joinedAt: new Date().toISOString() });

  const captured = await service.captureManualSource({ text: 'Grace probe', label: 'Grace' });
  const campaign = await service.create({
    name: 'Grace campaign',
    // sourceMessageId: undefined — see the multi-file test for the rationale.
    sourceMessageId: undefined,
    sourceMessageIds: [captured.sources[0].id],
    groupJids: [jid],
    schedule: { type: 'ONCE' },
    shuffleOrder: false,
  });

  sentCalls.length = 0;
  await service.runNow(campaign.id);
  // The grace is drawn from the frozen 120-360 minute range in safety/limits.ts —
  // a group joined just now always parks, whatever the draw.
  await waitForParkedTarget(campaign.id);

  await service.stop(campaign.id);
  const [after] = await db.select({ status: campaigns.status }).from(campaigns).where(eq(campaigns.id, campaign.id));
  assert.equal(after.status, 'STOPPED');
  assert.equal(sentCalls.length, 0, 'no message may be sent to a group inside its grace period');
});

test('daily send budget pauses the campaign before any message goes out', async () => {
  // The daily budget is the frozen SEND_DAILY_LIMIT constant in safety/limits.ts;
  // reaching it means filling the action log with that many SEND rows for today
  // (the same rows recordSend() writes for real sends).
  const createdAt = new Date().toISOString();
  const budgetRowIds: string[] = [];
  const rows = Array.from({ length: SEND_DAILY_LIMIT }, () => {
    const id = randomUUID();
    budgetRowIds.push(id);
    return { id, accountId: 'main', action: 'SEND' as const, createdAt };
  });
  await db.insert(actionLog).values(rows);

  const jid = `budget-${randomUUID()}@g.us`;
  await insertGroup(jid, 'Budget Group');
  const captured = await service.captureManualSource({ text: 'Budget probe', label: 'Budget' });
  const campaign = await service.create({
    name: 'Budget campaign',
    // sourceMessageId: undefined — see the multi-file test for the rationale.
    sourceMessageId: undefined,
    sourceMessageIds: [captured.sources[0].id],
    groupJids: [jid],
    schedule: { type: 'ONCE' },
    shuffleOrder: false,
  });

  sentCalls.length = 0;
  await service.runNow(campaign.id);
  await waitForPause(campaign.id);

  assert.equal(sentCalls.length, 0, 'the budget must stop sends before the first message');

  // The budget pause must not leave the target stranded in SENDING: the row is
  // still QUEUED so it can be picked up after the next UTC day.
  const [target] = await db.select({ status: campaignTargets.status }).from(campaignTargets).where(eq(campaignTargets.campaignId, campaign.id));
  assert.equal(target.status, 'QUEUED', 'a budget-paused target must return to QUEUED, never stay SENDING');

  // A budget pause is self-clearing: the campaign carries the auto-resume
  // deadline so a new day needs no operator action.
  const [paused] = await db.select({ autoResumeAt: campaigns.autoResumeAt }).from(campaigns).where(eq(campaigns.id, campaign.id));
  assert.ok(paused.autoResumeAt, 'a budget-paused campaign must record when it resumes itself');

  // Removing the SEND rows is what the next UTC day does to the budget: the
  // armed resume (300ms here, UTC midnight in production) then puts the
  // campaign back to RUNNING and the held message goes out without a resume
  // call from anyone.
  await db.delete(actionLog).where(inArray(actionLog.id, budgetRowIds));
  await waitForCampaignStatus(campaign.id, 'RUNNING');
  const [resumed] = await db.select({ pauseReason: campaigns.pauseReason, autoResumeAt: campaigns.autoResumeAt })
    .from(campaigns).where(eq(campaigns.id, campaign.id));
  assert.equal(resumed.pauseReason, null, 'an auto-resumed campaign must not keep its pause reason');
  assert.equal(resumed.autoResumeAt, null, 'an auto-resumed campaign must not keep its resume deadline');

  const deadline = Date.now() + 5_000;
  for (;;) {
    const [target] = await db.select({ status: campaignTargets.status }).from(campaignTargets).where(eq(campaignTargets.campaignId, campaign.id));
    if (target.status === 'SENT') break;
    if (Date.now() >= deadline) assert.fail(`the auto-resumed campaign did not deliver; target status: ${target.status}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(sentCalls.length, 1, 'exactly the held message goes out after the budget resets');

  const resumeLogs = await db.select({ event: operationalLogs.event, details: operationalLogs.details }).from(operationalLogs)
    .where(eq(operationalLogs.event, 'campaign.auto_resumed'));
  assert.ok(resumeLogs.some((row) => row.details?.includes(campaign.id)), 'the automatic resume must be recorded in the operational log');

  // Leave the action log empty for later tests (the delivery above added a row).
  await db.delete(actionLog).where(eq(actionLog.accountId, 'main'));
});

test('shuffled multi-target send records every send in the action log', async () => {
  // Earlier tests recorded SEND rows (the multi-file send); deleting them makes
  // the action-log count deterministic for this test. The frozen daily budget
  // (SEND_DAILY_LIMIT) is far above the two sends here regardless of test order.
  await db.delete(actionLog).where(eq(actionLog.accountId, 'main'));
  sentCalls.length = 0;

  const jidA = `shuffle-a-${randomUUID()}@g.us`;
  const jidB = `shuffle-b-${randomUUID()}@g.us`;
  await insertGroup(jidA, 'Shuffle Group A');
  await insertGroup(jidB, 'Shuffle Group B');

  const captured = await service.captureManualSource({ text: '', label: 'Shuffle image', files: [{ kind: 'image', dataUrl: TINY_PNG }] });
  const campaign = await service.create({
    name: 'Shuffle send',
    // sourceMessageId: undefined — see the multi-file test for the rationale.
    sourceMessageId: undefined,
    sourceMessageIds: captured.sources.map((source) => source.id),
    groupJids: [jidA, jidB],
    schedule: { type: 'ONCE' },
    // shuffleOrder omitted on purpose: the default (true) is what is under test.
  });

  await service.runNow(campaign.id);
  await waitForTargetsSent(campaign.id);
  await waitForCampaignStatus(campaign.id, 'COMPLETED');

  assert.equal(sentCalls.length, 2, `expected 2 sends, got ${sentCalls.length}: ${JSON.stringify(sentCalls.map((call) => call.jid))}`);
  const sends = await db.select({ action: actionLog.action }).from(actionLog)
    .where(eq(actionLog.accountId, 'main'));
  const sendRows = sends.filter((row) => row.action === 'SEND');
  assert.equal(sendRows.length, 2, `expected exactly 2 SEND rows, got ${JSON.stringify(sendRows)}`);
});

test('concurrent campaigns keep every account send at least the minimum gap apart', async () => {
  // The suite's shared service runs with a zero gap; this test uses its own
  // service instance with a deterministic 2s account-wide floor (the queue is
  // per account/instance, so both campaigns must run on the same instance).
  // Two campaigns running at once must not interleave tighter than that floor
  // even though each alone would send instantly — the account-wide queue is
  // what is under test here.
  const pacedService = new CampaignService(whatsappStub, loggerStub, 'main', {
    minSendGapSeconds: 2,
    sendGapSeconds: () => 0,
    warmupSeconds: () => 0,
    reconnectSettleMs: () => 0,
    dailyBudgetResetMs: () => 60_000,
    sendWindowDelayMs: () => 0,
  });
  sentCalls.length = 0;
  sendTimes.length = 0;

  const jids = ['gap-a1', 'gap-a2', 'gap-b1', 'gap-b2'].map((name) => `${name}-${randomUUID()}@g.us`);
  for (const jid of jids) await insertGroup(jid, `Gap ${jid}`);
  const capturedA = await pacedService.captureManualSource({ text: 'Gap probe A', label: 'Gap A' });
  const campaignA = await pacedService.create({
    name: 'Gap campaign A',
    // sourceMessageId: undefined — see the multi-file test for the rationale.
    sourceMessageId: undefined,
    sourceMessageIds: [capturedA.sources[0].id],
    groupJids: [jids[0], jids[1]],
    schedule: { type: 'ONCE' },
    shuffleOrder: false,
  });
  const capturedB = await pacedService.captureManualSource({ text: 'Gap probe B', label: 'Gap B' });
  const campaignB = await pacedService.create({
    name: 'Gap campaign B',
    // sourceMessageId: undefined — see the multi-file test for the rationale.
    sourceMessageId: undefined,
    sourceMessageIds: [capturedB.sources[0].id],
    groupJids: [jids[2], jids[3]],
    schedule: { type: 'ONCE' },
    shuffleOrder: false,
  });

  await pacedService.runNow(campaignA.id);
  await pacedService.runNow(campaignB.id);
  await waitForTargetsSent(campaignA.id);
  await waitForTargetsSent(campaignB.id);
  await waitForCampaignStatus(campaignA.id, 'COMPLETED');
  await waitForCampaignStatus(campaignB.id, 'COMPLETED');

  assert.equal(sentCalls.length, 4, `expected 4 sends across both campaigns, got ${sentCalls.length}`);
  assert.equal(sendTimes.length, 4, 'sendTimes must stay in lockstep with sentCalls');
  for (let i = 1; i < sendTimes.length; i += 1) {
    const gap = sendTimes[i] - sendTimes[i - 1];
    assert.ok(gap >= 1900, `account sends ${i - 1} and ${i} were only ${gap}ms apart; the 2s account-wide floor must hold across campaigns`);
  }
  assert.ok(sendTimes[3] - sendTimes[0] >= 3 * 1900, 'the four sends must span at least three full floor intervals');
});

/** Fake WhatsApp whose status listener is captured, so a test can push
 *  connection transitions the way the real manager's connection.update handler
 *  does. getStatus always reports CONNECTED, so the worker send loop never
 *  bails out; only the settle-transition logic sees the pushed events. */
function controllableWhatsapp(onSend: () => Promise<void>): { fake: WhatsAppManager; push: (state: WhatsAppStatus['state']) => void } {
  const listeners = new Set<(status: WhatsAppStatus) => void>();
  const connectedStatus: WhatsAppStatus = { state: 'CONNECTED', phone: null, lastConnectedAt: null, qrDataUrl: null, error: null };
  const fake = {
    getSocket: () => ({ sendMessage: async () => { await onSend(); } }),
    getStatus: () => connectedStatus,
    subscribe: (listener: (status: WhatsAppStatus) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    subscribeGroupJoined: () => noop,
  } as unknown as WhatsAppManager;
  return {
    fake,
    push: (state: WhatsAppStatus['state']) => {
      for (const listener of [...listeners]) listener({ ...connectedStatus, state });
    },
  };
}

/** Poll until the campaign is PAUSED by the circuit breaker. */
async function waitForBreakerPause(campaignId: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [campaign] = await db.select({ status: campaigns.status, pauseReason: campaigns.pauseReason })
      .from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (campaign?.status === 'PAUSED' && campaign.pauseReason?.includes('consecutive send failures')) return;
    if (Date.now() >= deadline) {
      assert.fail(`campaign ${campaignId} did not auto-pause on the circuit breaker: ${JSON.stringify(campaign)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('settle window gates the first send after a reconnect and is re-drawn per reconnect', async () => {
  // The settle draw is injected as a deterministic 2s window; the suite's
  // other instant pacing never exercises this path.
  const { fake, push } = controllableWhatsapp(async () => { sentCalls.push({ jid: 'fake', content: {} }); sendTimes.push(Date.now()); });
  const settleService = new CampaignService(fake, loggerStub, 'main', {
    minSendGapSeconds: 0,
    sendGapSeconds: () => 0,
    warmupSeconds: () => 0,
    reconnectSettleMs: () => 2000,
    dailyBudgetResetMs: () => 60_000,
    sendWindowDelayMs: () => 0,
  });
  sentCalls.length = 0;
  sendTimes.length = 0;

  async function sendCampaign(name: string): Promise<void> {
    const jids = [`settle-${name}-a-${randomUUID()}@g.us`, `settle-${name}-b-${randomUUID()}@g.us`];
    for (const jid of jids) await insertGroup(jid, `Settle ${name} ${jid}`);
    const captured = await settleService.captureManualSource({ text: `Settle probe ${name}`, label: `Settle ${name}` });
    const campaign = await settleService.create({
      name: `Settle campaign ${name}`,
      // sourceMessageId: undefined — see the multi-file test for the rationale.
      sourceMessageId: undefined,
      sourceMessageIds: [captured.sources[0].id],
      groupJids: jids,
      schedule: { type: 'ONCE' },
      shuffleOrder: false,
    });
    await settleService.runNow(campaign.id);
    await waitForTargetsSent(campaign.id);
    await waitForCampaignStatus(campaign.id, 'COMPLETED');
  }

  // A drop and a return: the return is a reconnect, so the first send must wait
  // out the whole settle window even though every pacing gap is instant.
  push('DISCONNECTED');
  const firstReturnAtMs = Date.now();
  push('CONNECTED');
  await sendCampaign('one');
  assert.ok(sendTimes[0] - firstReturnAtMs >= 1900, `first send after reconnect fired ${sendTimes[0] - firstReturnAtMs}ms in; the settle window must gate it`);

  // A second drop and return draws the window again: sends may only resume
  // after the fresh settle, never on the strength of the previous one.
  push('DISCONNECTED');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const secondReturnAtMs = Date.now();
  push('CONNECTED');
  await sendCampaign('two');
  assert.ok(sendTimes[2] - secondReturnAtMs >= 1900, `first send after the second reconnect fired ${sendTimes[2] - secondReturnAtMs}ms in; the settle window must be re-drawn per reconnect`);
  assert.equal(sendTimes.length, 4);
});

test('circuit breaker pauses every running campaign after consecutive send failures and clears on run now', async () => {
  let failSends = true;
  const { fake } = controllableWhatsapp(async () => {
    if (failSends) throw new Error('Connection reset by peer');
    sentCalls.push({ jid: 'fake', content: {} });
  });
  const breakerService = new CampaignService(fake, loggerStub, 'main', {
    minSendGapSeconds: 0,
    sendGapSeconds: () => 0,
    warmupSeconds: () => 0,
    reconnectSettleMs: () => 0,
    dailyBudgetResetMs: () => 60_000,
    sendWindowDelayMs: () => 0,
  });
  sentCalls.length = 0;

  // Campaign A fails against a dead socket; campaign B is RUNNING too but has
  // nothing to send (its group is parked in cooldown), so B proves the trip
  // pauses the whole account, not just the failing campaign.
  const failingJids = Array.from({ length: 5 }, (_, index) => `breaker-a${index}-${randomUUID()}@g.us`);
  for (const jid of failingJids) await insertGroup(jid, `Breaker A ${jid}`);
  const jidB = `breaker-b-${randomUUID()}@g.us`;
  await insertGroup(jidB, 'Breaker B', { lastCampaignSentAt: new Date().toISOString() });

  const capturedA = await breakerService.captureManualSource({ text: 'Breaker probe A', label: 'Breaker A' });
  const campaignA = await breakerService.create({
    name: 'Breaker campaign A',
    // sourceMessageId: undefined — see the multi-file test for the rationale.
    sourceMessageId: undefined,
    sourceMessageIds: [capturedA.sources[0].id],
    groupJids: failingJids,
    schedule: { type: 'ONCE' },
    shuffleOrder: false,
  });
  const capturedB = await breakerService.captureManualSource({ text: 'Breaker probe B', label: 'Breaker B' });
  const campaignB = await breakerService.create({
    name: 'Breaker campaign B',
    // sourceMessageId: undefined — see the multi-file test for the rationale.
    sourceMessageId: undefined,
    sourceMessageIds: [capturedB.sources[0].id],
    groupJids: [jidB],
    schedule: { type: 'ONCE' },
    shuffleOrder: false,
  });

  await breakerService.runNow(campaignB.id);
  // B parks its only group in the frozen 18-48h cooldown and stays RUNNING.
  await waitForParkedTarget(campaignB.id);
  await breakerService.runNow(campaignA.id);
  await waitForBreakerPause(campaignA.id);
  await waitForBreakerPause(campaignB.id);

  assert.equal(sentCalls.length, 0, 'a dead connection must not deliver anything');
  assert.ok(breakerService.getCircuitWarning()?.includes('paused'), 'the account warning must be visible while the breaker is open');
  const [pausedB] = await db.select({ status: campaigns.status, pauseReason: campaigns.pauseReason }).from(campaigns).where(eq(campaigns.id, campaignB.id));
  assert.equal(pausedB.status, 'PAUSED', 'a parked campaign of the same account must be paused by the breaker too');
  assert.ok(pausedB.pauseReason?.includes('consecutive send failures'), 'the paused campaign must carry the frozen breaker reason');
  const failedRows = await db.select({ status: campaignTargets.status }).from(campaignTargets).where(eq(campaignTargets.campaignId, campaignA.id));
  assert.ok(failedRows.every((row) => row.status === 'FAILED') && failedRows.length === 5, `all five failing targets must be FAILED, got ${JSON.stringify(failedRows)}`);

  const tripLogs = await db.select({ level: operationalLogs.level }).from(operationalLogs)
    .where(eq(operationalLogs.event, 'campaign.auto_paused'));
  const breakerLogs = tripLogs.filter((row) => row.level === 'error');
  assert.equal(breakerLogs.length, 2, 'the trip must log one error row per paused campaign');

  // Recovery: a healthy connection and an operator Run now clears the breaker
  // (the warning disappears), without touching the other paused campaign.
  failSends = false;
  await breakerService.runNow(campaignA.id);
  assert.equal(breakerService.getCircuitWarning(), null, 'an operator Run now must clear the account warning');
  const [stillPausedB] = await db.select({ status: campaigns.status }).from(campaigns).where(eq(campaigns.id, campaignB.id));
  assert.equal(stillPausedB.status, 'PAUSED', 'running one campaign again must not resume the others');
});
