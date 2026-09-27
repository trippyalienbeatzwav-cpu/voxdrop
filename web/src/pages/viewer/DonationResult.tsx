import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle2, Clock, XCircle } from 'lucide-react';
import { get } from '../../lib/api';
import { fmtMoney } from '../../lib/format';
import { ErrorState, Spinner } from '../../components/ui/Feedback';
import { ButtonLink } from '../../components/ui/Button';

interface D {
  id: string;
  amount_cents: number;
  currency: string;
  status: string;
  streamer_slug: string;
  streamer_display_name: string;
}

/** Landing page after checkout: waits for the server-verified webhook result. */
export default function DonationResult() {
  const [params] = useSearchParams();
  const id = params.get('donation');
  const cancelled = params.get('status') === 'cancelled';
  const q = useQuery({
    queryKey: ['donation', id],
    enabled: !!id,
    queryFn: () => get<{ donation: D }>(`/api/donations/${id}`),
    refetchInterval: (query) => (query.state.data?.donation.status === 'PENDING' && !cancelled ? 2000 : false),
  });
  if (!id) return <ErrorState error={new Error('Missing donation reference')} />;
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorState error={q.error} />;
  const d = q.data!.donation;
  const amount = fmtMoney(d.amount_cents, d.currency);
  const view =
    d.status === 'COMPLETED'
      ? { icon: <CheckCircle2 className="size-14 text-success" />, title: `Thank you! ${amount} sent to ${d.streamer_display_name}`, body: 'Your donation is confirmed. If you added a message, it’s on its way to the stream.' }
      : d.status === 'PENDING' && !cancelled
        ? { icon: <Clock className="size-14 animate-pulse text-amber" />, title: 'Confirming your payment…', body: 'This usually takes a few seconds. You can leave this page — we’ll notify you.' }
        : { icon: <XCircle className="size-14 text-danger" />, title: cancelled ? 'Donation cancelled' : 'Payment failed', body: cancelled ? 'You weren’t charged.' : 'The payment didn’t go through and you weren’t charged. Please try again.' };
  return (
    <div className="mx-auto max-w-lg py-12 text-center" role="status" aria-live="polite">
      <div className="flex justify-center">{view.icon}</div>
      <h1 className="mt-5 text-2xl font-semibold">{view.title}</h1>
      <p className="mt-2 text-muted">{view.body}</p>
      <div className="mt-8 flex flex-wrap justify-center gap-2">
        <ButtonLink to={`/streamer/${d.streamer_slug}`} variant="primary">
          Back to {d.streamer_display_name}
        </ButtonLink>
        <ButtonLink to="/donations">Donation history</ButtonLink>
      </div>
    </div>
  );
}
