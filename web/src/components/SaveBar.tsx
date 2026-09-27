import { Button } from './ui/Button';

/** Sticky save/discard bar shown when a settings form has unsaved changes. */
export function SaveBar({ visible, saving, onSave, onReset, invalid }: { visible: boolean; saving: boolean; onSave: () => void; onReset: () => void; invalid?: boolean }) {
  if (!visible) return null;
  return (
    <div className="glass sticky bottom-20 z-30 mt-6 flex animate-rise items-center justify-between gap-3 rounded-2xl border border-line-strong p-3 pl-5 shadow-[var(--shadow-pop)] lg:bottom-6" role="region" aria-label="Unsaved changes">
      <span className="text-sm font-medium">{invalid ? 'Fix the highlighted fields to save' : 'You have unsaved changes'}</span>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={onReset} disabled={saving}>
          Discard
        </Button>
        <Button variant="primary" onClick={onSave} loading={saving} disabled={invalid}>
          Save changes
        </Button>
      </div>
    </div>
  );
}
