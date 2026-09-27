import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AlertIntent } from '../services/alertTypes.js';

/** Every real-time event name the platform emits. */
export type EventType =
  | 'message.created'
  | 'message.approved'
  | 'message.rejected'
  | 'message.queued'
  | 'message.playing'
  | 'message.played'
  | 'message.updated'
  | 'queue.updated'
  | 'points.updated'
  | 'donation.created'
  | 'donation.completed'
  | 'donation.refunded'
  | 'subscription.received'
  | 'gift_sub.received'
  | 'sound.played'
  | 'user.banned'
  | 'user.warned'
  | 'notification.created'
  | 'streamer.updated'
  | 'overlay.play'
  | 'overlay.stop'
  | 'overlay.alert'
  | 'overlay.settings'
  | 'overlay.announcement_test'
  | 'announcement.started'
  | 'announcement.completed'
  | 'announcement.failed'
  | 'message.audio.started'
  | 'message.audio.completed'
  | 'message.completed'
  | 'message.skipped'
  | 'queue.added'
  | 'queue.position_changed'
  | 'alert.show'
  | 'alert.test';

export interface BusEvent<T = unknown> {
  id: string;
  type: EventType;
  data: T;
  ts: string;
}

/** Topic naming: who should receive an event. */
export const Topic = {
  user: (userId: string) => `user:${userId}`,
  /** Staff of a channel (owner + moderators) — dashboards and moderation views. */
  channel: (streamerId: string) => `channel:${streamerId}`,
  /** The OBS overlay for a channel — authenticated by overlay key, not session. */
  overlay: (streamerId: string) => `overlay:${streamerId}`,
  /** One alert overlay (subscription | gift_sub | donation) — its own OBS Browser Source. */
  alerts: (streamerId: string, kind: string) => `alerts:${streamerId}:${kind}`,
  /** Public channel info (live status, queue length) for profile pages. */
  publicChannel: (streamerId: string) => `public:${streamerId}`,
} as const;

/**
 * Centralised in-process event bus. Services publish domain events here after
 * their DB transaction commits; the SSE gateway fans them out to subscribers.
 *
 * Single-instance only. For horizontal scaling, replace the emitter with a
 * Redis / Postgres LISTEN-NOTIFY adapter behind the same publish/subscribe API.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish<T>(topic: string | string[], type: EventType, data: T): BusEvent<T> {
    const evt: BusEvent<T> = { id: randomUUID(), type, data, ts: new Date().toISOString() };
    for (const t of Array.isArray(topic) ? topic : [topic]) this.emitter.emit(t, evt);
    this.emitter.emit('*', { topic, ...evt });
    return evt;
  }

  subscribe(topic: string, fn: (evt: BusEvent) => void): () => void {
    this.emitter.on(topic, fn);
    return () => this.emitter.off(topic, fn);
  }

  listenerCount(topic: string) {
    return this.emitter.listenerCount(topic);
  }
}

/**
 * Collects events during a DB transaction and only publishes them once the
 * transaction has committed — clients never see state that was rolled back.
 */
export class Outbox {
  private readonly items: Array<{ topic: string | string[]; type: EventType; data: unknown }> = [];
  /** Alerts to create after commit — kept separate so an alert failure can never undo a reward or payment. */
  readonly alerts: AlertIntent[] = [];
  push(topic: string | string[], type: EventType, data: unknown) {
    this.items.push({ topic, type, data });
  }
  flush(bus: EventBus) {
    for (const i of this.items.splice(0)) bus.publish(i.topic, i.type, i.data);
  }
}
