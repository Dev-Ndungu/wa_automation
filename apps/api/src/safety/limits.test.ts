// Unit tests for the pure safety-limit helpers only — no DB calls, no
// bootstrap. Env vars must be set BEFORE anything that transitively loads
// config.js (limits.ts imports db/client, which loads config at module scope),
// so the libsql client lands on a unique temp file for this process. The pure
// functions never touch the database, so the temp file is only ever created if
// a future DB-backed test runs here; after() removes it either way.

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = `/tmp/wa-control-safety-test-${process.pid}.db`;

const {
  burstJoinDenied,
  CAMPAIGN_WARMUP,
  dailyJoinDenied,
  drawCampaignWarmupSeconds,
  drawGroupCooldownMs,
  drawGroupGraceMs,
  drawSendGapSeconds,
  GROUP_COOLDOWN,
  JOIN_BURST,
  JOIN_DAILY_LIMIT,
  JOIN_PACING,
  NEW_GROUP_GRACE,
  requiredJoinDelaySeconds,
  SEND_GAP,
} = await import('./limits.js');

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test, { after } from 'node:test';

after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${process.env.DATABASE_PATH}${suffix}`, { force: true });
  }
});

/** Deterministic rng: yields the given values in order, then 0 forever. */
function sequence(...values: number[]): () => number {
  let index = 0;
  return () => values[index++] ?? 0;
}

test('requiredJoinDelaySeconds returns 0 when there is no last join', () => {
  assert.equal(requiredJoinDelaySeconds(null), 0);
});

test('requiredJoinDelaySeconds computes the remaining delay from the last join', () => {
  const lastJoinAt = new Date(Date.now() - 10_000).toISOString();
  // rng 0.5 -> target halfway between 60s and 180s = 120s, ~10s elapsed, ~110s remain.
  assert.equal(requiredJoinDelaySeconds(lastJoinAt, () => 0.5), 110);
  // rng 0 -> target 60s, ~10s elapsed, ~50s remain.
  assert.equal(requiredJoinDelaySeconds(lastJoinAt, () => 0), 50);
});

test('requiredJoinDelaySeconds returns 0 once the delay window has passed', () => {
  const lastJoinAt = new Date(Date.now() - 100_000).toISOString();
  // rng 0 -> the minimum 60s target is exhausted after 100s.
  assert.equal(requiredJoinDelaySeconds(lastJoinAt, () => 0), 0);
});

test('requiredJoinDelaySeconds stays within the frozen join pacing range', () => {
  const lastJoinAt = new Date().toISOString();
  assert.equal(requiredJoinDelaySeconds(lastJoinAt, () => 0), JOIN_PACING.minSeconds);
  assert.equal(requiredJoinDelaySeconds(lastJoinAt, () => 1), JOIN_PACING.maxSeconds);
});

test('burstJoinDenied flips exactly at the frozen burst limit', () => {
  assert.equal(burstJoinDenied(JOIN_BURST.limit - 1), false);
  assert.equal(burstJoinDenied(JOIN_BURST.limit), true);
  assert.equal(burstJoinDenied(JOIN_BURST.limit + 1), true);
});

test('dailyJoinDenied flips exactly at the frozen daily limit', () => {
  assert.equal(dailyJoinDenied(JOIN_DAILY_LIMIT - 1), false);
  assert.equal(dailyJoinDenied(JOIN_DAILY_LIMIT), true);
  assert.equal(dailyJoinDenied(JOIN_DAILY_LIMIT + 1), true);
});

test('drawSendGapSeconds draws whole seconds across the frozen 45-180s range', () => {
  assert.equal(drawSendGapSeconds(() => 0), SEND_GAP.minSeconds);
  // rng just below 1 must still land inside the inclusive range, not 181.
  assert.equal(drawSendGapSeconds(() => 0.99999), SEND_GAP.maxSeconds);
  assert.equal(drawSendGapSeconds(() => 1), SEND_GAP.maxSeconds);
  // Whole seconds only: two mid-range draws never produce a fractional gap.
  for (const value of [0.25, 0.5, 0.75]) {
    assert.equal(Number.isInteger(drawSendGapSeconds(() => value)), true);
  }
  // Mid-range draws stay strictly between the bounds.
  const sampled = drawSendGapSeconds(() => 0.5);
  assert.ok(sampled > SEND_GAP.minSeconds && sampled < SEND_GAP.maxSeconds, `middle draw ${sampled} must be strictly inside the range`);
});

test('drawCampaignWarmupSeconds draws whole seconds across the frozen 30-120s range', () => {
  assert.equal(drawCampaignWarmupSeconds(() => 0), CAMPAIGN_WARMUP.minSeconds);
  assert.equal(drawCampaignWarmupSeconds(() => 1), CAMPAIGN_WARMUP.maxSeconds);
  const sampled = drawCampaignWarmupSeconds(() => 0.5);
  assert.ok(sampled > CAMPAIGN_WARMUP.minSeconds && sampled < CAMPAIGN_WARMUP.maxSeconds);
});

test('drawGroupCooldownMs draws a duration across the frozen 12-36h range', () => {
  assert.equal(drawGroupCooldownMs(() => 0), GROUP_COOLDOWN.minHours * 3_600_000);
  // rng 1 - epsilon stays below the 36h ceiling.
  const max = drawGroupCooldownMs(() => 0.999999);
  assert.ok(max < GROUP_COOLDOWN.maxHours * 3_600_000, 'ceiling draw must stay below 36h');
  const sampled = drawGroupCooldownMs(() => 0.5);
  assert.ok(sampled > 12 * 3_600_000 && sampled < 36 * 3_600_000, 'mid draw must be inside the range');
});

test('drawGroupGraceMs draws a duration across the frozen 90-240 minute range', () => {
  assert.equal(drawGroupGraceMs(() => 0), NEW_GROUP_GRACE.minMinutes * 60_000);
  const sampled = drawGroupGraceMs(() => 0.5);
  assert.ok(sampled > 90 * 60_000 && sampled < 240 * 60_000, 'mid draw must be inside the range');
});
