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
    // Campaigns are listed across every account: a campaign split between
    // accounts appears as one card with combined progress.
    app.get('/api/campaigns', async () => accounts.listCampaigns());
    app.get('/api/campaigns/:id', async (request) => accounts.getCampaign(idFrom(request)));
    app.post('/api/campaigns/source-messages/manual', async (request) => (await accounts.get(accountIdFrom(request))).campaigns.captureManualSource(request.body as never));
    app.post('/api/campaigns', async (request, reply) => {
      try {
        const account = await accounts.get(accountIdFrom(request));
        return await accounts.createCampaign(account.id, request.body as never);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not create the campaign.';
        return reply.code(400).send({ message });
      }
    });
    app.put('/api/campaigns/:id', async (request, reply) => {
      try {
        return await accounts.updateCampaign(idFrom(request), request.body as never);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not save campaign changes.';
        return reply.code(400).send({ message });
      }
    });
    app.post('/api/campaigns/:id/start', async (request, reply) => {
      try {
        return await accounts.campaignAction(idFrom(request), 'start');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not start the campaign.';
        return reply.code(400).send({ message });
      }
    });
    app.post('/api/campaigns/:id/run-now', async (request, reply) => {
      try {
        return await accounts.campaignAction(idFrom(request), 'run-now');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not start the campaign.';
        return reply.code(400).send({ message });
      }
    });
    app.post('/api/campaigns/:id/pause', async (request) => accounts.campaignAction(idFrom(request), 'pause'));
    app.post('/api/campaigns/:id/resume', async (request) => accounts.campaignAction(idFrom(request), 'resume'));
    app.post('/api/campaigns/:id/stop', async (request) => accounts.campaignAction(idFrom(request), 'stop'));
    app.post('/api/campaigns/stop-all', async () => accounts.stopAllCampaigns());
    app.delete('/api/campaigns/:id', async (request) => accounts.campaignAction(idFrom(request), 'delete'));
  };
}
