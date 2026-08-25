import assert from 'node:assert/strict';
import test from 'node:test';
import { canDeliverTarget, cooldownWarnings, MAX_CAMPAIGN_TARGETS, validateDailyRunTime, validateExplicitTargets, validateIntervals, validateSchedule } from './policy.js';

test('explicit targets are capped, unique, and group-only', () => {
  assert.deepEqual(validateExplicitTargets(['one@g.us', 'two@g.us']), ['one@g.us', 'two@g.us']);
  assert.throws(() => validateExplicitTargets([]));
  assert.throws(() => validateExplicitTargets(['one@g.us', 'one@g.us']));
  assert.throws(() => validateExplicitTargets(['person@s.whatsapp.net']));
  assert.throws(() => validateExplicitTargets(Array.from({ length: MAX_CAMPAIGN_TARGETS + 1 }, (_, index) => `${index}@g.us`)));
});

test('cooldown is informational and only applies inside the window', () => {
  const at = Date.parse('2026-08-21T12:00:00.000Z');
  assert.equal(cooldownWarnings([{ jid: 'recent@g.us', lastCampaignSentAt: '2026-08-21T11:30:00.000Z' }], at).length, 1);
  assert.equal(cooldownWarnings([{ jid: 'old@g.us', lastCampaignSentAt: '2026-08-21T10:00:00.000Z' }], at).length, 0);
});

test('a recorded send cannot be delivered again', () => {
  assert.equal(canDeliverTarget('QUEUED'), true);
  assert.equal(canDeliverTarget('WAITING'), true);
  assert.equal(canDeliverTarget('SENT'), false);
  assert.equal(canDeliverTarget('SENDING'), false);
});

test('multiple sending intervals are valid, bounded, and retain their order', () => {
  assert.deepEqual(validateIntervals([30, 60, 120]), [30, 60, 120]);
  assert.deepEqual(validateIntervals(60), [60]);
  assert.throws(() => validateIntervals([]));
  assert.throws(() => validateIntervals([-1]));
  assert.throws(() => validateIntervals([30.5]));
});

test('daily schedule time uses a valid 24-hour clock value', () => {
  assert.equal(validateDailyRunTime('17:00'), '17:00');
  assert.equal(validateDailyRunTime(undefined), null);
  assert.throws(() => validateDailyRunTime('5pm'));
  assert.throws(() => validateDailyRunTime('25:00'));
});

test('schedule choices preserve their validated configuration', () => {
  assert.deepEqual(validateSchedule({ type: 'ONCE' }), { type: 'ONCE' });
  assert.deepEqual(validateSchedule({ type: 'HOURLY', intervalHours: 3 }), { type: 'HOURLY', intervalHours: 3 });
  assert.deepEqual(validateSchedule({ type: 'EVERY_N_DAYS', intervalDays: 3, time: '17:00' }), { type: 'EVERY_N_DAYS', intervalDays: 3, time: '17:00' });
  assert.deepEqual(validateSchedule({ type: 'WEEKLY', weekdays: [5, 1], time: '09:00' }), { type: 'WEEKLY', weekdays: [1, 5], time: '09:00' });
  assert.throws(() => validateSchedule({ type: 'WEEKLY', weekdays: [], time: '09:00' }));
});
