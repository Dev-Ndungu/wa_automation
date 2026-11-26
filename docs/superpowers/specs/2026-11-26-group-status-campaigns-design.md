# Group Status Campaigns — Design

Date: 2026-11-26
Status: Draft for operator approval
Author: Claude Code (with operator)

## 1. Intent and why

WhatsApp's new Group Status feature (announced 29 Oct 2026) lets a group member
post a 24-hour status update that only that group's members can see. The
operator belongs to hundreds of groups and does not have time to post the same
update in each one by hand. They want a campaign-like feature: choose the status
content (text, image, video), point it at every group the linked account is in,
let it run with the existing safety pacing, and edit the content while it runs.

The feature automates the operator's own account only. It does not message
individuals, scrape group members, or post to groups the account is not in.

## 2. Goals

- Create a campaign whose delivery mode is a Group Status instead of a group
  message.
- Target either explicitly selected groups or every non-excluded group on the
  account, including groups joined after the campaign was created.
- Use the same source pool as message campaigns: up to 10 text/image/video
  sources, editable while the campaign runs.
- Post **one status per target group per pass**, chosen at random from the
  source pool, so a campaign with a 5-item pool does not post 5 statuses to each
  of hundreds of groups.
- Reuse the existing scheduler, Run/Pause/Stop/Resume actions, account-wide send
  queue, 06:00–23:00 Africa/Nairobi window, randomized 60–240 s gaps, 300
  sends/day budget, auto-pause/auto-resume, circuit breaker, and dashboard
  progress display.
- Apply a status-specific per-group cooldown of 48–96 hours (random draw), so a
  group does not receive a status every day.
- Keep the feature on a single account: the status must appear as authored by
  the operator's account, not distributed across linked accounts.

## 3. Non-goals

- Contact status (`status@broadcast`) posting. That is a different feature and
  is not part of this design.
- Replying to, reacting to, or ingesting other members' statuses.
- Revoking/deleting a posted status, or reading status view receipts.
- Contact/audience management beyond group membership.
- Distributing status campaigns across multiple linked accounts.
- Background monitoring of incoming `<status>` stanzas (see §10, risk item).
- A dedicated status campaign page. The existing Campaigns page gains a
  delivery-mode choice.

## 4. Anti-goals

The design fails even if the code runs when any of these happen:

- The account is restricted or banned. The account was restricted twice before,
  most recently 2026-09-02 after 34 messages to 34 groups in 36 minutes. A
  status broadcast to hundreds of groups is the same macro pattern at a larger
  scale. No pacing makes it officially safe.
- Statuses are acknowledged by the server but never appear to members. This is
  the exact failure mode of the removed attempt (§5.3): a missing plaintext
  `meta` node makes WhatsApp accept the stanza and silently drop it.
- A group receives repeated identical statuses at a rate that looks automated.
- The campaign sends to groups the account has left, tripping failures and the
  circuit breaker.
- Status sends consume the whole 300/day budget without the operator
  understanding why their message campaign is starving.

## 5. What we know

### 5.1 Protocol

Stock `@whiskeysockets/baileys` 7.0.0-rc14 already contains the protobuf fields
(`Message.groupStatusMessage` field 96 and `groupStatusMessageV2` field 103,
`ContextInfo.isGroupStatus`, `StatusAttribution.GroupStatus`), but it has no
high-level sender. `sock.sendMessage(groupJid, { groupStatusMessageV2: ... })`
throws `Invalid media type`; only the low-level `sock.relayMessage` works.

Community-validated working shape (confidence: medium; no official WhatsApp
documentation, and no controlled test on this account yet):

```js
// inner message is an ordinary Message with contextInfo.isGroupStatus = true
// relayed to the group's @g.us JID, with a plaintext meta child on the stanza
await sock.relayMessage(groupJid, innerMessage, {
  messageId,
  additionalNodes: [
    { tag: 'meta', attrs: { is_group_status: 'true', origin: 'group_status' } }
  ]
});
```

`groupStatusMessageV2 = { message: <inner> }` wraps the inner message; the
strongest field report wraps it at send time. `contextInfo.isGroupStatus = true`
is present on received group statuses. A 32-byte `messageSecret` may be required
for media; the community evidence conflicts on whether it belongs on the wrapper,
the inner message, both, or neither. The spike in §9 settles this on this
account before the campaign feature is wired.

Media has a second stock-Baileys gap: `relayMessage` computes `getMediaType()`
on the raw message, so media nested inside `groupStatusMessageV2` loses the
`<enc mediatype>` attribute and is reportedly dropped. The public
`SocketConfig.patchMessageBeforeSending` hook runs after `getMediaType` and can
wrap a marked message, preserving the attribute. This is the chosen mechanism
(used by community implementations such as Zaileys).

### 5.2 Linked-device eligibility

Official Group Status authoring is documented for Android and iOS only; no
WhatsApp Web/Desktop authoring path is documented. However, the multi-device
wire protocol accepts the post: community reports show a linked device posting
text and image group statuses that appeared on an Android phone and in WhatsApp
Web's status list. Confidence is medium and the spike is mandatory.

### 5.3 Prior art in this repository

Commit `6843cf5` added a group-status delivery mode; commit `0fa8bc7` removed it.
The removed sender built the inner message, stripped `messageContextInfo`, and
wrapped it in `groupStatusMessageV2` — but it did **not** set
`contextInfo.isGroupStatus` and did **not** attach the plaintext meta node. On
current evidence that shape is acknowledged and silently dropped. The removed
route also bypassed the account-wide serial send queue and checked only the
window and daily cap. We reuse the idea, not the broken payload or the
bypass.

### 5.4 Enforcement

- WhatsApp's Messaging Guidelines prohibit unofficial clients, bulk messaging,
  and automation, and explicitly cover status updates and groups. Every run is a
  policy violation regardless of pacing.
- Group status reaches every group member, including non-contacts, regardless
  of the poster's status privacy settings, and is reportable from the status
  viewer.
- No published safe volume exists. A public report describes a permanent ban
  after bulk contact-status uploads; no group-status-specific ban report exists
  yet because the feature is about four weeks old.
- The project's existing pacing is a risk reducer, not a safety guarantee.
  Macro pattern (many distinct groups in a short period, repeated daily) has
  mattered more than per-message gaps.

The operator has stated the account is currently in good standing and has
accepted the risk. The design still builds in the controls in §8.

## 6. Approaches considered

### A. Extend the campaign engine with a delivery mode (chosen)

Add `deliveryMode` (`MESSAGE` | `GROUP_STATUS`) and `targetAllGroups` to the
existing `campaigns` table and campaign input/plan. The same worker, scheduler,
target table, source table, pacing queue, and dashboard are used. The send path
branches on `deliveryMode`.

Why it fits: it reuses every safety control that already exists, keeps one
mental model for the operator, and supports live editing and newly joined
groups with the code already written for message campaigns. Status-specific
accounting (cooldown, sent timestamp) is additive.

### B. A dedicated `status_campaigns` stack (rejected)

Would duplicate the worker, scheduler, routes, UI, pause/resume logic, budget
accounting, and distribution code. Two engines drift; a safety fix would have
to be made twice. No benefit for this feature.

### C. Switch to a Baileys fork with native group-status send (rejected)

Forks (Vkazee, wolfsocket, Zaileys) advertise `groupStatusMessageV2` sending.
Adopting one adds an unvetted supply-chain dependency for a payload that stock
Baileys can express through its public `relayMessage` and
`patchMessageBeforeSending` APIs. The fork's send path also hides the exact
payload we need to test. Rejected; revisit only if the spike proves stock
Baileys cannot do it.

### D. Android device automation (rejected)

Driving the official app with ADB/Appium avoids the protocol guesswork but
requires a dedicated phone kept online, is fragile across app updates, and does
not fit a server-side dashboard. Not chosen.

## 7. Design

### 7.1 Data model

Add to `campaigns` (schema.ts and bootstrap.ts migrations):

| Column | Type | Default | Meaning |
|---|---|---|---|
| `delivery_mode` | text | `'MESSAGE'` | `MESSAGE` or `GROUP_STATUS` |
| `target_all_groups` | integer bool | `false` | When true, every non-excluded group on the account is a target, including future groups |

Add to `groups`:

| Column | Type | Meaning |
|---|---|---|
| `last_status_sent_at` | text | Last successful group-status post to this group |

Remove the `delivery_mode` removal guard at `bootstrap.ts:98-103`. That guard
pauses any `GROUP_STATUS` row; leaving it in place would immediately pause the
new feature on every boot. Replace it with an idempotent `ALTER TABLE` that adds
`delivery_mode` when missing.

`delivery_mode` is immutable after creation. Changing a campaign between message
and status semantics would invalidate its targets, accounting, and cooldown
history; the operator creates a new campaign instead.

`target_all_groups` is mutable after creation, because §9.3 reuses the pilot
campaign for the ramp. Turning it on keeps every existing target and adds all
other non-excluded groups; turning it off keeps the current target rows as the
explicit list, so the operator never has to re-pick. Existing SENT/WAITING rows
and their cooldowns are untouched.

### 7.2 Input and validation

Extend `CampaignInput` and `CampaignPlan` in
`apps/api/src/campaigns/service.ts`:

```ts
deliveryMode?: 'MESSAGE' | 'GROUP_STATUS';
targetAllGroups?: boolean;
```

Validation in `plan()`:

- `deliveryMode` defaults to `MESSAGE`; any other value is rejected.
- `targetAllGroups` defaults to `false`; when true, `groupJids` is ignored and
  the plan expands to all non-excluded `groups` rows for the account. The
  explicit-list validation (`validateExplicitTargets`) is skipped in that case.
- `targetAllGroups` is only valid with `GROUP_STATUS`. A `MESSAGE` campaign with
  `targetAllGroups: true` is rejected: all-groups message delivery is not part
  of this feature and would open a different risk surface.
- A status campaign must have at least one source and at most 10.
- Status text/caption: reject over 1,024 characters (the prior implementation's
  limit). Verify the real client limit in the spike; adjust only with evidence.
- Video: allowed through the same source pool, but see §9; if the spike cannot
  prove video rendering, reject video sources for `GROUP_STATUS` at plan time
  with a clear message instead of shipping a silently failing path.
- Status campaigns are never distributed. `AccountService.createCampaign` and
  `updateCampaign` must keep them on the owner account (no `distributionId`,
  no shards) even when other accounts are connected.

`targetAllGroups` is stored on the campaign so a later pass can reconcile.
`autoAddJoinedGroups` remains available for explicit-list status campaigns.

### 7.3 Sending path

Add to `WhatsAppManager`:

```ts
private readonly statusWraps = new WeakSet<proto.IMessage>();

public async sendGroupStatus(
  groupJid: string,
  content: GroupStatusContent,
): Promise<void>
```

Steps:

1. Reject non-`@g.us` JIDs and a non-CONNECTED socket.
2. Generate the inner message with the existing
   `generateWAMessageContent(content, { upload: socket.waUploadToServer })`.
   Text goes through `extendedTextMessage`; image/video through the normal media
   path (JPEG conversion and thumbnail for images as in message campaigns).
3. Set `contextInfo.isGroupStatus = true` on the generated inner content
   (`extendedTextMessage`, `imageMessage`, or `videoMessage`).
4. Decide `messageSecret` handling from the spike result. The default
   implementation wraps with a single 32-byte secret at both the wrapper and
   inner levels; the spike also tests the no-secret variant.
5. Add the inner message to `statusWraps` and call
   `socket.relayMessage(groupJid, inner, { messageId: generateMessageID(),
   additionalNodes: [{ tag: 'meta', attrs: { is_group_status: 'true',
   origin: 'group_status' } }] })`.
6. Configure `patchMessageBeforeSending` on the socket at connect time. If the
   message is in `statusWraps`, return
   `{ messageContextInfo: { messageSecret }, groupStatusMessageV2: { message: {
   ...msg, messageContextInfo: { messageSecret } } } }`. Otherwise return the
   message unchanged.

`relayMessage` is called with the **inner** message, never a pre-built
`groupStatusMessageV2` envelope. rc14 computes `getMediaType` on that argument
before the patch runs, so the top-level `imageMessage`/`videoMessage` is what
sets the `<enc mediatype>` attribute; the patch then wraps it. The WeakSet
ensures ordinary campaign messages are untouched. If an image or video is acked
but never appears, the mediatype attribute is the first suspect: the spike tests
a dual-field carrier variant (top-level media plus the wrapper marker) before
any fork is considered.

Two rc14 details are part of the send path, not optional polish:

- **Retry cache:** rc14 caches the raw `relayMessage` argument (the inner
  message). After each status relay we overwrite that cache entry with the
  wrapped `groupStatusMessageV2` envelope, and `getMessage` also returns the
  wrapper as a fallback, so a retry resends a status-shaped payload. Verified
  in rc14 on 2026-11-26: the retry branch bypasses
  `patchMessageBeforeSending` and does not attach `additionalNodes`, so the
  plaintext `meta` node cannot be added on a retry through the public API. A
  retried status may therefore still be dropped; the target is marked `SENT`
  and the pilot must watch for it. Attaching the meta on retries would require
  a local Baileys patch/fork.
- **Incoming `<status>` stanzas:** rc14 registers no `CB:status` handler. When
  group members (including this account's own group-status audience) produce
  status traffic, the server expects an ack; without one it closes the stream
  after roughly 50 minutes with `Stream Errored (ack)`. Because this feature
  makes group-status traffic likely, the implementation must add a minimal
  status-stanza ack handler (port the ack-only approach from upstream PRs
  #2866/#2883, via the socket's underlying ws event if no public API exists)
  and prove it in the spike. Without this, the connection will churn and the
  campaign cannot run reliably.

`GroupStatusContent` is a small shared type:
`{ text: string } | { image: Buffer, caption: string } |
{ video: Buffer, caption: string }` (background color/font are out of scope for
v1).

### 7.4 Campaign worker branch

In `CampaignService.work()`:

- Before selecting a target, when `deliveryMode === 'GROUP_STATUS'` and
  `targetAllGroups` is true, reconcile targets with the current group set:
  - At the start of each run (or at most once per pass), refresh WhatsApp group
    participation through a new manager method that returns the live group JIDs
    (wrapping `groupFetchAllParticipating`). This is one server IQ.
  - Insert a `campaign_targets` row for every live, non-excluded group not
    already present.
  - Mark existing targets whose group is no longer live as `CANCELLED` with a
    clear reason, so a left group cannot exhaust retries or trip the breaker.
  - If the live fetch fails, fall back to the local `groups` table and leave
    existing targets alone; do not cancel on a transient fetch failure.
- Deliverability: `canDeliverTarget` still applies.
- Cooldown: for `GROUP_STATUS`, use `groups.last_status_sent_at` and a frozen
  `STATUS_GROUP_COOLDOWN = { minHours: 48, maxHours: 96 }` draw. For `MESSAGE`,
  the existing 18–48 h `GROUP_COOLDOWN` and `last_campaign_sent_at` are
  unchanged. The draw is made once when the target is parked as `WAITING`, same
  as the existing cooldown logic. The existing 2–6 h `NEW_GROUP_GRACE` still
  applies to status targets because the worker path is shared; groups synced
  from outside the app have `joinedAt = null` and therefore get no grace.
- Permission refusals: the local `groups` table stores no admin/announcement
  flag, so announce-only groups where the account cannot post are not filtered
  proactively. A refused post is a normal failure and counts toward the
  account-wide circuit breaker; the operator excludes the group after the first
  failure. The spike (§9.2) includes this case.
- Send: pick one source at random from the campaign's ordered source list. Build
  its payload, then call `whatsapp.sendGroupStatus(groupJid, content)` **inside**
  `enqueueAccountSend`, exactly like a normal send. This preserves the serial
  queue, 60–240 s gaps, reconnect settle, send window, settle re-check, and
  `recordSend` budget accounting.
- Success: mark the target `SENT` with `sentAt`, set
  `groups.last_status_sent_at`, and reset the consecutive-failure counter.
- Failure: mark the target `FAILED` with the error; increment the failure streak
  and trip the circuit breaker after 5 consecutive failures, exactly as today.
- A status campaign that reaches the 300/day budget auto-pauses and auto-resumes
  through the existing `pauseForDailyBudget`/`applyAutoResume` path.
- The per-target loop that sends every source in message mode does not apply to
  status mode: status mode sends exactly one source and moves to the next
  target.

### 7.5 Scheduling and runs

Reuse the existing schedule types (once, minutely, hourly, daily, every N days,
weekly). A recurring status campaign re-queues its targets at the next run; the
per-group status cooldown parks groups that are not due. There is no "post all
sources to each group" mode.

`targetAllGroups` is a target-set modifier, not a scheduling mode. A pass runs
to completion, and the next scheduled run begins only after the current pass
drains, exactly as with message campaigns. The 48–96 h per-group cooldown — not
the schedule time — determines how often any one group receives a status. The
dashboard copy says this explicitly so a daily schedule is not mistaken for a
daily post per group.

Because status sends share the 300/day budget, a recurring campaign that finds
more due groups than the budget allows pauses for the rest of the day and
resumes after the budget resets (and after 06:00 EAT), exactly like a message
campaign.

### 7.6 Dashboard

In `apps/web/src/main.tsx`:

- Add a "Delivery" select to the campaign form: `Group message` (default) and
  `Group status`.
- When `Group status` is selected:
  - Show a short warning: status is visible to every member of the group,
    cannot be audience-limited, disappears after 24 hours, and shares the
    account's 300/day send budget.
  - Add a checkbox "Post to every group on this account, including groups joined
    later" (`targetAllGroups`). When checked, hide/disable the individual group
    picker and send `targetAllGroups: true`.
  - Show the source-pool hint: one source is chosen at random per group per
    pass.
  - Keep the schedule, auto-add (for explicit lists), and shuffle-order
    controls.
- Campaign history shows a `GROUP STATUS` badge and the same progress counts.
  The card's schedule summary remains correct.
- Editing loads the same detail payload. For a status campaign with
  `targetAllGroups`, the edit view shows the count of current groups and the
  "all groups" checkbox instead of a stale explicit list.

The UI does not add a separate status composer page; the campaign form is the
single entry point.

### 7.7 Routes

No new route. The existing `POST /api/campaigns`, `PUT /api/campaigns/:id`, and
action routes carry the new fields. The existing `GET /api/campaigns` and
`GET /api/campaigns/:id` return `deliveryMode` and `targetAllGroups` through the
spread of the campaign row.

### 7.8 Accounting and relationships

- Status sends are `action_log` rows with `action = 'SEND'` (via the existing
  `recordSend`), so they count against the shared 300/day budget. This is
  deliberate: the account never exceeds its existing total outbound ceiling.
- Status sends set `groups.last_status_sent_at`, not `last_campaign_sent_at`.
  Message cooldowns and status cooldowns do not block each other, but the daily
  budget is shared.
- `campaign_targets.sent_at` is the status post time for status campaigns.
- Operational logs record status-campaign sends and failures through the
  existing campaign events; no new sensitive data is logged (no group member
  lists, no message bodies beyond the existing preview).

### 7.9 Edge cases

- **Group joined after campaign creation:** inserted by the next reconcile pass
  when `targetAllGroups`, or by the existing `subscribeGroupJoined` path when
  `autoAddJoinedGroups` is on for an explicit-list campaign.
- **Group left/removed:** cancelled by the live reconcile; if the live fetch is
  unavailable, the send fails cleanly and counts toward the breaker.
- **Excluded group:** never added by reconcile; an existing target is cancelled
  at delivery time by the existing exclusion check.
- **Empty source pool:** plan-time rejection (campaigns already require at
  least one source).
- **Source deleted while running:** the existing "source message no longer
  exists" error fails the target; the operator can stop and fix.
- **Delivery mode change on edit:** rejected; create a new campaign.
- **Multi-account connected:** status campaigns stay on the owner; the campaign
  list still renders them normally.
- **Campaign restart (process crash):** `recover()` marks in-flight rows FAILED
  and never resends automatically, as today. The operator re-runs.

### 7.10 Community-linked groups (added after the live spike)

The live spike proved text, image and video render in a normal group and are
silently dropped in the UOEM group, whose metadata has `linkedParent` set
(Community-linked). WhatsApp enforces this server-side; the operator chose a
message fallback so every group is reached.

- `groups.community_parent_jid` stores `GroupMetadata.linkedParent`, refreshed by
  the group sync/upsert.
- A status campaign still targets every non-excluded group.
- The worker sends a group status to normal groups. For a target whose
  `community_parent_jid` is set, it sends the same randomly selected source as a
  **normal group message** through `enqueueAccountSend` (text, image, or video).
- The fallback stamps both `last_status_sent_at` and `last_campaign_sent_at`.
  Its cooldown uses the later of the two timestamps plus the status 48–96 h
  draw, so the status cadence and the normal message cooldown are both
  respected.
- A fallback failure counts toward the same circuit breaker.
- The dashboard marks Community-linked groups and shows how many status-campaign
  targets will receive a message instead of a status.
- Semantics note: a Community group receives a chat message, not a 24-hour
  status; members may be notified by the message.

## 8. Safety controls

These are fixed in `safety/limits.ts` and not operator-configurable, matching the
existing project policy:

- `STATUS_GROUP_COOLDOWN = { minHours: 48, maxHours: 96 }` (random draw per
  group, per parking).
- Existing `SEND_GAP` 60–240 s, `SEND_DAILY_LIMIT` 300/day, send window
  06:00–23:00 Africa/Nairobi, reconnect settle, campaign warm-up, circuit
  breaker, and daily-budget auto-pause all apply unchanged.
- Status campaigns are single-account; no cross-account multiplication of the
  daily cap.
- Stop All Sending and Disconnect remain the kill switches.
- A `GROUP_STATUS` campaign's Start/Run now is rejected with a clear error when
  the account is not CONNECTED. A campaign already RUNNING when the connection
  drops simply waits, like a message campaign; it does not auto-pause.
- A status campaign cannot start unless the WhatsApp manager's 403/LOGGED_OUT
  handling has not stopped reconnects.

The operator-facing rollout in §9 is part of the safety design, not optional
polish: the first live status is a single test group; the campaign is not
pointed at all groups until that is verified.

## 9. Testing and live spike

### 9.1 Unit and integration tests

- `campaigns/service.test.ts`:
  - plan accepts `GROUP_STATUS`, rejects unknown modes, rejects oversized
    status text, expands `targetAllGroups` to non-excluded groups.
  - create/update persist `deliveryMode` and `targetAllGroups`.
  - status worker sends exactly one source per target through the serial queue,
    sets `last_status_sent_at`, does not set `last_campaign_sent_at`.
  - status cooldown parking uses 48–96 h draws; message cooldown remains 18–48 h.
  - daily budget: status sends count against the shared 300 and auto-pause.
  - worker reconcile adds new groups and cancels left groups; a failed live
    fetch does not cancel targets.
  - `AccountService.createCampaign` keeps status campaigns on the owner with no
    distribution id.
- `whatsapp/manager.test.ts` (new): the status envelope has
  `groupStatusMessageV2.message`, `contextInfo.isGroupStatus = true`, the meta
  node, and the configured messageSecret; non-marked messages pass through the
  patch hook unchanged.
- Existing tests must keep passing. The working tree already has uncommitted
  multi-account changes; run the suite before and after and do not fold
  unrelated fixes into this feature.

### 9.2 Live spike (mandatory before the campaign UI is enabled)

Run with the API server stopped so two processes do not share the Baileys auth
folder. Use a dedicated test group the operator creates and controls.

1. Text status: post a short text with the meta node + `isGroupStatus`, no
   messageSecret. Verify on the operator's phone (Updates tab / group status).
   Phone rendering is the gate; Web listing is unconfirmed by any official
   source and is not proof.
2. Text status with a 32-byte secret at both levels. Verify.
3. Image status with the `patchMessageBeforeSending` wrapper and the winning
   secret variant. Verify thumbnail/caption.
4. Short video status (≤30 s, ≤16 MB). Verify. If video does not render, mark
   video unsupported for `GROUP_STATUS` and reject it at plan time.
5. Post to a group the account is not in (negative test): expect a clean error,
   no silent success. Repeat in an announcement-only group where the account is
   not an admin, and in a restricted-chat or Community-linked group if the
   operator has one; both are reported to block or reject linked-device posts.
   Record whether the refusal is a thrown error or a silent drop.
6. Leave the linked session connected for at least 60 minutes after a group
   status exists and watch for a `Stream Errored (ack)` close. If it happens,
   the status ack handler from §7.3 must be added and the spike repeated
   before any campaign work.
7. Confirm ordinary message campaigns still send normally through the patched
   socket and after a retry request if one can be induced.

The spike script is throwaway, not committed. Record the winning variant in
the design/implementation notes.

**Spike result (2026-11-26):** text (“spike: secret both”), image and video all
rendered in Test213456 (a normal, non-Community group; see §7.10). The first
`messageSecret: 'none'` text was sent only into the Community-linked UOEM group
and did not render there; that group cannot render any group status, so `'none'`
is not conclusively tested and `'both'` remains the default. The 1,024-character
limit was not independently verified. The 60-minute connection check passed:
the session stayed connected with no `Stream Errored` or reconnect; the only
close was the script's deliberate disconnect.

### 9.3 Rollout

1. **Spike** above, one test group.
2. **Pilot:** a status campaign targeted at 5–10 trusted, admin-owned groups,
   one status per group, 48–96 h cooldown. Watch for 403/463, disconnects,
   send failures, and any WhatsApp warning.
3. **Ramp:** only after a clean pilot, enable `targetAllGroups`. Keep the
   300/day ceiling; the 48–96 h cooldown keeps actual volume below it unless the
   group count is large.
4. **Monitor:** campaign card failures, circuit-breaker banner, WhatsApp
   account status, and the manager's connection state. Stop on the first
   restriction signal.

## 10. Risks the operator accepts

- **Automation is a WhatsApp policy violation.** Baileys is an unofficial
  client; bulk/automated messaging and status posting are prohibited. Pacing
  does not make it compliant.
- **Account restriction or ban.** The account has been restricted twice. A
  recurring all-groups status campaign is a standing mass-broadcast pattern; the
  research rates this **very high** risk for a permanent ban.
- **Visibility is group-wide.** Every member (including non-contacts) sees the
  status; privacy settings do not limit it; any member can report it.
- **Silent drops are possible.** The payload is community-validated, not
  documented. The meta node/messageSecret details may change; WhatsApp can
  change server behavior without notice. The spike and monitoring are the only
  detection.
- **Incoming group statuses are not handled by rc14.** If other members post
  group statuses, the linked device receives `<status>` stanzas that rc14 never
  acks; upstream issue #2858 reports the server closing the stream after about
  50 minutes (`Stream Errored (ack)`). §7.3 makes the minimal ack handler part
  of the implementation; if the spike shows the handler is not enough, the
  feature is blocked until rc14 is patched properly.
- **Restricted Chat setting.** A late-2026 WhatsApp setting can block linked
  device/Web sends in specific chats, including groups, and only the primary
  phone can toggle it. A status post to such a group may fail or be silently
  dropped; the pilot should include one if available.
- **Budget coupling.** Status sends consume the same 300/day budget as message
  campaigns. Running both means neither gets the full cap.
- **Community fallback is a normal chat message.** Community-linked groups get a
  message, not a 24-hour status; members may be notified.
- **The prior implementation did not work as written.** It is a warning, not a
  proven base.

## 11. Decisions made in this design (builder may rely on these)

- Extend `campaigns`, do not add a status-campaign table.
- `deliveryMode` is immutable after creation.
- One status per group per pass, random source from the pool.
- Status campaigns are single-account, never distributed.
- Status sends count against the existing 300/day SEND budget.
- Status cooldown 48–96 h, separate from the message cooldown field.
- Stock Baileys + `relayMessage` + `patchMessageBeforeSending`; no fork.
- Video is gated by the spike; if it cannot be proven, reject video sources at
  plan time.

## 12. Left to the builder

- Exact `GroupStatusContent` type placement and the shared parsing helper for
  source payloads.
- The reconcile cadence (once per run vs. a short interval) and how to avoid a
  live group fetch on every worker tick; the design requires one fetch per run
  and a local fallback.
- The spike script's exact shape and the operator's test-group JID.
- Whether `syncGroups` grows a new return value or a sibling method is added;
  existing callers must keep working.
- The exact UI copy and layout for the delivery select/checkbox.
- Migration ordering for a database that already has the old `delivery_mode`
  column from commit `6843cf5`.
- How the campaign card labels status vs. message progress (badge text).
