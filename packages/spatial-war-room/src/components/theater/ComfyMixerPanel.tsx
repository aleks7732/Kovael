import { memo, useEffect, useMemo, useState } from 'react';
import { Image, SlidersHorizontal, Zap } from 'lucide-react';
import { useWarRoomStore } from '../../store/useWarRoomStore';

const RECIPES = ['nyx', 'veyra', 'naethara'] as const;

interface MixerRow {
  recipeId: string;
  strength: number;
  denoise: number;
}

export const ComfyMixerPanel = memo(() => {
  const activeTopicId = useWarRoomStore((s) => s.activeTopicId);
  const activeTopic = useWarRoomStore((s) => s.topics.find((topic) => topic.id === s.activeTopicId));
  const previews = useWarRoomStore((s) => s.comfyPreviews);
  const recordComfyPreview = useWarRoomStore((s) => s.recordComfyPreview);
  const [rows, setRows] = useState<MixerRow[]>(() => RECIPES.map((recipeId) => ({ recipeId, strength: 0.75, denoise: 0.55 })));
  const [busy, setBusy] = useState(false);
  const [streamState, setStreamState] = useState<'idle' | 'connecting' | 'live' | 'closed'>('idle');
  const latest = previews[0] ?? null;

  const prompt = useMemo(() => {
    const title = activeTopic?.title ?? 'kovael theater portrait';
    return `${title} · spatial command portrait`;
  }, [activeTopic?.title]);

  useEffect(() => {
    if (!latest?.streamUrl) {
      setStreamState('idle');
      return;
    }
    const streamUrl = safeComfyStreamUrl(latest.streamUrl);
    if (!streamUrl) {
      setStreamState('closed');
      return;
    }
    setStreamState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(streamUrl);
    } catch {
      setStreamState('closed');
      return;
    }
    ws.onopen = () => setStreamState('live');
    ws.onclose = () => setStreamState('closed');
    ws.onerror = () => setStreamState('closed');
    return () => ws.close();
  }, [latest?.streamUrl]);

  const updateRow = (index: number, patch: Partial<MixerRow>) => {
    setRows((current) => current.map((row, i) => i === index ? { ...row, ...patch } : row));
  };

  const renderPreview = async () => {
    setBusy(true);
    try {
      const response = await fetch('http://localhost:8080/api/v1/comfy/mix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: activeTopic?.participants[0] ?? 'nyx-codex',
          prompt,
          aspectRatio: 'theater-card',
          traceId: activeTopicId ?? undefined,
          mixer: rows,
        }),
      });
      if (!response.ok) throw new Error(`comfy_mix_${response.status}`);
      const body = await response.json();
      recordComfyPreview({
        agentId: body.agentId,
        source: body.source,
        width: body.width,
        height: body.height,
        mimeType: body.mimeType,
        promptId: body.promptId,
        svg: body.svg,
        streamUrl: safeComfyStreamUrl(body.stream?.url),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-white/5 bg-black/20 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="w-4 h-4 text-command-accent" aria-hidden="true" />
          <span className="text-[10px] font-extrabold uppercase tracking-widest text-command-warm-white/55">
            LORA MIX
          </span>
        </div>
        <button
          type="button"
          onClick={renderPreview}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md border border-command-accent/40 bg-command-accent/10 px-2 py-1 text-[9px] font-extrabold uppercase tracking-widest text-command-accent transition hover:bg-command-accent/20 disabled:opacity-50"
        >
          <Zap className="w-3.5 h-3.5" aria-hidden="true" />
          {busy ? 'QUEUE' : 'RENDER'}
        </button>
      </div>

      <div className="mt-3 grid grid-cols-1 lg:grid-cols-[1fr_180px] gap-3">
        <div className="space-y-2">
          {rows.map((row, index) => (
            <div key={row.recipeId} className="grid grid-cols-[74px_1fr_1fr] items-center gap-2 text-[10px]">
              <span className="font-mono uppercase text-command-warm-white/50">{row.recipeId}</span>
              <label className="flex items-center gap-2 text-command-warm-white/40">
                <span className="w-9">STR</span>
                <input
                  aria-label={`${row.recipeId} strength`}
                  type="range"
                  min="0"
                  max="2"
                  step="0.05"
                  value={row.strength}
                  onChange={(event) => updateRow(index, { strength: Number(event.currentTarget.value) })}
                  className="w-full"
                />
              </label>
              <label className="flex items-center gap-2 text-command-warm-white/40">
                <span className="w-9">DEN</span>
                <input
                  aria-label={`${row.recipeId} denoise`}
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={row.denoise}
                  onChange={(event) => updateRow(index, { denoise: Number(event.currentTarget.value) })}
                  className="w-full"
                />
              </label>
            </div>
          ))}
        </div>

        <div className="min-h-24 rounded-lg border border-white/5 bg-black/30 overflow-hidden flex items-center justify-center">
          {latest?.svg ? (
            <img src={`data:image/svg+xml;utf8,${encodeURIComponent(latest.svg)}`} alt={`${latest.agentId} preview`} className="h-full w-full object-cover" />
          ) : (
            <div className="flex flex-col items-center gap-1 text-command-warm-white/25">
              <Image className="w-5 h-5" aria-hidden="true" />
              <span className="text-[9px] font-mono uppercase">{streamState}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
});

ComfyMixerPanel.displayName = 'ComfyMixerPanel';
export default ComfyMixerPanel;

function safeComfyStreamUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value, window.location.href);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return undefined;
    const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', window.location.hostname]);
    if (!allowedHosts.has(url.hostname)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
