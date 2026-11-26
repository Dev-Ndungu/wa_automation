export type CampaignShardLike = {
  id: string;
  accountId: string;
  distributionId?: string | null;
  sourceAccountId?: string | null;
  name: string;
  status: string;
  createdAt?: string;
  nextRunAt?: string | null;
  pauseReason?: string | null;
  autoResumeAt?: string | null;
  targets: Array<{ status: string; groupJid: string; [key: string]: unknown }>;
  warnings?: string[];
  [key: string]: unknown;
};

export type CampaignAccountSummary = {
  id: string;
  name: string;
  campaignId: string;
  status: string;
  total: number;
  sent: number;
  sending: number;
  failed: number;
  waiting: number;
};

/**
 * Split target groups across the accounts that are members of each group,
 * always choosing the participant with the fewest groups so far. The first
 * participant (the account that created the campaign) wins ties. Groups no
 * participant is known to be in still go to the first participant so the
 * normal validation error is shown instead of silently dropping them.
 */
export function assignTargets(
  targetJids: string[],
  participantIds: string[],
  memberships: Map<string, Set<string>>,
): Map<string, string[]> {
  const assigned = new Map(participantIds.map((id) => [id, [] as string[]]));
  const counts = new Map(participantIds.map((id) => [id, 0]));
  const order = new Map(participantIds.map((id, index) => [id, index]));
  for (const jid of targetJids) {
    const eligible = participantIds.filter((id) => memberships.get(id)?.has(jid));
    const candidates = eligible.length ? eligible : [participantIds[0]];
    candidates.sort((left, right) => (counts.get(left)! - counts.get(right)!) || (order.get(left)! - order.get(right)!));
    const chosen = candidates[0];
    assigned.get(chosen)!.push(jid);
    counts.set(chosen, counts.get(chosen)! + 1);
  }
  return assigned;
}

export function aggregateStatus(statuses: string[]): string {
  const unique = new Set(statuses);
  if (unique.size === 0) return 'DRAFT';
  if (unique.size === 1) return statuses[0];
  if (unique.has('RUNNING')) return 'RUNNING';
  if (unique.has('PAUSED')) return 'PAUSED';
  if (unique.has('QUEUED')) return 'QUEUED';
  if (unique.has('DRAFT')) return 'DRAFT';
  if (unique.has('FAILED')) return 'FAILED';
  if (unique.has('COMPLETED')) return 'COMPLETED';
  return 'STOPPED';
}

function earliestDate(values: Array<string | null | undefined>): string | null {
  let earliest: number | null = null;
  let earliestIso: string | null = null;
  for (const value of values) {
    if (!value) continue;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) continue;
    if (earliest === null || time < earliest) {
      earliest = time;
      earliestIso = value;
    }
  }
  return earliestIso;
}

/**
 * Merge the per-account shards of one distributed campaign into the single
 * card the dashboard displays. The owner shard supplies the name, schedule and
 * source message; progress is summed across all shards.
 */
export function combineCampaignShards(
  shards: CampaignShardLike[],
  accountNames: Map<string, string>,
): CampaignShardLike & { distributionId: string | null; accounts: CampaignAccountSummary[] } {
  const ownerShard = shards.find((shard) => shard.accountId === (shard.sourceAccountId ?? shard.accountId)) ?? shards[0];
  const accounts = shards.map((shard) => {
    const sent = shard.targets.filter((target) => target.status === 'SENT').length;
    const sending = shard.targets.filter((target) => target.status === 'SENDING').length;
    const failed = shard.targets.filter((target) => target.status === 'FAILED').length;
    return {
      id: shard.accountId,
      name: accountNames.get(shard.accountId) ?? shard.accountId,
      campaignId: shard.id,
      status: shard.status,
      total: shard.targets.length,
      sent,
      sending,
      failed,
      waiting: shard.targets.length - sent - failed - sending,
    };
  });
  return {
    ...ownerShard,
    distributionId: ownerShard.distributionId ?? null,
    status: aggregateStatus(shards.map((shard) => shard.status)),
    targets: shards.flatMap((shard) => shard.targets),
    warnings: [...new Set(shards.flatMap((shard) => shard.warnings ?? []))],
    pauseReason: shards.map((shard) => shard.pauseReason).find((reason): reason is string => Boolean(reason)) ?? null,
    autoResumeAt: shards.map((shard) => shard.autoResumeAt).find((value): value is string => Boolean(value)) ?? null,
    nextRunAt: earliestDate(shards.map((shard) => shard.nextRunAt)),
    accounts,
  };
}
