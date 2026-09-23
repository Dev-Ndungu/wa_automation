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
  CIRCUIT_BREAKER_CONSECUTIVE_FAILURES,
  dailyJoinDenied,
  drawCampaignWarmupSeconds,
  drawGroupCooldownMs,
  drawGroupGraceMs,
  drawReconnectBackoffSeconds,
  drawReconnectSettleSeconds,
  drawSendGapSeconds,
  GROUP_COOLDOWN,
  JOIN_BURST,
  JOIN_DAILY_LIMIT,
  JOIN_PACING,
  NEW_GROUP_GRACE,
  RECONNECT_BACKOFF_TIERS,
  RECONNECT_SETTLE,
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
  // rng 0.5 -> target is the midpoint of JOIN_PACING, ~10s elapsed -> ~midpoint-10s remain.
  const midpoint = Math.round((JOIN_PACING.minSeconds + JOIN_PACING.maxSeconds) / 2);
  assert.equal(requiredJoinDelaySeconds(lastJoinAt, () => 0.5), midpoint - 10);
  // rng 0 -> target is the floor, ~10s elapsed -> ~floor-10s remain.
  assert.equal(requiredJoinDelaySeconds(lastJoinAt, () => 0), JOIN_PACING.minSeconds - 10);
});

test('requiredJoinDelaySeconds returns 0 once the delay window has passed', () => {
  const lastJoinAt = new Date(Date.now() - (JOIN_PACING.maxSeconds + 10) * 1_000).toISOString();
  // rng 0 -> even the longest target is exhausted after maxSeconds+10s.
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

test('drawSendGapSeconds draws whole seconds across the frozen send-gap range', () => {
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

test('drawGroupCooldownMs draws a duration across the frozen group cooldown range', () => {
  assert.equal(drawGroupCooldownMs(() => 0), GROUP_COOLDOWN.minHours * 3_600_000);
  // rng 1 - epsilon stays below the ceiling.
  const max = drawGroupCooldownMs(() => 0.999999);
  assert.ok(max < GROUP_COOLDOWN.maxHours * 3_600_000, 'ceiling draw must stay below the top of the range');
  const sampled = drawGroupCooldownMs(() => 0.5);
  assert.ok(sampled > GROUP_COOLDOWN.minHours * 3_600_000 && sampled < GROUP_COOLDOWN.maxHours * 3_600_000, 'mid draw must be inside the range');
});

test('drawGroupGraceMs draws a duration across the frozen new-group grace range', () => {
  assert.equal(drawGroupGraceMs(() => 0), NEW_GROUP_GRACE.minMinutes * 60_000);
  const sampled = drawGroupGraceMs(() => 0.5);
  assert.ok(sampled > NEW_GROUP_GRACE.minMinutes * 60_000 && sampled < NEW_GROUP_GRACE.maxMinutes * 60_000, 'mid draw must be inside the range');
});

test('drawReconnectBackoffSeconds draws each ladder rung across its own frozen range', () => {
  for (const [index, tier] of RECONNECT_BACKOFF_TIERS.entries()) {
    const streak = index + 1;
    assert.equal(drawReconnectBackoffSeconds(streak, () => 0), tier.minSeconds, `streak ${streak} floor`);
    assert.equal(drawReconnectBackoffSeconds(streak, () => 1), tier.maxSeconds, `streak ${streak} ceiling`);
    const sampled = drawReconnectBackoffSeconds(streak, () => 0.5);
    assert.ok(sampled !== null, `streak ${streak} is inside the ladder and must draw a wait`);
    assert.ok(sampled > tier.minSeconds && sampled < tier.maxSeconds, `streak ${streak} mid draw must be strictly inside the rung`);
  }
});

test('drawReconnectBackoffSeconds escalates monotonically with the streak', () => {
  // Every rung must be strictly wider and later than the one before it, so a
  // growing streak always means a growing wait.
  for (let index = 1; index < RECONNECT_BACKOFF_TIERS.length; index += 1) {
    const previous = RECONNECT_BACKOFF_TIERS[index - 1];
    const current = RECONNECT_BACKOFF_TIERS[index];
    assert.ok(current.minSeconds > previous.maxSeconds, `rung ${index + 1} must start after rung ${index} ends`);
  }
});

test('drawReconnectBackoffSeconds returns null once every rung is spent', () => {
  const spent = RECONNECT_BACKOFF_TIERS.length + 1;
  assert.equal(drawReconnectBackoffSeconds(spent, () => 0), null, `streak ${spent} must exhaust the ladder`);
  assert.equal(drawReconnectBackoffSeconds(99, () => 1), null, 'any streak beyond the ladder must also exhaust');
});

test('drawReconnectSettleSeconds draws whole seconds across the frozen 120-300s range', () => {
  assert.equal(drawReconnectSettleSeconds(() => 0), RECONNECT_SETTLE.minSeconds);
  assert.equal(drawReconnectSettleSeconds(() => 1), RECONNECT_SETTLE.maxSeconds);
  assert.equal(Number.isInteger(drawReconnectSettleSeconds(() => 0.5)), true);
  const sampled = drawReconnectSettleSeconds(() => 0.5);
  assert.ok(sampled > RECONNECT_SETTLE.minSeconds && sampled < RECONNECT_SETTLE.maxSeconds, `middle draw ${sampled} must be strictly inside the range`);
});

test('circuit breaker threshold is a positive frozen constant', () => {
  assert.equal(CIRCUIT_BREAKER_CONSECUTIVE_FAILURES, 5);
  assert.ok(Number.isInteger(CIRCUIT_BREAKER_CONSECUTIVE_FAILURES) && CIRCUIT_BREAKER_CONSECUTIVE_FAILURES > 0);
});
