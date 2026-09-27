import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from './lib/api';
import { useMe } from './lib/session';
import { RealtimeProvider } from './lib/realtime';
import { ToastProvider } from './components/ui/Toast';
import { ConfirmProvider } from './components/ui/Modal';
import App from './App';
import './styles.css';

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      // Don't hammer the API on auth/permission/validation errors.
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
  queryCache: new QueryCache({
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'UNAUTHORIZED') qc.invalidateQueries({ queryKey: ['me'] });
    },
  }),
  mutationCache: new MutationCache({
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'CSRF_FAILED') qc.invalidateQueries({ queryKey: ['me'] });
    },
  }),
});

/** The OBS overlay and dev mock screens never open the user's real-time stream. */
function WithRealtime({ children }: { children: ReactNode }) {
  const bare = /^\/(overlay|dev)\//.test(window.location.pathname);
  const me = useMe();
  return <RealtimeProvider me={bare ? undefined : me.data}>{children}</RealtimeProvider>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <ToastProvider>
          <ConfirmProvider>
            <WithRealtime>
              <App />
            </WithRealtime>
          </ConfirmProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
