import type { Db } from './client.js';
import { one } from './client.js';
import type { AppContext } from '../context.js';
import { encodeWav16 } from '../audio/wav.js';
import { applyPoints } from '../services/points.js';
import { upsertStreamerFromKick, updateSettings } from '../services/streamers.js';
import { uploadAudio } from '../services/audio.js';
import { createSound } from '../services/sounds.js';
import { approveMessage, createMessage, rejectMessage } from '../services/messages.js';
import { handleKickEvent } from '../services/rewards.js';
import { createDonation, handlePaymentEvent } from '../services/payments.js';
import type { SessionUser } from '../services/types.js';

const CATEGORIES = [
  ['memes', 'Memes'],
  ['reactions', 'Reactions'],
  ['gaming', 'Gaming'],
  ['funny', 'Funny'],
  ['alerts', 'Alerts'],
  ['custom', 'Custom'],
  ['community', 'Community'],
] as const;

const PACKAGES = [
  ['Starter', 500, null, 199],
  ['Crew', 1500, '+10% bonus', 499],
  ['Squad', 3500, '+25% bonus', 999],
  ['Legend', 8000, '+40% bonus', 1999],
] as const;

/** Reference data required in every environment (idempotent). */
export async function seedBaseline(db: Db) {
  for (let i = 0; i < CATEGORIES.length; i++) {
    const [slug, name] = CATEGORIES[i]!;
    await db.query('INSERT INTO sound_categories (slug, name, sort_order) VALUES ($1,$2,$3) ON CONFLICT (slug) DO NOTHING', [slug, name, i]);
  }
  const hasPackages = await one(db, 'SELECT 1 FROM points_packages LIMIT 1');
  if (!hasPackages) {
    for (let i = 0; i < PACKAGES.length; i++) {
      const [name, points, bonus, cents] = PACKAGES[i]!;
      await db.query('INSERT INTO points_packages (name, points, bonus_label, price_cents, sort_order) VALUES ($1,$2,$3,$4,$5)', [name, points, bonus, cents, i]);
    }
  }
}

// ── Procedural demo audio (synthesised — no third-party samples) ────────────
const SR = 22050;
function synth(seconds: number, fn: (t: number, i: number) => number): Buffer {
  const n = Math.floor(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.max(-1, Math.min(1, fn(i / SR, i)));
  return encodeWav16([out], SR);
}
const env = (t: number, a: number, d: number, len: number) => Math.min(1, t / a) * Math.min(1, Math.max(0, (len - t) / d));
const saw = (f: number, t: number) => 2 * ((t * f) % 1) - 1;
const sq = (f: number, t: number) => (Math.sin(2 * Math.PI * f * t) >= 0 ? 1 : -1);
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

export const DEMO_SOUNDS: Record<string, () => Buffer> = {
  airhorn: () => synth(1.3, (t) => 0.3 * env(t, 0.02, 0.15, 1.3) * (saw(440, t) + saw(554, t) + saw(659, t) + 0.5 * saw(880, t))),
  applause: () => synth(2.2, (t) => 0.5 * env(t, 0.2, 0.8, 2.2) * rnd() * (0.6 + 0.4 * Math.abs(Math.sin(t * 37)))),
  bruh: () => synth(0.8, (t) => {
    const f = 170 - 60 * t;
    return 0.6 * env(t, 0.03, 0.25, 0.8) * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(2 * Math.PI * f * 2 * t) + 0.3 * Math.sin(2 * Math.PI * 700 * t) * Math.sin(2 * Math.PI * f * t));
  }),
  levelup: () => synth(0.9, (t) => {
    const notes = [523, 659, 784, 1047];
    const idx = Math.min(3, Math.floor(t / 0.18));
    return 0.25 * env(t, 0.01, 0.2, 0.9) * sq(notes[idx]!, t);
  }),
  sadtrombone: () => synth(2.4, (t) => {
    const notes = [392, 370, 349, 330];
    const idx = Math.min(3, Math.floor(t / 0.5));
    const vib = idx === 3 ? 6 * Math.sin(2 * Math.PI * 6 * t) : 0;
    return 0.3 * env(t, 0.03, 0.4, 2.4) * saw(notes[idx]! + vib, t);
  }),
  boing: () => synth(0.9, (t) => 0.6 * env(t, 0.005, 0.3, 0.9) * Math.sin(2 * Math.PI * (120 + 500 * Math.exp(-t * 6) * Math.abs(Math.sin(t * 30))) * t)),
  drumroll: () => synth(2.0, (t) => {
    const hit = (t * 24) % 1;
    const cym = t > 1.6 ? 0.7 * rnd() * Math.exp(-(t - 1.6) * 4) : 0;
    return 0.5 * (rnd() * Math.exp(-hit * 18) * 0.7 + cym);
  }),
  chime: () => synth(1.4, (t) => 0.35 * Math.exp(-t * 2.5) * (Math.sin(2 * Math.PI * 880 * t) + 0.6 * Math.sin(2 * Math.PI * 1320 * t) + 0.3 * Math.sin(2 * Math.PI * 1760 * t))),
  voice_a: () => synth(4.5, (t) => {
    const syll = Math.abs(Math.sin(t * Math.PI * 2.6));
    const f0 = 140 + 25 * Math.sin(t * 3);
    return 0.5 * syll * env(t, 0.05, 0.3, 4.5) * (Math.sin(2 * Math.PI * f0 * t) + 0.4 * Math.sin(2 * Math.PI * f0 * 3 * t) + 0.2 * Math.sin(2 * Math.PI * 900 * t) * Math.sin(2 * Math.PI * f0 * t));
  }),
  voice_b: () => synth(7.2, (t) => {
    const syll = Math.abs(Math.sin(t * Math.PI * 3.1)) * (Math.sin(t * 0.9) > -0.6 ? 1 : 0.1);
    const f0 = 210 + 30 * Math.sin(t * 2.1);
    return 0.45 * syll * env(t, 0.05, 0.4, 7.2) * (Math.sin(2 * Math.PI * f0 * t) + 0.35 * Math.sin(2 * Math.PI * f0 * 2 * t) + 0.15 * Math.sin(2 * Math.PI * 1100 * t));
  }),
};

interface DemoUser {
  username: string;
  kickId: string;
  role: 'VIEWER' | 'STREAMER' | 'ADMIN';
  points: number;
  bio?: string;
}

const USERS: DemoUser[] = [
  { username: 'vx_admin', kickId: '100000001', role: 'ADMIN', points: 0 },
  { username: 'nova_plays', kickId: '100000010', role: 'STREAMER', points: 0, bio: 'Variety + late-night co-op. Send a voice note and I will read it on stream.' },
  { username: 'kaijubeats', kickId: '100000011', role: 'STREAMER', points: 0, bio: 'Beat-making streams every weeknight. Drop a sample, I flip it live.' },
  { username: 'ghostlyn', kickId: '100000012', role: 'STREAMER', points: 0, bio: 'Horror games, jump scares, and a very active soundboard.' },
  { username: 'pixelpete', kickId: '100000020', role: 'VIEWER', points: 4200 },
  { username: 'lunartide', kickId: '100000021', role: 'VIEWER', points: 1800 },
  { username: 'drift_king', kickId: '100000022', role: 'VIEWER', points: 650 },
  { username: 'mochimilk', kickId: '100000023', role: 'VIEWER', points: 9000 },
  { username: 'zeroping', kickId: '100000024', role: 'VIEWER', points: 120 },
];

/**
 * Demo data for development. Everything goes through the real services
 * (upload pipeline, message rules, ledger, webhook handlers) so the demo state
 * is internally consistent — no hand-written balances.
 */
export async function seedDemo(ctx: AppContext) {
  const db = ctx.db;
  const existing = await one(db, `SELECT 1 FROM users WHERE username = 'vx_admin'`);
  if (existing) return { skipped: true };

  const users: Record<string, SessionUser> = {};
  for (const u of USERS) {
    const row = await one<SessionUser>(
      db,
      `INSERT INTO users (username, display_name, role, bio, avatar_url) VALUES ($1,$1,$2,$3,NULL)
       RETURNING id, username, display_name, avatar_url, role, status, reduced_motion`,
      [u.username, u.role === 'STREAMER' ? 'VIEWER' : u.role, u.bio ?? ''],
    );
    await db.query('INSERT INTO kick_accounts (user_id, kick_user_id, kick_username) VALUES ($1,$2,$3)', [row!.id, u.kickId, u.username]);
    await db.query('INSERT INTO points_accounts (user_id) VALUES ($1)', [row!.id]);
    if (u.points > 0) {
      await applyPoints(db, { userId: row!.id, type: 'POINTS_ADJUSTED', amount: u.points, description: 'Demo seed balance', referenceType: 'seed', idempotencyKey: `seed:${u.username}` });
    }
    users[u.username] = row!;
  }

  const channels: Record<string, string> = {};
  for (const u of USERS.filter((x) => x.role === 'STREAMER')) {
    const s = await upsertStreamerFromKick(db, users[u.username]!, { broadcasterUserId: u.kickId, slug: u.username, description: u.bio ?? '', bannerPicture: null, isLive: u.username !== 'kaijubeats', streamTitle: null }, null);
    channels[u.username] = s.id;
    users[u.username]!.role = 'STREAMER';
  }
  await db.query(`UPDATE streamers SET brand_color = '#FF3D8B', live_title = 'Voice notes on screen — send one!' WHERE slug = 'nova_plays'`);
  await db.query(`UPDATE streamers SET brand_color = '#3DD9FF' WHERE slug = 'kaijubeats'`);
  await db.query(`UPDATE streamers SET brand_color = '#B18CFF', live_title = 'Scary games at 3am' WHERE slug = 'ghostlyn'`);
  await db.query(`INSERT INTO streamer_moderators (streamer_id, user_id) VALUES ($1,$2)`, [channels.nova_plays, users.lunartide!.id]);
  await db.query(`UPDATE users SET role = 'MODERATOR' WHERE id = $1`, [users.lunartide!.id]);
  users.lunartide!.role = 'MODERATOR';

  await updateSettings(db, users.nova_plays!, channels.nova_plays!, { cooldown_seconds: 0, free_text_per_day: 1, blocked_words: ['scam', 'free vbucks'] }, null);
  await updateSettings(db, users.kaijubeats!, channels.kaijubeats!, { cooldown_seconds: 0, approval_mode: 'AUTO', price_mp3: 300 }, null);
  await updateSettings(db, users.ghostlyn!, channels.ghostlyn!, { cooldown_seconds: 0, voice_enabled: true, mp3_enabled: false, sub_reward_points: 600 }, null);

  // Sound libraries (uploaded through the real validation pipeline)
  const soundSpecs: Array<[string, string, string, string, string, number, string]> = [
    ['nova_plays', 'airhorn', 'Air Horn', 'memes', 'megaphone', 100, '#C6FF3D'],
    ['nova_plays', 'bruh', 'Bruh', 'reactions', 'skull', 50, '#FFB23D'],
    ['nova_plays', 'applause', 'Applause', 'reactions', 'hand-metal', 150, '#3DD9FF'],
    ['nova_plays', 'levelup', 'Level Up', 'gaming', 'trophy', 120, '#B18CFF'],
    ['nova_plays', 'sadtrombone', 'Sad Trombone', 'funny', 'laugh', 90, '#FF3D8B'],
    ['nova_plays', 'boing', 'Boing', 'funny', 'party-popper', 60, '#FFD93D'],
    ['kaijubeats', 'drumroll', 'Drum Roll', 'alerts', 'drum', 120, '#3DD9FF'],
    ['kaijubeats', 'chime', 'Chime', 'alerts', 'bell', 40, '#C6FF3D'],
    ['kaijubeats', 'airhorn', 'Horn Stab', 'memes', 'megaphone', 80, '#FF3D8B'],
    ['ghostlyn', 'boing', 'Jump Scare', 'gaming', 'ghost', 200, '#B18CFF'],
    ['ghostlyn', 'sadtrombone', 'You Died', 'gaming', 'skull', 150, '#FF3D8B'],
    ['ghostlyn', 'chime', 'Spirit Bell', 'community', 'sparkles', 75, '#3DD9FF'],
  ];
  const soundIds: Record<string, string> = {};
  for (const [owner, gen, name, cat, icon, price, color] of soundSpecs) {
    const audio = await uploadAudio(ctx, users[owner]!, { buffer: DEMO_SOUNDS[gen]!(), filename: `${gen}.wav`, mimeType: 'audio/wav', streamerId: channels[owner]!, purpose: 'SOUND' });
    const s = await createSound(ctx, users[owner]!, {
      streamerId: channels[owner]!,
      audioFileId: audio.id,
      name,
      description: `${name} — synthesized demo sound`,
      categorySlug: cat,
      icon: icon as 'megaphone',
      color,
      pricePoints: price,
      cooldownSeconds: 20,
      dailyLimit: 0,
      isActive: true,
    });
    soundIds[`${owner}:${name}`] = s.id;
  }

  // Messages across states on nova_plays (MANUAL approval)
  const nova = channels.nova_plays!;
  const send = (u: string, input: Parameters<typeof createMessage>[2]) => createMessage(ctx, users[u]!, input, null);
  const voice = async (u: string, gen: string, streamerId: string) =>
    uploadAudio(ctx, users[u]!, { buffer: DEMO_SOUNDS[gen]!(), filename: 'voice-message.wav', mimeType: 'audio/wav', streamerId, purpose: 'MESSAGE' });

  const m1 = await send('pixelpete', { streamerId: nova, type: 'TEXT', text: 'First time catching the stream live — that clutch was unreal!', priority: false, bonusPoints: 0 });
  const v1 = await voice('mochimilk', 'voice_a', nova);
  await send('mochimilk', { streamerId: nova, type: 'VOICE', text: 'Quick shoutout for the squad', audioFileId: v1.id, priority: true, bonusPoints: 50 });
  const v2 = await voice('drift_king', 'voice_b', nova);
  await send('drift_king', { streamerId: nova, type: 'VOICE', text: '', audioFileId: v2.id, priority: false, bonusPoints: 0 });
  await send('zeroping', { streamerId: nova, type: 'TEXT', text: 'gg', priority: false, bonusPoints: 0 });
  const m5 = await send('pixelpete', { streamerId: nova, type: 'TEXT', text: 'Can you try the hard mode run next?', priority: false, bonusPoints: 0 });
  await approveMessage(ctx, users.nova_plays!, m1.message!.id, null);
  await rejectMessage(ctx, users.lunartide!, m5.message!.id, 'Off-topic right now', null);
  await send('mochimilk', { streamerId: nova, type: 'SOUND', soundId: soundIds['nova_plays:Air Horn']!, text: '', priority: false, bonusPoints: 0 });
  await send('pixelpete', { streamerId: nova, type: 'SOUND', soundId: soundIds['nova_plays:Applause']!, text: '', priority: false, bonusPoints: 0 });

  // kaijubeats (AUTO approval) — an MP3-type clip and a sound
  const k = channels.kaijubeats!;
  const clip = await uploadAudio(ctx, users.mochimilk!, { buffer: DEMO_SOUNDS.levelup!(), filename: 'sample.wav', mimeType: 'audio/wav', streamerId: k, purpose: 'MESSAGE' });
  await send('mochimilk', { streamerId: k, type: 'MP3', text: 'Flip this sample!', audioFileId: clip.id, priority: false, bonusPoints: 0 });
  await send('lunartide', { streamerId: k, type: 'TEXT', text: 'That 808 slide was nasty', priority: false, bonusPoints: 0 });

  // Kick events through the real webhook handler (idempotent keys, caps, pending links)
  const bc = (slug: string, id: string) => ({ is_anonymous: false, user_id: Number(id), username: slug, channel_slug: slug });
  const viewer = (u: string) => ({ is_anonymous: false, user_id: Number(USERS.find((x) => x.username === u)!.kickId), username: u, channel_slug: u });
  const evt = (id: string, type: string, payload: Record<string, unknown>) =>
    handleKickEvent(ctx, { messageId: id, subscriptionId: null, type, version: '1', timestamp: new Date().toISOString(), payload });
  await evt('seed-sub-1', 'channel.subscription.new', { broadcaster: bc('nova_plays', '100000010'), subscriber: viewer('drift_king'), duration: 1 });
  await evt('seed-sub-2', 'channel.subscription.renewal', { broadcaster: bc('nova_plays', '100000010'), subscriber: viewer('pixelpete'), duration: 4 });
  await evt('seed-gift-1', 'channel.subscription.gifts', {
    broadcaster: bc('nova_plays', '100000010'),
    gifter: viewer('mochimilk'),
    giftees: [viewer('zeroping'), { is_anonymous: false, user_id: 555000001, username: 'not_joined_yet' }, { is_anonymous: false, user_id: 555000002, username: 'lurker_22' }, { is_anonymous: false, user_id: 555000003, username: 'kickfan' }, { is_anonymous: false, user_id: 555000004, username: 'n00b' }],
  });
  await evt('seed-sub-3', 'channel.subscription.new', { broadcaster: bc('ghostlyn', '100000012'), subscriber: { is_anonymous: false, user_id: 555000009, username: 'future_member' }, duration: 1 });

  // Donations through the mock provider + the real payment webhook handler
  if (ctx.mockPayments) {
    for (const [u, cents, msg] of [
      ['pixelpete', 500, 'Keep the late streams coming!'],
      ['mochimilk', 2000, 'For the new mic 🎙️'],
      ['lunartide', 300, ''],
    ] as const) {
      const d = await createDonation(ctx, users[u]!, { streamerId: nova, amountCents: cents, message: msg, anonymous: false });
      const sessionId = d.checkoutUrl.split('/').pop()!;
      ctx.mockPayments.simulate(sessionId, 'paid');
      await handlePaymentEvent(ctx, { id: `seed-pay-${u}`, kind: 'checkout.completed', sessionId });
    }
  }
  return { skipped: false, users: Object.keys(users).length };
}
