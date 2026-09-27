import { SearchX } from 'lucide-react';
import { EmptyState } from '../../components/ui/Feedback';
import { ButtonLink } from '../../components/ui/Button';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-24">
      <EmptyState
        icon={<SearchX />}
        title="This page went off-air"
        body="The link may be broken, or the page may have moved."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <ButtonLink to="/" variant="primary">
              Go home
            </ButtonLink>
            <ButtonLink to="/streamers">Explore streamers</ButtonLink>
          </div>
        }
      />
    </div>
  );
}
