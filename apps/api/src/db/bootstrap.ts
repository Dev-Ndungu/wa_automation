import { sql } from 'drizzle-orm';
import { db } from './client.js';

export async function bootstrapDatabase(): Promise<void> {
  await db.run(sql`PRAGMA foreign_keys = ON`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS admin_users (id text PRIMARY KEY NOT NULL, email text NOT NULL UNIQUE, password_hash text NOT NULL, created_at text NOT NULL, updated_at text NOT NULL)`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS sessions (id text PRIMARY KEY NOT NULL, user_id text NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE, csrf_token text NOT NULL, expires_at text NOT NULL, created_at text NOT NULL)`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS app_settings (key text PRIMARY KEY NOT NULL, value text NOT NULL, updated_at text NOT NULL)`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS groups (id text PRIMARY KEY NOT NULL, whatsapp_group_jid text NOT NULL UNIQUE, name text NOT NULL, description text, is_target integer NOT NULL DEFAULT false, is_scanner_enabled integer NOT NULL DEFAULT true, is_excluded integer NOT NULL DEFAULT false, last_campaign_sent_at text, last_synced_at text, created_at text NOT NULL, updated_at text NOT NULL)`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS discovered_links (id text PRIMARY KEY NOT NULL, invite_url text NOT NULL UNIQUE, invite_code text NOT NULL, source_group_jid text NOT NULL, source_group_name text NOT NULL, first_seen_at text NOT NULL, last_seen_at text NOT NULL, times_seen integer NOT NULL DEFAULT 1, source_message_id text, status text NOT NULL DEFAULT 'NEW', notes text)`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS link_occurrences (id text PRIMARY KEY NOT NULL, link_id text NOT NULL REFERENCES discovered_links(id) ON DELETE CASCADE, source_group_jid text NOT NULL, occurred_at text NOT NULL)`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS source_messages (id text PRIMARY KEY NOT NULL, chat_jid text NOT NULL, message_id text NOT NULL, payload text NOT NULL, preview text NOT NULL, created_at text NOT NULL, UNIQUE(chat_jid, message_id))`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS campaigns (id text PRIMARY KEY NOT NULL, name text NOT NULL, source_message_reference text NOT NULL REFERENCES source_messages(id), status text NOT NULL DEFAULT 'DRAFT', interval_seconds integer NOT NULL, created_at text NOT NULL, started_at text, completed_at text)`);
  const campaignColumns = await db.all<{ name: string }>(sql`PRAGMA table_info(campaigns)`);
  if (!campaignColumns.some((column) => column.name === 'interval_seconds_list')) {
    await db.run(sql`ALTER TABLE campaigns ADD COLUMN interval_seconds_list text NOT NULL DEFAULT '[0]'`);
  }
  if (!campaignColumns.some((column) => column.name === 'daily_run_time')) {
    await db.run(sql`ALTER TABLE campaigns ADD COLUMN daily_run_time text`);
  }
  if (!campaignColumns.some((column) => column.name === 'next_run_at')) {
    await db.run(sql`ALTER TABLE campaigns ADD COLUMN next_run_at text`);
  }
  if (!campaignColumns.some((column) => column.name === 'last_run_at')) {
    await db.run(sql`ALTER TABLE campaigns ADD COLUMN last_run_at text`);
  }
  if (!campaignColumns.some((column) => column.name === 'schedule_config')) {
    await db.run(sql`ALTER TABLE campaigns ADD COLUMN schedule_config text NOT NULL DEFAULT '{"type":"ONCE"}'`);
  }
  await db.run(sql`CREATE TABLE IF NOT EXISTS campaign_targets (id text PRIMARY KEY NOT NULL, campaign_id text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, group_jid text NOT NULL, group_name text NOT NULL, position integer NOT NULL, status text NOT NULL DEFAULT 'QUEUED', scheduled_at text, sent_at text, error_message text, attempt_count integer NOT NULL DEFAULT 0, UNIQUE(campaign_id, group_jid))`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS operational_logs (id text PRIMARY KEY NOT NULL, level text NOT NULL, event text NOT NULL, details text, created_at text NOT NULL)`);
}
