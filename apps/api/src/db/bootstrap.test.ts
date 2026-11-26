process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = `/tmp/wa-bootstrap-status-test-${process.pid}.db`;

const { bootstrapDatabase } = await import('./bootstrap.js');
const { db } = await import('./client.js');

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test, { after } from 'node:test';
import { sql } from 'drizzle-orm';

after(() => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${process.env.DATABASE_PATH}${suffix}`, { force: true });
});

test('bootstrap adds group-status columns and does not pause existing status campaigns', async () => {
  await bootstrapDatabase();
  const campaignColumns = await db.all<{ name: string }>(sql`PRAGMA table_info(campaigns)`);
  assert.ok(campaignColumns.some((column) => column.name === 'delivery_mode'));
  assert.ok(campaignColumns.some((column) => column.name === 'target_all_groups'));
  const groupColumns = await db.all<{ name: string }>(sql`PRAGMA table_info(groups)`);
  assert.ok(groupColumns.some((column) => column.name === 'last_status_sent_at'));

  const timestamp = new Date().toISOString();
  await db.run(sql`INSERT INTO source_messages (id, account_id, chat_jid, message_id, payload, preview, created_at)
    VALUES ('status-source', 'main', 'manual:status-source', 'manual:status-source', '{"text":"x"}', 'x', ${timestamp})`);
  await db.run(sql`INSERT INTO campaigns (id, account_id, name, source_message_reference, status, interval_seconds, delivery_mode, created_at)
    VALUES ('status-campaign', 'main', 'Status', 'status-source', 'RUNNING', 0, 'GROUP_STATUS', ${timestamp})`);
  await bootstrapDatabase();
  const [row] = await db.all<{ status: string }>(sql`SELECT status FROM campaigns WHERE id = 'status-campaign'`);
  assert.equal(row.status, 'RUNNING');
});
