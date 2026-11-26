import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateStatus, assignTargets, combineCampaignShards } from './coordinator.js';

test('assignTargets balances groups across accounts that are members', () => {
  const memberships = new Map([
    ['owner', new Set(['a@g.us', 'b@g.us', 'c@g.us', 'd@g.us'])],
    ['second', new Set(['a@g.us', 'b@g.us', 'c@g.us', 'd@g.us'])],
  ]);
  const assignment = assignTargets(['a@g.us', 'b@g.us', 'c@g.us', 'd@g.us'], ['owner', 'second'], memberships);
  assert.deepEqual(assignment.get('owner'), ['a@g.us', 'c@g.us']);
  assert.deepEqual(assignment.get('second'), ['b@g.us', 'd@g.us']);
});

test('assignTargets puts a group only on the account that is a member', () => {
  const memberships = new Map([
    ['owner', new Set(['shared@g.us'])],
    ['second', new Set(['shared@g.us', 'second-only@g.us'])],
  ]);
  const assignment = assignTargets(['shared@g.us', 'second-only@g.us'], ['owner', 'second'], memberships);
  assert.deepEqual(assignment.get('owner'), ['shared@g.us']);
  assert.deepEqual(assignment.get('second'), ['second-only@g.us']);
});

test('assignTargets falls back to the first participant when nobody is known to be a member', () => {
  const memberships = new Map([['owner', new Set<string>()], ['second', new Set<string>()]]);
  const assignment = assignTargets(['unknown@g.us'], ['owner', 'second'], memberships);
  assert.deepEqual(assignment.get('owner'), ['unknown@g.us']);
  assert.deepEqual(assignment.get('second'), []);
});

test('combineCampaignShards sums progress and reports each account', () => {
  const combined = combineCampaignShards([
    {
      id: 'shard-a', accountId: 'a', distributionId: 'dist', sourceAccountId: 'a', name: 'Split', status: 'RUNNING', targets: [
        { groupJid: '1@g.us', status: 'SENT' }, { groupJid: '2@g.us', status: 'WAITING' },
      ], warnings: ['w1'],
    },
    {
      id: 'shard-b', accountId: 'b', distributionId: 'dist', sourceAccountId: 'a', name: 'Split', status: 'COMPLETED', targets: [
        { groupJid: '3@g.us', status: 'SENT' }, { groupJid: '4@g.us', status: 'FAILED' },
      ], warnings: ['w1', 'w2'],
    },
  ], new Map([['a', 'Main'], ['b', 'Second']]));

  assert.equal(combined.status, 'RUNNING');
  assert.equal(combined.targets.length, 4);
  assert.deepEqual(combined.warnings, ['w1', 'w2']);
  assert.deepEqual(combined.accounts.map((account) => [account.name, account.sent, account.total]), [
    ['Main', 1, 2],
    ['Second', 1, 2],
  ]);
});

test('aggregateStatus prefers live states over terminal shard states', () => {
  assert.equal(aggregateStatus(['COMPLETED', 'PAUSED']), 'PAUSED');
  assert.equal(aggregateStatus(['STOPPED', 'COMPLETED']), 'COMPLETED');
  assert.equal(aggregateStatus(['RUNNING', 'PAUSED']), 'RUNNING');
  assert.equal(aggregateStatus(['STOPPED', 'STOPPED']), 'STOPPED');
});
