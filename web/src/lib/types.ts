export type Role = 'VIEWER' | 'STREAMER' | 'MODERATOR' | 'ADMIN';
export type MessageStatus = 'PENDING' | 'APPROVED' | 'QUEUED' | 'PLAYING' | 'PLAYED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
export type MessageType = 'TEXT' | 'VOICE' | 'MP3' | 'SOUND';

export interface Me {
  user: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    role: Role;
    status: 'ACTIVE' | 'SUSPENDED';
    bio: string;
    reducedMotion: boolean;
    createdAt: string;
    dailyBonusAvailable: boolean;
  } | null;
  kick?: { userId: string; username: string; profilePicture: string | null; channelTokens: boolean; scopes: string[] } | null;
  channels?: Array<{ id: string; slug: string; display_name: string; avatar_url: string | null; is_live?: boolean; access: 'owner' | 'moderator' }>;
  points?: number;
  unreadNotifications?: number;
  csrfToken: string | null;
}

export interface PublicConfig {
  kickMode: 'live' | 'mock';
  paymentProvider: 'stripe' | 'mock';
  storageProvider: 's3' | 'mock';
  malwareScanning: boolean;
  currency: string;
  dailyBonusPoints: number;
  devMocks: boolean;
  discordUrl: string | null;
}

export interface Streamer {
  id: string;
  slug: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  isLive: boolean;
  liveTitle: string | null;
  brandColor: string;
  kickUrl: string;
  status?: string;
  features?: { text: boolean; voice: boolean; mp3: boolean; sounds: boolean; donations: boolean; donationVoice: boolean };
  pricing?: { text: number; voice: number; mp3: number; priority: number; minPerMessage: number; maxPerMessage: number; freeTextPerDay: number };
  limits?: { maxAudioSeconds: number; maxFileBytes: number; cooldownSeconds: number; dailyMessageLimit: number };
  donations?: { minCents: number; maxCents: number };
  approvalMode?: 'AUTO' | 'MANUAL';
  activity7d?: number;
  soundCount?: number;
  voiceEnabled?: boolean;
  priceVoice?: number;
  priceText?: number;
}

export interface AudioRef {
  id: string;
  durationMs: number | null;
  waveform: number[];
  container?: string | null;
}

export interface Message {
  id: string;
  streamerId: string;
  streamer: { slug: string; displayName: string; avatarUrl: string | null };
  sender: { id: string | null; username: string; displayName: string; avatarUrl: string | null };
  type: MessageType;
  priorityTier?: 'NORMAL' | 'PRIORITY' | 'HIGH' | 'VIP';
  priorityPoints?: number;
  playbackState?: string;
  text: string;
  audio: AudioRef | null;
  sound: { id: string; name: string; icon: string; color: string } | null;
  donation: { id: string; amountCents: number; currency: string } | null;
  pointsSpent: number;
  bonusPoints: number;
  isPriority: boolean;
  status: MessageStatus;
  flagged: boolean;
  flagReason: string | null;
  rejectionReason: string | null;
  moderatedBy: string | null;
  moderatedAt: string | null;
  playedAt: string | null;
  createdAt: string;
  queue: {
    itemId: string;
    status: string;
    position: number;
    priority: boolean;
    phase: 'PENDING' | 'ANNOUNCING' | 'PLAYING_MESSAGE' | 'COMPLETED' | 'SKIPPED' | 'FAILED' | null;
    announcement: { status: 'NONE' | 'PENDING' | 'READY' | 'FAILED' | 'PLAYED' | 'SKIPPED' | null; text: string | null; audioId: string | null; durationMs: number | null };
  } | null;
}

export interface QueueItem extends Message {
  viewerName: string;
  announcementEnabled: boolean;
  announcementKind: 'VOICE' | 'MP3' | 'DONATION' | 'SOUND' | null;
  queuePosition: number;
  durationMs: number;
  estimatedWaitMs: number;
  waitingSeconds: number;
  pinned: boolean;
  priorityScore: { score: number; base: number; points: number; waiting: number; waitedSeconds: number; starving: boolean } | null;
}

export interface QueueState {
  paused: boolean;
  autoPlay: boolean;
  autoPlayDelayMs: number;
  overlayConnected: boolean;
  priority: { enabled: boolean; allowVipInterrupt: boolean; tiers: Array<{ tier: 'NORMAL' | 'PRIORITY' | 'HIGH' | 'VIP'; name: string; color: string; icon: string }> };
  announcements: { enabled: boolean; types: string[]; available: boolean; provider: string };
  nowPlaying: QueueItem | null;
  items: QueueItem[];
  totalWaitMs: number;
}

export interface Sound {
  id: string;
  streamerId: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  durationMs: number;
  pricePoints: number;
  cooldownSeconds: number;
  cooldownRemaining: number;
  dailyLimit: number;
  usesToday: number;
  available: boolean;
  isActive: boolean;
  sortOrder: number;
  category: { slug: string; name: string };
  audioFileId: string;
  waveform: number[];
  uses30d: number;
  createdBy: string;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PointsTx {
  id: string;
  type: string;
  amount: number;
  balance_before: number;
  balance_after: number;
  reference_type: string | null;
  description: string;
  created_at: string;
  streamer_slug: string | null;
  streamer_display_name: string | null;
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

export interface Quote {
  price: { base: number; priority: number; bonus: number; total: number; tier?: string };
  balance: number;
  balanceAfter: number;
  affordable: boolean;
  freeTextRemaining: number;
  cooldownRemaining: number;
  dailyRemaining: number | null;
  minPerMessage: number;
  maxPerMessage: number;
}
