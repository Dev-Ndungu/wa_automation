/**
 * WhatsApp invite codes are opaque.  Keep the parser deliberately strict so
 * ordinary URLs (and lookalike hosts) never become scanner records.
 */
const INVITE_HOST = 'chat.whatsapp.com';
const TRAILING_URL_PUNCTUATION = /[\]\[(){}<>.,;:!?"'`]+$/u;
const URL_CANDIDATE = /https?:\/\/[^\s<>"']+/giu;
const INVITE_CODE = /^[A-Za-z0-9_-]{5,128}$/;

export type InviteLink = {
  inviteUrl: string;
  inviteCode: string;
};

function normaliseCandidate(candidate: string): InviteLink | null {
  const trimmed = candidate.replace(TRAILING_URL_PUNCTUATION, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.hostname.toLowerCase() !== INVITE_HOST || parsed.username || parsed.password || parsed.port) return null;
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length !== 1) return null;

  let inviteCode: string;
  try {
    inviteCode = decodeURIComponent(segments[0]);
  } catch {
    return null;
  }
  if (!INVITE_CODE.test(inviteCode)) return null;

  return { inviteUrl: `https://${INVITE_HOST}/${inviteCode}`, inviteCode };
}

/** Extract, validate and normalise every WhatsApp group invite in a text payload. */
export function extractInviteLinks(text: string | null | undefined): InviteLink[] {
  if (!text) return [];
  const found: InviteLink[] = [];
  for (const match of text.matchAll(URL_CANDIDATE)) {
    const link = normaliseCandidate(match[0]);
    if (link) found.push(link);
  }
  return found;
}

/** A message can contain the same URL more than once; record one sighting per invite per message. */
export function deduplicateInviteLinks(links: Iterable<InviteLink>): InviteLink[] {
  const unique = new Map<string, InviteLink>();
  for (const link of links) unique.set(link.inviteUrl, link);
  return [...unique.values()];
}
