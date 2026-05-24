import { useCallback, useState } from 'react';

type DimensionUpdate = number | ((current: number) => number);

export function clampDimension(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function usePersistentDimension(
  key: string,
  fallback: number,
  min: number,
  max: number,
): readonly [number, (next: DimensionUpdate) => void] {
  const [value, setValue] = useState(() => {
    if (typeof window === 'undefined') return fallback;
    try {
      const raw = window.localStorage.getItem(key);
      const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
      return Number.isFinite(parsed) ? clampDimension(parsed, min, max) : fallback;
    } catch {
      return fallback;
    }
  });

  const setDimension = useCallback((next: DimensionUpdate) => {
    setValue((current) => {
      const raw = typeof next === 'function' ? next(current) : next;
      const clamped = clampDimension(raw, min, max);
      try {
        window.localStorage.setItem(key, String(clamped));
      } catch {
        // Local storage can be unavailable in privacy modes; resizing still works for the session.
      }
      return clamped;
    });
  }, [key, min, max]);

  return [value, setDimension] as const;
}
