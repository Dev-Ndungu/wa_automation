import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { resolve } from 'node:path';
import { CampaignService } from '../campaigns/service.js';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { whatsappAccounts } from '../db/schema.js';
import { ScannerService } from '../scanner/service.js';
import { WhatsAppManager } from '../whatsapp/manager.js';

const MAIN_ACCOUNT_ID = 'main';
const now = () => new Date().toISOString();

export type AccountRuntime = {
  id: string;
  scanner: ScannerService;
  whatsapp: WhatsAppManager;
  campaigns: CampaignService;
};

export class AccountService {
  private runtimes = new Map<string, AccountRuntime>();

  public constructor(private readonly logger: FastifyBaseLogger) {}

  public async initialize(): Promise<void> {
    const accounts = await db.select().from(whatsappAccounts);
    for (const account of accounts) {
      const runtime = this.createRuntime(account.id);
      await runtime.campaigns.recover();
      if (runtime.whatsapp.hasSavedSession()) void runtime.whatsapp.start();
    }
  }

  public async list() {
    const accounts = await db.select().from(whatsappAccounts).orderBy(whatsappAccounts.createdAt);
    return accounts.map((account) => ({ ...account, status: this.createRuntime(account.id).whatsapp.getStatus() }));
  }

  public async create(nameInput: unknown) {
    if (typeof nameInput !== 'string' || !nameInput.trim() || nameInput.trim().length > 80) {
      throw new Error('Account name must be between 1 and 80 characters.');
    }
    const name = nameInput.trim();
    const [existing] = await db.select({ id: whatsappAccounts.id }).from(whatsappAccounts).where(eq(whatsappAccounts.name, name)).limit(1);
    if (existing) throw new Error('An account with this name already exists.');
    const id = randomUUID();
    const createdAt = now();
    await db.insert(whatsappAccounts).values({ id, name, phone: null, createdAt, updatedAt: createdAt });
    const runtime = this.createRuntime(id);
    return { id, name, phone: null, createdAt, updatedAt: createdAt, status: runtime.whatsapp.getStatus() };
  }

  public async get(accountId: string | undefined): Promise<AccountRuntime> {
    const id = accountId || MAIN_ACCOUNT_ID;
    const [account] = await db.select({ id: whatsappAccounts.id }).from(whatsappAccounts).where(eq(whatsappAccounts.id, id)).limit(1);
    if (!account) throw new Error('WhatsApp account not found. Select an available account.');
    return this.createRuntime(id);
  }

  private createRuntime(accountId: string): AccountRuntime {
    const existing = this.runtimes.get(accountId);
    if (existing) return existing;
    const authDir = accountId === MAIN_ACCOUNT_ID
      ? config.WHATSAPP_AUTH_DIR
      : resolve(config.WHATSAPP_AUTH_DIR, '..', 'accounts', accountId);
    const scanner = new ScannerService(this.logger, accountId);
    const whatsapp = new WhatsAppManager(this.logger, scanner, authDir, accountId);
    const campaigns = new CampaignService(whatsapp, this.logger, accountId);
    const runtime = { id: accountId, scanner, whatsapp, campaigns };
    this.runtimes.set(accountId, runtime);
    return runtime;
  }
}
