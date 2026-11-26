// Integration tests for JoinQueueService's enqueue/list/cancel/clear and the
// single-item join processor. Env vars must be set BEFORE anything that
// transitively loads config.js (db/client, db/bootstrap), so the libsql
// database lands in a unique temp file. The WhatsApp manager is stubbed —
// nothing is ever sent to a real WhatsApp account.

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = `/tmp/wa-joins-test-${process.pid}.db`;

const { bootstrapDatabase } = await import('../db/bootstrap.js');
const { db } = await import('../db/client.js');
const { JoinQueueService } = await import('./service.js');

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test, { after, before, mock } from 'node:test';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { joinQueue } from '../db/schema.js';
import type { WhatsAppManager } from '../whatsapp/manager.js';

const noop = () => {};
const loggerStub = { info: noop, error: noop, warn: noop, debug: noop, fatal: noop, trace: noop, silent: noop, child: noop } as unknown as FastifyBaseLogger;

type WhatsAppStub = WhatsAppManager & { joinGroup: (code: string) => Promise<string> };
function whatsappStub(state: 'CONNECTED' | 'DISCONNECTED' = 'CONNECTED', joinedCodes: string[] = []): WhatsAppStub {
  return {
    getStatus: () => ({ state, phone: null, lastConnectedAt: null, qrDataUrl: null, error: null }),
    getSocket: () => null,
    joinGroup: async (code: string) => {
      joinedCodes.push(code);
      return `${code}@g.us`;
    },
    subscribe: () => noop,
    subscribeGroupJoined: () => noop,
  } as unknown as WhatsAppStub;
}

before(async () => {
  await bootstrapDatabase();
});

after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${process.env.DATABASE_PATH}${suffix}`, { force: true });
  }
});

async function clearTables(): Promise<void> {
  await db.delete(joinQueue);
}

// Joins are gated to 06:00-23:00 East Africa Time. Pin the clock inside that
// window so the suite behaves the same at any hour it is run.
async function duringJoinWindow(run: () => Promise<void>): Promise<void> {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-06-15T09:00:00+03:00') });
  try {
    await run();
  } finally {
    mock.timers.reset();
  }
}

test('enqueue parses pasted text, normalises and dedupes links', async () => {
  await clearTables();
  const joinedCodes: string[] = [];
  const service = new JoinQueueService(whatsappStub('CONNECTED', joinedCodes), loggerStub);
  const result = await service.enqueue({ text: 'https://chat.whatsapp.com/AbcD_12345 and https://chat.whatsapp.com/AbcD_12345 and https://chat.whatsapp.com/Zyx987654 and https://evil.example/x' });
  assert.equal(result.added, 2);
  assert.equal(result.skipped, 0);
  assert.equal(result.queued, 2);
  const { items } = await service.list();
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.inviteCode).sort(), ['AbcD_12345', 'Zyx987654']);
});

test('enqueue skips links that are already queued', async () => {
  await clearTables();
  const service = new JoinQueueService(whatsappStub('CONNECTED'), loggerStub);
  const first = await service.enqueue({ links: ['https://chat.whatsapp.com/AbcD_12345'] });
  assert.equal(first.added, 1);
  const second = await service.enqueue({ links: ['https://chat.whatsapp.com/AbcD_12345'] });
  assert.equal(second.added, 0);
  assert.equal(second.skipped, 1);
});

test('processNextDue joins one due item and marks it JOINED', async () => {
  await duringJoinWindow(async () => {
    await clearTables();
    const joinedCodes: string[] = [];
    const service = new JoinQueueService(whatsappStub('CONNECTED', joinedCodes), loggerStub);
    await service.enqueue({ links: ['https://chat.whatsapp.com/AbcD_12345'] });
    await service.processNextDue();
    assert.deepEqual(joinedCodes, ['AbcD_12345']);
    const rows = await db.select().from(joinQueue).where(eq(joinQueue.inviteCode, 'AbcD_12345'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'JOINED');
    assert.equal(rows[0].groupJid, 'AbcD_12345@g.us');
    assert.ok(rows[0].joinedAt);
  });
});

test('processNextDue leaves items queued while the account is disconnected', async () => {
  await clearTables();
  const joinedCodes: string[] = [];
  const service = new JoinQueueService(whatsappStub('DISCONNECTED', joinedCodes), loggerStub);
  await service.enqueue({ links: ['https://chat.whatsapp.com/AbcD_12345'] });
  await service.processNextDue();
  assert.deepEqual(joinedCodes, []);
  const rows = await db.select().from(joinQueue).where(eq(joinQueue.inviteCode, 'AbcD_12345'));
  assert.equal(rows[0].status, 'QUEUED');
});

test('cancel and clear only affect queued rows', async () => {
  await clearTables();
  const service = new JoinQueueService(whatsappStub('CONNECTED'), loggerStub);
  await service.enqueue({ links: ['https://chat.whatsapp.com/AbcD_12345', 'https://chat.whatsapp.com/Zyx987654'] });
  const { items } = await service.list();
  const cancelled = await service.cancel(items[0].id);
  assert.equal(cancelled.status, 'CANCELLED');
  const removed = await service.clear();
  assert.equal(removed, 1);
});
