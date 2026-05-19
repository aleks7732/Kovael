import { memo, useCallback, useRef, useState } from 'react';

interface MissionConsoleProps {
  onInject: (goal: string) => void;
  disabled?: boolean;
}

/**
 * MissionConsole: the one input on the entire cockpit. A human types a
 * mission objective, hits Enter (or the dispatch arrow), and the goal is
 * sent to the orchestrator as a `mission_inject` WS frame. Without this
 * affordance the board is a read-only window; with it, the board closes
 * the loop between human intent and the Triad pipeline.
 */
export const MissionConsole = memo(({ onInject, disabled }: MissionConsoleProps) => {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const dispatch = useCallback(() => {
    const goal = value.trim();
    if (!goal || disabled) return;
    onInject(goal);
    setValue('');
    inputRef.current?.blur();
  }, [value, disabled, onInject]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      dispatch();
    } else if (e.key === 'Escape') {
      setValue('');
      inputRef.current?.blur();
    }
  }, [dispatch]);

  return (
    <div className="flex items-center gap-2 h-8 px-2 rounded-md bg-black/40 border border-white/5 focus-within:border-command-accent/40 transition-colors min-w-[280px]">
      <span className="t-eyebrow !text-[7px] shrink-0">INJECT</span>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        placeholder="Type mission objective…"
        className="flex-1 bg-transparent border-none outline-none t-mono text-[11px] text-command-warm-white placeholder:text-white/25"
        spellCheck={false}
        autoComplete="off"
      />
      <button
        type="button"
        onClick={dispatch}
        disabled={disabled || !value.trim()}
        className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-command-accent hover:bg-command-accent/15 disabled:opacity-25 disabled:hover:bg-transparent transition-colors"
        aria-label="Dispatch mission"
      >
        <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 6h8m0 0L7 3m3 3L7 9" />
        </svg>
      </button>
    </div>
  );
});
MissionConsole.displayName = 'MissionConsole';

export default MissionConsole;
