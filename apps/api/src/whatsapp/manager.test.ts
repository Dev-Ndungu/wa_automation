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
