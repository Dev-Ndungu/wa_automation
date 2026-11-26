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

test('sendGroupStatus caches the wrapped envelope for rc14 retries', async () => {
  const manager = new WhatsAppManager(loggerStub, {} as never, '/tmp/wa-manager-status-test', 'main');
  const relayed: Array<{ jid: string; message: proto.IMessage; options: Record<string, unknown> }> = [];
  const retryCache: Array<{ to: string; id: string; message: proto.IMessage }> = [];
  const fakeSocket = {
    user: { id: '111:1@s.whatsapp.net' },
    waUploadToServer: async () => ({}) as never,
    messageRetryManager: {
      addRecentMessage: (to: string, id: string, message: proto.IMessage) => {
        retryCache.push({ to, id, message });
      },
    },
    relayMessage: async (jid: string, message: proto.IMessage, options: Record<string, unknown>) => {
      relayed.push({ jid, message, options });
    },
  };
  (manager as unknown as { socket: unknown }).socket = fakeSocket;
  (manager as unknown as { status: unknown }).status = {
    state: 'CONNECTED', phone: null, lastConnectedAt: null, qrDataUrl: null, error: null,
  };

  await manager.sendGroupStatus('120363000000000000@g.us', { text: 'retry me' });
  const messageId = String(relayed[0].options.messageId);
  const cached = await (manager as unknown as {
    statusRetryMessage: (key: { id: string }) => Promise<proto.IMessage | undefined>;
  }).statusRetryMessage({ id: messageId });

  assert.ok(cached?.groupStatusMessageV2, 'the retry fallback must hold the wrapped envelope');
  assert.equal(cached?.groupStatusMessageV2?.message?.extendedTextMessage?.text, 'retry me');
  assert.equal(retryCache.length, 1, 'the status retry cache entry must be overwritten with the wrapper');
  assert.equal(retryCache[0].to, '120363000000000000@g.us');
  assert.equal(retryCache[0].id, messageId);
  assert.ok(retryCache[0].message.groupStatusMessageV2);
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
