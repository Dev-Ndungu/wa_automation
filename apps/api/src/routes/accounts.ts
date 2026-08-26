import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AccountService } from '../accounts/service.js';

const createAccount = z.object({ name: z.string().trim().min(1).max(80) });

export function accountIdFrom(request: { headers: Record<string, unknown>; query?: unknown }): string | undefined {
  const value = request.headers['x-whatsapp-account-id'];
  if (typeof value === 'string' && value) return value;
  const queryValue = typeof request.query === 'object' && request.query !== null ? (request.query as { accountId?: unknown }).accountId : undefined;
  return typeof queryValue === 'string' && queryValue ? queryValue : undefined;
}

export function accountRoutes(accounts: AccountService) {
  return async function routes(app: FastifyInstance): Promise<void> {
    app.get('/api/accounts', async () => accounts.list());
    app.post('/api/accounts', async (request, reply) => {
      const parsed = createAccount.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ message: 'Enter an account name of up to 80 characters.' });
      try { return await accounts.create(parsed.data.name); }
      catch (error) { return reply.code(400).send({ message: error instanceof Error ? error.message : 'Could not create account.' }); }
    });
  };
}
