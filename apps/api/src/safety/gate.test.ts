// Integration tests for the safety gate's DB-backed counting functions and the
// pure denial helpers evaluated against real DB counts. Env vars must be set
// BEFORE anything that transitively loads config.js (db/client, db/bootstrap,
// safety/limits), so the libsql database lands in a unique temp file for this
// process. Rows are inserted directly into action_log and app_settings — no
// WhatsApp socket or manager is involved.

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = `/tmp/wa-safety-test-${process.pid}.db`;

const { bootstrapDatabase } = await import('../db/bootstrap.js');
const { db } = await import('../db/client.js');
const { burstJoinDenied, dailyJoinDenied, JOIN_BURST, JOIN_DAILY_LIMIT, joinsInWindow, joinsToday, lastJoinAt, sendsToday } = await import('../safety/limits.js');

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import test, { after, before } from 'node:test';
import { eq, inArray, sql } from 'drizzle-orm';
import { actionLog, appSettings } from '../db/schema.js';

before(async () => {
  await bootstrapDatabase();
});

after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${process.env.DATABASE_PATH}${suffix}`, { force: true });
  }
});

async function insertAction(action: 'JOIN' | 'SEND', createdAt: string, id = randomUUID()): Promise<string> {
  await db.insert(actionLog).values({ id, accountId: 'main', action, createdAt });
  return id;
}

// Every test starts from an empty action_log and app_settings so counts are
// deterministic regardless of test order.
async function clearTables(): Promise<void> {
  await db.delete(actionLog);
  await db.delete(appSettings);
}

test('joinsInWindow counts JOIN rows inside the window and ignores SEND rows', async () => {
  await clearTables();
  const nowIso = new Date().toISOString();
  const twoHoursAgoIso = new Date(Date.now() - 2 * 3_600_000).toISOString();
  await insertAction('JOIN', nowIso);
  await insertAction('JOIN', twoHoursAgoIso);
  await insertAction('SEND', nowIso);

  assert.equal(await joinsInWindow('main', 60 * 60_000), 1, '60-minute window must count only the fresh JOIN (SEND rows must not count)');
  assert.equal(await joinsInWindow('main', 3 * 3_600_000), 2, '3-hour window must count both JOIN rows');
});

test('joinsToday and sendsToday count only rows from the current UTC day and only their own action', async () => {
  await clearTables();
  const nowIso = new Date().toISOString();
  await insertAction('JOIN', nowIso);
  await insertAction('JOIN', '2020-01-01T00:00:00.000Z');
  await insertAction('SEND', nowIso);

  assert.equal(await joinsToday('main'), 1, 'the 2020 JOIN row is outside today and must not count');
  assert.equal(await sendsToday('main'), 1, 'only the SEND row counts toward sendsToday');
});

test('lastJoinAt returns the newest JOIN row createdAt', async () => {
  await clearTables();
  const nowIso = new Date().toISOString();
  const tenMinutesAgoIso = new Date(Date.now() - 10 * 60_000).toISOString();
  await insertAction('JOIN', tenMinutesAgoIso);
  await insertAction('JOIN', nowIso);

  assert.equal(await lastJoinAt('main'), nowIso, 'the newest JOIN row wins');
});

test('burst and daily denial thresholds compare DB counts against the frozen limits', async () => {
  await clearTables();
  const nowIso = new Date().toISOString();
  const inserted: string[] = [];
  for (let index = 0; index < JOIN_DAILY_LIMIT; index += 1) {
    inserted.push(await insertAction('JOIN', nowIso));
  }

  assert.equal(burstJoinDenied(await joinsInWindow('main', JOIN_BURST.windowMinutes * 60_000)), true, `${JOIN_BURST.limit} joins in the window reach the frozen burst limit`);
  assert.equal(dailyJoinDenied(await joinsToday('main')), true, `${JOIN_DAILY_LIMIT} joins today reach the frozen daily limit`);

  // Drop back under both limits: leave JOIN_BURST.limit - 1 joins in the
  // window (below the burst limit), which is also below the daily limit.
  const keepInWindow = JOIN_BURST.limit - 1;
  await db.delete(actionLog).where(inArray(actionLog.id, inserted.slice(keepInWindow)));
  assert.equal(burstJoinDenied(await joinsInWindow('main', JOIN_BURST.windowMinutes * 60_000)), false, `${keepInWindow} joins in the window are below the frozen burst limit`);
  assert.equal(dailyJoinDenied(await joinsToday('main')), false, `${keepInWindow} joins today are below the frozen daily limit`);
});

test('bootstrap removes legacy per-account safety settings rows', async () => {
  await clearTables();
  const updatedAt = new Date().toISOString();
  await db.insert(appSettings).values([
    { key: 'main.safety.minSendDelaySeconds', value: '0', updatedAt },
    { key: 'main.safety.sendDailyLimit', value: '100000', updatedAt },
    { key: 'other.safety.campaignWarmupSeconds', value: '0', updatedAt },
  ]);
  await db.insert(appSettings).values({ key: 'main.scanner.enabled', value: 'true', updatedAt });

  await bootstrapDatabase();

  const remaining = await db.all<{ key: string }>(sql`SELECT key FROM app_settings ORDER BY key`);
  const keys = remaining.map((row) => row.key);
  assert.deepEqual(keys, ['main.scanner.enabled'], 'only non-safety settings survive a bootstrap');
});
