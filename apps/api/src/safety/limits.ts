import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { actionLog } from '../db/schema.js';

/**
 * Anti-restriction pacing is built into this module and deliberately NOT
 * user-configurable: nothing here is stored or edited. Every delay is drawn
 * uniformly from a range (never a fixed value), so no interval or cooldown
 * ever repeats in a pattern WhatsApp could flag. These constants are the whole
 * policy — the database is only used to record what happened (action_log),
 * never to tune how fast things happen.
 */

/** Random wait between consecutive group joins. */
export const JOIN_PACING = { minSeconds: 120, maxSeconds: 300 };

/** Hard caps on joins: a burst window and a per-day total. */
export const JOIN_BURST = { limit: 2, windowMinutes: 180 };
export const JOIN_DAILY_LIMIT = 3;

/** Random wait between consecutive message sends, drawn per message. */
export const SEND_GAP = { minSeconds: 60, maxSeconds: 240 };

/** Random cooldown after a group received a campaign, drawn once per parking. */
export const GROUP_COOLDOWN = { minHours: 18, maxHours: 48 };

/** Random grace for a freshly joined group before its first campaign send. */
export const NEW_GROUP_GRACE = { minMinutes: 120, maxMinutes: 360 };

/** Random one-time warm-up when a campaign run starts. */
export const CAMPAIGN_WARMUP = { minSeconds: 30, maxSeconds: 120 };

/**
 * Hard cap on campaign sends per account per UTC day. Kept deliberately
 * conservative: sending to many groups every day is the classic restriction
 * trigger, and a fresh number has no reputation to spend.
 */
export const SEND_DAILY_LIMIT = 30;

/**
 * Reconnect ladder after a connection closes: each consecutive close draws a
 * fresh wait from the next, wider tier. The ladder has no final tier — when
 * every tier is spent the next close stops auto-reconnect entirely until a
 * human acts (see WhatsAppManager), so a restricted or rejected session can
 * never be hammered by automatic reconnect attempts.
 */
export const RECONNECT_BACKOFF_TIERS = [
  { minSeconds: 3, maxSeconds: 10 },
  { minSeconds: 15, maxSeconds: 45 },
  { minSeconds: 60, maxSeconds: 180 },
  { minSeconds: 300, maxSeconds: 900 },
];

/** Random quiet window after a connection comes back, before any send resumes. */
export const RECONNECT_SETTLE = { minSeconds: 120, maxSeconds: 300 };

/** Consecutive failed sends that pause every running campaign of the account. */
export const CIRCUIT_BREAKER_CONSECUTIVE_FAILURES = 5;

const timestamp = (): string => new Date().toISOString();

/** Whole seconds drawn uniformly from the inclusive range [min, max]. */
function drawInteger(min: number, max: number, rng: () => number): number {
  return Math.min(max, min + Math.floor(rng() * (max - min + 1)));
}

/** Seconds to wait before the next join: the random target delay minus time since the last join, floored at 0. */
export function requiredJoinDelaySeconds(lastJoinAt: string | null, rng: () => number = Math.random): number {
  if (lastJoinAt === null) return 0;
  const target = JOIN_PACING.minSeconds + (JOIN_PACING.maxSeconds - JOIN_PACING.minSeconds) * rng();
  const elapsedSeconds = (Date.now() - Date.parse(lastJoinAt)) / 1000;
  return Math.max(0, Math.round(target - elapsedSeconds));
}

/** True when the number of joins in the current burst window has reached the burst limit. */
export function burstJoinDenied(joinsInWindowCount: number): boolean {
  return joinsInWindowCount >= JOIN_BURST.limit;
}

/** True when the number of joins today has reached the daily limit. */
export function dailyJoinDenied(joinsTodayCount: number): boolean {
  return joinsTodayCount >= JOIN_DAILY_LIMIT;
}

/** Uniform whole-second gap between two consecutive message sends, from SEND_GAP. */
export function drawSendGapSeconds(rng: () => number = Math.random): number {
  return drawInteger(SEND_GAP.minSeconds, SEND_GAP.maxSeconds, rng);
}

/** Uniform whole-second one-time campaign warm-up, from CAMPAIGN_WARMUP. */
export function drawCampaignWarmupSeconds(rng: () => number = Math.random): number {
  return drawInteger(CAMPAIGN_WARMUP.minSeconds, CAMPAIGN_WARMUP.maxSeconds, rng);
}

/** Uniform group cooldown in milliseconds, from GROUP_COOLDOWN hours. */
export function drawGroupCooldownMs(rng: () => number = Math.random): number {
  const hours = GROUP_COOLDOWN.minHours + rng() * (GROUP_COOLDOWN.maxHours - GROUP_COOLDOWN.minHours);
  return Math.floor(hours * 3_600_000);
}

/** Uniform new-group grace period in milliseconds, from NEW_GROUP_GRACE minutes. */
export function drawGroupGraceMs(rng: () => number = Math.random): number {
  const minutes = NEW_GROUP_GRACE.minMinutes + rng() * (NEW_GROUP_GRACE.maxMinutes - NEW_GROUP_GRACE.minMinutes);
  return Math.floor(minutes * 60_000);
}

/**
 * Seconds to wait before the streak-th consecutive reconnection attempt, drawn
 * from the matching ladder tier. Returns null once every tier is spent, which
 * tells the caller to stop auto-reconnecting (streak is 1-based: the first
 * close draws from tier 0).
 */
export function drawReconnectBackoffSeconds(streak: number, rng: () => number = Math.random): number | null {
  const tier = RECONNECT_BACKOFF_TIERS[streak - 1];
  if (!tier) return null;
  return drawInteger(tier.minSeconds, tier.maxSeconds, rng);
}

/** Uniform whole-second quiet window after a reconnect, from RECONNECT_SETTLE. */
export function drawReconnectSettleSeconds(rng: () => number = Math.random): number {
  return drawInteger(RECONNECT_SETTLE.minSeconds, RECONNECT_SETTLE.maxSeconds, rng);
}

/** Record a group join in action_log. groupJid is accepted for future use; action_log has no group column. */
export async function recordJoin(accountId: string, groupJid: string): Promise<void> {
  void groupJid;
  await db.insert(actionLog).values({ id: randomUUID(), accountId, action: 'JOIN', createdAt: timestamp() });
}

/** Record a send in action_log. */
export async function recordSend(accountId: string): Promise<void> {
  await db.insert(actionLog).values({ id: randomUUID(), accountId, action: 'SEND', createdAt: timestamp() });
}

/** Number of JOIN rows for the account in the last windowMs milliseconds. */
export async function joinsInWindow(accountId: string, windowMs: number): Promise<number> {
  const since = new Date(Date.now() - windowMs).toISOString();
  const [row] = await db.select({ count: sql<number>`count(*)` })
    .from(actionLog)
    .where(and(eq(actionLog.accountId, accountId), eq(actionLog.action, 'JOIN'), gte(actionLog.createdAt, since)));
  return Number(row?.count ?? 0);
}

async function countActionsToday(accountId: string, action: 'JOIN' | 'SEND'): Promise<number> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const startIso = start.toISOString();
  const [row] = await db.select({ count: sql<number>`count(*)` })
    .from(actionLog)
    .where(and(eq(actionLog.accountId, accountId), eq(actionLog.action, action), gte(actionLog.createdAt, startIso)));
  return Number(row?.count ?? 0);
}

/** Number of JOIN rows for the account since the start of the current UTC day. */
export async function joinsToday(accountId: string): Promise<number> {
  return countActionsToday(accountId, 'JOIN');
}

/** Number of SEND rows for the account since the start of the current UTC day. */
export async function sendsToday(accountId: string): Promise<number> {
  return countActionsToday(accountId, 'SEND');
}

/** createdAt of the account's newest JOIN row, or null when there is none. */
export async function lastJoinAt(accountId: string): Promise<string | null> {
  const [row] = await db.select({ createdAt: actionLog.createdAt })
    .from(actionLog)
    .where(and(eq(actionLog.accountId, accountId), eq(actionLog.action, 'JOIN')))
    .orderBy(desc(actionLog.createdAt))
    .limit(1);
  return row?.createdAt ?? null;
}
