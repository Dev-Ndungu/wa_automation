# Group Status Campaigns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a campaign delivery mode that posts one WhatsApp Group Status per target group, reusing the existing campaign scheduling, pacing, budget and dashboard.

**Architecture:** Extend the existing `campaigns` table and `CampaignService` with `deliveryMode = 'GROUP_STATUS'` and an optional `targetAllGroups` flag. Status posts go through a new `WhatsAppManager.sendGroupStatus` that builds the `groupStatusMessageV2` envelope, marks it for `patchMessageBeforeSending`, and relays it with the plaintext group-status meta node. The worker sends exactly one status per target group per pass, inside the existing account-wide serial queue, and uses a status-specific 48–96 h per-group cooldown.

**Tech Stack:** Node 22, TypeScript, Fastify, Drizzle + SQLite (libsql), React + Vite, `@whiskeysockets/baileys` 7.0.0-rc14 (stock, no fork).

**Spec:** `docs/superpowers/specs/2026-11-26-group-status-campaigns-design.md` (approved 2026-11-26). Read the spec before starting; this plan implements it.

## Global Constraints

- Stock Baileys 7.0.0-rc14 only. Do not add a Baileys fork or a new WhatsApp dependency.
- Pacing values live in `apps/api/src/safety/limits.ts` and are not operator-configurable. Reuse `SEND_GAP` (60–240 s), `SEND_DAILY_LIMIT` (300), the 06:00–23:00 Africa/Nairobi window, reconnect settle, warm-up, circuit breaker and daily-budget auto-pause.
- `deliveryMode` is immutable after campaign creation. Changing it throws; the operator creates a new campaign.
- `targetAllGroups` is valid only with `deliveryMode = 'GROUP_STATUS'`. It is mutable after creation: on keeps existing targets and adds all other non-excluded groups; off keeps the current targets as an explicit list.
- Status campaigns are single-account: no `distributionId`, no shards, regardless of how many accounts are connected.
- Status posts count as ordinary `SEND` rows (`recordSend`) and share the account-wide 300/day budget. Do not add a second budget.
- Status cooldown is `STATUS_GROUP_COOLDOWN = { minHours: 48, maxHours: 96 }`, stored on `groups.last_status_sent_at`. The message cooldown (`GROUP_COOLDOWN`, `last_campaign_sent_at`) is unchanged.
- Status text/caption limit is 1,024 characters. Image limit stays 4 MB; video limit stays 16 MB. Video is gated by `GROUP_STATUS_VIDEO_SUPPORTED` (false until the live spike proves it).
- Status sends go through `CampaignService.enqueueAccountSend`. Do not call `sendGroupStatus` outside that queue.
- The working tree contains uncommitted multi-account coordinator work (`campaigns/coordinator.ts`, `accounts/service.ts`, `db/schema.ts`, `db/bootstrap.ts`, `campaigns/service.ts`, `routes/campaigns.ts`, `main.tsx`, tests). Do not reset or revert it. Build on it. Commit only the files a task names; never `git add -A`.
- Do not push. Commits only.
- Tests: `npm test --workspace=@wa-control/api` runs `tsx --test src/**/*.test.ts`. A single file: `cd apps/api && npx tsx --test src/path/file.test.ts`.
- Type check: `npm run check`. Build: `npm run build`.

## Review Focus

These are the input classes most likely to break a real operator. Each has a test in the task that owns it.

1. **A group joined after the campaign was created.** The next reconcile must add it without restarting the campaign. Task 8 test.
2. **A group the account left or was removed from.** Its target must become `CANCELLED`, not retry forever or trip the breaker. Task 8 test.
3. **An image or video status.** The media must be built top-level so `<enc mediatype>` is set and the message still renders after the `groupStatusMessageV2` wrap. Tasks 1–3 tests + spike.
4. **A retry/resend of a status.** The patch must re-wrap the same cached inner message and produce the same envelope; an unwrapped retry is silently dropped. Tasks 1–2 tests.
5. **Starting a status campaign while the account is disconnected.** Start/Run now must reject with a clear message; a running campaign may wait like a message campaign. Task 7 test.

---

## Task 1: Group-status envelope helper

**Files:**
- Create: `apps/api/src/whatsapp/group-status.ts`
- Test: `apps/api/src/whatsapp/group-status.test.ts`

**Interfaces:**
- Produces for Task 2 and Task 7:
  - `type GroupStatusContent = { text: string } | { image: Buffer; caption: string } | { video: Buffer; caption: string }`
  - `type GroupStatusSecretMode = 'both' | 'none'`
  - `const GROUP_STATUS_META: BinaryNode` — `{ tag: 'meta', attrs: { is_group_status: 'true', origin: 'group_status' } }`
  - `const GROUP_STATUS_VIDEO_SUPPORTED: boolean` — initial value `false`
  - `function markGroupStatus(inner: proto.IMessage): proto.IMessage`
  - `function createGroupStatusWrapper(defaultMode?: GroupStatusSecretMode): { mark(inner, mode?): proto.IMessage; patch(message): proto.IMessage }`
  - `async function buildGroupStatusInner(content: GroupStatusContent, options: { upload: WASocket['waUploadToServer']; logger?: FastifyBaseLogger }): Promise<proto.IMessage>`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/whatsapp/group-status.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import type { proto } from '@whiskeysockets/baileys';
import {
  buildGroupStatusInner,
  createGroupStatusWrapper,
  GROUP_STATUS_META,
  markGroupStatus,
} from './group-status.js';

test('markGroupStatus flags text, image and video content', () => {
  const text = { extendedTextMessage: { text: 'hi' } } as proto.IMessage;
  const image = { imageMessage: { caption: 'hi' } } as proto.IMessage;
  const video = { videoMessage: { caption: 'hi' } } as proto.IMessage;
  markGroupStatus(text);
  markGroupStatus(image);
  markGroupStatus(video);
  assert.equal(text.extendedTextMessage!.contextInfo!.isGroupStatus, true);
  assert.equal(image.imageMessage!.contextInfo!.isGroupStatus, true);
  assert.equal(video.videoMessage!.contextInfo!.isGroupStatus, true);
});

test('the meta node carries the group-status marker', () => {
  assert.deepEqual(GROUP_STATUS_META, {
    tag: 'meta',
    attrs: { is_group_status: 'true', origin: 'group_status' },
  });
});

test('the wrapper adds a 32-byte secret at both levels for a marked message', () => {
  const wrapper = createGroupStatusWrapper('both');
  const inner = wrapper.mark({ extendedTextMessage: { text: 'hi' } } as proto.IMessage);
  const wrapped = wrapper.patch(inner) as proto.IMessage;
  const outer = wrapped.messageContextInfo!.messageSecret!;
  const nested = wrapped.groupStatusMessageV2!.message!.messageContextInfo!.messageSecret!;
  assert.equal(outer.length, 32);
  assert.deepEqual(Buffer.from(outer), Buffer.from(nested));
});

test('the wrapper leaves unmarked messages untouched', () => {
  const wrapper = createGroupStatusWrapper();
  const plain = { extendedTextMessage: { text: 'campaign' } } as proto.IMessage;
  assert.strictEqual(wrapper.patch(plain), plain);
});

test('the wrapper reuses the same envelope on a retry', () => {
  const wrapper = createGroupStatusWrapper('both');
  const inner = wrapper.mark({ extendedTextMessage: { text: 'hi' } } as proto.IMessage);
  assert.strictEqual(wrapper.patch(inner), wrapper.patch(inner));
});

test('the spike variant can omit the secret entirely', () => {
  const wrapper = createGroupStatusWrapper('none');
  const inner = wrapper.mark({ extendedTextMessage: { text: 'hi' } } as proto.IMessage);
  const wrapped = wrapper.patch(inner) as proto.IMessage;
  assert.equal(wrapped.messageContextInfo, undefined);
  assert.equal(wrapped.groupStatusMessageV2!.message!.messageContextInfo, undefined);
});

test('buildGroupStatusInner generates a text status with the flag and no random secret', async () => {
  const inner = await buildGroupStatusInner(
    { text: 'hello group' },
    { upload: (async () => ({}) as never) },
  );
  assert.equal(inner.extendedTextMessage!.text, 'hello group');
  assert.equal(inner.extendedTextMessage!.contextInfo!.isGroupStatus, true);
  assert.equal(inner.messageContextInfo, undefined);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx tsx --test src/whatsapp/group-status.test.ts`
Expected: FAIL with "Cannot find module './group-status.js'".

- [ ] **Step 3: Implement `group-status.ts`**

Use `generateWAMessageContent` from the Baileys root. Build the inner, set `contextInfo.isGroupStatus` on whichever of `extendedTextMessage`, `imageMessage`, `videoMessage` exists, and delete `inner.messageContextInfo` so the wrapper controls the secret. The wrapper keeps a `WeakMap` of marked messages and a second `WeakMap` of already-built envelopes; `patch` returns the cached envelope on retry. `'both'` generates a 32-byte secret with `randomBytes(32)` and places the same bytes at the top level and inside `groupStatusMessageV2.message`; `'none'` omits both. `GROUP_STATUS_VIDEO_SUPPORTED` starts `false`; Task 3 flips it only if the spike proves video.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx tsx --test src/whatsapp/group-status.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/whatsapp/group-status.ts apps/api/src/whatsapp/group-status.test.ts
git commit -m "feat: add group-status envelope helper

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 2: WhatsAppManager send path, socket patch, status ack and retry

**Files:**
- Modify: `apps/api/src/whatsapp/manager.ts`
- Create: `apps/api/src/whatsapp/status-ack.ts`
- Test: `apps/api/src/whatsapp/status-ack.test.ts`
- Test: `apps/api/src/whatsapp/manager.test.ts`

**Interfaces:**
- Consumes: Task 1's `GroupStatusContent`, `GROUP_STATUS_META`, `buildGroupStatusInner`, `createGroupStatusWrapper`.
- Produces for Task 7:
  - `WhatsAppManager.sendGroupStatus(groupJid: string, content: GroupStatusContent, options?: { messageSecret?: GroupStatusSecretMode }): Promise<void>`
  - `WhatsAppManager.participatingGroupJids(): Promise<string[]>`
- `syncGroups(): Promise<number>` keeps its return type and delegates to `participatingGroupJids()`.

- [ ] **Step 1: Write the failing ack and manager tests**

```ts
// apps/api/src/whatsapp/status-ack.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStatusAck } from './status-ack.js';

test('buildStatusAck acks a status stanza and keeps participant and type', () => {
  const ack = buildStatusAck({
    tag: 'status',
    attrs: {
      id: 'AC00', from: '120363000000000000@g.us', type: 'media',
      participant: '111111111111@lid',
    },
  });
  assert.deepEqual(ack, {
    tag: 'ack',
    attrs: {
      id: 'AC00', to: '120363000000000000@g.us', class: 'status',
      participant: '111111111111@lid', type: 'media',
    },
  });
});

test('buildStatusAck never adds a from attribute for status class', () => {
  const ack = buildStatusAck({ tag: 'status', attrs: { id: 'AC01', from: '120363000000000000@g.us' } });
  assert.equal(ack.attrs.from, undefined);
});
```

```ts
// apps/api/src/whatsapp/manager.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import type { proto } from '@whiskeysockets/baileys';
import { WhatsAppManager } from './manager.js';
import { GROUP_STATUS_META } from './group-status.js';

const loggerStub = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {}, fatal: () => {}, trace: () => {}, silent: () => {}, child: () => loggerStub } as never;

test('sendGroupStatus relays a marked inner message with the meta node', async () => {
  const manager = new WhatsAppManager(loggerStub, {} as never, '/tmp/wa-manager-status-test', 'main');
  const relayed: Array<{ jid: string; message: proto.IMessage; options: Record<string, unknown> }> = [];
  const fakeSocket = {
    user: { id: '111:1@s.whatsapp.net' },
    waUploadToServer: async () => ({}) as never,
    relayMessage: async (jid: string, message: proto.IMessage, options: Record<string, unknown>) => {
      relayed.push({ jid, message, options });
    },
  };
  (manager as unknown as { socket: unknown }).socket = fakeSocket;
  (manager as unknown as { status: unknown }).status = {
    state: 'CONNECTED', phone: null, lastConnectedAt: null, qrDataUrl: null, error: null,
  };

  await manager.sendGroupStatus('120363000000000000@g.us', { text: 'hello' });

  assert.equal(relayed.length, 1);
  assert.equal(relayed[0].jid, '120363000000000000@g.us');
  assert.equal(relayed[0].message.extendedTextMessage!.contextInfo!.isGroupStatus, true);
  assert.deepEqual(relayed[0].options.additionalNodes, [GROUP_STATUS_META]);
});

test('sendGroupStatus rejects a non-group JID and a disconnected account', async () => {
  const manager = new WhatsAppManager(loggerStub, {} as never, '/tmp/wa-manager-status-test', 'main');
  await assert.rejects(
    () => manager.sendGroupStatus('111@s.whatsapp.net', { text: 'hello' }),
    /only be posted to a group/,
  );
  await assert.rejects(
    () => manager.sendGroupStatus('120363000000000000@g.us', { text: 'hello' }),
    /not connected/,
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx tsx --test src/whatsapp/status-ack.test.ts src/whatsapp/manager.test.ts`
Expected: FAIL with "Cannot find module './status-ack.js'" and no `sendGroupStatus` method.

- [ ] **Step 3: Implement the ack helper and manager changes**

`status-ack.ts`: a pure `buildStatusAck(node: BinaryNode): BinaryNode` that mirrors Baileys' `buildAckStanza` for a `status` node: `tag: 'ack'`, attrs `id`, `to: node.attrs.from`, `class: node.tag`, plus `participant`, `recipient`, and `type` when present. Do not add `from`.

`manager.ts`:
- Import `generateMessageID`, `GroupStatusContent`, `GROUP_STATUS_META`, `buildGroupStatusInner`, `createGroupStatusWrapper`, `buildStatusAck`.
- Add a private `readonly groupStatusWrapper = createGroupStatusWrapper()`.
- In `makeWASocket` config add `enableRecentMessageCache: true` and
  `patchMessageBeforeSending: async (message) => this.groupStatusWrapper.patch(message)`.
- After `this.socket = socket;` in `connect()`, attach the status ack handler:
  `(socket.ws as unknown as { on(event: string, listener: (node: BinaryNode) => void): void }).on('CB:status', (node) => { void this.ackStatusStanza(socket, node); });`
  Add `private async ackStatusStanza(socket, node)` that calls
  `(socket as unknown as { sendNode?: (node: BinaryNode) => Promise<void> }).sendNode` with
  `buildStatusAck(node)`, wrapped in try/catch logging a warning.
- Add `sendGroupStatus`: reject non-`@g.us` and non-CONNECTED; build the inner with
  `buildGroupStatusInner(content, { upload: this.socket.waUploadToServer, logger: this.logger })`;
  `this.groupStatusWrapper.mark(inner, options.messageSecret)`; then
  `await this.socket.relayMessage(groupJid, inner, { messageId: generateMessageID(), additionalNodes: [GROUP_STATUS_META] })`.
- Add `participatingGroupJids()` that requires CONNECTED, calls
  `groupFetchAllParticipating()`, upserts the metadata via `upsertGroups`, and returns
  `Object.keys(available)`. Make `syncGroups()` call it and return the length.

The patch hook runs on every send; it must return unmarked messages unchanged. The WeakMap-based wrapper from Task 1 makes that so. `enableRecentMessageCache` makes rc14 cache the inner message; the same cached object is marked, so the retry path calls the patch again and returns the cached envelope.

**Media guard:** call `relayMessage` with the **inner** message, never with a pre-built `groupStatusMessageV2` envelope. rc14 computes `getMediaType(message)` on the relayMessage argument before the patch runs; passing the inner (with top-level `imageMessage`/`videoMessage`) is what sets the `<enc mediatype=...>` attribute. The patch then wraps it. If an image or video is acked but never appears, the mediatype attribute is the first suspect: test the dual-field carrier variant in the spike before adding a fork.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx tsx --test src/whatsapp/status-ack.test.ts src/whatsapp/manager.test.ts`
Expected: all tests PASS.

Run the existing API suite to catch regressions:
`npm test --workspace=@wa-control/api`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/whatsapp/status-ack.ts apps/api/src/whatsapp/status-ack.test.ts apps/api/src/whatsapp/manager.ts apps/api/src/whatsapp/manager.test.ts
git commit -m "feat: send group status through Baileys relay

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 3: Live spike (gate)

**Files:**
- Create (throwaway, do not commit): `apps/api/spike-status.ts`
- Modify: `apps/api/src/whatsapp/group-status.ts` (only the constants the spike settles)

**Interfaces:**
- Uses Task 1 and Task 2. No new production interface.

**Prerequisite:** the operator has created a dedicated test group on the linked account and can see it on their phone. Stop the API server first; two processes must not share `whatsapp-auth/`.

- [ ] **Step 1: Write the throwaway spike script**

```ts
// apps/api/spike-status.ts — throwaway, run once, do not commit.
import { readFileSync } from 'node:fs';
import { config } from './src/config.js';
import { ScannerService } from './src/scanner/service.js';
import { WhatsAppManager } from './src/whatsapp/manager.js';

const logger = { info: console.log, warn: console.warn, error: console.error, debug: () => {}, fatal: console.error, trace: () => {}, silent: () => {}, child: () => logger } as never;
const manager = new WhatsAppManager(logger, new ScannerService(logger, 'main'), config.WHATSAPP_AUTH_DIR, 'main');
const groupJid = process.env.SPIKE_GROUP_JID;
if (!groupJid) throw new Error('SPIKE_GROUP_JID is required');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

await new Promise<void>((resolve, reject) => {
  const unsubscribe = manager.subscribe((status) => {
    if (status.state === 'CONNECTED') { unsubscribe(); resolve(); }
    if (status.state === 'LOGGED_OUT') { unsubscribe(); reject(new Error(status.error ?? 'logged out')); }
  });
  void manager.start();
  setTimeout(() => reject(new Error('connect timeout')), 120_000).unref();
});

await manager.sendGroupStatus(groupJid, { text: 'spike: no secret' }, { messageSecret: 'none' });
await sleep(15_000);
await manager.sendGroupStatus(groupJid, { text: 'spike: secret both' }, { messageSecret: 'both' });
await sleep(15_000);
const imagePath = process.env.SPIKE_IMAGE;
if (imagePath) {
  await manager.sendGroupStatus(groupJid, { image: readFileSync(imagePath), caption: 'spike image' }, { messageSecret: 'both' });
}
await sleep(15_000);
const videoPath = process.env.SPIKE_VIDEO;
if (videoPath) {
  await manager.sendGroupStatus(groupJid, { video: readFileSync(videoPath), caption: 'spike video' }, { messageSecret: 'both' });
}
const negativeJid = process.env.SPIKE_NEGATIVE_JID;
if (negativeJid) {
  try {
    await manager.sendGroupStatus(negativeJid, { text: 'spike: negative' }, { messageSecret: 'both' });
    console.log('Negative-group send resolved; it may still have been silently dropped.');
  } catch (error) {
    console.log('Negative-group send threw:', error instanceof Error ? error.message : error);
  }
}
console.log('Posted test statuses. Keep this process alive for 60 minutes, then check the phone.');
await sleep(60 * 60_000);
await manager.disconnect();
```

- [ ] **Step 2: Run the spike**

Run:
`cd apps/api && SPIKE_GROUP_JID='<jid>' SPIKE_IMAGE='<path>' SPIKE_VIDEO='<path>' SPIKE_NEGATIVE_JID='<announcement-only or restricted group jid>' npx tsx spike-status.ts`

Expected: the script connects and posts. On the operator's phone (Updates tab / the test group's status), record which posts appear:
- text with `messageSecret: 'none'`
- text with `messageSecret: 'both'`
- image
- video
- the negative-group send: thrown error or silently dropped

Phone rendering is the gate. A WhatsApp Web listing is not confirmed by any official source and must not be treated as proof that a post worked.

If `'none'` works for text, repeat the image and video with `messageSecret: 'none'` before deciding the default.

- [ ] **Step 3: Watch the 60-minute connection**

Leave the process running. If the manager logs a close with `Stream Errored (ack)` around 50 minutes, the status ack handler is not sufficient; stop and report before Task 4. If the connection stays up, the ack handler is validated.

- [ ] **Step 4: Record the winning variant in code**

If `'both'` is the only working variant, leave `createGroupStatusWrapper()` defaulting to `'both'`. If `'none'` works for text and media, change the default in `manager.ts` (`createGroupStatusWrapper('none')`). If text works one way and media the other, change `sendGroupStatus` to choose the mode per content type. If video appears, change `GROUP_STATUS_VIDEO_SUPPORTED` to `true`; if it does not, leave it `false`.

- [ ] **Step 5: Delete the throwaway script and commit the settled constants**

```bash
rm apps/api/spike-status.ts
git add apps/api/src/whatsapp/group-status.ts apps/api/src/whatsapp/manager.ts
git commit -m "chore: record the live group-status envelope result

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

If no constant changed, skip this commit.

**Gate:** Do not proceed to Task 4 until the operator confirms at least one text status and one image status are visible, and the session survived the 60 minutes (or the ack handler was fixed and the spike repeated). If nothing appears, stop and return to the design; do not build the campaign path on an unverified envelope.

---

## Task 4: Schema and bootstrap migration

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Modify: `apps/api/src/db/bootstrap.ts`
- Test: `apps/api/src/db/bootstrap.test.ts`

**Interfaces:**
- Produces for Tasks 5–7: `campaigns.deliveryMode`, `campaigns.targetAllGroups`, `groups.lastStatusSentAt`.

- [ ] **Step 1: Write the failing bootstrap test**

```ts
// apps/api/src/db/bootstrap.test.ts
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = `/tmp/wa-bootstrap-status-test-${process.pid}.db`;

const { bootstrapDatabase } = await import('./bootstrap.js');
const { db } = await import('./client.js');

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test, { after } from 'node:test';
import { sql } from 'drizzle-orm';

after(() => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${process.env.DATABASE_PATH}${suffix}`, { force: true });
});

test('bootstrap adds group-status columns and does not pause existing status campaigns', async () => {
  await bootstrapDatabase();
  const campaignColumns = await db.all<{ name: string }>(sql`PRAGMA table_info(campaigns)`);
  assert.ok(campaignColumns.some((column) => column.name === 'delivery_mode'));
  assert.ok(campaignColumns.some((column) => column.name === 'target_all_groups'));
  const groupColumns = await db.all<{ name: string }>(sql`PRAGMA table_info(groups)`);
  assert.ok(groupColumns.some((column) => column.name === 'last_status_sent_at'));

  const timestamp = new Date().toISOString();
  await db.run(sql`INSERT INTO source_messages (id, account_id, chat_jid, message_id, payload, preview, created_at)
    VALUES ('status-source', 'main', 'manual:status-source', 'manual:status-source', '{"text":"x"}', 'x', ${timestamp})`);
  await db.run(sql`INSERT INTO campaigns (id, account_id, name, source_message_reference, status, interval_seconds, delivery_mode, created_at)
    VALUES ('status-campaign', 'main', 'Status', 'status-source', 'RUNNING', 0, 'GROUP_STATUS', ${timestamp})`);
  await bootstrapDatabase();
  const [row] = await db.all<{ status: string }>(sql`SELECT status FROM campaigns WHERE id = 'status-campaign'`);
  assert.equal(row.status, 'RUNNING');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx tsx --test src/db/bootstrap.test.ts`
Expected: FAIL — `delivery_mode` column missing (or the old guard pauses the campaign).

- [ ] **Step 3: Add the columns and remove the old guard**

`schema.ts`:
- `campaigns`: add `deliveryMode: text('delivery_mode', { enum: ['MESSAGE', 'GROUP_STATUS'] }).notNull().default('MESSAGE')` and `targetAllGroups: integer('target_all_groups', { mode: 'boolean' }).notNull().default(false)`.
- `groups`: add `lastStatusSentAt: text('last_status_sent_at')`.

`bootstrap.ts`:
- In the campaign-column block, add idempotent `ALTER TABLE campaigns ADD COLUMN delivery_mode text NOT NULL DEFAULT 'MESSAGE'` and `... target_all_groups integer NOT NULL DEFAULT false` when missing.
- Delete the entire `if (campaignColumns.some((column) => column.name === 'delivery_mode')) { UPDATE ... GROUP_STATUS ... }` guard at `bootstrap.ts:98-103`. It would pause every status campaign on boot.
- After the `groups.joined_at` block, add `ALTER TABLE groups ADD COLUMN last_status_sent_at text` when missing.

- [ ] **Step 4: Run the test and the API suite**

Run: `cd apps/api && npx tsx --test src/db/bootstrap.test.ts`
Expected: PASS.
Run: `npm test --workspace=@wa-control/api`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/src/db/bootstrap.ts apps/api/src/db/bootstrap.test.ts
git commit -m "feat: add group-status campaign columns and migration

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 5: Campaign planning and validation

**Files:**
- Modify: `apps/api/src/campaigns/service.ts`
- Test: `apps/api/src/campaigns/service.test.ts`

**Interfaces:**
- `CampaignInput` gains `deliveryMode?: unknown; targetAllGroups?: unknown`.
- `CampaignPlan` gains `deliveryMode: 'MESSAGE' | 'GROUP_STATUS'; targetAllGroups: boolean`.
- `plan()` expands `targetAllGroups` and rejects invalid status sources.
- Consumes Task 1's `GROUP_STATUS_VIDEO_SUPPORTED`.

- [ ] **Step 1: Write the failing tests**

Add to `service.test.ts`:

```ts
test('a status campaign expands targetAllGroups to non-excluded groups', async () => {
  await db.update(groups).set({ isExcluded: true });
  await insertGroup('all-one@g.us', 'All one');
  await insertGroup('all-excluded@g.us', 'All excluded');
  await db.update(groups).set({ isExcluded: true }).where(eq(groups.whatsappGroupJid, 'all-excluded@g.us'));
  const captured = await service.captureManualSource({ text: 'All groups status', label: 'All groups status' });
  const plan = await service.plan({
    name: 'All groups status', sourceMessageIds: [captured.sources[0].id],
    groupJids: [], deliveryMode: 'GROUP_STATUS', targetAllGroups: true,
  } as never);
  assert.deepEqual(plan.groupJids.sort(), ['all-one@g.us']);
  assert.equal(plan.deliveryMode, 'GROUP_STATUS');
  assert.equal(plan.targetAllGroups, true);
});

test('targetAllGroups is rejected for a message campaign', async () => {
  const captured = await service.captureManualSource({ text: 'Message source', label: 'Message source' });
  await assert.rejects(
    () => service.plan({
      name: 'Bad', sourceMessageIds: [captured.sources[0].id],
      groupJids: ['all-one@g.us'], deliveryMode: 'MESSAGE', targetAllGroups: true,
    } as never),
    /only available for group-status/,
  );
});

test('an unknown delivery mode is rejected', async () => {
  const captured = await service.captureManualSource({ text: 'Mode source', label: 'Mode source' });
  await assert.rejects(
    () => service.plan({
      name: 'Bad', sourceMessageIds: [captured.sources[0].id],
      groupJids: ['all-one@g.us'], deliveryMode: 'STATUS',
    } as never),
    /deliveryMode must be MESSAGE or GROUP_STATUS/,
  );
});

test('a status campaign rejects text over 1024 characters', async () => {
  const captured = await service.captureManualSource({ text: 'x'.repeat(1025), label: 'Long status' });
  await assert.rejects(
    () => service.plan({
      name: 'Long status', sourceMessageIds: [captured.sources[0].id],
      groupJids: ['all-one@g.us'], deliveryMode: 'GROUP_STATUS',
    } as never),
    /at most 1024/,
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx tsx --test src/campaigns/service.test.ts`
Expected: FAIL — `deliveryMode` is not part of `CampaignPlan`, and the validation does not exist.

- [ ] **Step 3: Implement the validation**

In `service.ts`:
- Extend `CampaignInput` and `CampaignPlan` with the fields above.
- Add `deliveryModeFrom(value: unknown)` (undefined → `'MESSAGE'`; only the two literals; otherwise throw) and `targetAllGroupsFrom(value, deliveryMode)` (undefined/false; boolean only; true only for `GROUP_STATUS`, otherwise throw).
- Add `private async allNonExcludedGroupJids(): Promise<string[]>` querying `groups` for `accountId = this.accountId` and `isExcluded = false`; throw if empty.
- Add `private async assertStatusSources(ids, sourceAccountId)`: load each payload, take `text` or `caption`, reject over 1024 characters, and reject a `videoDataUrl` when `!GROUP_STATUS_VIDEO_SUPPORTED`.
- In `plan()`, parse the mode and flag before validating targets; use `allNonExcludedGroupJids()` when `targetAllGroups`, otherwise `validateExplicitTargets(input.groupJids)`; call `assertStatusSources` when the mode is `GROUP_STATUS`; return the new fields.

- [ ] **Step 4: Run the tests and the suite**

Run: `cd apps/api && npx tsx --test src/campaigns/service.test.ts`
Expected: PASS.
Run: `npm test --workspace=@wa-control/api`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/campaigns/service.ts apps/api/src/campaigns/service.test.ts
git commit -m "feat: validate group-status campaign planning

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 6: Persistence and single-account distribution

**Files:**
- Modify: `apps/api/src/campaigns/service.ts`
- Modify: `apps/api/src/accounts/service.ts`
- Test: `apps/api/src/campaigns/service.test.ts`
- Test: `apps/api/src/accounts/service.campaigns.test.ts`

**Interfaces:**
- `createFromPlan` persists `deliveryMode` and `targetAllGroups`.
- `updateFromPlan` rejects a delivery-mode change and persists `targetAllGroups`.
- `AccountService.createCampaign`/`updateCampaign` keep status campaigns on the owner account with no `distributionId`.

- [ ] **Step 1: Write the failing tests**

Add to `service.test.ts`:

```ts
test('a status campaign persists its delivery mode and rejects a mode change', async () => {
  await insertGroup('persisted-status@g.us', 'Persisted status');
  const captured = await service.captureManualSource({ text: 'Persisted status', label: 'Persisted status' });
  const created = await service.create({
    name: 'Persisted status', sourceMessageIds: [captured.sources[0].id],
    groupJids: ['persisted-status@g.us'], deliveryMode: 'GROUP_STATUS', schedule: { type: 'ONCE' },
  } as never);
  assert.equal(created.deliveryMode, 'GROUP_STATUS');
  await assert.rejects(
    () => service.update(created.id, {
      name: 'Persisted status', sourceMessageIds: [captured.sources[0].id],
      groupJids: ['persisted-status@g.us'], deliveryMode: 'MESSAGE', schedule: { type: 'ONCE' },
    } as never),
    /cannot change its delivery mode/,
  );
});
```

Add to `accounts/service.campaigns.test.ts`:

```ts
test('a status campaign stays on the owner account and has no distribution', async () => {
  const accounts = new AccountService(loggerStub);
  const secondRuntime = await accounts.get(SECOND_ACCOUNT_ID);
  (secondRuntime.whatsapp as unknown as { getStatus: () => { state: string } }).getStatus = () => ({
    state: 'CONNECTED', phone: null, lastConnectedAt: null, qrDataUrl: null, error: null,
  });
  const mainRuntime = await accounts.get('main');
  const captured = await mainRuntime.campaigns.captureManualSource({ text: 'Owner status', label: 'Owner status' });
  const created = await accounts.createCampaign('main', {
    name: 'Owner status', sourceMessageIds: [captured.sources[0].id],
    groupJids: ['split-one@g.us'], deliveryMode: 'GROUP_STATUS', schedule: { type: 'ONCE' },
  }) as { distributionId: string | null; targets: Array<{ groupJid: string }> };
  assert.equal(created.distributionId, null);
  assert.deepEqual(created.targets.map((target) => target.groupJid), ['split-one@g.us']);
  const rows = await db.select().from(campaigns).where(eq(campaigns.name, 'Owner status'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].accountId, 'main');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx tsx --test src/campaigns/service.test.ts src/accounts/service.campaigns.test.ts`
Expected: FAIL — the fields are not persisted and the campaign is split.

- [ ] **Step 3: Implement persistence and the distribution bypass**

`campaigns/service.ts`:
- `createFromPlan` inserts `deliveryMode: plan.deliveryMode` and `targetAllGroups: plan.targetAllGroups`.
- `updateFromPlan` throws when `plan.deliveryMode !== campaign.deliveryMode`; includes `targetAllGroups` in the update.
- The running-campaign edit path adds new groups only when they are selected; `targetAllGroups` reconciliation is Task 7.

`accounts/service.ts`:
- In `createCampaign`, compute `statusDelivery = plan.deliveryMode === 'GROUP_STATUS'`; `participants = statusDelivery ? [ownerId] : await this.eligibleParticipantIds(ownerId)`; `distributionId = !statusDelivery && participants.length > 1 ? randomUUID() : null`.
- In `updateCampaign`, for a status plan require a single shard belonging to the owner; throw `'Status campaigns cannot be distributed.'` if more than one shard exists, otherwise call the normal single-shard update.

- [ ] **Step 4: Run the tests and the suite**

Run: `cd apps/api && npx tsx --test src/campaigns/service.test.ts src/accounts/service.campaigns.test.ts`
Expected: PASS.
Run: `npm test --workspace=@wa-control/api`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/campaigns/service.ts apps/api/src/accounts/service.ts apps/api/src/campaigns/service.test.ts apps/api/src/accounts/service.campaigns.test.ts
git commit -m "feat: persist group-status campaigns on one account

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 7: Worker cooldown, send branch and start guard

**Files:**
- Modify: `apps/api/src/safety/limits.ts`
- Modify: `apps/api/src/campaigns/service.ts`
- Modify: `apps/api/src/routes/campaigns.ts`
- Test: `apps/api/src/safety/limits.test.ts`
- Test: `apps/api/src/campaigns/service.test.ts`

**Interfaces:**
- `STATUS_GROUP_COOLDOWN = { minHours: 48, maxHours: 96 }`
- `drawStatusGroupCooldownMs(rng?: () => number): number`
- `CampaignService.start`/`runNow` throw `'WhatsApp must be connected before starting a group-status campaign.'` when the mode is `GROUP_STATUS` and the state is not `CONNECTED`.
- The worker sends one status per target via `whatsapp.sendGroupStatus` and sets `groups.lastStatusSentAt`.

- [ ] **Step 1: Write the failing tests**

Add to `limits.test.ts`:

```ts
test('drawStatusGroupCooldownMs draws from the 48-96 hour range', () => {
  assert.equal(drawStatusGroupCooldownMs(() => 0), 48 * 3_600_000);
  assert.equal(drawStatusGroupCooldownMs(() => 0.5), 72 * 3_600_000);
  assert.equal(drawStatusGroupCooldownMs(() => 1), 96 * 3_600_000);
});
```

Extend the service test stub and add tests:

```ts
const statusCalls: Array<{ jid: string; content: unknown }> = [];
// In whatsappStub add:
//   sendGroupStatus: async (jid, content) => { statusCalls.push({ jid, content }); },

test('a group-status campaign posts one status per group and stamps last_status_sent_at', async () => {
  await insertGroup('status-one@g.us', 'Status one');
  await insertGroup('status-two@g.us', 'Status two');
  const captured = await service.captureManualSource({ text: 'Status text', label: 'Status text' });
  const created = await service.create({
    name: 'Status run', sourceMessageIds: [captured.sources[0].id],
    groupJids: ['status-one@g.us', 'status-two@g.us'], deliveryMode: 'GROUP_STATUS', schedule: { type: 'ONCE' },
  } as never);
  statusCalls.length = 0;
  await service.start(created.id);
  await waitForTargetsSent(created.id, 10_000, 2);

  assert.equal(statusCalls.length, 2);
  assert.deepEqual(statusCalls.map((call) => call.jid).sort(), ['status-one@g.us', 'status-two@g.us']);
  assert.deepEqual(statusCalls[0].content, { text: 'Status text' });
  const rows = await db.select({ jid: groups.whatsappGroupJid, lastStatusSentAt: groups.lastStatusSentAt, lastCampaignSentAt: groups.lastCampaignSentAt })
    .from(groups).where(inArray(groups.whatsappGroupJid, ['status-one@g.us', 'status-two@g.us']));
  assert.ok(rows.every((row) => row.lastStatusSentAt));
  assert.ok(rows.every((row) => row.lastCampaignSentAt === null));
});

test('a group inside the status cooldown is parked, not sent', async () => {
  await insertGroup('cooled-status@g.us', 'Cooled status', { lastCampaignSentAt: null });
  await db.update(groups).set({ lastStatusSentAt: new Date(Date.now() - 3_600_000).toISOString() })
    .where(eq(groups.whatsappGroupJid, 'cooled-status@g.us'));
  const captured = await service.captureManualSource({ text: 'Cooled status', label: 'Cooled status' });
  const created = await service.create({
    name: 'Cooled status', sourceMessageIds: [captured.sources[0].id],
    groupJids: ['cooled-status@g.us'], deliveryMode: 'GROUP_STATUS', schedule: { type: 'ONCE' },
  } as never);
  statusCalls.length = 0;
  await service.start(created.id);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const [target] = await db.select().from(campaignTargets).where(eq(campaignTargets.campaignId, created.id));
  assert.equal(target.status, 'WAITING');
  const delay = Date.parse(target.scheduledAt!) - Date.now();
  assert.ok(delay >= 47 * 3_600_000 && delay <= 97 * 3_600_000);
  assert.equal(statusCalls.length, 0);
  await service.stop(created.id);
});

test('starting a status campaign while disconnected is rejected', async () => {
  await insertGroup('offline-status@g.us', 'Offline status');
  const offlineStub = { ...whatsappStub, getStatus: () => ({ state: 'DISCONNECTED', phone: null, lastConnectedAt: null, qrDataUrl: null, error: null }) } as unknown as WhatsAppManager;
  const offline = new CampaignService(offlineStub, loggerStub, 'main', {
    minSendGapSeconds: 0, sendGapSeconds: () => 0, warmupSeconds: () => 0,
    reconnectSettleMs: () => 0, dailyBudgetResetMs: () => 300, sendWindowDelayMs: () => 0,
  });
  const captured = await service.captureManualSource({ text: 'Offline status', label: 'Offline status' });
  const created = await service.create({
    name: 'Offline status', sourceMessageIds: [captured.sources[0].id],
    groupJids: ['offline-status@g.us'], deliveryMode: 'GROUP_STATUS', schedule: { type: 'ONCE' },
  } as never);
  await assert.rejects(() => offline.start(created.id), /must be connected/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx tsx --test src/safety/limits.test.ts src/campaigns/service.test.ts`
Expected: FAIL — `drawStatusGroupCooldownMs` is missing and the worker still calls `sendMessage`.

- [ ] **Step 3: Implement the limits and worker**

`limits.ts`: add the constant and draw (uniform, inclusive floor, same pattern as `drawGroupCooldownMs`).

`campaigns/service.ts`:
- Add `private async statusContentFromPayload(payload: string): Promise<GroupStatusContent>`: parse the stored JSON; image → `prepareCampaignImage` then `{ image: image.image, caption }`; video → base64 buffer and `{ video, caption }` (reject if `!GROUP_STATUS_VIDEO_SUPPORTED`); text → `{ text }`; anything else throws the existing invalid-source error.
- In the recipient select, include `lastStatusSentAt`. In the cooldown block, when `statusMode`, use `lastStatusSentAt` and `drawStatusGroupCooldownMs()`; keep the existing grace logic and the message branch unchanged.
- In the send branch, when `statusMode`, load the ordered sources once, pick one with `Math.floor(Math.random() * sources.length)`, build the content with `statusContentFromPayload`, and call `this.whatsapp.sendGroupStatus(target.groupJid, content)` inside `enqueueAccountSend` (the same `minSendGapSeconds` argument). On success, stamp `groups.lastStatusSentAt`; otherwise the existing catch marks FAILED and feeds the breaker. Skip the per-source loop in status mode.
- In `start()` and `runNow()`, after loading the campaign and before changing status, throw the clear error when `campaign.deliveryMode === 'GROUP_STATUS'` and `this.whatsapp.getStatus().state !== 'CONNECTED'`.

`routes/campaigns.ts`: wrap the `start` and `run-now` handlers in try/catch and return `reply.code(400).send({ message })`, matching the create/update handlers.

- [ ] **Step 4: Run the tests and the suite**

Run: `cd apps/api && npx tsx --test src/safety/limits.test.ts src/campaigns/service.test.ts`
Expected: PASS.
Run: `npm test --workspace=@wa-control/api`
Expected: PASS.
Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/safety/limits.ts apps/api/src/campaigns/service.ts apps/api/src/routes/campaigns.ts apps/api/src/safety/limits.test.ts apps/api/src/campaigns/service.test.ts
git commit -m "feat: send group-status campaigns with cooldown and start guard

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 8: targetAllGroups reconciliation

**Files:**
- Modify: `apps/api/src/campaigns/service.ts`
- Test: `apps/api/src/campaigns/service.test.ts`

**Interfaces:**
- `CampaignPacing.statusReconcileIntervalMs?: number` (default 10 minutes)
- `CampaignService` uses `WhatsAppManager.participatingGroupJids()` from Task 2.
- `private async reconcileAllGroupTargets(campaignId: string, liveJids: string[]): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Add to `service.test.ts`. Set `statusReconcileIntervalMs: 0` on the shared service's pacing object so the worker reconciles on every pass in tests:

```ts
let liveGroupJids: string[] = [];
// In whatsappStub add:
//   participatingGroupJids: async () => liveGroupJids,

test('targetAllGroups adds a newly synced group', async () => {
  await db.update(groups).set({ isExcluded: true });
  await insertGroup('all-live@g.us', 'All live');
  const captured = await service.captureManualSource({ text: 'All live status', label: 'All live status' });
  const created = await service.create({
    name: 'All live status', sourceMessageIds: [captured.sources[0].id],
    groupJids: [], deliveryMode: 'GROUP_STATUS', targetAllGroups: true, schedule: { type: 'ONCE' },
  } as never);
  await insertGroup('all-new@g.us', 'All new');
  liveGroupJids = ['all-live@g.us', 'all-new@g.us'];
  await service.start(created.id);
  await waitForTargetsSent(created.id, 10_000, 2);
  const jids = (await db.select({ jid: campaignTargets.groupJid }).from(campaignTargets)
    .where(eq(campaignTargets.campaignId, created.id))).map((row) => row.jid).sort();
  assert.deepEqual(jids, ['all-live@g.us', 'all-new@g.us']);
});

test('reconciliation cancels a queued target whose group is no longer live', async () => {
  await insertGroup('left-group@g.us', 'Left group');
  const captured = await service.captureManualSource({ text: 'Left status', label: 'Left status' });
  const created = await service.create({
    name: 'Left status', sourceMessageIds: [captured.sources[0].id],
    groupJids: ['left-group@g.us'], deliveryMode: 'GROUP_STATUS', schedule: { type: 'ONCE' },
  } as never);
  const reconcile = (service as unknown as {
    reconcileAllGroupTargets: (id: string, live: string[]) => Promise<void>;
  }).reconcileAllGroupTargets.bind(service);
  await reconcile(created.id, ['some-other-group@g.us']);
  const [target] = await db.select().from(campaignTargets).where(eq(campaignTargets.campaignId, created.id));
  assert.equal(target.status, 'CANCELLED');
  assert.match(target.errorMessage ?? '', /no longer a member/);
});

test('an empty live group list does not cancel targets', async () => {
  await insertGroup('kept-group@g.us', 'Kept group');
  const captured = await service.captureManualSource({ text: 'Kept status', label: 'Kept status' });
  const created = await service.create({
    name: 'Kept status', sourceMessageIds: [captured.sources[0].id],
    groupJids: ['kept-group@g.us'], deliveryMode: 'GROUP_STATUS', schedule: { type: 'ONCE' },
  } as never);
  const reconcile = (service as unknown as {
    reconcileAllGroupTargets: (id: string, live: string[]) => Promise<void>;
  }).reconcileAllGroupTargets.bind(service);
  await reconcile(created.id, []);
  const [target] = await db.select().from(campaignTargets).where(eq(campaignTargets.campaignId, created.id));
  assert.equal(target.status, 'QUEUED');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx tsx --test src/campaigns/service.test.ts`
Expected: FAIL — `reconcileAllGroupTargets` is missing and new groups are not added.

- [ ] **Step 3: Implement reconciliation**

In `campaigns/service.ts`:
- Add `statusReconcileIntervalMs?: number` to `CampaignPacing`; `DEFAULT_PACING` sets `10 * 60_000`.
- Add a private `lastAllGroupReconcile = new Map<string, number>()`.
- Add `reconcileAllGroupTargets(campaignId, liveJids)`:
  - Return immediately when `liveJids.length === 0` (a transient empty fetch must not cancel everything).
  - Load existing targets (`id`, `groupJid`, `status`, `position`).
  - Query non-excluded `groups` rows for the account whose JIDs are in `liveJids` but not already targeted; insert missing rows with sequential positions and `.onConflictDoNothing()`.
  - Update QUEUED/WAITING targets whose group is not in `liveJids` to `CANCELLED` with `errorMessage: 'The account is no longer a member of this group.'`.
- In `work()`, after the CONNECTED check, when `campaign.deliveryMode === 'GROUP_STATUS' && campaign.targetAllGroups`, run the reconcile when `Date.now() - (this.lastAllGroupReconcile.get(id) ?? 0) >= (this.pacing.statusReconcileIntervalMs ?? 600_000)`; wrap in try/catch and log a warning on failure; set the timestamp only on success. Call `this.whatsapp.participatingGroupJids()`.

- [ ] **Step 4: Run the tests and the suite**

Run: `cd apps/api && npx tsx --test src/campaigns/service.test.ts`
Expected: PASS.
Run: `npm test --workspace=@wa-control/api`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/campaigns/service.ts apps/api/src/campaigns/service.test.ts
git commit -m "feat: reconcile all-group status campaign targets

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 9: Dashboard delivery mode

**Files:**
- Modify: `apps/web/src/main.tsx`

**Interfaces:**
- Campaign payload includes `deliveryMode` and `targetAllGroups`.
- The form shows the delivery select, the status warning, and the all-groups checkbox.
- The history card shows a `GROUP STATUS` badge.

- [ ] **Step 1: Add the type and state**

Add to `type Campaign`: `deliveryMode?: 'MESSAGE' | 'GROUP_STATUS'; targetAllGroups?: boolean;`.

Add state:
```ts
const [deliveryMode, setDeliveryMode] = useState<'MESSAGE' | 'GROUP_STATUS'>('MESSAGE');
const [targetAllGroups, setTargetAllGroups] = useState(false);
```

Reset both in `clearCampaignForm`. Load both in `beginCampaignEdit` from `detail.deliveryMode ?? 'MESSAGE'` and `Boolean(detail.targetAllGroups)`.

- [ ] **Step 2: Send the fields**

In `createCampaign` and `saveCampaignEdit`:
- Skip the "select at least one group" error when `deliveryMode === 'GROUP_STATUS' && targetAllGroups`.
- Reject `targetAllGroups` unless the mode is `GROUP_STATUS`.
- Send `deliveryMode`, `targetAllGroups`, and `groupJids: targetAllGroups ? [] : selectedGroupJids`.

- [ ] **Step 3: Render the form controls**

Above the source textarea or below the name, add a delivery select. It is disabled when `editingCampaign` is set (mode is immutable). When `deliveryMode === 'GROUP_STATUS'`, render the warning (visible to all group members, no audience limit, 24 hours, shares the 300/day budget, one random source per group per pass) and the "Post to every group on this account, including groups joined later" checkbox. Hide the recipient-group picker when that checkbox is checked. Keep the schedule and shuffle controls. Hide the auto-add checkbox when `targetAllGroups` is on (the reconcile covers it).

In the campaign history row, add `{campaign.deliveryMode === 'GROUP_STATUS' && <span className="badge">GROUP STATUS</span>}` near the status text.

- [ ] **Step 4: Verify the UI builds**

Run: `npm run check`
Expected: PASS.
Run: `npm run build`
Expected: PASS.

Manual check (do not start a live campaign): load the dashboard, create a status campaign as a draft with a test group, edit it, confirm the checkbox state and the badge. Do not press Start until the operator's rollout in the spec §9.3.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/main.tsx
git commit -m "feat: add group-status delivery to campaign dashboard

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 10: Final verification

**Files:** none.

- [ ] **Step 1: Run the full checks**

Run: `npm run check`
Expected: PASS.
Run: `npm test`
Expected: PASS (API suite; the web workspace has no test script).
Run: `npm run build`
Expected: PASS.

- [ ] **Step 2: Verify a clean boot migrates an existing database**

Run:
```bash
cd apps/api
DATABASE_PATH=/tmp/wa-status-boot.db npx tsx -e "
  import { sql } from 'drizzle-orm';
  const { bootstrapDatabase } = await import('./src/db/bootstrap.js');
  const { db } = await import('./src/db/client.js');
  await bootstrapDatabase();
  console.log(await db.all(sql.raw('PRAGMA table_info(campaigns)')));
  console.log(await db.all(sql.raw('PRAGMA table_info(groups)')));
"
rm -f /tmp/wa-status-boot.db /tmp/wa-status-boot.db-wal /tmp/wa-status-boot.db-shm
```
Expected: `delivery_mode` and `target_all_groups` in the campaigns columns; `last_status_sent_at` in the groups columns. If `tsx -e` does not accept the inline module, run the same code from a temporary `.ts` file instead; the assertion is the column list, not the command shape.

- [ ] **Step 3: Report the state**

Summarize for the operator: the spike result, the video support flag, the tests that pass, and the remaining rollout gates (test group, pilot 5–10 groups, then all groups). Do not start a live all-groups campaign as part of this plan; that is the operator's rollout decision.
