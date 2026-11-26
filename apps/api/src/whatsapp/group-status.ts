import { randomBytes } from 'node:crypto';
import { generateWAMessageContent } from '@whiskeysockets/baileys';
import type { AnyMessageContent, BinaryNode, proto, WASocket } from '@whiskeysockets/baileys';
import type { FastifyBaseLogger } from 'fastify';

/** The content shapes a group status can carry. */
export type GroupStatusContent =
  | { text: string }
  | { image: Buffer; caption: string }
  | { video: Buffer; caption: string };

/**
 * The community evidence conflicts on whether a 32-byte messageSecret is
 * required. 'both' places the same bytes on the outer message and inside the
 * wrapped inner message; 'none' omits it. The live spike settles which one the
 * server accepts for this account.
 */
export type GroupStatusSecretMode = 'both' | 'none';

/**
 * Plaintext stanza child WhatsApp uses to classify a message as a group
 * status. Without it the server acknowledges the stanza and members never see
 * the status.
 */
export const GROUP_STATUS_META: BinaryNode = {
  tag: 'meta',
  attrs: { is_group_status: 'true', origin: 'group_status' },
};

/** Proven by the live spike on 2026-11-26 in a non-Community test group. */
export const GROUP_STATUS_VIDEO_SUPPORTED = true;

type GroupStatusInnerKey = 'extendedTextMessage' | 'imageMessage' | 'videoMessage';

/** Mark the generated inner message as a group status. */
export function markGroupStatus(inner: proto.IMessage): proto.IMessage {
  for (const key of ['extendedTextMessage', 'imageMessage', 'videoMessage'] as GroupStatusInnerKey[]) {
    const content = inner[key] as { contextInfo?: proto.IContextInfo | null } | null | undefined;
    if (!content) continue;
    content.contextInfo = { ...(content.contextInfo ?? {}), isGroupStatus: true };
  }
  return inner;
}

export type GroupStatusWrapper = {
  /** Mark an inner message and return it for relayMessage. */
  mark(inner: proto.IMessage, mode?: GroupStatusSecretMode): proto.IMessage;
  /** Wrap a marked message into the groupStatusMessageV2 envelope. */
  patch(message: proto.IMessage): proto.IMessage;
};

/**
 * WeakMap-based wrapper used by SocketConfig.patchMessageBeforeSending. The
 * patch runs on every outgoing message, so unmarked messages must pass through
 * untouched. The built envelope is cached per inner message: a server-requested
 * retry re-sends the same inner object and must produce the same envelope.
 */
export function createGroupStatusWrapper(defaultMode: GroupStatusSecretMode = 'both'): GroupStatusWrapper {
  const marked = new WeakMap<proto.IMessage, GroupStatusSecretMode>();
  const wrapped = new WeakMap<proto.IMessage, proto.IMessage>();
  return {
    mark(inner, mode = defaultMode) {
      marked.set(inner, mode);
      return inner;
    },
    patch(message) {
      const mode = marked.get(message);
      if (!mode) return message;
      const existing = wrapped.get(message);
      if (existing) return existing;
      let envelope: proto.IMessage;
      if (mode === 'none') {
        envelope = { groupStatusMessageV2: { message } };
      } else {
        const secret = randomBytes(32);
        envelope = {
          messageContextInfo: { messageSecret: secret },
          groupStatusMessageV2: { message: { ...message, messageContextInfo: { messageSecret: secret } } },
        };
      }
      wrapped.set(message, envelope);
      return envelope;
    },
  };
}

/**
 * Generate the ordinary inner message and mark it as a group status. The
 * random messageContextInfo secret injected by generateWAMessageContent is
 * removed so the wrapper controls the secret mode; the live spike decides
 * whether 'both' or 'none' is accepted.
 */
export async function buildGroupStatusInner(
  content: GroupStatusContent,
  options: { upload: WASocket['waUploadToServer']; logger?: FastifyBaseLogger },
): Promise<proto.IMessage> {
  const inner = await generateWAMessageContent(content as AnyMessageContent, {
    upload: options.upload,
    logger: options.logger as never,
  });
  markGroupStatus(inner);
  // generateWAMessageContent returns a proto.Message whose prototype exposes
  // messageContextInfo = null, so `delete` falls back to that null. Assign
  // undefined instead: protobuf encoding omits it, and the wrapper's secret
  // mode becomes the only messageContextInfo.
  inner.messageContextInfo = undefined;
  return inner;
}
