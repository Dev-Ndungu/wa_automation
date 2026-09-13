import makeWASocket, { Browsers, DisconnectReason, fetchLatestWaWebVersion, useMultiFileAuthState } from '@whiskeysockets/baileys';
import type { ConnectionState, WASocket } from '@whiskeysockets/baileys';
import type { FastifyBaseLogger } from 'fastify';
import QRCode from 'qrcode';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { groups, whatsappAccounts } from '../db/schema.js';
import { config } from '../config.js';
import { ScannerService } from '../scanner/service.js';
import { burstJoinDenied, dailyJoinDenied, drawReconnectBackoffSeconds, JOIN_BURST, JOIN_DAILY_LIMIT, joinsInWindow, joinsToday, lastJoinAt, recordJoin, RECONNECT_BACKOFF_TIERS, requiredJoinDelaySeconds } from '../safety/limits.js';

export type WhatsAppStatus = {
  state: 'DISCONNECTED' | 'CONNECTING' | 'QR_READY' | 'CONNECTED' | 'LOGGED_OUT';
  phone: string | null;
  lastConnectedAt: string | null;
  qrDataUrl: string | null;
  error: string | null;
};

const now = () => new Date().toISOString();
const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
// A fallback is kept for an offline machine. The normal path obtains the
// current public WhatsApp Web revision with a strict timeout before linking.
const whatsappWebVersion: [number, number, number] = [2, 3000, 1043857760];
// A stock, unbranded browser profile. The previous configuration sent a custom
// "WA Group Control" app identity in the login node and device properties,
// which no real browser would send; a plain Safari-on-macOS profile looks like
// an ordinary WhatsApp Web link and removes the most obvious self-report.
const whatsappBrowser = Browsers.macOS('Safari');

export class WhatsAppManager {
  private socket: WASocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  // Consecutive unrequested connection closes, keyed into the reconnect backoff
  // ladder (safety/limits.ts). Reset by any successful open or manual action.
  private consecutiveCloses = 0;
  // Set when WhatsApp actively refused the session (403): the next Link action
  // must start a fresh QR flow instead of reusing the refused credentials.
  private needsFreshLink = false;
  // Set by relink(true): the immediately following connect must not resurrect
  // a stored session from a backup, or a rejected session could never be
  // replaced by a new pairing.
  private skipRestoreNextConnect = false;
  // True while the current socket has shown a pairing QR. A close in that
  // state means the QR was never scanned (the server-issued refs simply ran
  // out), which is benign: a fresh QR must follow quickly instead of burning
  // the anti-restriction reconnect ladder on a session that never existed.
  private qrWasShown = false;
  private requestedDisconnect = false;
  private status: WhatsAppStatus = { state: 'DISCONNECTED', phone: null, lastConnectedAt: null, qrDataUrl: null, error: null };
  private listeners = new Set<(status: WhatsAppStatus) => void>();
  private groupJoinListeners = new Set<(group: { jid: string; name: string }) => void | Promise<void>>();
  private readonly authDir: string;
  // Keep a local recovery copy outside the live Baileys folder. A normal
  // restart can restore this copy if an interrupted process leaves the live
  // folder incomplete.
  private readonly authBackupDir: string;
  // Older local builds kept one flat backup folder for the main account.
  // Reading it (in addition to the per-account folder) keeps sessions
  // recoverable after an upgrade without forcing a new QR pairing.
  private readonly legacyAuthBackupDir: string | null;
  private authSnapshotPromise: Promise<void> = Promise.resolve();
  // Serializes manual join attempts so pacing limits always hold across them.
  private joinQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly logger: FastifyBaseLogger, private readonly scanner: ScannerService, authDir = config.WHATSAPP_AUTH_DIR, private readonly accountId = 'main') {
    this.authDir = authDir;
    this.authBackupDir = resolve(dirname(config.DATABASE_PATH), 'whatsapp-auth-backups', accountId);
    this.legacyAuthBackupDir = accountId === 'main' ? resolve(dirname(config.DATABASE_PATH), 'whatsapp-auth-backup') : null;
  }

  public getStatus(): WhatsAppStatus { return { ...this.status }; }
  public getSocket(): WASocket | null { return this.socket; }
  public subscribe(listener: (status: WhatsAppStatus) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  public subscribeGroupJoined(listener: (group: { jid: string; name: string }) => void | Promise<void>): () => void {
    this.groupJoinListeners.add(listener);
    return () => this.groupJoinListeners.delete(listener);
  }
  public hasSavedSession(): boolean {
    return this.hasSavedSessionAt(this.authDir);
  }

  /** True when a valid session can be recovered from a backup folder. */
  public hasRecoverableSession(): boolean {
    if (this.hasSavedSessionAt(this.authBackupDir)) return true;
    return this.legacyAuthBackupDir !== null && this.hasSavedSessionAt(this.legacyAuthBackupDir);
  }

  private hasSavedSessionAt(directory: string): boolean {
    const credentialsPath = resolve(directory, 'creds.json');
    if (!existsSync(credentialsPath)) return false;
    try {
      // Baileys creates a credentials file before a QR has been scanned. That
      // file is not a saved login and must never be mistaken for one on boot.
      const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8')) as {
        registered?: boolean;
        me?: { id?: string };
        account?: { details?: string };
      };
      // Newer WhatsApp multi-device registrations can retain `registered:
      // false` even after the account and device identity have been saved.
      // An account payload plus a device id is the durable evidence of a
      // completed link; a pre-QR file has neither, so it is still rejected.
      const hasLinkedIdentity = typeof credentials.me?.id === 'string'
        && typeof credentials.account?.details === 'string';
      return credentials.registered === true
        ? typeof credentials.me?.id === 'string'
        : hasLinkedIdentity;
    } catch {
      return false;
    }
  }

  public requestLink(): WhatsAppStatus {
    // The button is hidden while connected, but a stale client or a double
    // click must never open a second session alongside the live one.
    if (this.status.state === 'CONNECTED') return this.getStatus();
    const priorState = this.status.state;
    // Remember whether the automatic reconnect ladder had already stopped
    // before resetting it: a human click resets the ladder, but when every
    // automatic attempt with the stored session already failed, the click
    // must start a fresh QR instead of one more doomed round on it.
    const reconnectLadderExhausted = this.consecutiveCloses >= RECONNECT_BACKOFF_TIERS.length;
    // A deliberate human action restarts the backoff ladder: a manual link or
    // reconnect must never inherit the escalating penalty of the automatic one.
    this.consecutiveCloses = 0;
    this.setStatus({ state: 'CONNECTING', qrDataUrl: null, error: null });
    // A normal refresh/reconnect reuses the saved session (restoring it from
    // a backup when the live folder is empty). A fresh QR flow starts when
    // WhatsApp rejected the session, when no linked session exists anywhere,
    // when a QR is already on screen, or when the stored session has already
    // demonstrably failed (the reconnect ladder was exhausted). In the
    // non-rejected fresh-QR cases the backups are kept: only the live folder
    // is cleared, so a stored session can never steal the requested QR.
    const rejected = priorState === 'LOGGED_OUT' || this.needsFreshLink;
    const freshQr = rejected || !this.hasSavedSession() || priorState === 'QR_READY' || reconnectLadderExhausted;
    if (!freshQr) this.skipRestoreNextConnect = false;
    const link = freshQr ? this.relink(rejected || !this.hasRecoverableSession(), true)
      : this.start();
    void link.catch((error: unknown) => {
      this.setStatus({ state: 'DISCONNECTED', error: 'Could not begin WhatsApp linking. Try again.' });
      this.logger.error({ err: error }, 'Unable to begin WhatsApp linking');
    });
    return this.getStatus();
  }

  private setStatus(next: Partial<WhatsAppStatus>) {
    this.status = { ...this.status, ...next };
    for (const listener of this.listeners) listener(this.getStatus());
  }

  public async start(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.requestedDisconnect = false;
    this.connectPromise = this.connect().finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  private async connect(): Promise<void> {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try {
      // A fresh pairing request (relink) asks this connect to not resurrect a
      // stored session from a backup. The flag stays set until the socket
      // actually opens: an automatic reconnect after an unscanned QR expired
      // must regenerate a QR instead of stealing the requested pairing with
      // an old backup session.
      if (!this.skipRestoreNextConnect) await this.restoreAuthBackupIfNeeded();
      await mkdir(this.authDir, { recursive: true });
      this.setStatus({ state: 'CONNECTING', qrDataUrl: null, error: null });
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      const version = await this.getCompatibleWebVersion();
      this.qrWasShown = false;
      const socket = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: whatsappBrowser,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        logger: this.logger as never,
        generateHighQualityLinkPreview: false,
      });
      this.socket = socket;
      socket.ev.on('creds.update', () => {
        void saveCreds().then(() => this.queueAuthSnapshot()).catch((error: unknown) => {
          this.logger.error({ err: error }, 'Unable to save WhatsApp credentials');
        });
      });
      socket.ev.on('messages.upsert', ({ type, messages }) => {
        // Baileys emits history and local echo events too. The scanner only acts
        // on newly delivered inbound group messages.
        if (type !== 'notify') return;
        for (const message of messages) {
          void this.scanner.processIncomingMessage(message).catch((error: unknown) => {
            this.logger.error({ err: error, groupJid: message.key.remoteJid }, 'Unable to process incoming group message for invite links');
          });
        }
      });
      socket.ev.on('connection.update', (update) => {
        // One async handler that never rejects: a throwing handler here would
        // be an unhandled rejection that kills the whole API process.
        void this.handleConnectionUpdate(socket, update);
      });
    } catch (error) {
      // A failed open (disk trouble, offline version registry, …) must never
      // escape start() into an unhandled rejection, and must never retry in a
      // tight loop: the same backoff ladder as a dropped connection applies.
      this.socket = null;
      this.logger.error({ err: error }, 'Unable to open the WhatsApp connection');
      this.setStatus({ state: 'DISCONNECTED', qrDataUrl: null, error: 'Could not open WhatsApp. Check the internet connection, then press Link WhatsApp.' });
      if (!this.requestedDisconnect) this.scheduleReconnect();
    }
  }

  /** Handle one connection.update event without ever throwing into the event loop. */
  private async handleConnectionUpdate(socket: WASocket, update: Partial<ConnectionState>): Promise<void> {
    try {
      if (update.qr) {
        this.qrWasShown = true;
        this.setStatus({ state: 'QR_READY', qrDataUrl: await QRCode.toDataURL(update.qr), error: null });
        this.logger.info('WhatsApp QR is ready for local linking');
      }
      if (update.connection === 'open') {
        this.qrWasShown = false;
        this.consecutiveCloses = 0;
        this.needsFreshLink = false;
        // The fresh pairing completed: backup restoration is allowed again.
        this.skipRestoreNextConnect = false;
        const phone = socket.user?.id?.split(':')[0] ?? null;
        this.setStatus({ state: 'CONNECTED', phone, lastConnectedAt: now(), qrDataUrl: null, error: null });
        this.logger.info({ phone }, 'WhatsApp connected');
        try {
          if (phone) await db.update(whatsappAccounts).set({ phone, updatedAt: now() }).where(eq(whatsappAccounts.id, this.accountId));
          await this.syncGroups();
        } catch (error) {
          // Group fetch or settings writes must never take down a working
          // connection, or the process.
          this.logger.warn({ err: error }, 'Connected, but the initial group sync failed');
        }
        void this.queueAuthSnapshot();
      }
      if (update.connection === 'close') {
        // A previous socket can close after a fresh relink has begun. Its
        // event must not replace the new QR or connected status.
        if (this.socket !== socket) return;
        const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        this.socket = null;
        if (this.requestedDisconnect) {
          this.setStatus({ state: 'DISCONNECTED', qrDataUrl: null });
          return;
        }
        if (loggedOut) {
          this.setStatus({ state: 'LOGGED_OUT', qrDataUrl: null, error: 'WhatsApp session logged out. Re-link the device.' });
          this.logger.warn('WhatsApp session logged out');
          return;
        }
        // A 403 means WhatsApp actively refused the session (typically a
        // restricted or banned number). Reconnecting into it automatically
        // would only reinforce the restriction, so stop, and make the next
        // Link action start a fresh pairing instead of reusing it.
        if (code === DisconnectReason.forbidden) {
          this.needsFreshLink = true;
          this.setStatus({ state: 'DISCONNECTED', qrDataUrl: null, error: 'WhatsApp refused the connection (403). The number may be restricted. Automatic reconnects are stopped; use the phone normally for a while before relinking.' });
          this.logger.warn({ code }, 'WhatsApp refused the connection; automatic reconnect stopped');
          return;
        }
        // The socket only ever showed a pairing QR: the server-issued refs ran
        // out before anyone scanned. That is not a failing session and must
        // not escalate the reconnect ladder (or stop it after a few rounds).
        // Regenerate a fresh QR after a short pause and keep doing so until
        // the phone actually scans one — an on-screen QR is then always live.
        if (this.qrWasShown) {
          this.qrWasShown = false;
          this.setStatus({ state: 'DISCONNECTED', qrDataUrl: null, error: 'The QR expired before it was scanned. A fresh one is being generated.' });
          this.logger.info('WhatsApp QR was not scanned before its refs expired; regenerating a fresh QR shortly');
          this.reconnectTimer = setTimeout(() => void this.start(), 3_000);
          return;
        }
        this.scheduleReconnect();
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Error while handling a WhatsApp connection update');
    }
  }

  /**
   * Escalate the wait with every consecutive unrequested close (frozen tiers,
   * see safety/limits.ts) so a rejected or restricted session is never
   * hammered by automatic reconnect attempts.
   */
  private scheduleReconnect(): void {
    this.consecutiveCloses += 1;
    const backoffSeconds = drawReconnectBackoffSeconds(this.consecutiveCloses);
    if (backoffSeconds === null) {
      this.setStatus({ state: 'DISCONNECTED', qrDataUrl: null, error: 'Connection lost repeatedly; automatic reconnect stopped. Press Link WhatsApp to reconnect.' });
      this.logger.warn({ closes: this.consecutiveCloses }, 'WhatsApp disconnected repeatedly; automatic reconnect stopped');
      return;
    }
    const waitLabel = backoffSeconds < 60 ? `${backoffSeconds} seconds` : `about ${Math.round(backoffSeconds / 60)} minutes`;
    this.setStatus({ state: 'DISCONNECTED', qrDataUrl: null, error: `Connection lost; reconnecting in ${waitLabel}.` });
    this.logger.warn({ closes: this.consecutiveCloses, backoffSeconds }, 'WhatsApp disconnected; scheduling reconnect');
    this.reconnectTimer = setTimeout(() => void this.start(), backoffSeconds * 1_000);
  }

  public async syncGroups(): Promise<number> {
    if (!this.socket || this.status.state !== 'CONNECTED') throw new Error('WhatsApp is not connected.');
    const available = await this.socket.groupFetchAllParticipating();
    const syncedAt = now();
    for (const [jid, metadata] of Object.entries(available)) {
      await db.insert(groups).values({
        id: randomUUID(), accountId: this.accountId, whatsappGroupJid: jid, name: metadata.subject || jid, description: metadata.desc ?? null,
        isTarget: false, isScannerEnabled: true, isExcluded: false, lastSyncedAt: syncedAt, createdAt: syncedAt, updatedAt: syncedAt,
      }).onConflictDoUpdate({ target: [groups.accountId, groups.whatsappGroupJid], set: { name: metadata.subject || jid, description: metadata.desc ?? null, lastSyncedAt: syncedAt, updatedAt: syncedAt } });
    }
    this.logger.info({ groups: Object.keys(available).length }, 'WhatsApp group sync completed');
    return Object.keys(available).length;
  }

  public async joinGroup(inviteCode: string): Promise<string> {
    const run = this.joinQueue.then(async () => {
      if (!this.socket || this.status.state !== 'CONNECTED') throw new Error('WhatsApp is not connected.');
      if (burstJoinDenied(await joinsInWindow(this.accountId, JOIN_BURST.windowMinutes * 60_000))) throw new Error(`Join limit reached: at most ${JOIN_BURST.limit} joins per ${JOIN_BURST.windowMinutes} minutes. Try again later.`);
      if (dailyJoinDenied(await joinsToday(this.accountId))) throw new Error(`Daily join limit reached: at most ${JOIN_DAILY_LIMIT} joins per day. Try again tomorrow.`);
      // Random wait between joins is built in (see safety/limits.ts); the queue
      // wait below is the only place joins are throttled.
      const required = requiredJoinDelaySeconds(await lastJoinAt(this.accountId));
      if (required > 0) await wait(required * 1_000);
      const groupJid = await this.socket.groupAcceptInvite(inviteCode);
      if (!groupJid) throw new Error('WhatsApp did not confirm that the group was joined.');
      await this.syncGroups();
      await db.update(groups).set({ joinedAt: new Date().toISOString() }).where(and(eq(groups.accountId, this.accountId), eq(groups.whatsappGroupJid, groupJid)));
      const [group] = await db.select({ name: groups.name }).from(groups).where(and(eq(groups.accountId, this.accountId), eq(groups.whatsappGroupJid, groupJid))).limit(1);
      if (group) {
        for (const listener of this.groupJoinListeners) void listener({ jid: groupJid, name: group.name });
      }
      await recordJoin(this.accountId, groupJid);
      this.logger.info({ groupJid }, 'Joined WhatsApp group from an explicitly selected invite link');
      return groupJid;
    });
    this.joinQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  public async getGroupInviteLink(groupJid: string): Promise<string> {
    if (!this.socket || this.status.state !== 'CONNECTED') throw new Error('WhatsApp is not connected.');
    const inviteCode = await this.socket.groupInviteCode(groupJid);
    return `https://chat.whatsapp.com/${inviteCode}`;
  }

  public async disconnect(): Promise<void> {
    this.requestedDisconnect = true;
    // A deliberate disconnect is not part of the automatic-close streak.
    this.consecutiveCloses = 0;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      // Do not make a new QR wait for an old websocket's close handshake.
      // The connection listener ignores this old socket once it is replaced.
      void socket.ws.close();
    }
    this.setStatus({ state: 'DISCONNECTED', qrDataUrl: null });
  }

  public async relink(clearRejectedSession = false, skipRestore = false): Promise<void> {
    await this.disconnect();
    // Do not delete credentials during an ordinary reconnect. A deliberate
    // fresh QR flow is the exception: WhatsApp has already rejected the
    // session, so the live and per-account backup copies are removed to
    // prevent restoring the same rejected credentials, and the next connect
    // skips backup restoration entirely. The legacy backup folder is left
    // untouched as a last-resort recovery record. A QR regeneration without
    // a rejection (skipRestore) also skips restoration and removes only the
    // live folder when it still holds a linked session: backups survive, but
    // the old identity cannot be handed to the socket that must show a QR.
    if (clearRejectedSession || skipRestore) {
      this.skipRestoreNextConnect = true;
    }
    if (clearRejectedSession) {
      await rm(this.authDir, { recursive: true, force: true });
      await rm(this.authBackupDir, { recursive: true, force: true });
    } else if (skipRestore && this.hasSavedSession()) {
      await rm(this.authDir, { recursive: true, force: true });
    }
    await this.start();
  }

  private async restoreAuthBackupIfNeeded(): Promise<void> {
    if (this.hasSavedSession()) return;
    const candidates = [this.authBackupDir];
    if (this.legacyAuthBackupDir) candidates.push(this.legacyAuthBackupDir);
    for (const candidate of candidates) {
      if (!this.hasSavedSessionAt(candidate)) continue;
      await rm(this.authDir, { recursive: true, force: true });
      await cp(candidate, this.authDir, { recursive: true, force: true });
      this.logger.info({ from: candidate }, 'Restored saved WhatsApp session from local backup');
      return;
    }
  }

  private queueAuthSnapshot(): Promise<void> {
    this.authSnapshotPromise = this.authSnapshotPromise
      .then(async () => {
        if (!this.hasSavedSession()) return;
        await rm(this.authBackupDir, { recursive: true, force: true });
        await cp(this.authDir, this.authBackupDir, { recursive: true, force: true });
      })
      .catch((error: unknown) => {
        this.logger.error({ err: error }, 'Unable to back up WhatsApp credentials');
      });
    return this.authSnapshotPromise;
  }

  private async getCompatibleWebVersion(): Promise<[number, number, number]> {
    const latest = await fetchLatestWaWebVersion({ signal: AbortSignal.timeout(7_000) });
    if (latest.isLatest) return latest.version as [number, number, number];
    this.logger.warn({ err: latest.error }, 'Could not retrieve the current WhatsApp Web version; using offline fallback');
    return whatsappWebVersion;
  }
}
