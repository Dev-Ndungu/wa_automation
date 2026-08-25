import assert from 'node:assert/strict';
import test from 'node:test';
import { deduplicateInviteLinks, extractInviteLinks } from './extract.js';

test('extractInviteLinks normalises valid WhatsApp group URLs and strips attached punctuation', () => {
  const links = extractInviteLinks('Join (https://chat.whatsapp.com/AbcD_12345), or https://CHAT.WHATSAPP.COM/Zyx987654?unused=yes.');
  assert.deepEqual(links, [
    { inviteUrl: 'https://chat.whatsapp.com/AbcD_12345', inviteCode: 'AbcD_12345' },
    { inviteUrl: 'https://chat.whatsapp.com/Zyx987654', inviteCode: 'Zyx987654' },
  ]);
});

test('extractInviteLinks rejects malformed, non-WhatsApp and lookalike URLs', () => {
  const links = extractInviteLinks('https://evil.example/chat.whatsapp.com/AbcD_12345 https://chat.whatsapp.com.evil/AbcD_12345 https://chat.whatsapp.com/no');
  assert.deepEqual(links, []);
});

test('deduplicateInviteLinks creates one sighting per invite per message', () => {
  const link = { inviteUrl: 'https://chat.whatsapp.com/AbcD_12345', inviteCode: 'AbcD_12345' };
  assert.deepEqual(deduplicateInviteLinks([link, link]), [link]);
});
