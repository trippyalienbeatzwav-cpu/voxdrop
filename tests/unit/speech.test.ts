import { describe, expect, it } from 'vitest';
import { MAX_SPOKEN_NAME, renderAnnouncement, sanitizeSpokenName, sanitizeTemplate } from '../../server/lib/speech.js';

const say = (raw: string, t = 'Voice message from {viewerName}', blocked: string[] = []) => renderAnnouncement(t, sanitizeSpokenName(raw, blocked));

describe('spoken name sanitisation', () => {
  it('makes usernames pronounceable', () => {
    expect(say('TrippyAlien')).toBe('Voice message from Trippy Alien');
    expect(say('trippy_alien')).toBe('Voice message from trippy alien');
    expect(say('xX_Sniper__Xx')).toBe('Voice message from x X Sniper Xx');
  });

  it('neutralises SSML / TTS markup injection', () => {
    const out = say('<speak><break time="30s"/>pwned</speak>');
    expect(out).not.toMatch(/[<>"/=]/);
    expect(out).toContain('pwned');
    expect(say('<prosody rate="x-slow">')).not.toMatch(/[<>"=]/);
  });

  it('neutralises HTML / script injection', () => {
    const out = say('<img src=x onerror=alert(1)><script>alert(1)</script>');
    expect(out).not.toMatch(/[<>()=]/);
  });

  it('strips template braces so names cannot inject another placeholder', () => {
    expect(say('{viewerName}{viewerName}')).toBe('Voice message from viewer Name viewer Name');
  });

  it('removes bidi overrides, zero-width and control characters', () => {
    expect(say('Evil\u202EemaN\u200B\u0007Guy')).toBe('Voice message from Evilema NGuy');
  });

  it('limits length', () => {
    const r = sanitizeSpokenName('Supercalifragilistic Expialidocious TheThird OfHisName');
    expect(r.name!.length).toBeLessThanOrEqual(MAX_SPOKEN_NAME);
  });

  it('falls back for names that cannot be spoken safely', () => {
    expect(say('')).toBe('Voice message from a viewer');
    expect(say('💀💀💀🔥')).toBe('Voice message from a viewer');
    expect(say('12345678')).toBe('Voice message from a viewer');
    expect(say('x')).toBe('Voice message from a viewer');
    expect(say('visit www.scam-site.com')).toBe('Voice message from a viewer');
    expect(say('https://evil.example')).toBe('Voice message from a viewer');
    expect(say('aaaaaaaaaaaaaaaa')).toBe('Voice message from a viewer');
    expect(say('BadWordGuy', undefined, ['badword'])).toBe('Voice message from a viewer');
  });

  it('keeps non-Latin scripts', () => {
    expect(say('Ренат')).toBe('Voice message from Ренат');
    expect(say('さくら')).toBe('Voice message from さくら');
  });
});

describe('templates', () => {
  it('sanitises streamer templates but keeps the token', () => {
    expect(sanitizeTemplate('<b>Next</b> message from {viewerName}!')).toBe('b Next b message from {viewerName}!');
    expect(renderAnnouncement('{viewerName} sent a voice message', sanitizeSpokenName('Nova'))).toBe('Nova sent a voice message');
  });
  it('speaks templates without a token as-is', () => {
    expect(renderAnnouncement('Incoming message', sanitizeSpokenName('Nova'))).toBe('Incoming message');
  });
});
