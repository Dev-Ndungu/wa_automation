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
