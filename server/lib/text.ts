/** Strips control / bidi-override / zero-width characters and collapses whitespace. */
export function cleanText(input: string, max: number): string {
  return (
    input
      .normalize('NFKC')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
  );
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Case-insensitive blocked-word match that also catches simple evasion:
 * l33t substitutions ("5c4m") and separators between letters ("s.c.a.m",
 * "free v-bucks") — while still respecting word boundaries ("scampi" is fine).
 */
export function findBlockedWord(text: string, blocked: string[]): string | null {
  if (!blocked.length || !text) return null;
  const folded = text
    .toLowerCase()
    .replace(/[0@]/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/[5$]/g, 's')
    .replace(/7/g, 't');
  for (const raw of blocked) {
    const chars = [...raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')];
    if (!chars.length) continue;
    const body = chars.map(escapeRe).join('[^a-z0-9]*');
    if (new RegExp(`(^|[^a-z0-9])${body}([^a-z0-9]|$)`).test(folded)) return raw;
  }
  return null;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
