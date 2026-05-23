import { memo, useEffect } from 'react';
import { Keyboard, X } from 'lucide-react';

interface ShortcutSheetProps {
  open: boolean;
  onClose: () => void;
}

const shortcuts = [
  ['?', 'Keyboard'],
  ['Esc', 'Close'],
  ['Canvas', 'Canvas'],
  ['Theater', 'Theater'],
  ['Trace', 'Trace'],
];

export const ShortcutSheet = memo(({ open, onClose }: ShortcutSheetProps) => {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard"
        className="w-[min(520px,calc(100vw-32px))] rounded-lg border border-white/10 bg-zinc-950/95 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="flex items-center gap-2">
            <Keyboard className="h-4 w-4 text-command-accent" aria-hidden />
            <h2 className="text-sm font-bold tracking-wide text-command-warm-white">Keyboard</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded border border-white/10 text-command-warm-white/70 hover:bg-white/10 hover:text-command-warm-white"
            aria-label="Close"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>
        <div className="grid gap-2 p-4">
          {shortcuts.map(([key, label]) => (
            <div key={`${key}-${label}`} className="grid grid-cols-[88px_1fr] items-center gap-3 rounded border border-white/5 bg-white/[0.03] px-3 py-2">
              <kbd className="inline-flex h-7 items-center justify-center rounded border border-white/10 bg-black/40 px-2 font-mono text-xs font-bold text-command-warm-white">
                {key}
              </kbd>
              <span className="text-xs font-medium text-command-warm-white/75">{label}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
});

ShortcutSheet.displayName = 'ShortcutSheet';
export default ShortcutSheet;
