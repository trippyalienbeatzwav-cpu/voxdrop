export const ALERT_KINDS = ['subscription', 'gift_sub', 'donation'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/**
 * A request to show an alert, produced inside a reward/payment transaction and
 * delivered only AFTER that transaction commits (see Outbox.alerts). Delivery
 * is best-effort and idempotent per (kind, source); it can never roll back or
 * block the points reward / payment that caused it.
 */
export interface AlertIntent {
  streamerId: string;
  kind: AlertKind;
  sourceType: 'subscription' | 'gift_subscription' | 'donation' | 'test';
  sourceId: string;
  viewerName: string;
  avatarUrl?: string | null;
  months?: number;
  giftCount?: number;
  amountCents?: number;
  currency?: string;
  message?: string;
  isTest?: boolean;
}
