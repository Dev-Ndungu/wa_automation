import type { FastifyInstance } from 'fastify';
import type { AccountService } from '../accounts/service.js';
import { accountIdFrom } from './accounts.js';

function idFrom(request: { params: unknown }): string {
  const id = (request.params as { id?: unknown }).id;
  if (typeof id !== 'string' || !id) throw new Error('Campaign ID is required.');
  return id;
}

export function campaignRoutes(accounts: AccountService) {
  return async function routes(app: FastifyInstance): Promise<void> {
    app.get('/api/campaigns', async (request) => (await accounts.get(accountIdFrom(request))).campaigns.list());
    app.get('/api/campaigns/:id', async (request) => (await accounts.get(accountIdFrom(request))).campaigns.get(idFrom(request)));
    app.post('/api/campaigns/source-messages/manual', async (request) => (await accounts.get(accountIdFrom(request))).campaigns.captureManualSource(request.body as never));
    app.post('/api/campaigns', async (request) => (await accounts.get(accountIdFrom(request))).campaigns.create(request.body as never));
    app.put('/api/campaigns/:id', async (request, reply) => {
      try {
        return await (await accounts.get(accountIdFrom(request))).campaigns.update(idFrom(request), request.body as never);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not save campaign changes.';
        return reply.code(400).send({ message });
      }
    });
    app.post('/api/campaigns/:id/start', async (request) => (await accounts.get(accountIdFrom(request))).campaigns.start(idFrom(request)));
    app.post('/api/campaigns/:id/run-now', async (request) => (await accounts.get(accountIdFrom(request))).campaigns.runNow(idFrom(request)));
    app.post('/api/campaigns/:id/pause', async (request) => (await accounts.get(accountIdFrom(request))).campaigns.pause(idFrom(request)));
    app.post('/api/campaigns/:id/resume', async (request) => (await accounts.get(accountIdFrom(request))).campaigns.resume(idFrom(request)));
    app.post('/api/campaigns/:id/stop', async (request) => (await accounts.get(accountIdFrom(request))).campaigns.stop(idFrom(request)));
    app.post('/api/campaigns/stop-all', async (request) => (await accounts.get(accountIdFrom(request))).campaigns.stopAll());
  };
}
