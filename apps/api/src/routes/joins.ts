import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AccountService } from '../accounts/service.js';
import { accountIdFrom } from './accounts.js';

const enqueueSchema = z.object({
  text: z.string().max(200_000).optional(),
  links: z.array(z.string().max(2_000)).max(5_000).optional(),
}).refine((value) => value.text !== undefined || value.links !== undefined, {
  message: 'Provide a text block or a links array of WhatsApp invite links.',
});

export function joinRoutes(accounts: AccountService) {
  return async function routes(app: FastifyInstance): Promise<void> {
    app.get('/api/joins', async (request) => (await accounts.get(accountIdFrom(request))).joins.list());
    app.post('/api/joins', async (request, reply) => {
      const parsed = enqueueSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ message: parsed.error.issues[0]?.message ?? 'Invalid join queue request.' });
      try {
        const joins = (await accounts.get(accountIdFrom(request))).joins;
        const result = await joins.enqueue(parsed.data);
        // Kick the processor so a freshly pasted list starts joining promptly
        // instead of waiting for the next minute tick.
        void joins.processNextDue();
        return result;
      } catch (error) {
        return reply.code(400).send({ message: error instanceof Error ? error.message : 'Could not queue the links.' });
      }
    });
    app.delete('/api/joins/:id', async (request, reply) => {
      const id = z.string().uuid().safeParse((request.params as { id?: string }).id);
      if (!id.success) return reply.code(400).send({ message: 'Invalid queue ID.' });
      const item = await (await accounts.get(accountIdFrom(request))).joins.cancel(id.data);
      return item ?? reply.code(404).send({ message: 'Queued item not found.' });
    });
    app.post('/api/joins/clear', async (request) => ({ removed: await (await accounts.get(accountIdFrom(request))).joins.clear() }));
  };
}
