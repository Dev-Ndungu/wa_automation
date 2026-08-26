import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const timestamps = {
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
};

export const adminUsers = sqliteTable('admin_users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  ...timestamps,
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => adminUsers.id, { onDelete: 'cascade' }),
  csrfToken: text('csrf_token').notNull(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull(),
});

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const whatsappAccounts = sqliteTable('whatsapp_accounts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  phone: text('phone'),
  ...timestamps,
}, (table) => [uniqueIndex('whatsapp_accounts_name').on(table.name)]);

export const groups = sqliteTable('groups', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => whatsappAccounts.id, { onDelete: 'cascade' }),
  whatsappGroupJid: text('whatsapp_group_jid').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  isTarget: integer('is_target', { mode: 'boolean' }).notNull().default(false),
  isScannerEnabled: integer('is_scanner_enabled', { mode: 'boolean' }).notNull().default(true),
  isExcluded: integer('is_excluded', { mode: 'boolean' }).notNull().default(false),
  lastCampaignSentAt: text('last_campaign_sent_at'),
  lastSyncedAt: text('last_synced_at'),
  ...timestamps,
}, (table) => [uniqueIndex('groups_account_jid').on(table.accountId, table.whatsappGroupJid)]);

export const discoveredLinks = sqliteTable('discovered_links', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => whatsappAccounts.id, { onDelete: 'cascade' }),
  inviteUrl: text('invite_url').notNull(),
  inviteCode: text('invite_code').notNull(),
  sourceGroupJid: text('source_group_jid').notNull(),
  sourceGroupName: text('source_group_name').notNull(),
  firstSeenAt: text('first_seen_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
  timesSeen: integer('times_seen').notNull().default(1),
  sourceMessageId: text('source_message_id'),
  status: text('status', { enum: ['NEW', 'VIEWED', 'USED', 'ARCHIVED'] }).notNull().default('NEW'),
  notes: text('notes'),
}, (table) => [uniqueIndex('discovered_links_account_url').on(table.accountId, table.inviteUrl)]);

export const linkOccurrences = sqliteTable('link_occurrences', {
  id: text('id').primaryKey(),
  linkId: text('link_id').notNull().references(() => discoveredLinks.id, { onDelete: 'cascade' }),
  sourceGroupJid: text('source_group_jid').notNull(),
  occurredAt: text('occurred_at').notNull(),
});

export const sourceMessages = sqliteTable('source_messages', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => whatsappAccounts.id, { onDelete: 'cascade' }),
  chatJid: text('chat_jid').notNull(),
  messageId: text('message_id').notNull(),
  payload: text('payload').notNull(),
  preview: text('preview').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [uniqueIndex('source_messages_account_message_ref').on(table.accountId, table.chatJid, table.messageId)]);

export const campaigns = sqliteTable('campaigns', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => whatsappAccounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  sourceMessageReference: text('source_message_reference').notNull().references(() => sourceMessages.id),
  status: text('status', { enum: ['DRAFT', 'QUEUED', 'RUNNING', 'PAUSED', 'COMPLETED', 'STOPPED', 'FAILED'] }).notNull().default('DRAFT'),
  intervalSeconds: integer('interval_seconds').notNull(),
  intervalSecondsList: text('interval_seconds_list').notNull().default('[0]'),
  dailyRunTime: text('daily_run_time'),
  nextRunAt: text('next_run_at'),
  lastRunAt: text('last_run_at'),
  scheduleConfig: text('schedule_config').notNull().default('{"type":"ONCE"}'),
  autoAddJoinedGroups: integer('auto_add_joined_groups', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
});

export const campaignTargets = sqliteTable('campaign_targets', {
  id: text('id').primaryKey(),
  campaignId: text('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  groupJid: text('group_jid').notNull(),
  groupName: text('group_name').notNull(),
  position: integer('position').notNull(),
  status: text('status', { enum: ['QUEUED', 'WAITING', 'SENDING', 'SENT', 'FAILED', 'CANCELLED'] }).notNull().default('QUEUED'),
  scheduledAt: text('scheduled_at'),
  sentAt: text('sent_at'),
  errorMessage: text('error_message'),
  attemptCount: integer('attempt_count').notNull().default(0),
}, (table) => [
  uniqueIndex('campaign_targets_campaign_group').on(table.campaignId, table.groupJid),
  uniqueIndex('campaign_targets_sent_group').on(table.campaignId, table.groupJid, table.status),
]);

export const operationalLogs = sqliteTable('operational_logs', {
  id: text('id').primaryKey(),
  level: text('level').notNull(),
  event: text('event').notNull(),
  details: text('details'),
  createdAt: text('created_at').notNull(),
});
