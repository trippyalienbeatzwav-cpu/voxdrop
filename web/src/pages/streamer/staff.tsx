import { useMutation, useQueryClient } from '@tanstack/react-query';
import { del, post } from '../../lib/api';
import { useChannel } from '../../lib/channel';
import { useConfirm } from '../../components/ui/Modal';
import { useErrorToast, useToast } from '../../components/ui/Toast';
import type { Message } from '../../lib/types';

/** Moderation/queue mutations shared by the queue, moderation and messages screens. */
export function useStaffActions() {
  const { channel } = useChannel();
  const sid = channel?.id ?? '';
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const confirm = useConfirm();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['queue'] });
    qc.invalidateQueries({ queryKey: ['channel-messages'] });
    qc.invalidateQueries({ queryKey: ['channel-dashboard'] });
  };
  const m = <A,>(fn: (a: A) => Promise<unknown>, ok?: (a: A) => string) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useMutation({
      mutationFn: fn,
      onSuccess: (_r, a) => {
        refresh();
        if (ok) toast({ title: ok(a), tone: 'success', durationMs: 2500 });
      },
      onError,
    });

  const approve = m((id: string) => post(`/api/messages/${id}/approve`), () => 'Approved — added to queue');
  const reject = m(({ id, reason }: { id: string; reason?: string }) => post(`/api/messages/${id}/reject`, { reason: reason ?? '' }), () => 'Rejected');
  const playNow = m((id: string) => post(`/api/messages/${id}/play-now`), () => 'Playing now');
  const queueMsg = m((id: string) => post(`/api/messages/${id}/queue`), () => 'Queued');
  const remove = m((id: string) => del(`/api/messages/${id}`), () => 'Message deleted');
  const flag = m(({ id, flagged }: { id: string; flagged: boolean }) => post(`/api/messages/${id}/flag`, { flagged }), (a) => (a.flagged ? 'Flagged' : 'Unflagged'));
  const skip = m((itemId: string) => post(`/api/channels/${sid}/queue/skip`, { itemId }), () => 'Skipped');
  const playNext = m((force: boolean) => post(`/api/channels/${sid}/queue/play-next`, { force }));
  const pause = m((paused: boolean) => post(`/api/channels/${sid}/queue/${paused ? 'pause' : 'resume'}`), (p) => (p ? 'Queue paused' : 'Queue resumed'));
  const userAction = m(
    ({ userId, action, minutes, reason }: { userId: string; action: 'warn' | 'mute' | 'unmute' | 'ban' | 'unban'; minutes?: number; reason?: string }) =>
      post(`/api/channels/${sid}/users/${userId}/${action}`, { minutes, reason }),
    (a) => ({ warn: 'Warning sent', mute: 'User muted', unmute: 'User unmuted', ban: 'User banned', unban: 'User unbanned' })[a.action],
  );

  return {
    sid,
    approve,
    reject,
    playNow,
    queueMsg,
    remove,
    flag,
    skip,
    playNext,
    pause,
    userAction,
    async confirmBan(msg: Pick<Message, 'sender'>) {
      if (!msg.sender.id) return;
      if (await confirm({ title: `Ban ${msg.sender.displayName}?`, body: 'They can’t send anything to this channel until unbanned. Their waiting messages are rejected (and refunded per your settings).', confirmLabel: 'Ban user', tone: 'danger' }))
        userAction.mutate({ userId: msg.sender.id, action: 'ban', reason: 'Banned from moderation' });
    },
    async confirmMute(msg: Pick<Message, 'sender'>, minutes = 10) {
      if (!msg.sender.id) return;
      if (await confirm({ title: `Mute ${msg.sender.displayName} for ${minutes} minutes?`, confirmLabel: 'Mute', tone: 'danger' }))
        userAction.mutate({ userId: msg.sender.id, action: 'mute', minutes, reason: 'Muted from moderation' });
    },
    async confirmDelete(id: string) {
      if (await confirm({ title: 'Delete this message?', body: 'The content and audio are removed permanently from the platform. Unplayed messages are refunded per your settings.', confirmLabel: 'Delete', tone: 'danger' })) remove.mutate(id);
    },
  };
}
