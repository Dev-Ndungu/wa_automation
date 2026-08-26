import type { FastifyInstance } from 'fastify';
import { and, asc, eq, like, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { groups } from '../db/schema.js';
import type { AccountService } from '../accounts/service.js';
import { accountIdFrom } from './accounts.js';

const updateSchema = z.object({ isTarget: z.boolean().optional(), isScannerEnabled: z.boolean().optional(), isExcluded: z.boolean().optional() }).refine((value) => Object.keys(value).length > 0);

export function groupRoutes(accounts: AccountService) {
  return async function routes(app: FastifyInstance): Promise<void> {
  app.get('/api/groups', async (request) => {
    const account = await accounts.get(accountIdFrom(request));
    const search = typeof (request.query as { search?: unknown }).search === 'string' ? (request.query as { search: string }).search.trim() : '';
    const searchFilter = search ? or(like(groups.name, `%${search}%`), like(groups.whatsappGroupJid, `%${search}%`)) : undefined;
    return db.select().from(groups).where(searchFilter ? and(eq(groups.accountId, account.id), searchFilter) : eq(groups.accountId, account.id)).orderBy(asc(groups.name));
  });
  app.patch('/api/groups/:jid', async (request, reply) => {
    const account = await accounts.get(accountIdFrom(request));
    const jid = decodeURIComponent(String((request.params as { jid?: string }).jid ?? ''));
    const parsed = updateSchema.safeParse(request.body);
    if (!jid || !parsed.success) return reply.code(400).send({ message: 'Invalid group update.' });
    const updatedAt = new Date().toISOString();
    const changes = parsed.data.isExcluded ? { ...parsed.data, isScannerEnabled: false, isTarget: false } : parsed.data;
    const updated = await db.update(groups).set({ ...changes, updatedAt }).where(and(eq(groups.accountId, account.id), eq(groups.whatsappGroupJid, jid))).returning();
    return updated[0] ?? reply.code(404).send({ message: 'Group not found.' });
  });
    app.get('/api/groups/:jid/invite-link', async (request, reply) => {
      const account = await accounts.get(accountIdFrom(request));
      const jid = decodeURIComponent(String((request.params as { jid?: string }).jid ?? ''));
      if (!jid.endsWith('@g.us')) return reply.code(400).send({ message: 'Invalid WhatsApp group.' });
      return { inviteUrl: await account.whatsapp.getGroupInviteLink(jid) };
    });
  };
}
