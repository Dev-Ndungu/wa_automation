import type { FastifyInstance } from 'fastify';
import type { AccountService } from '../accounts/service.js';
import { accountIdFrom } from './accounts.js';

export function whatsappRoutes(accounts: AccountService) {
  return async function routes(app: FastifyInstance): Promise<void> {
    // The status payload carries the account circuit-breaker warning when one
    // is open, so the dashboard banner can surface it next to the state.
    app.get('/api/whatsapp/status', async (request) => {
      const runtime = await accounts.get(accountIdFrom(request));
      return { ...runtime.whatsapp.getStatus(), warning: runtime.campaigns.getCircuitWarning() };
    });
    app.post('/api/whatsapp/link', async (request) => (await accounts.get(accountIdFrom(request))).whatsapp.requestLink());
    app.post('/api/whatsapp/disconnect', async (request) => { const manager = (await accounts.get(accountIdFrom(request))).whatsapp; await manager.disconnect(); return manager.getStatus(); });
    app.post('/api/whatsapp/relink', async (request) => { const manager = (await accounts.get(accountIdFrom(request))).whatsapp; await manager.relink(); return manager.getStatus(); });
    app.post('/api/whatsapp/sync-groups', async (request) => ({ count: await (await accounts.get(accountIdFrom(request))).whatsapp.syncGroups() }));
  };
}
