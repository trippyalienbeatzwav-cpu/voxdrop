import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { PublicLayout } from './components/layout/PublicLayout';
import { FullSpinner, RequireAdmin, RequireAuth, RequireStaff } from './components/layout/Guards';
import { ChannelProvider } from './lib/channel';
import { useMe } from './lib/session';

// Route-level code splitting keeps the landing page and overlay light.
const Landing = lazy(() => import('./pages/public/Landing'));
const Login = lazy(() => import('./pages/public/Login'));
const Streamers = lazy(() => import('./pages/public/Streamers'));
const StreamerProfile = lazy(() => import('./pages/public/StreamerProfile'));
const NotFound = lazy(() => import('./pages/public/NotFound'));
const Overlay = lazy(() => import('./pages/Overlay'));
const AlertOverlay = lazy(() => import('./pages/AlertOverlay'));
const LegacyOverlay = lazy(() => import('./pages/LegacyOverlay'));
const BecomeStreamer = lazy(() => import('./pages/public/BecomeStreamer'));
const StreamerLogin = lazy(() => import('./pages/public/StreamerLogin'));
const MockKick = lazy(() => import('./pages/dev/MockKick'));
const MockCheckout = lazy(() => import('./pages/dev/MockCheckout'));

const Home = lazy(() => import('./pages/viewer/Home'));
const Subscriptions = lazy(() => import('./pages/viewer/Subscriptions'));
const StreamerPicker = lazy(() => import('./pages/viewer/StreamerPicker'));
const SendMessage = lazy(() => import('./pages/viewer/SendMessage'));
const Voice = lazy(() => import('./pages/viewer/Voice'));
const Sounds = lazy(() => import('./pages/viewer/Sounds'));
const PointsShop = lazy(() => import('./pages/viewer/PointsShop'));
const History = lazy(() => import('./pages/viewer/History'));
const Donations = lazy(() => import('./pages/viewer/Donations'));
const DonationResult = lazy(() => import('./pages/viewer/DonationResult'));
const Profile = lazy(() => import('./pages/viewer/Profile'));
const Settings = lazy(() => import('./pages/viewer/Settings'));
const Notifications = lazy(() => import('./pages/viewer/Notifications'));

const SDashboard = lazy(() => import('./pages/streamer/Dashboard'));
const SQueue = lazy(() => import('./pages/streamer/Queue'));
const SModeration = lazy(() => import('./pages/streamer/Moderation'));
const SMessages = lazy(() => import('./pages/streamer/Messages'));
const SSounds = lazy(() => import('./pages/streamer/SoundsManage'));
const SSoundboard = lazy(() => import('./pages/streamer/Soundboard'));
const SPoints = lazy(() => import('./pages/streamer/Points'));
const SDonations = lazy(() => import('./pages/streamer/Donations'));
const SSubscribers = lazy(() => import('./pages/streamer/Subscribers'));
const SUsers = lazy(() => import('./pages/streamer/Users'));
const SAnalytics = lazy(() => import('./pages/streamer/Analytics'));
const SHistory = lazy(() => import('./pages/streamer/History'));
const SSettings = lazy(() => import('./pages/streamer/Settings'));
const SIntegrations = lazy(() => import('./pages/streamer/Integrations'));
const SPriority = lazy(() => import('./pages/streamer/Priority'));
const SAlerts = lazy(() => import('./pages/streamer/Alerts'));
const SObs = lazy(() => import('./pages/streamer/Obs'));

const Admin = lazy(() => import('./pages/admin/Admin'));

/** Public discovery pages use the app shell when signed in, the marketing shell otherwise. */
function Adaptive() {
  const me = useMe();
  if (me.isLoading) return <FullSpinner />;
  return me.data?.user ? <AppShell area="viewer" /> : <PublicLayout />;
}

export default function App() {
  return (
    <Suspense fallback={<FullSpinner />}>
      <Routes>
        <Route path="/overlay/:streamerId/audio" element={<Overlay />} />
        <Route path="/overlay/:streamerId/:kind" element={<AlertOverlay />} />
        <Route path="/overlay/:streamer" element={<LegacyOverlay />} />
        <Route path="/dev/mock-kick" element={<MockKick />} />
        <Route path="/dev/mock-checkout/:sessionId" element={<MockCheckout />} />

        <Route element={<PublicLayout />}>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
        </Route>

        <Route element={<Adaptive />}>
          <Route path="/become-streamer" element={<BecomeStreamer />} />
          <Route path="/streamer/login" element={<StreamerLogin />} />
        </Route>

        <Route element={<Adaptive />}>
          <Route path="/streamers" element={<Streamers />} />
          <Route path="/streamer/:username" element={<StreamerProfile />} />
        </Route>

        <Route element={<RequireAuth />}>
          <Route element={<AppShell area="viewer" />}>
            <Route path="/home" element={<Home />} />
            <Route path="/dashboard" element={<Navigate to="/home" replace />} />
            <Route path="/subscriptions" element={<Subscriptions />} />
            <Route path="/messages" element={<History tab="messages" />} />
            <Route path="/send" element={<StreamerPicker mode="send" />} />
            <Route path="/send/:streamer" element={<SendMessage />} />
            <Route path="/voice" element={<StreamerPicker mode="voice" />} />
            <Route path="/voice/:streamer" element={<Voice />} />
            <Route path="/sounds" element={<Sounds />} />
            <Route path="/points" element={<PointsShop />} />
            <Route path="/history" element={<History tab="points" />} />
            <Route path="/history/messages" element={<History tab="messages" />} />
            <Route path="/donations" element={<Donations />} />
            <Route path="/donations/result" element={<DonationResult />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/notifications" element={<Notifications />} />
          </Route>

          <Route
            element={
              <ChannelProvider>
                <AppShell area="streamer" />
              </ChannelProvider>
            }
          >
            <Route element={<RequireStaff />}>
              <Route path="/streamer/dashboard" element={<SDashboard />} />
              <Route path="/streamer/queue" element={<SQueue />} />
              <Route path="/streamer/moderation" element={<SModeration />} />
              <Route path="/streamer/messages" element={<SMessages />} />
              <Route path="/streamer/sounds" element={<SSounds />} />
              <Route path="/streamer/soundboard" element={<SSoundboard />} />
              <Route path="/streamer/points" element={<SPoints />} />
              <Route path="/streamer/donations" element={<SDonations />} />
              <Route path="/streamer/subscribers" element={<SSubscribers />} />
              <Route path="/streamer/users" element={<SUsers />} />
              <Route path="/streamer/analytics" element={<SAnalytics />} />
              <Route path="/streamer/history" element={<SHistory />} />
              <Route path="/streamer/settings" element={<SSettings />} />
              <Route path="/streamer/integrations" element={<SIntegrations />} />
              <Route path="/streamer/priority" element={<SPriority />} />
              <Route path="/streamer/alerts" element={<SAlerts />} />
              <Route path="/streamer/obs" element={<SObs />} />
              <Route path="/streamer/overview" element={<Navigate to="/streamer/dashboard" replace />} />
              <Route path="/streamer/gift-subs" element={<SSubscribers defaultKind="gifts" />} />
            </Route>
          </Route>

          <Route
            element={
              <ChannelProvider>
                <AppShell area="admin" />
              </ChannelProvider>
            }
          >
            <Route element={<RequireAdmin />}>
              <Route path="/admin" element={<Admin />} />
              <Route path="/admin/:tab" element={<Admin />} />
            </Route>
          </Route>
        </Route>

        <Route element={<PublicLayout />}>
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
