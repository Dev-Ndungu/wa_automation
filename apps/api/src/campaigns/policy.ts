export const MAX_CAMPAIGN_TARGETS = 10_000;
export const COOLDOWN_WARNING_MS = 60 * 60 * 1000;

export type TargetCandidate = {
  jid: string;
  lastCampaignSentAt: string | null;
};

export function validateExplicitTargets(groupJids: unknown): string[] {
  if (!Array.isArray(groupJids)) throw new Error('groupJids must be an array of explicitly selected group IDs.');
  const values = groupJids.map((value) => typeof value === 'string' ? value.trim() : '');
  if (values.length === 0) throw new Error('Select at least one target group.');
  if (values.length > MAX_CAMPAIGN_TARGETS) throw new Error(`A campaign can target at most ${MAX_CAMPAIGN_TARGETS} groups.`);
  if (values.some((jid) => !jid.endsWith('@g.us'))) throw new Error('Every target must be a WhatsApp group ID.');
  if (new Set(values).size !== values.length) throw new Error('Each target group can be selected only once.');
  return values;
}

export function validateIntervals(value: unknown): number[] {
  const rawValues = Array.isArray(value) ? value : [value ?? 0];
  if (rawValues.length === 0 || rawValues.length > 20) {
    throw new Error('Select between 1 and 20 sending intervals.');
  }
  const intervals = rawValues.map((interval) => typeof interval === 'number' ? interval : Number(interval));
  if (intervals.some((interval) => !Number.isInteger(interval) || interval < 0 || interval > 86_400)) {
    throw new Error('Each interval must be a whole number of seconds from 0 to 86400.');
  }
  return intervals;
}

export function validateDailyRunTime(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error('dailyRunTime must use 24-hour HH:MM format.');
  }
  return value;
}

export type CampaignSchedule =
  | { type: 'ONCE' }
  | { type: 'MINUTELY'; intervalMinutes: number }
  | { type: 'HOURLY'; intervalHours: number }
  | { type: 'DAILY'; time: string }
  | { type: 'EVERY_N_DAYS'; intervalDays: number; time: string }
  | { type: 'WEEKLY'; weekdays: number[]; time: string };

export function validateSchedule(value: unknown): CampaignSchedule {
  if (value === undefined || value === null) return { type: 'ONCE' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('schedule must be a valid schedule object.');
  const schedule = value as Record<string, unknown>;
  if (schedule.type === 'ONCE') return { type: 'ONCE' };
  if (schedule.type === 'MINUTELY') {
    const intervalMinutes = Number(schedule.intervalMinutes);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 10_080) throw new Error('Minute interval must be a whole number from 1 to 10080 minutes.');
    return { type: 'MINUTELY', intervalMinutes };
  }
  if (schedule.type === 'HOURLY') {
    const intervalHours = Number(schedule.intervalHours);
    if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 168) throw new Error('Hourly interval must be a whole number from 1 to 168 hours.');
    return { type: 'HOURLY', intervalHours };
  }
  const time = validateDailyRunTime(schedule.time);
  if (!time) throw new Error('A scheduled campaign needs a 24-hour start time.');
  if (schedule.type === 'DAILY') return { type: 'DAILY', time };
  if (schedule.type === 'EVERY_N_DAYS') {
    const intervalDays = Number(schedule.intervalDays);
    if (!Number.isInteger(intervalDays) || intervalDays < 2 || intervalDays > 365) throw new Error('Day interval must be a whole number from 2 to 365 days.');
    return { type: 'EVERY_N_DAYS', intervalDays, time };
  }
  if (schedule.type === 'WEEKLY') {
    if (!Array.isArray(schedule.weekdays) || schedule.weekdays.length === 0) throw new Error('Select at least one weekday.');
    const weekdays = schedule.weekdays.map(Number);
    if (weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6) || new Set(weekdays).size !== weekdays.length) {
      throw new Error('Weekdays must be unique values from 0 to 6.');
    }
    return { type: 'WEEKLY', weekdays: weekdays.sort((left, right) => left - right), time };
  }
  throw new Error('Choose a valid campaign schedule.');
}

export function cooldownWarnings(targets: TargetCandidate[], at = Date.now()): string[] {
  return targets.flatMap((target) => {
    if (!target.lastCampaignSentAt) return [];
    const elapsed = at - Date.parse(target.lastCampaignSentAt);
    if (!Number.isFinite(elapsed) || elapsed >= COOLDOWN_WARNING_MS) return [];
    const minutes = Math.ceil((COOLDOWN_WARNING_MS - elapsed) / 60_000);
    return [`${target.jid} received a campaign message recently; ${minutes} minute(s) remain in the local cooldown window.`];
  });
}

export function canDeliverTarget(status: string): boolean {
  // A durable SENT record is final: a restarted worker must never re-send it.
  return status === 'QUEUED' || status === 'WAITING';
}
