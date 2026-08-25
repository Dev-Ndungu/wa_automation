import type { FastifyInstance } from 'fastify';
import type { CampaignService } from '../campaigns/service.js';

function idFrom(request: { params: unknown }): string {
  const id = (request.params as { id?: unknown }).id;
  if (typeof id !== 'string' || !id) throw new Error('Campaign ID is required.');
  return id;
}

export function campaignRoutes(service: CampaignService) {
  return async function routes(app: FastifyInstance): Promise<void> {
    app.get('/api/campaigns', async () => service.list());
    app.get('/api/campaigns/:id', async (request) => service.get(idFrom(request)));
    app.post('/api/campaigns/source-messages/manual', async (request) => service.captureManualSource(request.body as never));
    app.post('/api/campaigns', async (request) => service.create(request.body as never));
    app.put('/api/campaigns/:id', async (request, reply) => {
      try {
        return await service.update(idFrom(request), request.body as never);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not save campaign changes.';
        return reply.code(400).send({ message });
      }
    });
    app.post('/api/campaigns/:id/start', async (request) => service.start(idFrom(request)));
    app.post('/api/campaigns/:id/run-now', async (request) => service.runNow(idFrom(request)));
    app.post('/api/campaigns/:id/pause', async (request) => service.pause(idFrom(request)));
    app.post('/api/campaigns/:id/resume', async (request) => service.resume(idFrom(request)));
    app.post('/api/campaigns/:id/stop', async (request) => service.stop(idFrom(request)));
    app.post('/api/campaigns/stop-all', async () => service.stopAll());
  };
}
