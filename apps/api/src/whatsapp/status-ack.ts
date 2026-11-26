import type { BinaryNode } from '@whiskeysockets/baileys';

/**
 * Build the ack for a top-level `<status>` stanza. Mirrors Baileys'
 * `buildAckStanza` for the status class: `class` is the stanza tag, `to` is the
 * sender, and `from` is only added for message-class ACKs, so status ACKs omit
 * it.
 */
export function buildStatusAck(node: BinaryNode): BinaryNode {
  const attrs: Record<string, string> = {
    id: node.attrs.id,
    to: node.attrs.from,
    class: node.tag,
  };
  if (node.attrs.participant) attrs.participant = node.attrs.participant;
  if (node.attrs.recipient) attrs.recipient = node.attrs.recipient;
  if (node.attrs.type) attrs.type = node.attrs.type;
  return { tag: 'ack', attrs };
}
