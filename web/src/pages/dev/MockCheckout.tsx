import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { CreditCard, FlaskConical, XCircle } from 'lucide-react';
import { get, post } from '../../lib/api';
import { fmtMoney } from '../../lib/format';
import { useMe } from '../../lib/session';
import { ErrorState, Spinner } from '../../components/ui/Feedback';
import { Button } from '../../components/ui/Button';

/**
 * ███ DEVELOPMENT ONLY ███ — stands in for a hosted payment page (e.g. Stripe
 * Checkout) when PAYMENT_PROVIDER=mock. Clicking Pay sends a signed webhook to
 * the real /api/webhooks/payments handler, which re-verifies the checkout.
 */
export default function MockCheckout() {
  const { sessionId = '' } = useParams();
  useMe(); // loads the CSRF token for the POST below
  const q = useQuery({ queryKey: ['mock-checkout', sessionId], queryFn: () => get<{ session: { amountCents: number; currency: string; description: string; status: string; cancelUrl: string } }>(`/api/dev/mock-checkout/${sessionId}`) });
  const act = useMutation({
    mutationFn: (outcome: 'pay' | 'decline') => post<{ redirect: string }>(`/api/dev/mock-checkout/${sessionId}/${outcome}`),
    onSuccess: (r) => window.location.assign(r.redirect),
  });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorState className="m-6" error={q.error} />;
  const s = q.data!.session;
  return (
    <div className="grid-bg flex min-h-dvh items-center justify-center p-4">
      <div className="card-raised w-full max-w-md p-6">
        <div className="mb-5 flex items-center gap-2 rounded-xl border border-amber/30 bg-amber/10 p-3 text-sm text-amber">
          <FlaskConical className="size-5 shrink-0" aria-hidden /> Mock checkout — development only. No money moves.
        </div>
        <p className="text-sm text-muted">{s.description}</p>
        <p className="num mt-1 font-display text-4xl font-bold">{fmtMoney(s.amountCents, s.currency)}</p>
        {s.status !== 'unpaid' ? (
          <p className="mt-6 text-sm text-muted">This checkout is already {s.status}.</p>
        ) : (
          <div className="mt-6 grid gap-2">
            <Button variant="primary" size="lg" icon={<CreditCard className="size-4" />} loading={act.isPending && act.variables === 'pay'} onClick={() => act.mutate('pay')}>
              Pay (simulate success)
            </Button>
            <Button variant="danger" icon={<XCircle className="size-4" />} loading={act.isPending && act.variables === 'decline'} onClick={() => act.mutate('decline')}>
              Decline (simulate failure)
            </Button>
            <a href={s.cancelUrl} className="mt-2 text-center text-sm text-muted underline">
              Cancel and go back
            </a>
          </div>
        )}
        {act.error && <p className="mt-3 text-sm text-danger">{(act.error as Error).message}</p>}
      </div>
    </div>
  );
}
