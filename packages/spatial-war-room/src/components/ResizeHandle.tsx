import { memo, useCallback, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';

interface ResizeHandleProps {
  axis: 'x' | 'y';
  onResize: (delta: number) => void;
  title: string;
  className?: string;
}

const KEYBOARD_STEP_PX = 16;

export const ResizeHandle = memo(({ axis, onResize, title, className = '' }: ResizeHandleProps) => {
  const beginResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    let previous = axis === 'x' ? event.clientX : event.clientY;
    const cursor = axis === 'x' ? 'col-resize' : 'row-resize';
    const originalCursor = document.body.style.cursor;
    const originalUserSelect = document.body.style.userSelect;
    document.body.style.cursor = cursor;
    document.body.style.userSelect = 'none';

    const move = (moveEvent: PointerEvent) => {
      const current = axis === 'x' ? moveEvent.clientX : moveEvent.clientY;
      const delta = current - previous;
      previous = current;
      if (delta !== 0) onResize(delta);
    };
    const stop = () => {
      document.body.style.cursor = originalCursor;
      document.body.style.userSelect = originalUserSelect;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
    window.addEventListener('pointercancel', stop, { once: true });
  }, [axis, onResize]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (axis === 'x') {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        onResize(-KEYBOARD_STEP_PX);
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        onResize(KEYBOARD_STEP_PX);
      }
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      onResize(-KEYBOARD_STEP_PX);
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      onResize(KEYBOARD_STEP_PX);
    }
  }, [axis, onResize]);

  const vertical = axis === 'x';
  const orientation = vertical ? 'vertical' : 'horizontal';
  const base = vertical
    ? 'w-2 cursor-col-resize'
    : 'h-2 cursor-row-resize';
  const rail = vertical
    ? 'h-10 w-px group-hover:h-16 group-focus-visible:h-16'
    : 'h-px w-10 group-hover:w-16 group-focus-visible:w-16';

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={title}
      tabIndex={0}
      title={title}
      onPointerDown={beginResize}
      onKeyDown={handleKeyDown}
      className={`group shrink-0 relative z-30 flex items-center justify-center bg-white/[0.01] hover:bg-command-accent/10 focus-visible:bg-command-accent/10 transition-colors ${base} ${className}`}
    >
      <span className={`${rail} rounded-full bg-command-warm-white/20 group-hover:bg-command-accent/80 group-focus-visible:bg-command-accent/80 transition-all`} />
    </div>
  );
});

ResizeHandle.displayName = 'ResizeHandle';
