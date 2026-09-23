import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { and, asc, eq, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import sharp from 'sharp';
import { db } from '../db/client.js';
import { campaignSources, campaignTargets, campaigns, groups, operationalLogs, sourceMessages } from '../db/schema.js';
import type { WhatsAppManager, WhatsAppStatus } from '../whatsapp/manager.js';
import { CIRCUIT_BREAKER_CONSECUTIVE_FAILURES, drawCampaignWarmupSeconds, drawGroupCooldownMs, drawGroupGraceMs, drawReconnectSettleSeconds, drawSendGapSeconds, GROUP_COOLDOWN, millisecondsUntilDailyBudgetResets, millisecondsUntilSendWindowOpens, recordSend, SEND_DAILY_LIMIT, SEND_GAP, sendsToday } from '../safety/limits.js';
import { canDeliverTarget, cooldownWarnings, type CampaignSchedule, validateExplicitTargets, validateSchedule } from './policy.js';

const now = () => new Date().toISOString();
const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * Where pacing comes from while a campaign runs. Production uses the frozen
 * random draws from safety/limits.ts (DEFAULT_PACING); tests inject instant,
 * deterministic pacing here so a suite never waits out real 60-240s gaps.
 */
export type CampaignPacing = {
  /** Account-wide floor between any two sends, applied by the serial queue. */
  minSendGapSeconds: number;
  /** Wait before the next message in a campaign, drawn per message. */
  sendGapSeconds: () => number;
  /** One-time wait when a campaign run starts. */
  warmupSeconds: () => number;
  /**
   * Quiet window after the connection returns (or is first established) before
   * the account sends anything: drawn once per CONNECTED-after-other
   * transition and applied to the first send through the serial queue.
   */
  reconnectSettleMs: () => number;
  /**
   * How long a campaign auto-paused on the daily send budget waits before it
   * resumes itself: in production the time until the budget refills (the next
   * UTC midnight) and the send window is open again, whichever is later.
   */
  dailyBudgetResetMs: () => number;
  /**
   * Milliseconds until the nightly quiet hours end, or 0 while the send window
   * is open. Production reads the real clock (06:00-23:00 EAT); tests inject 0
   * so a suite is not blocked by the hour it happens to run at.
   */
  sendWindowDelayMs: () => number;
};

export const DEFAULT_PACING: CampaignPacing = {
  minSendGapSeconds: SEND_GAP.minSeconds,
  sendGapSeconds: drawSendGapSeconds,
  warmupSeconds: drawCampaignWarmupSeconds,
  reconnectSettleMs: () => drawReconnectSettleSeconds() * 1_000,
  // The budget refills at UTC midnight (03:00 EAT), inside the nightly quiet
  // hours, so the resume waits for the send window to open as well: a resumed
  // campaign starts delivering straight away instead of holding a claimed row
  // until 06:00 EAT.
  dailyBudgetResetMs: () => Math.max(millisecondsUntilDailyBudgetResets(), millisecondsUntilSendWindowOpens()),
  sendWindowDelayMs: () => millisecondsUntilSendWindowOpens(),
};

type CampaignStatus = 'DRAFT' | 'QUEUED' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'STOPPED' | 'FAILED';

export type ManualSourceInput = {
  text: unknown; label?: unknown; imageDataUrl?: unknown; // legacy, single image
  files?: unknown; // Array<{ kind: 'image'|'video'; dataUrl: unknown; caption?: unknown; name?: unknown }>
  updateSourceIds?: unknown; // keep existing sources, only refresh their caption/text
};
export type CampaignInput = { name: unknown; sourceMessageId: unknown; sourceMessageIds?: unknown; groupJids: unknown; schedule?: unknown; dailyRunTime?: unknown; autoAddJoinedGroups?: unknown; shuffleOrder?: unknown };

export type CapturedSource = { id: string; kind: 'text' | 'image' | 'video'; preview: string };

type PreparedImage = { dataUrl: string; image: Buffer; jpegThumbnail: Buffer; width?: number; height?: number };

function validText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maxLength) {
    throw new Error(`${field} must be between 1 and ${maxLength} characters.`);
  }
  return value.trim();
}

function autoAddJoinedGroupsFrom(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error('Auto-add joined groups must be true or false.');
  return value;
}

function shuffleOrderFrom(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') throw new Error('Shuffle recipient order must be true or false.');
  return value;
}

async function prepareCampaignImage(imageDataUrl: string): Promise<PreparedImage> {
  const encoded = imageDataUrl.slice(imageDataUrl.indexOf(',') + 1);
  const input = Buffer.from(encoded, 'base64');
  if (!input.length) throw new Error('Image data is empty.');
  // Use one broadly supported format and explicitly attach a thumbnail. This
  // avoids the generic media tile shown by WhatsApp when thumbnail generation
  // is unavailable on the sending machine.
  const image = await sharp(input).rotate().flatten({ background: '#ffffff' }).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
  const metadata = await sharp(image).metadata();
  const jpegThumbnail = await sharp(image).resize({ width: 96, height: 96, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 60, mozjpeg: true }).toBuffer();
  return {
    dataUrl: `data:image/jpeg;base64,${image.toString('base64')}`,
    image,
    jpegThumbnail,
    width: metadata.width,
    height: metadata.height,
  };
}

function nextRunAtForTime(time: string, from: Date, daysAhead = 0): Date {
  const [hours, minutes] = time.split(':').map(Number);
  const scheduled = new Date(from);
  scheduled.setHours(hours, minutes, 0, 0);
  if (scheduled.getTime() <= from.getTime()) scheduled.setDate(scheduled.getDate() + 1 + daysAhead);
  else if (daysAhead > 0) scheduled.setDate(scheduled.getDate() + daysAhead);
  return scheduled;
}

function sourceKindFromPayload(payload: string): 'text' | 'image' | 'video' {
  try {
    const parsed = JSON.parse(payload) as { imageDataUrl?: unknown; videoDataUrl?: unknown };
    if (typeof parsed.imageDataUrl === 'string') return 'image';
    if (typeof parsed.videoDataUrl === 'string') return 'video';
  } catch { /* A broken payload is treated as plain text for display purposes. */ }
  return 'text';
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
  private pendingWarmups = new Map<string, number>();
  // Armed timers for campaigns auto-paused on the daily send budget: each one
  // fires when the budget refills and resumes its campaign without an operator.
  // The durable record is campaigns.auto_resume_at, so a restart re-arms them
  // (see sweepAutoResumes) instead of losing the pending resume.
  private autoResumeTimers = new Map<string, NodeJS.Timeout>();
  // One serial queue per account (a CampaignService exists per WhatsApp
  // account): every message send goes through it, so the minimum gap between
  // sends holds across concurrent campaigns, not just inside one campaign.
  private accountSendQueue: Promise<void> = Promise.resolve();
  private lastSendAtMs = 0;
  // After the connection returns, sends stay gated until this wall-clock time.
  // Drawn once per reconnect (see the constructor subscription) so the account
  // sits quiet on the server side while the freshly resumed session settles.
  private settleUntilMs: number | null = null;
  private lastConnectionState: WhatsAppStatus['state'] | null = null;
  // Account-level circuit breaker: consecutive send failures trip it, pausing
  // every running campaign until an operator acts (see tripCircuitBreaker).
  private consecutiveSendFailures = 0;
  private circuitOpen = false;

  public constructor(private readonly whatsapp: WhatsAppManager, private readonly logger: FastifyBaseLogger, private readonly accountId = 'main', private readonly pacing: CampaignPacing = DEFAULT_PACING) {
    // A reconnect (or a first connect after boot) is treated as the account
    // coming back online, so every send waits out one quiet window. Status
    // events only fire on change, and the manager is always pre-start when this
    // service subscribes, so the first open of the process is observed too.
    this.lastConnectionState = this.whatsapp.getStatus().state;
    this.whatsapp.subscribe((status) => {
      if (status.state === 'CONNECTED' && this.lastConnectionState !== 'CONNECTED') {
        const settleMs = this.pacing.reconnectSettleMs();
        this.settleUntilMs = Date.now() + settleMs;
        this.logger.info({ accountId, settleSeconds: Math.round(settleMs / 1_000) }, 'WhatsApp connected; sends are gated until the settle window passes');
      }
      this.lastConnectionState = status.state;
      if (status.state === 'CONNECTED') {
        void this.resumeRunningWorkers();
        void this.sweepAutoResumes();
      }
    });
    this.whatsapp.subscribeGroupJoined((group) => this.addJoinedGroupToCampaigns(group));
  }

  public async captureManualSource(input: ManualSourceInput): Promise<{ id: string; preview: string; text: string; hasImage: boolean; createdAt: string; sources: CapturedSource[] }> {
    const label = input.label === undefined ? 'Manual message' : validText(input.label, 'label', 120);
    const files = Array.isArray(input.files) && input.files.length >= 1 ? input.files : undefined;
    // Combined edit: refresh the selected existing rows in place and capture
    // the new files as additional rows, in one ordered source list.
    if (files && input.updateSourceIds !== undefined) return this.captureCombined(input, label, files);
    if (files) return this.captureManualFiles(input.text, label, files);
    // Caption/text-only edits keep the existing media rows and refresh their
    // payload in place, so the stored media data is never re-encoded or dropped.
    if (input.updateSourceIds !== undefined) {
      const ids = await this.resolveSourceMessageIdList(input.updateSourceIds, 'updateSourceIds');
      const text = validText(input.text, 'text', 4096);
      const createdAt = now();
      const { sources, hasImage } = await this.refreshCapturedSourceCaptions(ids, text);
      return { id: ids[0], preview: label, text, hasImage, createdAt, sources };
    }
    // Legacy single-message path, unchanged: one text row, or one image row when
    // imageDataUrl is given. The shared textarea text doubles as the caption.
    const text = validText(input.text, 'text', 4096);
    const imageDataUrl = typeof input.imageDataUrl === 'string' ? input.imageDataUrl : undefined;
    if (imageDataUrl && (!/^data:image\/(png|jpe?g|webp);base64,/.test(imageDataUrl) || imageDataUrl.length > 6_000_000)) throw new Error('Image must be a PNG, JPEG, or WebP under about 4 MB.');
    const preparedImage = imageDataUrl ? await prepareCampaignImage(imageDataUrl) : undefined;
    const id = randomUUID();
    const createdAt = now();
    // Only content deliberately entered into this endpoint is persisted. We do not read chat history.
    await db.insert(sourceMessages).values({
      id, accountId: this.accountId,
      chatJid: `manual:${id}`,
      messageId: `manual:${id}`,
      payload: JSON.stringify(preparedImage ? { imageDataUrl: preparedImage.dataUrl, caption: text } : { text }),
      preview: label,
      createdAt,
    });
    return { id, preview: label, text, hasImage: Boolean(preparedImage), createdAt, sources: [{ id, kind: preparedImage ? 'image' : 'text', preview: label }] };
  }

  /** Refresh the caption/text of the given source rows, in id order, keeping
   *  their stored media payload untouched. Shared by the updateSourceIds-only
   *  edit and the combined edit so the two paths cannot drift. */
  private async refreshCapturedSourceCaptions(ids: string[], text: string): Promise<{ sources: CapturedSource[]; hasImage: boolean }> {
    const rows = await db.select({ id: sourceMessages.id, payload: sourceMessages.payload, preview: sourceMessages.preview })
      .from(sourceMessages).where(and(eq(sourceMessages.accountId, this.accountId), inArray(sourceMessages.id, ids)));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const sources: CapturedSource[] = [];
    let hasImage = false;
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) throw new Error('The selected manual source message was not found.');
      if (sourceKindFromPayload(row.payload) === 'image') hasImage = true;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.payload);
      } catch { /* A broken stored payload is handled below with the same message the send loop uses. */ }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The stored source message is invalid.');
      const content = parsed as { text?: unknown; caption?: unknown; imageDataUrl?: unknown; videoDataUrl?: unknown };
      // Media stays exactly as stored; only the shared caption/text is refreshed.
      if (typeof content.imageDataUrl === 'string') content.caption = text;
      else if (typeof content.videoDataUrl === 'string') content.caption = text;
      else if (typeof content.text === 'string') content.text = text;
      else throw new Error('The stored source message is invalid.');
      await db.update(sourceMessages).set({ payload: JSON.stringify(content) }).where(eq(sourceMessages.id, id));
      sources.push({ id, kind: sourceKindFromPayload(row.payload), preview: row.preview });
    }
    return { sources, hasImage };
  }

  /** Combined capture: refresh the selected existing rows' caption in place and
   *  add new files as additional rows, returning one ordered source list with
   *  the existing sources first, then the new captures. The combined list
   *  defines campaign_sources position order downstream. */
  private async captureCombined(input: ManualSourceInput, label: string, files: unknown[]): Promise<{ id: string; preview: string; text: string; hasImage: boolean; createdAt: string; sources: CapturedSource[] }> {
    const ids = await this.resolveSourceMessageIdList(input.updateSourceIds, 'updateSourceIds');
    // The cap covers the existing and the new rows together.
    if (ids.length + files.length > 10) throw new Error('A campaign can contain at most 10 files.');
    const text = validText(input.text, 'text', 4096);
    const { sources: existingSources, hasImage: existingHasImage } = await this.refreshCapturedSourceCaptions(ids, text);
    const captured = await this.captureManualFiles(text, label, files);
    return { id: ids[0], preview: label, text, hasImage: existingHasImage || captured.hasImage, createdAt: captured.createdAt, sources: [...existingSources, ...captured.sources] };
  }

  private async captureManualFiles(textInput: unknown, label: string, files: unknown[]): Promise<{ id: string; preview: string; text: string; hasImage: boolean; createdAt: string; sources: CapturedSource[] }> {
    if (files.length > 10) throw new Error('A campaign can contain at most 10 files.');
    // Media needs no caption, so the shared text may be empty here; the usual
    // upper bound still applies. The text is the caption for every file.
    if (typeof textInput !== 'string' || textInput.trim().length > 4096) throw new Error('text must be between 1 and 4096 characters.');
    const text = textInput.trim();
    type ValidatedFile = { kind: 'image' | 'video'; dataUrl: string; name: string | null };
    const validated: ValidatedFile[] = files.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Every file must be an image or a video.');
      const file = entry as Record<string, unknown>;
      if (file.kind !== 'image' && file.kind !== 'video') throw new Error('Every file must be an image or a video.');
      const dataUrl = file.dataUrl;
      if (typeof dataUrl !== 'string') throw new Error('Every file needs a data URL string.');
      if (file.kind === 'image') {
        if (!/^data:image\/(png|jpe?g|webp);base64,/.test(dataUrl) || dataUrl.length > 6_000_000) throw new Error('Image must be a PNG, JPEG, or WebP under about 4 MB.');
      } else {
        if (!/^data:video\/mp4;base64,/.test(dataUrl) || dataUrl.length > 22_400_000) throw new Error('Video must be an MP4 under about 16 MB.');
        const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1);
        if (!Buffer.from(encoded, 'base64').length) throw new Error('Video data is empty.');
      }
      let name: string | null = null;
      if (file.name !== undefined) {
        if (typeof file.name !== 'string' || file.name.length > 120) throw new Error('Each file name must be at most 120 characters.');
        name = file.name;
      }
      return { kind: file.kind, dataUrl, name };
    });
    const createdAt = now();
    const sources: CapturedSource[] = [];
    let firstId: string | null = null;
    let hasImage = false;
    // One sourceMessages row per file, in order. Raw data URLs are stored
    // untouched; sharp stays image-only for the send path.
    for (const [index, file] of validated.entries()) {
      const id = randomUUID();
      firstId ??= id;
      if (file.kind === 'image') hasImage = true;
      const payload = file.kind === 'image'
        ? { kind: 'image', imageDataUrl: file.dataUrl, caption: text }
        : { kind: 'video', videoDataUrl: file.dataUrl, caption: text };
      const preview = file.name ? `${label} — ${file.kind}: ${file.name}` : `${label} — ${file.kind} file ${index + 1}`;
      await db.insert(sourceMessages).values({
        id, accountId: this.accountId,
        chatJid: `manual:${id}`,
        messageId: `manual:${id}`,
        payload: JSON.stringify(payload),
        preview,
        createdAt,
      });
      sources.push({ id, kind: file.kind, preview });
    }
    return { id: firstId!, preview: label, text, hasImage, createdAt, sources };
  }

  /** Resolve the ordered source-message list for a campaign input. The new
   *  multi-file field wins when both are present; the legacy single ID is the
   *  fallback. Every referenced message must exist for this account. */
  private async resolveSourceMessageIds(sourceMessageIds: unknown, sourceMessageId: unknown): Promise<string[]> {
    if (sourceMessageIds !== undefined) return this.resolveSourceMessageIdList(sourceMessageIds, 'sourceMessageIds');
    if (sourceMessageId === undefined) throw new Error('A campaign needs at least one source message.');
    const single = validText(sourceMessageId, 'sourceMessageId', 128);
    await this.assertSourceMessagesExist([single]);
    return [single];
  }

  /** Validate one source-message ID list for a named input field: an array of
   *  at most 10 non-empty trimmed strings, no duplicates, and every message
   *  existing for this account. Shared by the campaign input and the manual
   *  capture update path, each with its own field name in error messages. */
  private async resolveSourceMessageIdList(value: unknown, field: string): Promise<string[]> {
    if (!Array.isArray(value)) throw new Error(`${field} must be an array of source message IDs.`);
    const ids = value as unknown[];
    if (ids.length === 0) throw new Error('A campaign needs at least one source message.');
    if (ids.length > 10) throw new Error('A campaign can contain at most 10 source messages.');
    const trimmed: string[] = [];
    for (const entry of ids) {
      if (typeof entry !== 'string' || entry.trim().length === 0 || entry.trim().length > 128) {
        throw new Error('Each source message ID must be a non-empty string of at most 128 characters.');
      }
      trimmed.push(entry.trim());
    }
    if (new Set(trimmed).size !== trimmed.length) throw new Error('Each source message can be selected only once.');
    await this.assertSourceMessagesExist(trimmed);
    return trimmed;
  }

  private async assertSourceMessagesExist(ids: string[]): Promise<void> {
    const found = await db.select({ id: sourceMessages.id }).from(sourceMessages)
      .where(and(eq(sourceMessages.accountId, this.accountId), inArray(sourceMessages.id, ids)));
    const known = new Set(found.map((row) => row.id));
    if (ids.some((id) => !known.has(id))) throw new Error('The selected manual source message was not found.');
  }

  /** Replace the campaign's ordered source list only when it actually changed.
   *  These rows are not delivery state: work() reads them at send time, so
   *  deleting and re-inserting them during a live edit is safe. */
  private async syncCampaignSources(campaignId: string, sourceIds: string[]): Promise<void> {
    const existing = await db.select({ sourceMessageId: campaignSources.sourceMessageId }).from(campaignSources)
      .where(eq(campaignSources.campaignId, campaignId)).orderBy(asc(campaignSources.position));
    const unchanged = existing.length === sourceIds.length
      && existing.every((row, index) => row.sourceMessageId === sourceIds[index]);
    if (unchanged) return;
    await db.delete(campaignSources).where(eq(campaignSources.campaignId, campaignId));
    const createdAt = now();
    for (const [position, sourceId] of sourceIds.entries()) {
      await db.insert(campaignSources).values({ id: randomUUID(), campaignId, sourceMessageId: sourceId, position, createdAt });
    }
  }

  public async create(input: CampaignInput) {
    const name = validText(input.name, 'name', 120);
    const sourceIds = await this.resolveSourceMessageIds(input.sourceMessageIds, input.sourceMessageId);
    const groupJids = validateExplicitTargets(input.groupJids);
    const autoAddJoinedGroups = autoAddJoinedGroupsFrom(input.autoAddJoinedGroups);
    const shuffleOrder = shuffleOrderFrom(input.shuffleOrder);
    const schedule = input.schedule === undefined && input.dailyRunTime ? validateSchedule({ type: 'DAILY', time: input.dailyRunTime }) : validateSchedule(input.schedule);

    const selectedGroups = await db.select({ jid: groups.whatsappGroupJid, name: groups.name, lastCampaignSentAt: groups.lastCampaignSentAt, isExcluded: groups.isExcluded })
      .from(groups).where(and(eq(groups.accountId, this.accountId), inArray(groups.whatsappGroupJid, groupJids)));
    const byJid = new Map(selectedGroups.map((group) => [group.jid, group]));
    const missing = groupJids.filter((jid) => !byJid.has(jid));
    if (missing.length) throw new Error('Every target must be a group synced from the linked WhatsApp account.');
    if (selectedGroups.some((group) => group.isExcluded)) throw new Error('Excluded groups cannot be included in a campaign. Remove the exclusion first if you want to use one.');

    const id = randomUUID();
    const createdAt = now();
    // The interval_seconds columns are legacy and inert: pacing is randomized
    // and built in (see safety/limits.ts). They stay because the columns are
    // NOT NULL without a default in the original bootstrap schema.
    await db.insert(campaigns).values({ id, accountId: this.accountId, name, sourceMessageReference: sourceIds[0], status: 'DRAFT', intervalSeconds: 0, intervalSecondsList: '[0]', dailyRunTime: schedule.type === 'DAILY' ? schedule.time : null, nextRunAt: null, lastRunAt: null, scheduleConfig: JSON.stringify(schedule), autoAddJoinedGroups, shuffleOrder, createdAt, startedAt: null, completedAt: null });
    for (const [position, sourceId] of sourceIds.entries()) {
      await db.insert(campaignSources).values({ id: randomUUID(), campaignId: id, sourceMessageId: sourceId, position, createdAt });
    }
    for (const [position, jid] of groupJids.entries()) {
      const group = byJid.get(jid)!;
      await db.insert(campaignTargets).values({ id: randomUUID(), campaignId: id, groupJid: jid, groupName: group.name, position, status: 'QUEUED', scheduledAt: null, sentAt: null, errorMessage: null, attemptCount: 0 });
    }
    return { ...(await this.get(id)), warnings: cooldownWarnings(selectedGroups) };
  }

  public async list() {
    const rows = await db.select().from(campaigns).where(eq(campaigns.accountId, this.accountId)).orderBy(asc(campaigns.createdAt));
    return Promise.all(rows.map((campaign) => this.get(campaign.id)));
  }

  public async get(id: string) {
    const [campaign] = await db.select().from(campaigns).where(and(eq(campaigns.id, id), eq(campaigns.accountId, this.accountId))).limit(1);
    if (!campaign) throw new Error('Campaign not found.');
    const targets = await db.select().from(campaignTargets).where(eq(campaignTargets.campaignId, id)).orderBy(asc(campaignTargets.position));
    const sourceRows = await db.select({ id: campaignSources.id, sourceMessageId: campaignSources.sourceMessageId, payload: sourceMessages.payload, preview: sourceMessages.preview })
      .from(campaignSources)
      .innerJoin(sourceMessages, eq(campaignSources.sourceMessageId, sourceMessages.id))
      .where(and(eq(campaignSources.campaignId, id), eq(sourceMessages.accountId, this.accountId)))
      .orderBy(asc(campaignSources.position));
    // Legacy campaigns (created before campaign_sources existed) have no rows;
    // fall back to the single source_message_reference entry.
    let firstPayload: string | null = null;
    let sources: CapturedSource[] = [];
    if (sourceRows.length) {
      sources = sourceRows.map((row) => ({ id: row.sourceMessageId, kind: sourceKindFromPayload(row.payload), preview: row.preview }));
      firstPayload = sourceRows[0].payload;
    } else {
      const [source] = await db.select({ payload: sourceMessages.payload, preview: sourceMessages.preview }).from(sourceMessages)
        .where(and(eq(sourceMessages.id, campaign.sourceMessageReference), eq(sourceMessages.accountId, this.accountId))).limit(1);
      if (source) {
        firstPayload = source.payload;
        sources = [{ id: campaign.sourceMessageReference, kind: sourceKindFromPayload(source.payload), preview: source.preview }];
      }
    }
    let sourceContent: { text: string; hasImage: boolean } | null = null;
    try {
      const parsed = firstPayload ? JSON.parse(firstPayload) as { text?: unknown; caption?: unknown; imageDataUrl?: unknown } : null;
      const text = typeof parsed?.text === 'string' ? parsed.text : typeof parsed?.caption === 'string' ? parsed.caption : '';
      // Legacy semantics: a legacy image payload has imageDataUrl, so the first
      // source being an image (hasImage true) is preserved for edit prefill.
      sourceContent = { text, hasImage: typeof parsed?.imageDataUrl === 'string' };
    } catch { /* A broken legacy source remains visible as a campaign but cannot be prefilled. */ }
    const recent = await db.select({ jid: groups.whatsappGroupJid, lastCampaignSentAt: groups.lastCampaignSentAt }).from(groups)
      .where(and(eq(groups.accountId, this.accountId), inArray(groups.whatsappGroupJid, targets.map((target) => target.groupJid))));
    return { ...campaign, targets, sources, sourceContent, warnings: cooldownWarnings(recent) };
  }

  public async start(id: string) {
    const campaign = await this.requireStatus(id, ['DRAFT', 'QUEUED', 'PAUSED']);
    // An operator deliberately (re)starting a campaign clears the account
    // circuit breaker: they have chosen to retry, so failures count fresh.
    this.circuitOpen = false;
    this.consecutiveSendFailures = 0;
    // Heal rows that an older build left stuck in SENDING (a paused campaign
    // has no in-flight send, so releasing them cannot double-send).
    await this.releaseStuckSendingRows(id);
    const startedAt = now();
    const schedule = storedSchedule(campaign.scheduleConfig, campaign.dailyRunTime);
    const nextRunAt = schedule.type !== 'ONCE'
      ? (campaign.nextRunAt && Date.parse(campaign.nextRunAt) > Date.now() ? campaign.nextRunAt : nextScheduledRunAt(schedule))
      : null;
    this.clearAutoResumeTimer(id);
    await db.update(campaigns).set({ status: 'RUNNING', startedAt: campaign.startedAt ?? startedAt, completedAt: null, nextRunAt, pauseReason: null, autoResumeAt: null }).where(eq(campaigns.id, id));
    if (nextRunAt) await db.update(campaignTargets).set({ scheduledAt: nextRunAt }).where(eq(campaignTargets.campaignId, id));
    this.pendingWarmups.set(id, this.pacing.warmupSeconds());
    this.runWorker(id);
    return this.get(id);
  }

  /** Start a saved campaign immediately, without changing its recurring schedule. */
  public async runNow(id: string) {
    const [campaign] = await db.select().from(campaigns).where(and(eq(campaigns.id, id), eq(campaigns.accountId, this.accountId))).limit(1);
    if (!campaign) throw new Error('Campaign not found.');
    // Same operator-action semantics as start(): retrying is a fresh start.
    this.circuitOpen = false;
    this.consecutiveSendFailures = 0;
    this.clearAutoResumeTimer(id);
    if (campaign.status === 'STOPPED' || campaign.status === 'COMPLETED') {
      await db.update(campaignTargets).set({ status: 'QUEUED', scheduledAt: null, sentAt: null, errorMessage: null, attemptCount: 0 })
        .where(eq(campaignTargets.campaignId, id));
    }
    if (campaign.status === 'DRAFT' || campaign.status === 'QUEUED' || campaign.status === 'PAUSED' || campaign.status === 'STOPPED' || campaign.status === 'COMPLETED') {
      await db.update(campaigns).set({ status: 'RUNNING', startedAt: campaign.startedAt ?? now(), completedAt: null, nextRunAt: null, pauseReason: null, autoResumeAt: null })
        .where(eq(campaigns.id, id));
    } else {
      await db.update(campaigns).set({ nextRunAt: null, pauseReason: null, autoResumeAt: null }).where(eq(campaigns.id, id));
    }
    await db.update(campaignTargets).set({ scheduledAt: null }).where(eq(campaignTargets.campaignId, id));
    this.wakeWorker(id);
    this.pendingWarmups.set(id, this.pacing.warmupSeconds());
    this.runWorker(id);
    return this.get(id);
  }

  public async update(id: string, input: CampaignInput) {
    const campaign = await this.requireStatus(id, ['DRAFT', 'QUEUED', 'RUNNING', 'PAUSED', 'COMPLETED', 'STOPPED']);
    const name = validText(input.name, 'name', 120);
    const sourceIds = await this.resolveSourceMessageIds(input.sourceMessageIds, input.sourceMessageId);
    const groupJids = validateExplicitTargets(input.groupJids);
    const autoAddJoinedGroups = autoAddJoinedGroupsFrom(input.autoAddJoinedGroups);
    const shuffleOrder = shuffleOrderFrom(input.shuffleOrder);
    const schedule = input.schedule === undefined && input.dailyRunTime ? validateSchedule({ type: 'DAILY', time: input.dailyRunTime }) : validateSchedule(input.schedule);
    const selectedGroups = await db.select({ jid: groups.whatsappGroupJid, name: groups.name, isExcluded: groups.isExcluded })
      .from(groups).where(and(eq(groups.accountId, this.accountId), inArray(groups.whatsappGroupJid, groupJids)));
    const byJid = new Map(selectedGroups.map((group) => [group.jid, group]));
    if (groupJids.some((jid) => !byJid.has(jid))) throw new Error('Every target must be a group synced from the linked WhatsApp account.');
    if (selectedGroups.some((group) => group.isExcluded)) throw new Error('Excluded groups cannot be included in a campaign. Remove the exclusion first if you want to use one.');

    const scheduleConfig = JSON.stringify(schedule);
    const scheduleChanged = campaign.scheduleConfig !== scheduleConfig;
    const nextRunAt = campaign.status === 'RUNNING' && !scheduleChanged
      ? campaign.nextRunAt
      : schedule.type === 'ONCE' ? null : nextScheduledRunAt(schedule);
    await db.update(campaigns).set({
      name, sourceMessageReference: sourceIds[0], intervalSeconds: 0, intervalSecondsList: '[0]',
      dailyRunTime: schedule.type === 'DAILY' ? schedule.time : null, scheduleConfig,
      autoAddJoinedGroups, shuffleOrder, nextRunAt, lastRunAt: campaign.status === 'RUNNING' ? campaign.lastRunAt : null,
      completedAt: campaign.status === 'COMPLETED' ? null : campaign.completedAt,
    }).where(eq(campaigns.id, id));
    await this.syncCampaignSources(id, sourceIds);
    if (campaign.status === 'RUNNING') {
      // A live edit must never delete delivery history or a row currently
      // sending. New choices join the remaining queue; removed unsent rows are
      // cancelled so they cannot be delivered after the edit.
      const existingTargets = await db.select().from(campaignTargets).where(eq(campaignTargets.campaignId, id)).orderBy(asc(campaignTargets.position));
      const selected = new Set(groupJids);
      for (const target of existingTargets) {
        if (!selected.has(target.groupJid) && (target.status === 'QUEUED' || target.status === 'WAITING')) {
          await db.update(campaignTargets).set({ status: 'CANCELLED', errorMessage: 'Removed during a live campaign edit.' }).where(eq(campaignTargets.id, target.id));
        } else if (selected.has(target.groupJid)) {
          await db.update(campaignTargets).set({ groupName: byJid.get(target.groupJid)!.name }).where(eq(campaignTargets.id, target.id));
        }
      }
      const known = new Set(existingTargets.map((target) => target.groupJid));
      let position = (existingTargets.at(-1)?.position ?? -1) + 1;
      for (const jid of groupJids) {
        if (known.has(jid)) continue;
        const group = byJid.get(jid)!;
        await db.insert(campaignTargets).values({ id: randomUUID(), campaignId: id, groupJid: jid, groupName: group.name, position, status: 'QUEUED', scheduledAt: nextRunAt, sentAt: null, errorMessage: null, attemptCount: 0 });
        position += 1;
      }
      this.wakeWorker(id);
      this.runWorker(id);
    } else {
      await db.delete(campaignTargets).where(eq(campaignTargets.campaignId, id));
      for (const [position, jid] of groupJids.entries()) {
        const group = byJid.get(jid)!;
        await db.insert(campaignTargets).values({ id: randomUUID(), campaignId: id, groupJid: jid, groupName: group.name, position, status: 'QUEUED', scheduledAt: null, sentAt: null, errorMessage: null, attemptCount: 0 });
      }
    }
    return this.get(id);
  }

  public async pause(id: string) {
    await this.requireStatus(id, ['RUNNING']);
    // An operator pausing by hand stays paused: any pending budget auto-resume
    // is dropped so the campaign cannot restart itself behind their back.
    this.clearAutoResumeTimer(id);
    await db.update(campaigns).set({ status: 'PAUSED', autoResumeAt: null }).where(eq(campaigns.id, id));
    // Wake a sleeping loop so pause takes effect immediately instead of after
    // its current wait chunk.
    this.wakeWorker(id);
    return this.get(id);
  }

  public async resume(id: string) {
    await this.requireStatus(id, ['PAUSED']);
    // A paused campaign has no in-flight send: rows an older build left stuck
    // in SENDING are released back to the queue instead of blocking forever.
    await this.releaseStuckSendingRows(id);
    this.clearAutoResumeTimer(id);
    await db.update(campaigns).set({ status: 'RUNNING', pauseReason: null, autoResumeAt: null }).where(eq(campaigns.id, id));
    this.runWorker(id);
    return this.get(id);
  }

  /** Reset rows stranded in SENDING by a crashed process or an older build. */
  private async releaseStuckSendingRows(id: string): Promise<void> {
    await db.update(campaignTargets).set({ status: 'QUEUED', errorMessage: null })
      .where(and(eq(campaignTargets.campaignId, id), eq(campaignTargets.status, 'SENDING')));
  }

  public async stop(id: string) {
    await this.requireStatus(id, ['DRAFT', 'QUEUED', 'RUNNING', 'PAUSED']);
    const completedAt = now();
    this.clearAutoResumeTimer(id);
    await db.update(campaigns).set({ status: 'STOPPED', completedAt, pauseReason: null, autoResumeAt: null }).where(eq(campaigns.id, id));
    await db.update(campaignTargets).set({ status: 'CANCELLED' })
      .where(and(eq(campaignTargets.campaignId, id), inArray(campaignTargets.status, ['QUEUED', 'WAITING'])));
    // Mirror delete(): wake the sleeping loop so it exits instead of waiting
    // out its timer.
    this.wakeWorker(id);
    return this.get(id);
  }

  public async stopAll() {
    const active = await db.select({ id: campaigns.id }).from(campaigns).where(and(eq(campaigns.accountId, this.accountId), inArray(campaigns.status, ['DRAFT', 'QUEUED', 'RUNNING', 'PAUSED'])));
    await Promise.all(active.map((campaign) => this.stop(campaign.id)));
    return { stopped: active.length };
  }

  public async delete(id: string) {
    const [campaign] = await db.select().from(campaigns).where(and(eq(campaigns.id, id), eq(campaigns.accountId, this.accountId))).limit(1);
    if (!campaign) throw new Error('Campaign not found.');
    if (campaign.status === 'RUNNING') {
      // Mirror stop(): cancel what has not been sent yet, and wake the worker
      // so a sleeping loop exits instead of waiting out its timer.
      await db.update(campaignTargets).set({ status: 'CANCELLED', errorMessage: 'Campaign was deleted.' })
        .where(and(eq(campaignTargets.campaignId, id), inArray(campaignTargets.status, ['QUEUED', 'WAITING'])));
      this.wakeWorker(id);
    }
    this.clearAutoResumeTimer(id);
    // FK cascade (enabled by bootstrapDatabase) removes campaign_targets and
    // campaign_sources rows. source_messages are shared across campaigns and
    // are never deleted here.
    await db.delete(campaigns).where(and(eq(campaigns.id, id), eq(campaigns.accountId, this.accountId)));
    return { deleted: id };
  }

  public async recover() {
    // Never retry an ambiguous in-flight delivery after a process restart.
    const ownedCampaigns = await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.accountId, this.accountId));
    if (ownedCampaigns.length) {
      await db.update(campaignTargets).set({ status: 'FAILED', errorMessage: 'App restarted while delivery was in progress; it was not resent automatically.' })
        .where(and(eq(campaignTargets.status, 'SENDING'), inArray(campaignTargets.campaignId, ownedCampaigns.map((campaign) => campaign.id))));
    }
    await this.resumeRunningWorkers();
    await this.sweepAutoResumes();
  }

  private async addJoinedGroupToCampaigns(group: { jid: string; name: string }): Promise<void> {
    const [eligible] = await db.select({ isExcluded: groups.isExcluded }).from(groups)
      .where(and(eq(groups.accountId, this.accountId), eq(groups.whatsappGroupJid, group.jid))).limit(1);
    if (!eligible || eligible.isExcluded) return;
    const recipients = await db.select({ id: campaigns.id, status: campaigns.status }).from(campaigns).where(and(
      eq(campaigns.accountId, this.accountId),
      eq(campaigns.autoAddJoinedGroups, true),
      inArray(campaigns.status, ['DRAFT', 'QUEUED', 'RUNNING', 'PAUSED']),
    ));
    for (const campaign of recipients) {
      const existing = await db.select({ id: campaignTargets.id }).from(campaignTargets)
        .where(and(eq(campaignTargets.campaignId, campaign.id), eq(campaignTargets.groupJid, group.jid))).limit(1);
      if (existing.length) continue;
      const rows = await db.select({ position: campaignTargets.position }).from(campaignTargets).where(eq(campaignTargets.campaignId, campaign.id)).orderBy(asc(campaignTargets.position));
      const position = (rows.at(-1)?.position ?? -1) + 1;
      await db.insert(campaignTargets).values({ id: randomUUID(), campaignId: campaign.id, groupJid: group.jid, groupName: group.name, position, status: 'QUEUED', scheduledAt: null, sentAt: null, errorMessage: null, attemptCount: 0 });
      if (campaign.status === 'RUNNING') this.runWorker(campaign.id);
      this.logger.info({ campaignId: campaign.id, groupJid: group.jid }, 'Added newly joined group to campaign');
    }
  }

  /** Ordered source payloads for delivery: campaign_sources rows by position,
   *  or the legacy single source_message_reference when no rows exist. Any
   *  missing referenced message is a hard error so the target fails cleanly. */
  private async loadOrderedSourcesForSend(campaignId: string, fallbackReference: string): Promise<Array<{ id: string; payload: string }>> {
    const stored = await db.select({ sourceMessageId: campaignSources.sourceMessageId }).from(campaignSources)
      .where(eq(campaignSources.campaignId, campaignId)).orderBy(asc(campaignSources.position));
    if (stored.length) {
      const rows = await db.select({ id: sourceMessages.id, payload: sourceMessages.payload }).from(sourceMessages)
        .where(and(eq(sourceMessages.accountId, this.accountId), inArray(sourceMessages.id, stored.map((row) => row.sourceMessageId))));
      const byId = new Map(rows.map((row) => [row.id, row]));
      const ordered = stored.map((row) => byId.get(row.sourceMessageId));
      if (ordered.some((row) => !row)) throw new Error('The campaign source message no longer exists.');
      return ordered as Array<{ id: string; payload: string }>;
    }
    const [source] = await db.select({ id: sourceMessages.id, payload: sourceMessages.payload }).from(sourceMessages)
      .where(and(eq(sourceMessages.id, fallbackReference), eq(sourceMessages.accountId, this.accountId))).limit(1);
    if (!source) throw new Error('The campaign source message no longer exists.');
    return [{ id: source.id, payload: source.payload }];
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
      const [campaign] = await db.select().from(campaigns).where(and(eq(campaigns.id, id), eq(campaigns.accountId, this.accountId))).limit(1);
      if (!campaign || campaign.status !== 'RUNNING') return;
      // Pacing, budgets, grace and cooldown are frozen in safety/limits.ts and
      // drawn fresh from random ranges on every use — nothing here is loaded
      // from the database or configurable.
      // A campaign survives an offline period; it does not turn queued rows into failures merely
      // because the local WhatsApp client has not reconnected yet.
      if (this.whatsapp.getStatus().state !== 'CONNECTED') return;
      if (campaign.nextRunAt && Date.parse(campaign.nextRunAt) > Date.now()) {
        // Check the database regularly so pause/stop and a server restart are both safe.
        await this.waitForWorkerWakeup(id, Math.min(Date.parse(campaign.nextRunAt) - Date.now(), 60_000));
        continue;
      }
      // Only rows that are due now are deliverable: future-scheduledAt rows
      // (grace/cooldown parks) are ignored until their time comes.
      const nowIso = new Date().toISOString();
      const [target] = await db.select().from(campaignTargets)
        .where(and(
          eq(campaignTargets.campaignId, id),
          inArray(campaignTargets.status, ['QUEUED', 'WAITING']),
          or(isNull(campaignTargets.scheduledAt), lte(campaignTargets.scheduledAt, nowIso)),
        ))
        .orderBy(campaign.shuffleOrder ? sql`random()` : asc(campaignTargets.position)).limit(1);
      if (!target) {
        // A target may be parked as WAITING on a group grace period or cooldown.
        // Sleep in chunks until the earliest one becomes due, then re-evaluate.
        const [pending] = await db.select({ scheduledAt: campaignTargets.scheduledAt }).from(campaignTargets)
          .where(and(
            eq(campaignTargets.campaignId, id),
            eq(campaignTargets.status, 'WAITING'),
            sql`${campaignTargets.scheduledAt} is not null`,
          ))
          .orderBy(asc(campaignTargets.scheduledAt)).limit(1);
        if (pending?.scheduledAt && Date.parse(pending.scheduledAt) > Date.now()) {
          await this.waitForWorkerWakeup(id, Math.min(Date.parse(pending.scheduledAt) - Date.now(), 60_000));
          continue;
        }
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
      const [recipient] = await db.select({ isExcluded: groups.isExcluded, joinedAt: groups.joinedAt, lastCampaignSentAt: groups.lastCampaignSentAt }).from(groups).where(and(eq(groups.accountId, this.accountId), eq(groups.whatsappGroupJid, target.groupJid))).limit(1);
      if (!recipient || recipient.isExcluded) {
        await db.update(campaignTargets).set({ status: 'CANCELLED', errorMessage: 'Group was excluded before this campaign could send.' })
          .where(eq(campaignTargets.id, target.id));
        continue;
      }
      // New groups get a grace period before their first campaign send, and
      // every group honors a cooldown since its last campaign send. The target
      // is parked as WAITING with a future scheduledAt; the pick filter above
      // ignores it until then, and the no-target branch sleeps until it is due.
      // No sleep here, and attemptCount is deliberately untouched.
      //
      // The grace and cooldown durations are random draws made once per
      // parking, so a fresh draw can never quietly extend a wait that is
      // already underway. A WAITING row is only re-evaluated once its own
      // deadline has passed; it is then delivered (its grace is already
      // honored) unless the group received a campaign message recently enough
      // that a new cooldown park applies. Cooldown only blocks while its
      // minimum window has not elapsed since that send — a parked draw past
      // that window is already honored by the row's own deadline.
      const parkedRow = target.status === 'WAITING';
      let blockedUntilMs = 0;
      if (!parkedRow && recipient.joinedAt && Number.isFinite(Date.parse(recipient.joinedAt))) {
        blockedUntilMs = Math.max(blockedUntilMs, Date.parse(recipient.joinedAt) + drawGroupGraceMs());
      }
      const lastSendMs = recipient.lastCampaignSentAt && Number.isFinite(Date.parse(recipient.lastCampaignSentAt))
        ? Date.parse(recipient.lastCampaignSentAt)
        : 0;
      if (lastSendMs > 0 && lastSendMs + GROUP_COOLDOWN.minHours * 3_600_000 > Date.now()) {
        blockedUntilMs = Math.max(blockedUntilMs, lastSendMs + drawGroupCooldownMs());
      }
      if (blockedUntilMs > Date.now()) {
        await db.update(campaignTargets).set({ status: 'WAITING', scheduledAt: new Date(blockedUntilMs).toISOString(), errorMessage: null })
          .where(eq(campaignTargets.id, target.id));
        continue;
      }
      // Enforce the daily send budget before the row is claimed, so a paused
      // campaign never leaves a target stuck in SENDING forever.
      if (await sendsToday(this.accountId) >= SEND_DAILY_LIMIT) {
        await this.pauseForDailyBudget(id);
        return;
      }
      await db.update(campaignTargets).set({ status: 'SENDING', attemptCount: target.attemptCount + 1, errorMessage: null })
        .where(and(eq(campaignTargets.id, target.id), ne(campaignTargets.status, 'SENT')));
      // Consume the warm-up set by start()/runNow() once per worker pass, in
      // chunks so stop/pause/delete can wake the loop early.
      const warmupSeconds = this.pendingWarmups.get(id);
      if (warmupSeconds !== undefined) {
        this.pendingWarmups.delete(id);
        let remainingMs = warmupSeconds * 1000;
        while (remainingMs > 0) {
          await this.waitForWorkerWakeup(id, Math.min(remainingMs, 60_000));
          remainingMs -= Math.min(remainingMs, 60_000);
        }
      }
      // A pause/stop/disconnect that arrived during the warm-up (or while
      // loading sources) must abort this delivery and release the row.
      const [fresh] = await db.select({ status: campaigns.status }).from(campaigns)
        .where(and(eq(campaigns.id, id), eq(campaigns.accountId, this.accountId))).limit(1);
      if (!fresh || fresh.status !== 'RUNNING') {
        await db.update(campaignTargets).set({
          status: fresh?.status === 'STOPPED' ? 'CANCELLED' : 'QUEUED',
          errorMessage: fresh?.status === 'STOPPED' ? 'Campaign was stopped before this send.' : null,
        }).where(eq(campaignTargets.id, target.id));
        return;
      }
      if (this.whatsapp.getStatus().state !== 'CONNECTED') {
        await db.update(campaignTargets).set({ status: 'QUEUED', errorMessage: null }).where(eq(campaignTargets.id, target.id));
        return;
      }
      // Hoisted so the catch below can use it if loading the sources throws.
      let sources: Array<{ id: string; payload: string }> = [];
      try {
        sources = await this.loadOrderedSourcesForSend(id, campaign.sourceMessageReference);
        const socket = this.whatsapp.getSocket();
        if (!socket || this.whatsapp.getStatus().state !== 'CONNECTED') throw new Error('WhatsApp is not connected.');
        for (const source of sources) {
          // Enforce the daily send budget per message. A campaign that hits the
          // limit mid-file pauses itself so nothing further goes out until the
          // daily budget resets (UTC midnight) and the campaign is resumed. The
          // target is released back to QUEUED, never left SENDING.
          if (await sendsToday(this.accountId) >= SEND_DAILY_LIMIT) {
            await db.update(campaignTargets).set({ status: 'QUEUED', errorMessage: 'Daily send budget reached; queued for the next run.' })
              .where(eq(campaignTargets.id, target.id));
            await this.pauseForDailyBudget(id);
            return;
          }
          const content: unknown = JSON.parse(source.payload);
          if (!content || typeof content !== 'object') throw new Error('The stored source message is invalid.');
          const sourceContent = content as { text?: unknown; imageDataUrl?: unknown; videoDataUrl?: unknown; caption?: unknown };
          if (typeof sourceContent.imageDataUrl === 'string' && typeof sourceContent.caption === 'string') {
            const image = await prepareCampaignImage(sourceContent.imageDataUrl);
            // Locals capture the typeof narrowing: the queued closure re-reads
            // nothing from the parsed object, whose types do not narrow across
            // function boundaries.
            const caption = sourceContent.caption;
            const sent = await this.enqueueAccountSend(async () => {
              await socket.sendMessage(target.groupJid, {
                image: image.image,
                caption,
                mimetype: 'image/jpeg',
                jpegThumbnail: image.jpegThumbnail.toString('base64'),
                width: image.width,
                height: image.height,
              });
            }, this.pacing.minSendGapSeconds * 1_000, id);
            if (!sent) { await this.releaseInterruptedTarget(id, target.id); return; }
          } else if (typeof sourceContent.videoDataUrl === 'string' && typeof sourceContent.caption === 'string') {
            const encoded = sourceContent.videoDataUrl.slice(sourceContent.videoDataUrl.indexOf(',') + 1);
            const video = Buffer.from(encoded, 'base64');
            const caption = sourceContent.caption;
            // No thumbnail is generated by our code (that would need ffmpeg in
            // our pipeline); Baileys computes one internally when jpegThumbnail
            // is omitted (see Utils/messages.js: requiresThumbnailComputation).
            const sent = await this.enqueueAccountSend(async () => {
              await socket.sendMessage(target.groupJid, { video, caption, mimetype: 'video/mp4' });
            }, this.pacing.minSendGapSeconds * 1_000, id);
            if (!sent) { await this.releaseInterruptedTarget(id, target.id); return; }
          } else if (typeof sourceContent.text === 'string') {
            const text = sourceContent.text;
            const sent = await this.enqueueAccountSend(async () => {
              await socket.sendMessage(target.groupJid, { text });
            }, this.pacing.minSendGapSeconds * 1_000, id);
            if (!sent) { await this.releaseInterruptedTarget(id, target.id); return; }
          } else throw new Error('The stored source message is invalid.');
          // A fresh random gap after every file delivered, so a group's files
          // are paced like consecutive sends across the whole account. The
          // serial queue above already guarantees the minimum spacing; this
          // wait adds the randomized delay on top.
          await wait(this.pacing.sendGapSeconds() * 1_000);
        }
        const sentAt = now();
        await db.update(campaignTargets).set({ status: 'SENT', sentAt, errorMessage: null })
          .where(and(eq(campaignTargets.id, target.id), ne(campaignTargets.status, 'SENT')));
        await db.update(groups).set({ lastCampaignSentAt: sentAt, updatedAt: sentAt }).where(and(eq(groups.accountId, this.accountId), eq(groups.whatsappGroupJid, target.groupJid)));
        // A real delivery proves the connection works: the failure streak is over.
        this.consecutiveSendFailures = 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown delivery error';
        await db.update(campaignTargets).set({ status: 'FAILED', errorMessage: message.slice(0, 500) }).where(eq(campaignTargets.id, target.id));
        // A failed send still yields a random gap before the next group is
        // attempted, so a failing run cannot speed up into a detectable
        // pattern.
        // Consecutive failures count toward the account circuit breaker. Any
        // single success resets the count, so only an unbroken failing run
        // (a dead connection, a restricted account) pauses the campaigns.
        this.consecutiveSendFailures += 1;
        if (this.consecutiveSendFailures >= CIRCUIT_BREAKER_CONSECUTIVE_FAILURES) await this.tripCircuitBreaker();
        await wait(this.pacing.sendGapSeconds() * 1_000);
      }
    }
  }

  /**
   * Serialize one message send on the account-wide queue. The minimum-gap wait
   * is computed when the item reaches the head of the queue, so two campaigns
   * racing to send cannot both wait out the gap and then fire together: each
   * consecutive account send ends up at least minSendGapSeconds apart. Random
   * pacing between messages happens in the worker; this queue only enforces
   * the hard floor. A reconnect settle window, when one is active, gates every
   * send on top of the gap (it only ever delays the first send after a
   * reconnect, because it has expired by the time any later send runs).
   * A send that throws rejects the returned promise (the caller marks the
   * target FAILED) without breaking the queue for later sends.
   */
  private enqueueAccountSend(send: () => Promise<void>, minGapMs: number, campaignId: string): Promise<boolean> {
    const next = this.accountSendQueue.then(async () => {
      while (true) {
        const [campaign] = await db.select({ status: campaigns.status }).from(campaigns)
          .where(and(eq(campaigns.id, campaignId), eq(campaigns.accountId, this.accountId))).limit(1);
        if (!campaign || campaign.status !== 'RUNNING') return false;
        const nowMs = Date.now();
        const windowDelayMs = this.pacing.sendWindowDelayMs();
        const settleRemainingMs = this.settleUntilMs === null ? 0 : this.settleUntilMs - nowMs;
        const gapRemainingMs = minGapMs - (nowMs - this.lastSendAtMs);
        const remaining = windowDelayMs > 0 ? windowDelayMs : Math.max(settleRemainingMs, gapRemainingMs);
        if (remaining > 0) {
          await wait(Math.min(remaining, 60_000));
          continue;
        }
        // Recheck the time boundary immediately before sending in case a wait
        // or database read crossed 23:00 EAT.
        if (this.pacing.sendWindowDelayMs() > 0) continue;
        await send();
        this.lastSendAtMs = Date.now();
        await recordSend(this.accountId);
        return true;
      }
    });
    this.accountSendQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async releaseInterruptedTarget(campaignId: string, targetId: string): Promise<void> {
    const [campaign] = await db.select({ status: campaigns.status }).from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.accountId, this.accountId))).limit(1);
    await db.update(campaignTargets).set({
      status: campaign?.status === 'STOPPED' ? 'CANCELLED' : 'QUEUED',
      errorMessage: campaign?.status === 'STOPPED' ? 'Campaign was stopped before this send.' : null,
    }).where(eq(campaignTargets.id, targetId));
  }

  /**
   * Pause a campaign because the account-wide daily send budget is spent. The
   * pause is durable (status + pauseReason) so a restart cannot silently
   * resume it, and the worker is woken so the pause takes effect immediately.
   *
   * Unlike the circuit breaker, this pause is self-clearing: auto_resume_at
   * records when the budget refills (the next UTC midnight) and a timer resumes
   * the campaign then, so a new day needs no operator action. The column is the
   * durable part — the timer is only this process's copy of it.
   */
  private async pauseForDailyBudget(id: string): Promise<void> {
    const resumeAt = new Date(Date.now() + this.pacing.dailyBudgetResetMs()).toISOString();
    await db.update(campaigns).set({
      status: 'PAUSED',
      pauseReason: `Daily send limit reached (${SEND_DAILY_LIMIT} messages). Sending resumes automatically when the budget resets at UTC midnight — no need to resume by hand.`,
      autoResumeAt: resumeAt,
    }).where(eq(campaigns.id, id));
    await db.insert(operationalLogs).values({ id: randomUUID(), level: 'warn', event: 'campaign.auto_paused', details: JSON.stringify({ campaignId: id, reason: 'daily_budget', autoResumeAt: resumeAt }), createdAt: now() });
    this.wakeWorker(id);
    this.armAutoResume(id, resumeAt);
  }

  /**
   * Arm (or re-arm) this process's timer for a budget auto-resume. The wait is
   * taken in chunks of at most 15 minutes so a suspended or clock-shifted
   * machine re-evaluates the deadline against the database instead of trusting
   * one long timer. Timers are unref'd: a pending resume never keeps the
   * process alive by itself.
   */
  private armAutoResume(id: string, resumeAt: string): void {
    this.clearAutoResumeTimer(id);
    const remainingMs = Math.max(1, Date.parse(resumeAt) - Date.now());
    const timer = setTimeout(() => {
      this.autoResumeTimers.delete(id);
      void this.applyAutoResume(id);
    }, Math.min(remainingMs, 15 * 60_000));
    timer.unref?.();
    this.autoResumeTimers.set(id, timer);
  }

  private clearAutoResumeTimer(id: string): void {
    const timer = this.autoResumeTimers.get(id);
    if (timer) clearTimeout(timer);
    this.autoResumeTimers.delete(id);
  }

  /**
   * Resume a campaign whose budget auto-resume is due. Everything is re-checked
   * against the database first, so a timer that fires early (a chunked wait), a
   * campaign an operator has since stopped or resumed, or a budget that is
   * somehow still spent all take the safe path: re-arm or do nothing. Never
   * resumes a campaign that is not PAUSED with an auto_resume_at of its own,
   * which is what keeps the circuit-breaker pause an operator-only recovery.
   */
  private async applyAutoResume(id: string): Promise<void> {
    const [campaign] = await db.select({ status: campaigns.status, autoResumeAt: campaigns.autoResumeAt })
      .from(campaigns).where(and(eq(campaigns.id, id), eq(campaigns.accountId, this.accountId))).limit(1);
    if (!campaign || campaign.status !== 'PAUSED' || !campaign.autoResumeAt) {
      this.clearAutoResumeTimer(id);
      return;
    }
    if (Date.parse(campaign.autoResumeAt) > Date.now()) {
      this.armAutoResume(id, campaign.autoResumeAt);
      return;
    }
    if (await sendsToday(this.accountId) >= SEND_DAILY_LIMIT) {
      // The budget is still spent (a clock change, or sends from elsewhere on
      // the account): wait out the next window rather than resuming into an
      // immediate re-pause.
      const nextResumeAt = new Date(Date.now() + this.pacing.dailyBudgetResetMs()).toISOString();
      await db.update(campaigns).set({ autoResumeAt: nextResumeAt }).where(eq(campaigns.id, id));
      this.armAutoResume(id, nextResumeAt);
      return;
    }
    await this.releaseStuckSendingRows(id);
    await db.update(campaigns).set({ status: 'RUNNING', pauseReason: null, autoResumeAt: null })
      .where(and(eq(campaigns.id, id), eq(campaigns.status, 'PAUSED')));
    await db.insert(operationalLogs).values({ id: randomUUID(), level: 'info', event: 'campaign.auto_resumed', details: JSON.stringify({ campaignId: id, reason: 'daily_budget' }), createdAt: now() });
    this.logger.info({ accountId: this.accountId, campaignId: id }, 'Daily send budget reset: resuming the campaign automatically');
    // A fresh run pass gets its own warm-up, like an operator start would.
    this.pendingWarmups.set(id, this.pacing.warmupSeconds());
    this.runWorker(id);
  }

  /**
   * Re-arm every pending budget auto-resume from the database: called after a
   * restart (recover) and whenever the account reconnects, so a resume whose
   * deadline passed while the process was down happens as soon as it is back.
   */
  private async sweepAutoResumes(): Promise<void> {
    const pending = await db.select({ id: campaigns.id, autoResumeAt: campaigns.autoResumeAt }).from(campaigns)
      .where(and(eq(campaigns.accountId, this.accountId), eq(campaigns.status, 'PAUSED'), sql`${campaigns.autoResumeAt} is not null`));
    for (const campaign of pending) {
      if (!campaign.autoResumeAt) continue;
      if (Date.parse(campaign.autoResumeAt) <= Date.now()) await this.applyAutoResume(campaign.id);
      else this.armAutoResume(campaign.id, campaign.autoResumeAt);
    }
  }

  /**
   * Pause every running campaign of the account after an unbroken run of send
   * failures. The pause is durable (status + pauseReason, like the daily-limit
   * auto-pause) so a restart cannot silently resume a campaign whose account
   * keeps failing; workers are woken so paused campaigns stop immediately.
   * Recovery is an operator action: Run again resumes the remaining queue, or
   * Stop then Run retries the failed sends. start()/runNow() clear the breaker.
   */
  private async tripCircuitBreaker(): Promise<void> {
    this.circuitOpen = true;
    const reason = `Paused automatically after ${CIRCUIT_BREAKER_CONSECUTIVE_FAILURES} consecutive send failures. Check the WhatsApp connection, then Run the campaign again to continue, or Stop then Run to retry failed sends.`;
    const running = await db.select({ id: campaigns.id }).from(campaigns)
      .where(and(eq(campaigns.accountId, this.accountId), eq(campaigns.status, 'RUNNING')));
    for (const campaign of running) {
      await db.update(campaigns).set({ status: 'PAUSED', pauseReason: reason }).where(eq(campaigns.id, campaign.id));
      await db.insert(operationalLogs).values({
        id: randomUUID(), level: 'error', event: 'campaign.auto_paused',
        details: JSON.stringify({ campaignId: campaign.id, reason: 'circuit_breaker' }), createdAt: now(),
      });
      this.wakeWorker(campaign.id);
    }
    this.logger.error({ accountId: this.accountId, paused: running.length }, 'Circuit breaker tripped: pausing every running campaign after consecutive send failures');
  }

  /** Banner text for the dashboard while the account circuit breaker is open. */
  public getCircuitWarning(): string | null {
    if (!this.circuitOpen) return null;
    return `Sends failed ${CIRCUIT_BREAKER_CONSECUTIVE_FAILURES} times in a row, so every running campaign was paused. Check the WhatsApp connection, then Run a campaign again to continue or Stop then Run to retry failed sends.`;
  }

  private async requireStatus(id: string, allowed: CampaignStatus[]) {
    const [campaign] = await db.select().from(campaigns).where(and(eq(campaigns.id, id), eq(campaigns.accountId, this.accountId))).limit(1);
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
    const running = await db.select({ id: campaigns.id }).from(campaigns).where(and(eq(campaigns.accountId, this.accountId), eq(campaigns.status, 'RUNNING')));
    for (const campaign of running) this.runWorker(campaign.id);
  }
}
