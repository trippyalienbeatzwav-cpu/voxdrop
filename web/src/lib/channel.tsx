import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useMe } from './session';

type Channel = NonNullable<ReturnType<typeof useMe>['data']>['channels'] extends (infer T)[] | undefined ? T : never;

const Ctx = createContext<{ channel: Channel | null; channels: Channel[]; select: (id: string) => void }>({ channel: null, channels: [], select: () => undefined });

/** Which channel the streamer area is operating on (owners default to their own; moderators pick). */
export function ChannelProvider({ children }: { children: ReactNode }) {
  const me = useMe();
  const channels = (me.data?.channels ?? []) as Channel[];
  const [selected, setSelected] = useState<string | null>(() => {
    try {
      return localStorage.getItem('vx.channel');
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (channels.length && !channels.some((c) => c.id === selected)) setSelected((channels.find((c) => c.access === 'owner') ?? channels[0])!.id);
  }, [channels, selected]);
  const select = (id: string) => {
    setSelected(id);
    try {
      localStorage.setItem('vx.channel', id);
    } catch {
      /* private mode */
    }
  };
  const channel = channels.find((c) => c.id === selected) ?? null;
  return <Ctx.Provider value={{ channel, channels, select }}>{children}</Ctx.Provider>;
}

export const useChannel = () => useContext(Ctx);
