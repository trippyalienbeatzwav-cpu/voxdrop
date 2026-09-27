# VoxDrop

Voice messages, MP3 clips, sound effects, points and donations for **Kick** streams.
Viewers sign in with Kick, spend points (earned from subs / gifted subs / check-ins, or bought) to send
messages; streamers moderate them and play them live through an OBS Browser Source overlay.

> VoxDrop is an independent product and is not affiliated with Kick. Points have no cash value.

---

## Quick start (development — no credentials needed)

Requires **Node 22.13+** (tested on Node 24). No PostgreSQL server, Redis or Docker needed for development.

```bash
npm install
cp .env.example .env        # defaults run every integration in clearly-labelled mock mode
npm run db:seed             # demo users, channels, sounds, messages, subs, donations
npm run dev                 # API on :4000, web on :5173 (set PORT / WEB_PORT in .env to change)
```

Open http://localhost:5173 → **Continue with Kick** → the *mock* consent screen lists the demo accounts:

| Account      | Role                               | Try                                                   |
| ------------ | ---------------------------------- | ----------------------------------------------------- |
| `nova_plays` | Streamer (manual approval)         | Studio → Live queue, Moderation (keyboard shortcuts)  |
| `kaijubeats` | Streamer (auto approval)           | Queue fills automatically                             |
| `ghostlyn`   | Streamer                           | Custom sub reward (600)                               |
| `lunartide`  | Moderator of `nova_plays`          | Moderation without owner-only pages                   |
| `mochimilk`  | Viewer, 12k+ points                | Record a voice message, play sounds, donate           |
| `vx_admin`   | Admin                              | `/admin` — users, ledger, webhooks, failed jobs       |

**OBS overlays:** Studio → *OBS Overlays* has four Browser Source URLs (1920×1080), each with its own secret
token: voice/MP3 audio, subscriptions, gift subs and donations. Open one in a browser tab to watch it; auto-play
only runs while the audio overlay is connected. *Preview* on an alert overlay shows a local sample; *Test* sends a
flagged test alert through the real pipeline.

**Become a streamer:** signed-out visitors and viewers see *Become a Streamer* → `/become-streamer` →
`/streamer/login` → *Continue with Kick*. One Kick sign-in verifies the account, fetches the channel, and creates
the profile, settings, alert styles, priority tiers and overlay tokens, then opens `/streamer/dashboard`.

**Simulate Kick events:** Studio → Integrations → *Kick event simulator* (dev only). It sends RSA-signed
webhooks through the real `/api/webhooks/kick` endpoint; "Replay last" demonstrates idempotency.

## Scripts

| Command              | What it does                                                         |
| -------------------- | -------------------------------------------------------------------- |
| `npm run dev`        | API (tsx watch) + Vite dev server with proxy                          |
| `npm test`           | 185 unit + integration tests (Vitest, real PostgreSQL via PGlite)    |
| `npm run typecheck`  | TypeScript, server + tests + web                                      |
| `npm run build`      | Compiles the server to `dist/server` and the SPA to `dist/web`       |
| `npm start`          | Runs the compiled server (serves the SPA too)                         |
| `npm run db:migrate` | Applies SQL migrations + reference data (categories, point packages) |
| `npm run db:seed`    | Demo data (refuses to run in production)                             |

---

## What is real vs. mocked

Nothing below is "faked" in production code paths — mocks are separate classes, selected by env vars,
**refused at startup when `NODE_ENV=production`**, and announced by a banner in the UI.

| Area | Real implementation (production) | Dev mock | Verified by automated tests? |
| --- | --- | --- | --- |
| Kick login | `LiveKickAuthService` — OAuth 2.1 + PKCE S256 against `id.kick.com` | `MockKickService` consent screen; PKCE really verified | Flow + state/PKCE/CSRF logic: **yes** (mock provider). Against real Kick: **no — needs `KICK_CLIENT_ID/SECRET`** |
| Kick identity / channel | `LiveKickApiService` → `GET /public/v1/users`, `/public/v1/channels` | mock identities | Mock only |
| Kick webhooks | `KickWebhookService` — RSA-SHA256 over `id.timestamp.body` with Kick's public key (fetched, cached, documented fallback) | mock signs with its own RSA key; **same verifier** | Verification, replay window, idempotency, rewards: **yes**. Real Kick delivery: **no — needs a public HTTPS URL + Kick app** |
| Event subscription | `POST /public/v1/events/subscriptions` on channel connect | returns fake ids | Mock only |
| Payments | `StripePaymentService` — Checkout Sessions, signed webhooks, server-side re-fetch + amount check, refunds | `MockPaymentService` hosted-checkout screen, HMAC webhooks through the **same fulfilment code** | Fulfilment/idempotency/mismatch rejection: **yes** (mock). Stripe itself: **no — needs `PAYMENT_SECRET_KEY/WEBHOOK_SECRET`** |
| Storage | `S3StorageService` (AWS S3 / R2 / MinIO), private objects, streamed through the API | `MockStorageService` → `./data/uploads` | Mock/in-memory only. **S3 needs bucket credentials** |
| Malware scan | `ClamAvScanner` (clamd INSTREAM) when `CLAMAV_HOST` is set | — (recorded as `SKIPPED`) | **No — needs a clamd instance** |
| Text-to-speech (name announcements) | `EspeakTtsService` (eSpeak NG, Linux), `SapiTtsService` (Windows voices), `GoogleTtsService` (Cloud TTS) — all plain-text input, never SSML | `MockTtsService` (chime + tones, no words) | Sequencing/caching/failure logic: **yes** (mock). SAPI: **manually verified on this Windows machine** (real speech). espeak-ng: **no — binary not installed here**. Google: **no — needs `TTS_GOOGLE_API_KEY`** |
| Database | PostgreSQL via `pg` | PGlite (real Postgres compiled to WASM, in-process) | Tests run on PGlite. **Not yet run against a Postgres server in this repo** |

## Streamer accounts, priority queue, alerts

**One identity, optional streamer profile.** A Kick account is one VoxDrop user; becoming a streamer adds a
`streamers` row (the streamer profile) rather than a second account, so points and history carry over. The
dedicated flow is `GET /auth/kick/streamer` (OAuth intent `streamer_signup`, channel + event scopes). Failures
return to `/streamer/login?error=…`. Re-running it is idempotent.

**Automatic playback.** Approved messages enter `playback_queue` and play one at a time: name announcement →
viewer audio → marked played → next, driven by real `<audio>` events from the overlay. Studio → *Priority*:
automatic playback on/off and a 0 / 2 / 5 / 10 s delay. Messages that are pending moderation are never queued, so
auto-play cannot bypass moderation. The database enforces the message and queue state machines
(`enforce_message_transition`, `enforce_queue_transition` triggers).

**Points-based priority.** Tiers NORMAL / PRIORITY / HIGH / VIP (defaults 0 / 500 / 1,000 / 2,500 points; the
multiplier, name, colour, icon, per-tier cooldown and daily limit are all configurable). A tier's price is
`max(normal price, tier price)`. The premium is a separate `POINTS_SPENT_PRIORITY` ledger entry (tier recorded),
written in the same row-locked transaction as the message, so double-spending isn't possible. Refunds on
rejection have separate switches for the base price and the priority premium (`POINTS_REFUNDED`). Order
(`server/services/priority.ts`):

```
score = 10 × tier multiplier + pointsWeight × points ÷ 100 + waitingWeight × seconds waited ÷ 10
```

Items that have waited longer than the starvation cap (default 10 min) play next, oldest first. Streamer
drag-and-drop pins override the order until *Automatic order* is pressed. With priority off it's first come,
first served. A playing message is never interrupted unless *Allow VIP messages to interrupt* is on (default off);
the interrupted item is re-queued, not lost. Viewers see each tier's price, estimated position and wait before
paying, confirm *"Spend N points to prioritize this message?"*, and then get live *"N messages ahead of you ·
Estimated wait"* updates (`queue.position_changed`, pushed only when their position changes).

**Alerts.** Subscription, gift-sub and donation alerts each have a template (`{viewerName}`, `{giftCount}`,
`{amount}`, `{months}`), extra line, avatar, animation, position, duration, sound, volume, colour and optional TTS
(names sanitised like announcements). Pipeline: verified event → record → points reward → commit → alert. Alert
delivery runs after the commit and never throws, so an alert failure can't block points. `alert_events` is unique
per `(kind, source)`, so redelivered webhooks don't duplicate alerts. Donation alerts come only from the verified
payment webhook, never from a client request. Overlays acknowledge `shown` / `completed`. Alerts missed while an
overlay was offline are replayed for 2 minutes. Overlays reconnect on their own after network drops or API
restarts (server `ping` events + a client watchdog).

**Table mapping** (spec name → this codebase): streamer_profiles → `streamers`; subscription_events /
gift_subscription_events / donation_events → `subscriptions` / `gift_subscriptions` / `donations` (each unique
on its external event id); audio_messages → `messages`; alert_sounds → `sounds`; alert_templates →
`streamer_alert_settings.template`; playback_logs → `playback_queue` (per-phase timestamps, served by `GET …/playback-log`). New tables:
`priority_settings`, `priority_tiers`, `streamer_alert_settings`, `alert_events`, `overlay_tokens`.

## Viewer name announcements

Before a viewer's voice message / MP3 / donation (configurable, sound effects optional) plays on stream,
the overlay speaks a short intro such as **"Voice message from TrippyAlien"**, then plays the viewer's audio.

- **One queue item.** The announcement lives on the existing `playback_queue` row (the PlaybackItem):
  `phase` = `PENDING → ANNOUNCING → PLAYING_MESSAGE → COMPLETED | SKIPPED | FAILED`, plus announcement status,
  audio, text and timestamps. Only one item per channel can be PLAYING (DB unique index), so
  "A-announcement, B-announcement, A-audio" is impossible.
- **Order is enforced server-side.** The overlay reports real media events (`announcement_started`, `announcement_ended`,
  `announcement_error`, `message_started`, `ended`, `error`). The server rejects viewer-audio events with **409** while the
  announcement is still pending/ready, ignores duplicate or stale events, and completes the item only once.
- **Event-driven playback.** `web/src/lib/overlayPlayer.ts` waits for `audio.onended` of the announcement before loading the
  viewer's audio — no timers (text-only items, which have no audio, are shown for the alert duration).
  Stale callbacks are token-guarded; reports are serialised and retried (network drops).
- **Failures never block the stream.** TTS failure/timeout (8 s) or an announcement that fails to load → the viewer's audio
  plays without it, `announcement.failed` is emitted and logged. If the *viewer's* audio fails to load, the item is marked
  FAILED and the viewer is refunded.
- **Caching.** Audio is cached per streamer + viewer + spoken text + provider + voice + locale + speed + settings version and
  pre-generated for the next 5 queued items. Changing any voice/template setting bumps the version and clears the cache.
- **Safe names.** The Kick username (not the editable display name) is spoken after stripping markup/SSML/HTML/template
  characters, control/bidi/zero-width characters and emoji, splitting `snake_case`/`CamelCase`, limiting to 32 characters,
  and rejecting URLs, digit-only, repetitive or blocked-word names → fallback "a viewer" (anonymous donations: "an anonymous viewer").
- **Real-time events:** `announcement.started|completed|failed`, `message.audio.started|completed`.
- **UI:** Channel settings → *Voice announcements* (types, per-type templates, language/accent/voice, speed, volume,
  ▶ Preview with unsaved settings, Test on stream); Live queue → quick controls, per-item "Announcement enabled/ready/failed"
  badge + "Preview announcement"; History → *Playback log* (viewer, announcement, message, duration, status, errors).

## Architecture

```
web/            React 19 + Vite + Tailwind v4 SPA (TanStack Query, React Router)
  src/components  ui/ (Button, Modal/Confirm, Menu, Tabs, Field, Toast, Feedback…), audio/ (Recorder, Waveform, player), layout/
  src/pages       public/, viewer/, streamer/, admin/, Overlay.tsx, dev/
server/         Fastify 5 API (TypeScript, ESM)
  app.ts          plugins, session hook, CSRF, error mapping, static SPA
  config.ts       zod-validated env; production guard against mocks
  db/             client (pg | PGlite), SQL migrations, seed
  auth/           OAuth start/callback (state + PKCE + browser binding), sessions
  services/       points ledger, messages, queue, moderation, rewards, payments, sounds, audio, analytics, audit, notifications
  audio/          WAV parser/decoder/encoder, MP3 frame scanner, processing pipeline
  integrations/   kick/, payments/, storage/, scanner/ — interfaces + real + mock
  events/bus.ts   central event bus + transactional outbox
  routes/         HTTP layer only (validation → service → response)
tests/          unit/ + integration/ (Fastify inject against in-memory Postgres)
```

### Key design decisions

- **Ledger-based points.** `applyPoints` is the only code that changes a balance. It locks the account row
  (`SELECT … FOR UPDATE`), checks an optional idempotency key *after* the lock, and writes an append-only
  `points_transactions` row (`balance_after = balance_before + amount` is a CHECK constraint; UPDATE/DELETE
  are blocked by a trigger). Balance can never go negative (CHECK + guard). Money never touches this ledger.
- **Idempotent webhooks.** `webhook_events` has `UNIQUE(provider, event_id)`; redeliveries return
  `duplicate`. Failed events are kept and atomically re-claimed on redelivery or from the admin panel.
  Every points credit also carries a unique key derived from the event, so double payment is impossible even on reprocessing.
- **Rewards before sign-up.** Sub/gift events for Kick users who haven't joined yet are stored as `PENDING_LINK`
  and paid on first login with the same idempotency keys.
- **No overlapping playback.** A partial unique index allows one `PLAYING` row per streamer; all queue
  transitions take the streamer row lock. The overlay reports `ended` to advance; a sweeper recovers stuck items
  and expires unreviewed messages (with refunds).
- **Audio is never trusted.** Size → extension allowlist → MIME allowlist → magic bytes (all must agree) →
  full structural parse (every WAV chunk / MP3 frame) → duration limits (min 0.3s, channel max) → silence check →
  **re-encode** (WAV: decoded, peak-normalised, re-written as canonical PCM16; MP3: rebuilt from validated frames only,
  stripping ID3/APE tags and appended payloads) → optional ClamAV → private storage. Every attempt is logged in
  `audio_processing_jobs`. The browser recorder encodes WAV client-side so the server can fully decode it without ffmpeg.
- **Real-time** uses Server-Sent Events (all traffic is server→client; auto-reconnect; proxy/OBS friendly).
  Services publish through an **outbox** flushed only after the DB transaction commits.
- **Security:** opaque session tokens (SHA-256 stored), HttpOnly SameSite=Lax cookies (`Secure` in prod),
  per-session CSRF token header + Origin check, OAuth state single-use + browser-bound nonce, open-redirect guard,
  helmet CSP, rate limits (global + per-route), zod validation everywhere (strict schemas), parameterised SQL only,
  Kick tokens stored only for streamers and AES-256-GCM encrypted, IPs stored only as keyed hashes, immutable audit log,
  RBAC enforced server-side (`requireChannel(user, channel, 'moderate' | 'manage')`, `requireAdmin`).

### Roles

| Role | Scope | Can |
| --- | --- | --- |
| VIEWER | platform | send messages/sounds, donate, buy points, history |
| MODERATOR | per channel (`streamer_moderators`) | review, queue control, warn/mute/ban — no settings or revenue |
| STREAMER | own channel | everything for their channel (settings, sounds, rewards, refunds, analytics) |
| ADMIN | platform | suspend users/channels, adjust points (ledgered), delete content, reports, webhooks, jobs, logs |

## API overview

All JSON; errors are `{ error: { code, message, details? } }` with stable codes (`INSUFFICIENT_POINTS`,
`COOLDOWN_ACTIVE`, `AUDIO_TOO_LONG`, `FILE_TOO_LARGE`, `BANNED`, `FEATURE_DISABLED`, `CSRF_FAILED`, …).
State-changing requests need the `X-CSRF-Token` header (from `GET /api/me`).

| Area | Endpoints |
| --- | --- |
| Auth | `GET/POST /auth/kick`, `GET /auth/kick/streamer` (streamer sign-up), `GET /auth/kick/callback`, `POST /auth/logout`, `GET/PATCH /api/me`, `GET /api/me/sessions`, `POST /api/me/sessions/revoke-others`, `POST /api/me/connect-channel`, `POST /api/me/kick/revoke-tokens`, `POST /api/me/daily-bonus` |
| Discovery | `GET /api/streamers`, `GET /api/streamers/:slug`, `GET /api/streamers/:slug/sounds`, `GET /api/streamers/:slug/quote` (`priorityTier`), `GET /api/streamers/:slug/priority` (tier prices + estimated position/wait), `GET /api/streamers/:slug/events` (SSE) |
| Messages | `POST /api/messages` (Idempotency-Key, `priorityTier`), `GET /api/messages`, `GET /api/messages/:id`, `GET /api/messages/:id/position`, `POST /api/messages/:id/{cancel,approve,reject,queue,flag,play-now}`, `DELETE /api/messages/:id` |
| Audio | `POST /api/audio/upload` (multipart), `GET /api/audio/:id/stream` (authorised, Range) |
| Sounds | `GET /api/sounds`, `GET /api/sounds/recent`, `POST /api/sounds`, `PATCH/DELETE /api/sounds/:id`, `POST /api/sounds/:id/trigger` |
| Points | `GET /api/points`, `GET /api/points/transactions`, `GET /api/points/packages`, `POST /api/points/purchase` |
| Donations | `POST /api/donations`, `GET /api/donations`, `GET /api/donations/:id` |
| Channel (staff) | `/api/channels/:sid/{dashboard,analytics,settings,profile,overlay,queue,messages,users,bans,moderators,history,moderation-actions,subscriptions,points,donations,integrations}` + `priority` (GET/PATCH), `overlays` (+ `/:kind/rotate`), `alerts` (+ `PATCH /:kind`, `POST /:kind/test`), `alert-events`, `queue/reset-order`, queue actions, user actions, refunds; shortcuts `GET /api/streamer/dashboard`, `/api/streamer/analytics` |
| Real-time | `GET /api/realtime` (SSE, user + staffed channels) |
| Overlay | `GET /api/overlay/:streamerId/:kind`, `GET …/events` (SSE), `POST …/playback` (audio), `POST …/ack` (alerts) — `kind` ∈ `audio, subscription, gift-sub, donation`, each `?token=` of that overlay only. Old `/overlay/:slug?key=` links redirect to the audio overlay |
| Webhooks | `POST /api/webhooks/kick`, `POST /api/webhooks/payments` |
| Admin | `/api/admin/{overview,users,streamers,messages,audio,payments,donations,points,reports,bans,webhooks,jobs,audit-logs}` + actions |
| Other | `POST /api/reports`, `GET/POST /api/notifications…`, `GET /api/health`, `GET /api/config` |

## Going to production

1. **PostgreSQL:** set `DATABASE_URL=postgres://…`, run `npm run db:migrate`.
2. **Kick app** (https://kick.com → developer settings): set `KICK_MODE=live`, `KICK_CLIENT_ID`, `KICK_CLIENT_SECRET`,
   `KICK_REDIRECT_URI=https://your-domain/auth/kick/callback`, and register `https://your-domain/api/webhooks/kick`
   as the webhook URL. Streamers connect via Profile → *Connect Kick channel* (scopes `user:read channel:read events:subscribe`).
3. **Stripe:** `PAYMENT_PROVIDER=stripe`, `PAYMENT_SECRET_KEY`, `PAYMENT_WEBHOOK_SECRET`; point a Stripe webhook at
   `/api/webhooks/payments` for `checkout.session.completed|expired|async_payment_*` and `refund.created|updated`.
4. **Storage:** `STORAGE_PROVIDER=s3` + bucket/credentials (+ `STORAGE_ENDPOINT` for R2/MinIO).
5. **ClamAV (recommended):** `CLAMAV_HOST/PORT`.
6. `SESSION_SECRET` ≥ 32 random chars, `APP_URL=https://…`, `NODE_ENV=production`, then `npm run build && npm start`
   behind TLS. The server refuses to start in production if any mock is configured.

## Known limitations

- Real-time fan-out and rate-limit counters are **in-process** → run a single API instance, or swap the `EventBus`
  for Redis / Postgres LISTEN/NOTIFY and use a Redis rate-limit store before scaling horizontally.
- MP3 uploads are validated, tag-stripped and measured, but **not loudness-normalised** (needs an ffmpeg worker);
  WAV/voice recordings are normalised.
- Analytics hour buckets are UTC.
- The Kick API/webhook payload shapes follow docs.kick.com as of 2026-09; they were not exercised against live Kick here.
- No e-mail; notifications are in-app + real-time.
- Queue position estimates assume each item plays for its known duration plus the auto-play delay; they are
  estimates and change as higher-priority messages arrive.
