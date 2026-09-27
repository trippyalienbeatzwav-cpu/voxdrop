import { useEffect, useState } from 'react';
import { FlaskConical, WifiOff } from 'lucide-react';
import { useConfig } from '../../lib/session';

/** Always-visible notice while any development mock is active. */
export function DevModeBanner() {
  const { data } = useConfig();
  if (!data?.devMocks) return null;
  const parts = [data.kickMode === 'mock' && 'Kick login & events', data.paymentProvider === 'mock' && 'payments', data.storageProvider === 'mock' && 'storage'].filter(Boolean);
  return (
    <div role="note" className="flex items-center justify-center gap-2 border-b border-amber/30 bg-amber/10 px-4 py-1.5 text-center text-xs font-medium text-amber">
      <FlaskConical className="size-3.5 shrink-0" aria-hidden />
      <span>
        <strong>Development mode</strong> — mocked {parts.join(', ')}. No real Kick accounts or money are involved.
      </span>
    </div>
  );
}

export function OfflineBanner() {
  const [offline, setOffline] = useState(typeof navigator !== 'undefined' && !navigator.onLine);
  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  if (!offline) return null;
  return (
    <div role="alert" className="flex items-center justify-center gap-2 bg-danger px-4 py-2 text-sm font-medium text-white">
      <WifiOff className="size-4" aria-hidden /> You’re offline. Changes will fail until your connection is back.
    </div>
  );
}
