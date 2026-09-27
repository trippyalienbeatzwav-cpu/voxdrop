import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, Coins, FileAudio, Gift, HandCoins, MessageSquare, Mic, Sparkles } from 'lucide-react';
import { get, qs } from '../../lib/api';
import { useChannel } from '../../lib/channel';
import { fmtMoney, fmtPoints } from '../../lib/format';
import { useConfig } from '../../lib/session';
import { ErrorState, PageHeader, Skeleton, StatCard } from '../../components/ui/Feedback';
import { Input } from '../../components/ui/Field';
import { Button } from '../../components/ui/Button';
import { HourStrip, RankBars, StackedBars } from '../../components/charts';

interface A {
  daily: Array<{ day: string; text: number; voice: number; mp3: number; sound: number; points: number; donations_cents: number; subs: number; gifts: number }>;
  totals: { text: number; voice: number; mp3: number; sound: number; points: number; donationsCents: number; subs: number; gifts: number; pointsEarned: number };
  topSupporters: Array<{ display_name: string; points: number; messages: number; donated_cents: number }>;
  topSounds: Array<{ name: string; color: string; uses: number; points: number }>;
  peakHours: Array<{ hour: number; n: number }>;
}

const RANGES = [
  ['today', 'Today'],
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['90d', '90 days'],
  ['custom', 'Custom'],
] as const;

export default function Analytics() {
  const { channel } = useChannel();
  const cfg = useConfig().data;
  const [range, setRange] = useState<string>('7d');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [applied, setApplied] = useState({ from: '', to: '' });
  const q = useQuery({
    queryKey: ['channel-analytics', channel?.id, range, applied],
    enabled: !!channel && (range !== 'custom' || (!!applied.from && !!applied.to)),
    queryFn: () => get<A>(`/api/channels/${channel!.id}/analytics${qs({ range, from: range === 'custom' ? applied.from : undefined, to: range === 'custom' ? applied.to : undefined })}`),
  });
  const d = q.data;
  const cur = cfg?.currency;
  return (
    <div className="space-y-6">
      <PageHeader title="Analytics" subtitle="How your community engages. Times are UTC." />
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-wrap gap-1 rounded-xl bg-surface p-1 ring-1 ring-line" role="group" aria-label="Date range">
          {RANGES.map(([v, l]) => (
            <button key={v} onClick={() => setRange(v)} aria-pressed={range === v} className={`h-9 rounded-lg px-3 text-sm font-medium transition-colors ${range === v ? 'bg-raised text-fg ring-1 ring-line-strong' : 'text-muted hover:text-fg'}`}>
              {l}
            </button>
          ))}
        </div>
        {range === 'custom' && (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setApplied(custom);
            }}
          >
            <label className="text-xs text-muted">
              From
              <Input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} className="mt-1 h-9" />
            </label>
            <label className="text-xs text-muted">
              To
              <Input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} className="mt-1 h-9" />
            </label>
            <Button type="submit" size="sm" disabled={!custom.from || !custom.to}>
              Apply
            </Button>
          </form>
        )}
      </div>

      {q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !d ? (
        range === 'custom' && !applied.from ? (
          <p className="text-sm text-muted">Choose a start and end date.</p>
        ) : (
          <Skeleton className="h-96 rounded-2xl" />
        )
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Text messages" value={d.totals.text} icon={<MessageSquare />} tone="cyan" />
            <StatCard label="Voice messages" value={d.totals.voice} icon={<Mic />} />
            <StatCard label="MP3 clips" value={d.totals.mp3} icon={<FileAudio />} tone="violet" />
            <StatCard label="Sounds played" value={d.totals.sound} icon={<Sparkles />} tone="magenta" />
            <StatCard label="Points spent" value={fmtPoints(d.totals.points)} icon={<Coins />} />
            <StatCard label="Points earned (rewards)" value={fmtPoints(d.totals.pointsEarned)} icon={<Gift />} tone="violet" />
            <StatCard label="Donations" value={fmtMoney(d.totals.donationsCents, cur)} icon={<HandCoins />} tone="magenta" />
            <StatCard label="Subs · Gift subs" value={`${d.totals.subs} · ${d.totals.gifts}`} icon={<Sparkles />} tone="amber" />
          </div>
          <section className="card p-5" aria-labelledby="mpd-h">
            <h2 id="mpd-h" className="mb-4 flex items-center gap-2 font-semibold">
              <BarChart3 className="size-4 text-volt" aria-hidden /> Messages per day
            </h2>
            <StackedBars
              title="Messages per day by type"
              data={d.daily}
              xKey="day"
              series={[
                { key: 'text', label: 'Text', color: 'var(--color-cyan)' },
                { key: 'voice', label: 'Voice', color: 'var(--color-volt)' },
                { key: 'mp3', label: 'MP3', color: 'var(--color-violet)' },
                { key: 'sound', label: 'Sound', color: 'var(--color-magenta)' },
              ]}
            />
          </section>
          <div className="grid gap-6 lg:grid-cols-2">
            <section className="card p-5" aria-labelledby="ppd-h">
              <h2 id="ppd-h" className="mb-4 font-semibold">
                Points spent per day
              </h2>
              <StackedBars title="Points spent per day" data={d.daily} xKey="day" series={[{ key: 'points', label: 'Points', color: 'var(--color-volt)' }]} height={160} format={(n) => fmtPoints(n)} />
            </section>
            <section className="card p-5" aria-labelledby="dpd-h">
              <h2 id="dpd-h" className="mb-4 font-semibold">
                Subs & gift subs per day
              </h2>
              <StackedBars
                title="Subscriptions and gift subs per day"
                data={d.daily}
                xKey="day"
                series={[
                  { key: 'subs', label: 'Subs', color: 'var(--color-violet)' },
                  { key: 'gifts', label: 'Gift subs', color: 'var(--color-magenta)' },
                ]}
                height={160}
              />
            </section>
            <section className="card p-5" aria-labelledby="sup-h">
              <h2 id="sup-h" className="mb-4 font-semibold">
                Top supporters
              </h2>
              {d.topSupporters.length ? <RankBars rows={d.topSupporters.map((s) => ({ label: s.display_name, value: s.points, sub: s.donated_cents ? fmtMoney(s.donated_cents, cur) : `${s.messages} msgs` }))} format={fmtPoints} /> : <p className="text-sm text-muted">No data for this range.</p>}
            </section>
            <section className="card p-5" aria-labelledby="snd-h">
              <h2 id="snd-h" className="mb-4 font-semibold">
                Most used sounds
              </h2>
              {d.topSounds.length ? <RankBars rows={d.topSounds.map((s) => ({ label: s.name, value: s.uses, color: s.color, sub: `${fmtPoints(s.points)} pts` }))} /> : <p className="text-sm text-muted">No sounds played in this range.</p>}
            </section>
          </div>
          <section className="card p-5" aria-labelledby="peak-h">
            <h2 id="peak-h" className="mb-4 font-semibold">
              Peak activity
            </h2>
            <HourStrip hours={d.peakHours} />
          </section>
        </>
      )}
    </div>
  );
}
