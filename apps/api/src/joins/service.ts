import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { randomUUID } from 'node:crypto';
import { db } from '../db/client.js';
import { joinQueue } from '../db/schema.js';
import { deduplicateInviteLinks, extractInviteLinks } from '../scanner/extract.js';
import {
  burstJoinDenied,
  dailyJoinDenied,
  JOIN_BURST,
  joinsInWindow,
  joinsToday,
  lastJoinAt,
  millisecondsUntilDailyBudgetResets,
  millisecondsUntilJoinWindowOpens,
  requiredJoinDelaySeconds,
} from '../safety/limits.js';
import type { WhatsAppManager } from '../whatsapp/manager.js';

const now = () => new Date().toISOString();
const TICK_MS = 60_000;

export type JoinQueueEnqueueInput = { text?: unknown; links?: unknown };

/**
 * A persistent, account-scoped queue of group invite links. The background
 * processor joins exactly one group at a time, gated by the same
 * anti-restriction policy as manual joins (safety/limits.ts): a random 30-90
 * minute gap between joins, a per-day ceiling, and daytime-only operation.
 * Every item is durable, so a restart never loses the queued links.
 */
export class JoinQueueService {
  private timer: NodeJS.Timeout | null = null;
  private processing = false;

  public constructor(
    private readonly whatsapp: WhatsAppManager,
    private readonly logger: FastifyBaseLogger,
    private readonly accountId = 'main',
  ) {}

  public start(): void {
    this.stop();
    this.timer = setInterval(() => void this.processNextDue(), TICK_MS);
    void this.processNextDue();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Parse pasted text and/or an explicit URL list into queued join rows. */
  public async enqueue(input: JoinQueueEnqueueInput): Promise<{ added: number; skipped: number; queued: number }> {
    const textParts: string[] = [];
    if (typeof input.text === 'string' && input.text.trim()) textParts.push(input.text);
    if (Array.isArray(input.links)) {
      for (const link of input.links) {
        if (typeof link === 'string' && link.trim()) textParts.push(link);
      }
    }
    const links = deduplicateInviteLinks(extractInviteLinks(textParts.join('\n')));
    if (!links.length) throw new Error('No valid WhatsApp group invite links found in that list.');

    const [positionRow] = await db.select({ max: sql<number | null>`MAX(${joinQueue.position})` })
      .from(joinQueue)
      .where(eq(joinQueue.accountId, this.accountId));
    let position = Number(positionRow?.max ?? -1) + 1;
    const createdAt = now();
    let added = 0;
    for (const link of links) {
      const inserted = await db.insert(joinQueue).values({
        id: randomUUID(),
        accountId: this.accountId,
        inviteUrl: link.inviteUrl,
        inviteCode: link.inviteCode,
        status: 'QUEUED',
        groupJid: null,
        errorMessage: null,
        position,
        createdAt,
        joinedAt: null,
        failedAt: null,
      }).onConflictDoNothing({ target: [joinQueue.accountId, joinQueue.inviteUrl] }).returning({ id: joinQueue.id });
      if (inserted.length) {
        added += 1;
        position += 1;
      }
    }
    const skipped = links.length - added;
    this.logger.info({ accountId: this.accountId, added, skipped }, 'Bulk join queue: links enqueued');

    const [queuedRow] = await db.select({ count: sql<number>`count(*)` }).from(joinQueue)
      .where(and(eq(joinQueue.accountId, this.accountId), eq(joinQueue.status, 'QUEUED')));
    return { added, skipped, queued: Number(queuedRow?.count ?? 0) };
  }

  public async list() {
    const items = await db.select().from(joinQueue)
      .where(eq(joinQueue.accountId, this.accountId))
      .orderBy(asc(joinQueue.position), asc(joinQueue.createdAt));
    const status = this.whatsapp.getStatus();
    return {
      connected: status.state === 'CONNECTED',
      windowOpen: millisecondsUntilJoinWindowOpens() === 0,
      dailyLimitReached: dailyJoinDenied(await joinsToday(this.accountId)),
      estimatedNextJoinAt: await this.estimateNextJoinAt(),
      items,
    };
  }

  public async cancel(id: string) {
    const cancelled = await db.update(joinQueue).set({ status: 'CANCELLED', failedAt: now() })
      .where(and(eq(joinQueue.id, id), eq(joinQueue.accountId, this.accountId), eq(joinQueue.status, 'QUEUED')))
      .returning();
    return cancelled[0] ?? null;
  }

  public async clear(): Promise<number> {
    const pending = await db.select({ id: joinQueue.id }).from(joinQueue)
      .where(and(eq(joinQueue.accountId, this.accountId), eq(joinQueue.status, 'QUEUED')));
    if (pending.length) {
      await db.delete(joinQueue).where(and(eq(joinQueue.accountId, this.accountId), eq(joinQueue.status, 'QUEUED')));
    }
    return pending.length;
  }

  /** Join one due group, or do nothing when the account, window, limits, or pacing gate it. */
  public async processNextDue(): Promise<void> {
    if (this.processing) return;
    if (this.whatsapp.getStatus().state !== 'CONNECTED') return;
    if (millisecondsUntilJoinWindowOpens() > 0) return;
    if (dailyJoinDenied(await joinsToday(this.accountId))) return;

    const next = await this.nextQueued();
    if (!next) return;
    if (burstJoinDenied(await joinsInWindow(this.accountId, JOIN_BURST.windowMinutes * 60_000))) return;
    if (requiredJoinDelaySeconds(await lastJoinAt(this.accountId)) > 0) return;

    this.processing = true;
    try {
      const groupJid = await this.whatsapp.joinGroup(next.inviteCode);
      await db.update(joinQueue).set({ status: 'JOINED', groupJid, joinedAt: now(), errorMessage: null, failedAt: null })
        .where(and(eq(joinQueue.id, next.id), eq(joinQueue.accountId, this.accountId)));
      this.logger.info({ accountId: this.accountId, inviteCode: next.inviteCode, groupJid }, 'Bulk join queue: group joined');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not join this group.';
      if (this.isRetryableJoinError(message)) {
        // Keep the item queued; the next tick retries once pacing, the window,
        // or the daily budget permit it again.
        this.logger.warn({ accountId: this.accountId, inviteCode: next.inviteCode, err: error }, 'Bulk join queue: join deferred');
      } else {
        await db.update(joinQueue).set({ status: 'FAILED', errorMessage: message, failedAt: now() })
          .where(and(eq(joinQueue.id, next.id), eq(joinQueue.accountId, this.accountId)));
        this.logger.warn({ accountId: this.accountId, inviteCode: next.inviteCode, err: error }, 'Bulk join queue: join failed');
      }
    } finally {
      this.processing = false;
    }
  }

  private async nextQueued() {
    const [row] = await db.select().from(joinQueue)
      .where(and(eq(joinQueue.accountId, this.accountId), eq(joinQueue.status, 'QUEUED')))
      .orderBy(asc(joinQueue.position), asc(joinQueue.createdAt))
      .limit(1);
    return row ?? null;
  }

  private async estimateNextJoinAt(): Promise<string | null> {
    if (!(await this.nextQueued())) return null;
    if (this.whatsapp.getStatus().state !== 'CONNECTED') return null;
    const candidates: number[] = [];
    if (dailyJoinDenied(await joinsToday(this.accountId))) {
      candidates.push(Date.now() + millisecondsUntilDailyBudgetResets());
    }
    const windowMs = millisecondsUntilJoinWindowOpens();
    if (windowMs > 0) candidates.push(Date.now() + windowMs);
    const last = await lastJoinAt(this.accountId);
    if (last) candidates.push(Date.now() + requiredJoinDelaySeconds(last) * 1_000);
    return new Date(Math.max(Date.now(), ...candidates)).toISOString();
  }

  private isRetryableJoinError(message: string): boolean {
    return /not connected|limit reached|try again/i.test(message);
  }
}
