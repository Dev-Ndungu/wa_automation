import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { db } from '../db/client.js';
import { campaignTargets, campaigns, groups, sourceMessages } from '../db/schema.js';
import type { WhatsAppManager } from '../whatsapp/manager.js';
import { canDeliverTarget, cooldownWarnings, type CampaignSchedule, validateExplicitTargets, validateIntervals, validateSchedule } from './policy.js';

const now = () => new Date().toISOString();
const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

type CampaignStatus = 'DRAFT' | 'QUEUED' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'STOPPED' | 'FAILED';

export type ManualSourceInput = { text: unknown; label?: unknown; imageDataUrl?: unknown };
export type CampaignInput = { name: unknown; sourceMessageId: unknown; groupJids: unknown; intervalSeconds?: unknown; schedule?: unknown; dailyRunTime?: unknown };

function validText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maxLength) {
    throw new Error(`${field} must be between 1 and ${maxLength} characters.`);
  }
  return value.trim();
}

function intervalsFrom(value: unknown): number[] {
  return validateIntervals(value);
}

function storedIntervals(value: string, fallback: number): number[] {
  try {
    return validateIntervals(JSON.parse(value));
  } catch {
    return validateIntervals(fallback);
  }
}

function nextRunAtForTime(time: string, from: Date, daysAhead = 0): Date {
  const [hours, minutes] = time.split(':').map(Number);
  const scheduled = new Date(from);
  scheduled.setHours(hours, minutes, 0, 0);
  if (scheduled.getTime() <= from.getTime()) scheduled.setDate(scheduled.getDate() + 1 + daysAhead);
  else if (daysAhead > 0) scheduled.setDate(scheduled.getDate() + daysAhead);
  return scheduled;
}

function storedSchedule(value: string, legacyDailyRunTime: string | null): CampaignSchedule {
  try {
    const schedule = validateSchedule(JSON.parse(value));
    if (schedule.type !== 'ONCE' || !legacyDailyRunTime) return schedule;
  } catch { /* A legacy daily schedule is recovered below. */ }
  return legacyDailyRunTime ? validateSchedule({ type: 'DAILY', time: legacyDailyRunTime }) : { type: 'ONCE' };
}

function nextScheduledRunAt(schedule: CampaignSchedule, from = new Date()): string | null {
  if (schedule.type === 'ONCE') return null;
  if (schedule.type === 'MINUTELY') return new Date(from.getTime() + schedule.intervalMinutes * 60 * 1_000).toISOString();
  if (schedule.type === 'HOURLY') return new Date(from.getTime() + schedule.intervalHours * 60 * 60 * 1_000).toISOString();
  if (schedule.type === 'DAILY') return nextRunAtForTime(schedule.time, from).toISOString();
  if (schedule.type === 'EVERY_N_DAYS') return nextRunAtForTime(schedule.time, from, schedule.intervalDays - 1).toISOString();
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(from);
    candidate.setDate(candidate.getDate() + offset);
    const [hours, minutes] = schedule.time.split(':').map(Number);
    candidate.setHours(hours, minutes, 0, 0);
    if (schedule.weekdays.includes(candidate.getDay()) && candidate.getTime() > from.getTime()) return candidate.toISOString();
  }
  throw new Error('Unable to calculate the next weekly run.');
}

export class CampaignService {
  private workers = new Map<string, Promise<void>>();
  private workerWakeups = new Map<string, () => void>();

  public constructor(private readonly whatsapp: WhatsAppManager, private readonly logger: FastifyBaseLogger) {
    this.whatsapp.subscribe((status) => {
      if (status.state === 'CONNECTED') void this.resumeRunningWorkers();
    });
  }

  public async captureManualSource(input: ManualSourceInput) {
    const text = validText(input.text, 'text', 4096);
    const label = input.label === undefined ? 'Manual message' : validText(input.label, 'label', 120);
    const imageDataUrl = typeof input.imageDataUrl === 'string' ? input.imageDataUrl : undefined;
    if (imageDataUrl && (!/^data:image\/(png|jpe?g|webp);base64,/.test(imageDataUrl) || imageDataUrl.length > 6_000_000)) throw new Error('Image must be a PNG, JPEG, or WebP under about 4 MB.');
    const id = randomUUID();
    const createdAt = now();
    // Only content deliberately entered into this endpoint is persisted. We do not read chat history.
    await db.insert(sourceMessages).values({
      id,
      chatJid: `manual:${id}`,
      messageId: `manual:${id}`,
      payload: JSON.stringify(imageDataUrl ? { imageDataUrl, caption: text } : { text }),
      preview: label,
      createdAt,
    });
    return { id, preview: label, text, hasImage: Boolean(imageDataUrl), createdAt };
  }

  public async create(input: CampaignInput) {
    const name = validText(input.name, 'name', 120);
    const sourceMessageId = validText(input.sourceMessageId, 'sourceMessageId', 128);
    const groupJids = validateExplicitTargets(input.groupJids);
    const intervals = intervalsFrom(input.intervalSeconds);
    const schedule = input.schedule === undefined && input.dailyRunTime ? validateSchedule({ type: 'DAILY', time: input.dailyRunTime }) : validateSchedule(input.schedule);
    const [source] = await db.select({ id: sourceMessages.id }).from(sourceMessages).where(eq(sourceMessages.id, sourceMessageId)).limit(1);
    if (!source) throw new Error('The selected manual source message was not found.');

    const selectedGroups = await db.select({ jid: groups.whatsappGroupJid, name: groups.name, lastCampaignSentAt: groups.lastCampaignSentAt, isExcluded: groups.isExcluded })
      .from(groups).where(inArray(groups.whatsappGroupJid, groupJids));
    const byJid = new Map(selectedGroups.map((group) => [group.jid, group]));
    const missing = groupJids.filter((jid) => !byJid.has(jid));
    if (missing.length) throw new Error('Every target must be a group synced from the linked WhatsApp account.');
    if (selectedGroups.some((group) => group.isExcluded)) throw new Error('Excluded groups cannot be included in a campaign. Remove the exclusion first if you want to use one.');

    const id = randomUUID();
    const createdAt = now();
    await db.insert(campaigns).values({ id, name, sourceMessageReference: source.id, status: 'DRAFT', intervalSeconds: intervals[0], intervalSecondsList: JSON.stringify(intervals), dailyRunTime: schedule.type === 'DAILY' ? schedule.time : null, nextRunAt: null, lastRunAt: null, scheduleConfig: JSON.stringify(schedule), createdAt, startedAt: null, completedAt: null });
    for (const [position, jid] of groupJids.entries()) {
      const group = byJid.get(jid)!;
      await db.insert(campaignTargets).values({ id: randomUUID(), campaignId: id, groupJid: jid, groupName: group.name, position, status: 'QUEUED', scheduledAt: null, sentAt: null, errorMessage: null, attemptCount: 0 });
    }
    return { ...(await this.get(id)), warnings: cooldownWarnings(selectedGroups) };
  }

  public async list() {
    const rows = await db.select().from(campaigns).orderBy(asc(campaigns.createdAt));
    return Promise.all(rows.map((campaign) => this.get(campaign.id)));
  }

  public async get(id: string) {
    const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    if (!campaign) throw new Error('Campaign not found.');
    const targets = await db.select().from(campaignTargets).where(eq(campaignTargets.campaignId, id)).orderBy(asc(campaignTargets.position));
    const [source] = await db.select({ payload: sourceMessages.payload }).from(sourceMessages).where(eq(sourceMessages.id, campaign.sourceMessageReference)).limit(1);
    let sourceContent: { text: string; hasImage: boolean } | null = null;
    try {
      const parsed = source ? JSON.parse(source.payload) as { text?: unknown; caption?: unknown; imageDataUrl?: unknown } : null;
      const text = typeof parsed?.text === 'string' ? parsed.text : typeof parsed?.caption === 'string' ? parsed.caption : '';
      sourceContent = { text, hasImage: typeof parsed?.imageDataUrl === 'string' };
    } catch { /* A broken legacy source remains visible as a campaign but cannot be prefilled. */ }
    const recent = await db.select({ jid: groups.whatsappGroupJid, lastCampaignSentAt: groups.lastCampaignSentAt }).from(groups)
      .where(inArray(groups.whatsappGroupJid, targets.map((target) => target.groupJid)));
    return { ...campaign, targets, sourceContent, warnings: cooldownWarnings(recent) };
  }

  public async start(id: string) {
    const campaign = await this.requireStatus(id, ['DRAFT', 'QUEUED', 'PAUSED']);
    const startedAt = now();
    const schedule = storedSchedule(campaign.scheduleConfig, campaign.dailyRunTime);
    const nextRunAt = schedule.type !== 'ONCE'
      ? (campaign.nextRunAt && Date.parse(campaign.nextRunAt) > Date.now() ? campaign.nextRunAt : nextScheduledRunAt(schedule))
      : null;
    await db.update(campaigns).set({ status: 'RUNNING', startedAt: campaign.startedAt ?? startedAt, completedAt: null, nextRunAt }).where(eq(campaigns.id, id));
    if (nextRunAt) await db.update(campaignTargets).set({ scheduledAt: nextRunAt }).where(eq(campaignTargets.campaignId, id));
    this.runWorker(id);
    return this.get(id);
  }

  /** Start a saved campaign immediately, without changing its recurring schedule. */
  public async runNow(id: string) {
    const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    if (!campaign) throw new Error('Campaign not found.');
    if (campaign.status === 'STOPPED' || campaign.status === 'COMPLETED') {
      await db.update(campaignTargets).set({ status: 'QUEUED', scheduledAt: null, sentAt: null, errorMessage: null, attemptCount: 0 })
        .where(eq(campaignTargets.campaignId, id));
    }
    if (campaign.status === 'DRAFT' || campaign.status === 'QUEUED' || campaign.status === 'PAUSED' || campaign.status === 'STOPPED' || campaign.status === 'COMPLETED') {
      await db.update(campaigns).set({ status: 'RUNNING', startedAt: campaign.startedAt ?? now(), completedAt: null, nextRunAt: null })
        .where(eq(campaigns.id, id));
    } else {
      await db.update(campaigns).set({ nextRunAt: null }).where(eq(campaigns.id, id));
    }
    await db.update(campaignTargets).set({ scheduledAt: null }).where(eq(campaignTargets.campaignId, id));
    this.wakeWorker(id);
    this.runWorker(id);
    return this.get(id);
  }

  public async update(id: string, input: CampaignInput) {
    const campaign = await this.requireStatus(id, ['DRAFT', 'QUEUED', 'PAUSED', 'COMPLETED', 'STOPPED']);
    const name = validText(input.name, 'name', 120);
    const sourceMessageId = validText(input.sourceMessageId, 'sourceMessageId', 128);
    const groupJids = validateExplicitTargets(input.groupJids);
    const intervals = intervalsFrom(input.intervalSeconds);
    const schedule = input.schedule === undefined && input.dailyRunTime ? validateSchedule({ type: 'DAILY', time: input.dailyRunTime }) : validateSchedule(input.schedule);
    const [source] = await db.select({ id: sourceMessages.id }).from(sourceMessages).where(eq(sourceMessages.id, sourceMessageId)).limit(1);
    if (!source) throw new Error('The selected manual source message was not found.');
    const selectedGroups = await db.select({ jid: groups.whatsappGroupJid, name: groups.name, isExcluded: groups.isExcluded })
      .from(groups).where(inArray(groups.whatsappGroupJid, groupJids));
    const byJid = new Map(selectedGroups.map((group) => [group.jid, group]));
    if (groupJids.some((jid) => !byJid.has(jid))) throw new Error('Every target must be a group synced from the linked WhatsApp account.');
    if (selectedGroups.some((group) => group.isExcluded)) throw new Error('Excluded groups cannot be included in a campaign. Remove the exclusion first if you want to use one.');

    await db.update(campaigns).set({
      name, sourceMessageReference: sourceMessageId, intervalSeconds: intervals[0], intervalSecondsList: JSON.stringify(intervals),
      dailyRunTime: schedule.type === 'DAILY' ? schedule.time : null, scheduleConfig: JSON.stringify(schedule),
      nextRunAt: null, lastRunAt: null, completedAt: campaign.status === 'COMPLETED' ? null : campaign.completedAt,
    }).where(eq(campaigns.id, id));
    await db.delete(campaignTargets).where(eq(campaignTargets.campaignId, id));
    for (const [position, jid] of groupJids.entries()) {
      const group = byJid.get(jid)!;
      await db.insert(campaignTargets).values({ id: randomUUID(), campaignId: id, groupJid: jid, groupName: group.name, position, status: 'QUEUED', scheduledAt: null, sentAt: null, errorMessage: null, attemptCount: 0 });
    }
    return this.get(id);
  }

  public async pause(id: string) {
    await this.requireStatus(id, ['RUNNING']);
    await db.update(campaigns).set({ status: 'PAUSED' }).where(eq(campaigns.id, id));
    return this.get(id);
  }

  public async resume(id: string) {
    await this.requireStatus(id, ['PAUSED']);
    await db.update(campaigns).set({ status: 'RUNNING' }).where(eq(campaigns.id, id));
    this.runWorker(id);
    return this.get(id);
  }

  public async stop(id: string) {
    await this.requireStatus(id, ['DRAFT', 'QUEUED', 'RUNNING', 'PAUSED']);
    const completedAt = now();
    await db.update(campaigns).set({ status: 'STOPPED', completedAt }).where(eq(campaigns.id, id));
    await db.update(campaignTargets).set({ status: 'CANCELLED' })
      .where(and(eq(campaignTargets.campaignId, id), inArray(campaignTargets.status, ['QUEUED', 'WAITING'])));
    return this.get(id);
  }

  public async stopAll() {
    const active = await db.select({ id: campaigns.id }).from(campaigns).where(inArray(campaigns.status, ['DRAFT', 'QUEUED', 'RUNNING', 'PAUSED']));
    await Promise.all(active.map((campaign) => this.stop(campaign.id)));
    return { stopped: active.length };
  }

  public async recover() {
    // Never retry an ambiguous in-flight delivery after a process restart.
    await db.update(campaignTargets).set({ status: 'FAILED', errorMessage: 'App restarted while delivery was in progress; it was not resent automatically.' })
      .where(eq(campaignTargets.status, 'SENDING'));
    await this.resumeRunningWorkers();
  }

  private runWorker(id: string) {
    if (this.workers.has(id)) return;
    const worker = this.work(id).catch((error: unknown) => {
      this.logger.error({ err: error, campaignId: id }, 'Campaign worker ended unexpectedly');
    }).finally(() => this.workers.delete(id));
    this.workers.set(id, worker);
  }

  private async work(id: string) {
    while (true) {
      const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
      if (!campaign || campaign.status !== 'RUNNING') return;
      // A campaign survives an offline period; it does not turn queued rows into failures merely
      // because the local WhatsApp client has not reconnected yet.
      if (this.whatsapp.getStatus().state !== 'CONNECTED') return;
      if (campaign.nextRunAt && Date.parse(campaign.nextRunAt) > Date.now()) {
        // Check the database regularly so pause/stop and a server restart are both safe.
        await this.waitForWorkerWakeup(id, Math.min(Date.parse(campaign.nextRunAt) - Date.now(), 60_000));
        continue;
      }
      const [target] = await db.select().from(campaignTargets)
        .where(and(eq(campaignTargets.campaignId, id), inArray(campaignTargets.status, ['QUEUED', 'WAITING'])))
        .orderBy(asc(campaignTargets.position)).limit(1);
      if (!target) {
        const schedule = storedSchedule(campaign.scheduleConfig, campaign.dailyRunTime);
        if (schedule.type !== 'ONCE') {
          const lastRunAt = now();
          const nextRunAt = nextScheduledRunAt(schedule, new Date(lastRunAt));
          await db.update(campaignTargets).set({ status: 'QUEUED', scheduledAt: nextRunAt, sentAt: null, errorMessage: null, attemptCount: 0 })
            .where(eq(campaignTargets.campaignId, id));
          await db.update(campaigns).set({ nextRunAt, lastRunAt, completedAt: null }).where(and(eq(campaigns.id, id), eq(campaigns.status, 'RUNNING')));
          continue;
        }
        await db.update(campaigns).set({ status: 'COMPLETED', completedAt: now() }).where(and(eq(campaigns.id, id), eq(campaigns.status, 'RUNNING')));
        return;
      }
      if (!canDeliverTarget(target.status)) continue;
      // A group may be excluded after a campaign was created. Respect that
      // preference at the moment of delivery as well as at campaign creation.
      const [recipient] = await db.select({ isExcluded: groups.isExcluded }).from(groups).where(eq(groups.whatsappGroupJid, target.groupJid)).limit(1);
      if (!recipient || recipient.isExcluded) {
        await db.update(campaignTargets).set({ status: 'CANCELLED', errorMessage: 'Group was excluded before this campaign could send.' })
          .where(eq(campaignTargets.id, target.id));
        continue;
      }
      await db.update(campaignTargets).set({ status: 'SENDING', attemptCount: target.attemptCount + 1, errorMessage: null })
        .where(and(eq(campaignTargets.id, target.id), ne(campaignTargets.status, 'SENT')));
      try {
        const [source] = await db.select().from(sourceMessages).where(eq(sourceMessages.id, campaign.sourceMessageReference)).limit(1);
        if (!source) throw new Error('The campaign source message no longer exists.');
        const content: unknown = JSON.parse(source.payload);
        if (!content || typeof content !== 'object') throw new Error('The stored source message is invalid.');
        const socket = this.whatsapp.getSocket();
        if (!socket || this.whatsapp.getStatus().state !== 'CONNECTED') throw new Error('WhatsApp is not connected.');
        const sourceContent = content as { text?: unknown; imageDataUrl?: unknown; caption?: unknown };
        if (typeof sourceContent.imageDataUrl === 'string' && typeof sourceContent.caption === 'string') {
          const image = Buffer.from(sourceContent.imageDataUrl.slice(sourceContent.imageDataUrl.indexOf(',') + 1), 'base64');
          const mimetype = /^data:(image\/(?:png|jpe?g|webp));base64,/i.exec(sourceContent.imageDataUrl)?.[1];
          await socket.sendMessage(target.groupJid, { image, caption: sourceContent.caption, mimetype });
        } else if (typeof sourceContent.text === 'string') await socket.sendMessage(target.groupJid, { text: sourceContent.text });
        else throw new Error('The stored source message is invalid.');
        const sentAt = now();
        await db.update(campaignTargets).set({ status: 'SENT', sentAt, errorMessage: null })
          .where(and(eq(campaignTargets.id, target.id), ne(campaignTargets.status, 'SENT')));
        await db.update(groups).set({ lastCampaignSentAt: sentAt, updatedAt: sentAt }).where(eq(groups.whatsappGroupJid, target.groupJid));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown delivery error';
        await db.update(campaignTargets).set({ status: 'FAILED', errorMessage: message.slice(0, 500) }).where(eq(campaignTargets.id, target.id));
      }
      // Cycle through the configured intervals. The first interval is used after
      // the first send, then the next interval after the next send, and so on.
      const intervals = storedIntervals(campaign.intervalSecondsList, campaign.intervalSeconds);
      const nextInterval = intervals[target.position % intervals.length];
      if (nextInterval > 0) await wait(nextInterval * 1_000);
    }
  }

  private async requireStatus(id: string, allowed: CampaignStatus[]) {
    const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    if (!campaign) throw new Error('Campaign not found.');
    if (!allowed.includes(campaign.status as CampaignStatus)) throw new Error(`Campaign cannot be changed while it is ${campaign.status}.`);
    return campaign;
  }

  private async waitForWorkerWakeup(id: string, milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.workerWakeups.delete(id);
        resolve();
      }, milliseconds);
      this.workerWakeups.set(id, () => {
        clearTimeout(timer);
        this.workerWakeups.delete(id);
        resolve();
      });
    });
  }

  private wakeWorker(id: string): void { this.workerWakeups.get(id)?.(); }

  private async resumeRunningWorkers() {
    const running = await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.status, 'RUNNING'));
    for (const campaign of running) this.runWorker(campaign.id);
  }
}
