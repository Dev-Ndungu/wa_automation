import type { FastifyInstance } from 'fastify';
import { and, count, eq, gte, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { appSettings, campaigns, discoveredLinks, groups } from '../db/schema.js';

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/api/dashboard', async () => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const [groupCount, targetCount, linkCount, todayLinkCount, activeCampaign, scannerSetting] = await Promise.all([
      db.select({ value: count() }).from(groups),
      db.select({ value: count() }).from(groups).where(eq(groups.isTarget, true)),
      db.select({ value: count() }).from(discoveredLinks),
      db.select({ value: count() }).from(discoveredLinks).where(gte(discoveredLinks.firstSeenAt, startOfToday.toISOString())),
      db.select({ id: campaigns.id, name: campaigns.name, status: campaigns.status }).from(campaigns).where(inArray(campaigns.status, ['RUNNING', 'PAUSED'])).limit(1),
      db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, 'scanner.enabled')).limit(1),
    ]);
    return {
      scanner: scannerSetting[0]?.value === 'false' ? 'OFF' : 'RUNNING',
      groups: Number(groupCount[0]?.value ?? 0),
      targetGroups: Number(targetCount[0]?.value ?? 0),
      discoveredLinks: Number(linkCount[0]?.value ?? 0),
      linksToday: Number(todayLinkCount[0]?.value ?? 0),
      activeCampaign: activeCampaign[0] ?? null,
    };
  });
}
