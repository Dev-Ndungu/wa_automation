import type { WAMessage } from '@whiskeysockets/baileys';

type MessageNode = Record<string, unknown>;

function asNode(value: unknown): MessageNode | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as MessageNode : null;
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Pull only textual fields that can contain a received invite. This avoids
 * storing full WhatsApp message payloads while covering normal text, captions,
 * quoted messages, and the common ephemeral/view-once wrappers.
 */
export function extractMessageText(message: Pick<WAMessage, 'message'>): string[] {
  const values: string[] = [];
  const visited = new Set<object>();

  const visitContext = (context: unknown) => {
    const node = asNode(context);
    if (node) visit(node.quotedMessage);
  };

  const visit = (value: unknown): void => {
    const node = asNode(value);
    if (!node || visited.has(node)) return;
    visited.add(node);

    const conversation = textValue(node.conversation);
    if (conversation) values.push(conversation);

    for (const field of ['extendedTextMessage', 'imageMessage', 'videoMessage', 'documentMessage'] as const) {
      const content = asNode(node[field]);
      if (!content) continue;
      const text = textValue(field === 'extendedTextMessage' ? content.text : content.caption);
      if (text) values.push(text);
      visitContext(content.contextInfo);
    }

    for (const wrapper of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage', 'editedMessage'] as const) {
      const wrapped = asNode(node[wrapper]);
      if (wrapped) visit(wrapped.message);
    }

    const protocol = asNode(node.protocolMessage);
    if (protocol) visit(protocol.editedMessage);
  };

  visit(message.message);
  return values;
}
