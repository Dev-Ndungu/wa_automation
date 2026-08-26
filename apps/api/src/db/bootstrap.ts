import { sql } from 'drizzle-orm';
import { db } from './client.js';

const MAIN_ACCOUNT_ID = 'main';

async function hasColumn(table: string, column: string): Promise<boolean> {
  const columns = await db.all<{ name: string }>(sql.raw(`PRAGMA table_info(${table})`));
  return columns.some((entry) => entry.name === column);
}

/** Convert the original one-account tables into account-scoped tables once. */
async function migrateAccountScopes(): Promise<void> {
  if (!(await hasColumn('groups', 'id'))) return;
  if (await hasColumn('groups', 'account_id')) return;
  await db.run(sql`PRAGMA foreign_keys = OFF`);
  try {
    await db.run(sql`CREATE TABLE groups_account_migration (id text PRIMARY KEY NOT NULL, account_id text NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE, whatsapp_group_jid text NOT NULL, name text NOT NULL, description text, is_target integer NOT NULL DEFAULT false, is_scanner_enabled integer NOT NULL DEFAULT true, is_excluded integer NOT NULL DEFAULT false, last_campaign_sent_at text, last_synced_at text, created_at text NOT NULL, updated_at text NOT NULL, UNIQUE(account_id, whatsapp_group_jid))`);
    await db.run(sql`INSERT INTO groups_account_migration SELECT id, ${MAIN_ACCOUNT_ID}, whatsapp_group_jid, name, description, is_target, is_scanner_enabled, is_excluded, last_campaign_sent_at, last_synced_at, created_at, updated_at FROM groups`);
    await db.run(sql`DROP TABLE groups`);
    await db.run(sql`ALTER TABLE groups_account_migration RENAME TO groups`);

    await db.run(sql`CREATE TABLE discovered_links_account_migration (id text PRIMARY KEY NOT NULL, account_id text NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE, invite_url text NOT NULL, invite_code text NOT NULL, source_group_jid text NOT NULL, source_group_name text NOT NULL, first_seen_at text NOT NULL, last_seen_at text NOT NULL, times_seen integer NOT NULL DEFAULT 1, source_message_id text, status text NOT NULL DEFAULT 'NEW', notes text, UNIQUE(account_id, invite_url))`);
    await db.run(sql`INSERT INTO discovered_links_account_migration SELECT id, ${MAIN_ACCOUNT_ID}, invite_url, invite_code, source_group_jid, source_group_name, first_seen_at, last_seen_at, times_seen, source_message_id, status, notes FROM discovered_links`);
    await db.run(sql`DROP TABLE discovered_links`);
    await db.run(sql`ALTER TABLE discovered_links_account_migration RENAME TO discovered_links`);

    await db.run(sql`CREATE TABLE source_messages_account_migration (id text PRIMARY KEY NOT NULL, account_id text NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE, chat_jid text NOT NULL, message_id text NOT NULL, payload text NOT NULL, preview text NOT NULL, created_at text NOT NULL, UNIQUE(account_id, chat_jid, message_id))`);
    await db.run(sql`INSERT INTO source_messages_account_migration SELECT id, ${MAIN_ACCOUNT_ID}, chat_jid, message_id, payload, preview, created_at FROM source_messages`);
    await db.run(sql`DROP TABLE source_messages`);
    await db.run(sql`ALTER TABLE source_messages_account_migration RENAME TO source_messages`);

    await db.run(sql`CREATE TABLE campaigns_account_migration (id text PRIMARY KEY NOT NULL, account_id text NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE, name text NOT NULL, source_message_reference text NOT NULL REFERENCES source_messages(id), status text NOT NULL DEFAULT 'DRAFT', interval_seconds integer NOT NULL, interval_seconds_list text NOT NULL DEFAULT '[0]', daily_run_time text, next_run_at text, last_run_at text, schedule_config text NOT NULL DEFAULT '{"type":"ONCE"}', created_at text NOT NULL, started_at text, completed_at text)`);
    await db.run(sql`INSERT INTO campaigns_account_migration SELECT id, ${MAIN_ACCOUNT_ID}, name, source_message_reference, status, interval_seconds, interval_seconds_list, daily_run_time, next_run_at, last_run_at, schedule_config, created_at, started_at, completed_at FROM campaigns`);
    await db.run(sql`DROP TABLE campaigns`);
    await db.run(sql`ALTER TABLE campaigns_account_migration RENAME TO campaigns`);
  } finally {
    await db.run(sql`PRAGMA foreign_keys = ON`);
  }
}

export async function bootstrapDatabase(): Promise<void> {
  await db.run(sql`PRAGMA foreign_keys = ON`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS admin_users (id text PRIMARY KEY NOT NULL, email text NOT NULL UNIQUE, password_hash text NOT NULL, created_at text NOT NULL, updated_at text NOT NULL)`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS sessions (id text PRIMARY KEY NOT NULL, user_id text NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE, csrf_token text NOT NULL, expires_at text NOT NULL, created_at text NOT NULL)`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS app_settings (key text PRIMARY KEY NOT NULL, value text NOT NULL, updated_at text NOT NULL)`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS whatsapp_accounts (id text PRIMARY KEY NOT NULL, name text NOT NULL UNIQUE, phone text, created_at text NOT NULL, updated_at text NOT NULL)`);
  const createdAt = new Date().toISOString();
  await db.run(sql`INSERT OR IGNORE INTO whatsapp_accounts (id, name, phone, created_at, updated_at) VALUES (${MAIN_ACCOUNT_ID}, 'Main account', NULL, ${createdAt}, ${createdAt})`);
  // Preserve the previous one-account scanner preferences inside Main account.
  for (const key of ['scanner.enabled', 'scanner.autoJoinEnabled']) {
    const [setting] = await db.all<{ value: string }>(sql`SELECT value FROM app_settings WHERE key = ${key} LIMIT 1`);
    if (setting) await db.run(sql`INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (${`main.${key}`}, ${setting.value}, ${createdAt})`);
  }
  await migrateAccountScopes();
  await db.run(sql`CREATE TABLE IF NOT EXISTS groups (id text PRIMARY KEY NOT NULL, account_id text NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE, whatsapp_group_jid text NOT NULL, name text NOT NULL, description text, is_target integer NOT NULL DEFAULT false, is_scanner_enabled integer NOT NULL DEFAULT true, is_excluded integer NOT NULL DEFAULT false, last_campaign_sent_at text, last_synced_at text, created_at text NOT NULL, updated_at text NOT NULL, UNIQUE(account_id, whatsapp_group_jid))`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS discovered_links (id text PRIMARY KEY NOT NULL, account_id text NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE, invite_url text NOT NULL, invite_code text NOT NULL, source_group_jid text NOT NULL, source_group_name text NOT NULL, first_seen_at text NOT NULL, last_seen_at text NOT NULL, times_seen integer NOT NULL DEFAULT 1, source_message_id text, status text NOT NULL DEFAULT 'NEW', notes text, UNIQUE(account_id, invite_url))`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS link_occurrences (id text PRIMARY KEY NOT NULL, link_id text NOT NULL REFERENCES discovered_links(id) ON DELETE CASCADE, source_group_jid text NOT NULL, occurred_at text NOT NULL)`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS source_messages (id text PRIMARY KEY NOT NULL, account_id text NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE, chat_jid text NOT NULL, message_id text NOT NULL, payload text NOT NULL, preview text NOT NULL, created_at text NOT NULL, UNIQUE(account_id, chat_jid, message_id))`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS campaigns (id text PRIMARY KEY NOT NULL, account_id text NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE, name text NOT NULL, source_message_reference text NOT NULL REFERENCES source_messages(id), status text NOT NULL DEFAULT 'DRAFT', interval_seconds integer NOT NULL, created_at text NOT NULL, started_at text, completed_at text)`);
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
  if (!campaignColumns.some((column) => column.name === 'auto_add_joined_groups')) {
    await db.run(sql`ALTER TABLE campaigns ADD COLUMN auto_add_joined_groups integer NOT NULL DEFAULT false`);
  }
  await db.run(sql`CREATE TABLE IF NOT EXISTS campaign_targets (id text PRIMARY KEY NOT NULL, campaign_id text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, group_jid text NOT NULL, group_name text NOT NULL, position integer NOT NULL, status text NOT NULL DEFAULT 'QUEUED', scheduled_at text, sent_at text, error_message text, attempt_count integer NOT NULL DEFAULT 0, UNIQUE(campaign_id, group_jid))`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS operational_logs (id text PRIMARY KEY NOT NULL, level text NOT NULL, event text NOT NULL, details text, created_at text NOT NULL)`);
}
