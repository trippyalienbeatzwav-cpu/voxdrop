import { useEffect, useState } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router-dom';

/**
 * Old single-overlay URLs (/overlay/{slug}?key=…) keep working: the old key
 * became the audio overlay's token, so we look up the channel id and redirect.
 */
export default function LegacyOverlay() {
  const { streamer = '' } = useParams();
  const [params] = useSearchParams();
  const key = params.get('key') ?? '';
  const [id, setId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    fetch(`/api/streamers/${encodeURIComponent(streamer)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { streamer?: { id: string } } | null) => setId(j?.streamer?.id ?? null))
      .catch(() => setId(null));
  }, [streamer]);
  if (id === undefined) return null;
  if (!id || !key) return <div className="p-6 font-sans text-sm text-white/80">This overlay URL is out of date. Copy the current URL from VoxDrop Studio → OBS Overlays.</div>;
  return <Navigate to={`/overlay/${id}/audio?token=${encodeURIComponent(key)}`} replace />;
}
