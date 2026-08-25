import makeWASocket, { Browsers, DisconnectReason, fetchLatestWaWebVersion, useMultiFileAuthState } from '@whiskeysockets/baileys';
import type { WASocket } from '@whiskeysockets/baileys';
import type { FastifyBaseLogger } from 'fastify';
import QRCode from 'qrcode';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from '../db/client.js';
import { groups } from '../db/schema.js';
import { config } from '../config.js';
import { ScannerService } from '../scanner/service.js';

export type WhatsAppStatus = {
  state: 'DISCONNECTED' | 'CONNECTING' | 'QR_READY' | 'CONNECTED' | 'LOGGED_OUT';
  phone: string | null;
  lastConnectedAt: string | null;
  qrDataUrl: string | null;
  error: string | null;
};

const now = () => new Date().toISOString();
// A fallback is kept for an offline machine. The normal path obtains the
// current public WhatsApp Web revision with a strict timeout before linking.
const whatsappWebVersion: [number, number, number] = [2, 3000, 1043857760];

export class WhatsAppManager {
  private socket: WASocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private requestedDisconnect = false;
  private status: WhatsAppStatus = { state: 'DISCONNECTED', phone: null, lastConnectedAt: null, qrDataUrl: null, error: null };
  private listeners = new Set<(status: WhatsAppStatus) => void>();
  private readonly authDir = config.WHATSAPP_AUTH_DIR;
  // Keep a local recovery copy outside the live Baileys folder. A normal
  // restart can restore this copy if an interrupted process leaves the live
  // folder incomplete.
  private readonly authBackupDir = resolve(dirname(config.DATABASE_PATH), 'whatsapp-auth-backup');
  private authSnapshotPromise: Promise<void> = Promise.resolve();

  public constructor(private readonly logger: FastifyBaseLogger, private readonly scanner: ScannerService) {
    scanner.setAutoJoinHandler(async (inviteCode) => { await this.joinGroup(inviteCode); });
  }

  public getStatus(): WhatsAppStatus { return { ...this.status }; }
  public getSocket(): WASocket | null { return this.socket; }
  public subscribe(listener: (status: WhatsAppStatus) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  public hasSavedSession(): boolean {
    return this.hasSavedSessionAt(this.authDir);
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
    const priorState = this.status.state;
    this.setStatus({ state: 'CONNECTING', qrDataUrl: null, error: null });
    // A normal refresh/reconnect always reuses the saved session. Only a
    // deliberate Link WhatsApp action after WhatsApp itself has rejected the
    // session is allowed to start a fresh QR flow.
    const link = priorState === 'LOGGED_OUT' || !this.hasSavedSession()
      ? this.relink(true)
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
    await this.restoreAuthBackupIfNeeded();
    await mkdir(this.authDir, { recursive: true });
    this.setStatus({ state: 'CONNECTING', qrDataUrl: null, error: null });
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const version = await this.getCompatibleWebVersion();
    const socket = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('WA Group Control'),
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
    socket.ev.on('connection.update', async (update) => {
      if (update.qr) {
        this.setStatus({ state: 'QR_READY', qrDataUrl: await QRCode.toDataURL(update.qr), error: null });
        this.logger.info('WhatsApp QR is ready for local linking');
      }
      if (update.connection === 'open') {
        const phone = socket.user?.id?.split(':')[0] ?? null;
        this.setStatus({ state: 'CONNECTED', phone, lastConnectedAt: now(), qrDataUrl: null, error: null });
        this.logger.info({ phone }, 'WhatsApp connected');
        void this.queueAuthSnapshot();
        await this.syncGroups();
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
        this.setStatus({ state: 'DISCONNECTED', qrDataUrl: null, error: 'Connection lost; reconnecting.' });
        this.logger.warn({ code }, 'WhatsApp disconnected; scheduling reconnect');
        this.reconnectTimer = setTimeout(() => void this.start(), 3_000);
      }
    });
  }

  public async syncGroups(): Promise<number> {
    if (!this.socket || this.status.state !== 'CONNECTED') throw new Error('WhatsApp is not connected.');
    const available = await this.socket.groupFetchAllParticipating();
    const syncedAt = now();
    for (const [jid, metadata] of Object.entries(available)) {
      await db.insert(groups).values({
        id: randomUUID(), whatsappGroupJid: jid, name: metadata.subject || jid, description: metadata.desc ?? null,
        isTarget: false, isScannerEnabled: true, isExcluded: false, lastSyncedAt: syncedAt, createdAt: syncedAt, updatedAt: syncedAt,
      }).onConflictDoUpdate({ target: groups.whatsappGroupJid, set: { name: metadata.subject || jid, description: metadata.desc ?? null, lastSyncedAt: syncedAt, updatedAt: syncedAt } });
    }
    this.logger.info({ groups: Object.keys(available).length }, 'WhatsApp group sync completed');
    return Object.keys(available).length;
  }

  public async joinGroup(inviteCode: string): Promise<string> {
    if (!this.socket || this.status.state !== 'CONNECTED') throw new Error('WhatsApp is not connected.');
    const groupJid = await this.socket.groupAcceptInvite(inviteCode);
    if (!groupJid) throw new Error('WhatsApp did not confirm that the group was joined.');
    await this.syncGroups();
    this.logger.info({ groupJid }, 'Joined WhatsApp group from an explicitly selected invite link');
    return groupJid;
  }

  public async getGroupInviteLink(groupJid: string): Promise<string> {
    if (!this.socket || this.status.state !== 'CONNECTED') throw new Error('WhatsApp is not connected.');
    const inviteCode = await this.socket.groupInviteCode(groupJid);
    return `https://chat.whatsapp.com/${inviteCode}`;
  }

  public async disconnect(): Promise<void> {
    this.requestedDisconnect = true;
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

  public async relink(clearRejectedSession = false): Promise<void> {
    await this.disconnect();
    // Do not delete credentials during an ordinary reconnect. If WhatsApp has
    // explicitly rejected the session and the user presses Link WhatsApp,
    // clear only the live copy so a new QR can be generated; the last known
    // good copy is kept as a recovery record. A deliberate fresh QR flow is
    // the exception: WhatsApp has already rejected that session, so remove
    // both copies to prevent restoring the same rejected credentials.
    if (clearRejectedSession) {
      await rm(this.authDir, { recursive: true, force: true });
      await rm(this.authBackupDir, { recursive: true, force: true });
    }
    await this.start();
  }

  private async restoreAuthBackupIfNeeded(): Promise<void> {
    if (this.hasSavedSession() || !this.hasSavedSessionAt(this.authBackupDir)) return;
    await rm(this.authDir, { recursive: true, force: true });
    await cp(this.authBackupDir, this.authDir, { recursive: true, force: true });
    this.logger.info('Restored saved WhatsApp session from local backup');
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
