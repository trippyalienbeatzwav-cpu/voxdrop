/**
 * Turning untrusted text (Kick usernames, streamer templates) into something
 * safe to hand to a TTS engine.
 *
 * Defence in depth:
 *  1. Every provider is fed PLAIN TEXT only — never SSML/markup APIs.
 *  2. On top of that we strip every character that has meaning in SSML, HTML,
 *     shells or template syntax (< > & " ' ` { } [ ] \ / | ; $ = * # ^ ~ @ %),
 *     control/bidi/zero-width characters and emoji, so injected markup cannot
 *     survive even if a provider were misconfigured.
 *  3. Names are length-limited, must contain real letters, and cannot be URLs;
 *     otherwise a neutral fallback ("a viewer") is spoken instead.
 */

export const MAX_SPOKEN_NAME = 32;
export const MAX_TEMPLATE = 120;
export const MAX_SPOKEN_TEXT = 160;
export const NAME_TOKEN = '{viewerName}';

const INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;

/** Letters (any script), marks, digits, spaces and a few pronounceable punctuation marks. */
function keepSpeakable(s: string, extra = ''): string {
  const re = new RegExp(`[^\\p{L}\\p{M}\\p{Nd}\\s.,!?'\\-${extra}]`, 'gu');
  return s.replace(re, ' ');
}

export interface SpokenName {
  /** Safe to speak, or null when the fallback must be used. */
  name: string | null;
  reason?: 'empty' | 'too_short' | 'url' | 'no_letters' | 'blocked' | 'repetitive';
}

export function sanitizeSpokenName(raw: string | null | undefined, blockedWords: string[] = []): SpokenName {
  if (!raw) return { name: null, reason: 'empty' };
  let s = raw.normalize('NFKC').replace(INVISIBLE, '');
  if (/(https?:|www\.|\.(com|net|org|gg|tv|io|xyz|ru)\b)/i.test(s)) return { name: null, reason: 'url' };
  s = s
    .replace(/[_]+/g, ' ') // trippy_alien → "trippy alien"
    .replace(/([a-z])([A-Z])/g, '$1 $2'); // TrippyAlien → "Trippy Alien"
  s = keepSpeakable(s, '')
    .replace(/[.,!?'-]{2,}/g, ' ') // "!!!!" / "----" noise
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return { name: null, reason: 'empty' };
  const letters = (s.match(/\p{L}/gu) ?? []).length;
  if (letters === 0) return { name: null, reason: 'no_letters' };
  if (letters < 2) return { name: null, reason: 'too_short' };
  if (/(.)\1{5,}/u.test(s.replace(/\s/g, ''))) return { name: null, reason: 'repetitive' };
  if (s.length > MAX_SPOKEN_NAME) {
    const cut = s.slice(0, MAX_SPOKEN_NAME);
    const space = cut.lastIndexOf(' ');
    s = (space > 8 ? cut.slice(0, space) : cut).trim();
  }
  // Compare with spaces/punctuation removed so "BadWord_Guy" can't dodge a blocked "badword".
  const squashed = raw.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{Nd}]/gu, '');
  for (const w of blockedWords) {
    const word = w.toLowerCase().replace(/[^\p{L}\p{Nd}]/gu, '');
    if (word && squashed.includes(word)) return { name: null, reason: 'blocked' };
  }
  return { name: s };
}

/** Streamer template: same character policy, must stay short; the {viewerName} token is preserved. */
export function sanitizeTemplate(raw: string): string {
  const parts = raw.normalize('NFKC').replace(INVISIBLE, '').split(NAME_TOKEN);
  const clean = parts.map((p) => keepSpeakable(p).replace(/\s+/g, ' '));
  return clean.join(NAME_TOKEN).replace(/\s+/g, ' ').trim().slice(0, MAX_TEMPLATE);
}

/**
 * Final spoken sentence. Uses the neutral fallback when the name can't be
 * spoken safely; if the template has no token it is spoken as-is.
 */
export function renderAnnouncement(template: string, name: SpokenName, fallback = 'a viewer'): string {
  const t = sanitizeTemplate(template) || `Message from ${NAME_TOKEN}`;
  const text = t.includes(NAME_TOKEN) ? t.split(NAME_TOKEN).join(name.name ?? fallback) : t;
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_SPOKEN_TEXT);
}
