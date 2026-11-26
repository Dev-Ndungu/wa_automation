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
