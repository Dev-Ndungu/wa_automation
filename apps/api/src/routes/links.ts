import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ScannerService } from '../scanner/service.js';
import type { WhatsAppManager } from '../whatsapp/manager.js';

const linkStatus = z.enum(['NEW', 'VIEWED', 'USED', 'ARCHIVED']);
const listQuery = z.object({
  status: linkStatus.optional(),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  groupJids: z.string().optional(),
  lookbackHours: z.coerce.number().positive().max(87600).optional(),
});
const scannerUpdate = z.object({ enabled: z.boolean() });
const linkUpdate = z.object({ status: linkStatus.optional(), notes: z.string().trim().max(2_000).nullable().optional() }).refine((value) => value.status !== undefined || value.notes !== undefined);

function escapeCsv(value: unknown): string {
  const stringValue = String(value ?? '');
  return /[",\r\n]/.test(stringValue) ? `"${stringValue.replaceAll('"', '""')}"` : stringValue;
}

export function linkRoutes(scanner: ScannerService, whatsapp: WhatsAppManager) {
  return async function routes(app: FastifyInstance): Promise<void> {
    app.get('/api/scanner/status', async () => ({ enabled: await scanner.isEnabled() }));
    app.get('/api/links/auto-join', async () => ({ enabled: await scanner.isAutoJoinEnabled() }));
    app.patch('/api/links/auto-join', async (request, reply) => {
      const parsed = scannerUpdate.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ message: 'enabled must be true or false.' });
      return { enabled: await scanner.setAutoJoinEnabled(parsed.data.enabled) };
    });
    app.patch('/api/scanner/status', async (request, reply) => {
      const parsed = scannerUpdate.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ message: 'enabled must be true or false.' });
      return { enabled: await scanner.setEnabled(parsed.data.enabled) };
    });

    app.get('/api/links', async (request, reply) => {
      const parsed = listQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ message: 'Invalid link query.' });
      const since = parsed.data.lookbackHours ? new Date(Date.now() - parsed.data.lookbackHours * 60 * 60 * 1_000).toISOString() : undefined;
      const groupJids = parsed.data.groupJids?.split(',').map((jid) => jid.trim()).filter((jid) => jid.endsWith('@g.us'));
      return scanner.listLinks({ ...parsed.data, groupJids, since });
    });
    app.patch('/api/links/:id', async (request, reply) => {
      const id = z.string().uuid().safeParse((request.params as { id?: string }).id);
      const parsed = linkUpdate.safeParse(request.body);
      if (!id.success || !parsed.success) return reply.code(400).send({ message: 'Invalid link update.' });
      const updated = await scanner.updateLink(id.data, parsed.data);
      return updated ?? reply.code(404).send({ message: 'Link not found.' });
    });
    app.post('/api/links/:id/join', async (request, reply) => {
      const id = z.string().uuid().safeParse((request.params as { id?: string }).id);
      if (!id.success) return reply.code(400).send({ message: 'Invalid link ID.' });
      const link = await scanner.getLink(id.data);
      if (!link) return reply.code(404).send({ message: 'Link not found.' });
      const groupJid = await whatsapp.joinGroup(link.inviteCode);
      await scanner.deleteLink(link.id);
      return { groupJid, inviteUrl: link.inviteUrl };
    });
    app.get('/api/links/export.csv', async (_request, reply) => {
      const rows = await scanner.exportLinks();
      const header = ['invite_url', 'source_group', 'first_seen', 'last_seen', 'times_seen', 'status'];
      const csv = [header.join(','), ...rows.map((row) => [row.inviteUrl, row.sourceGroup, row.firstSeen, row.lastSeen, row.timesSeen, row.status].map(escapeCsv).join(','))].join('\r\n');
      return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="whatsapp-group-links.csv"').send(csv);
    });
  };
}
