import { useEffect, useMemo, useRef, useState } from "react";
import { crab } from "@/src/cmd/commandAdapter";
import type {
  AudioDebugSpectrogram,
  AudioDebugSpectrogramRequest,
  AudioState,
  Music,
} from "@/src/cmd/commands";
import { hook } from "@/src/flow/music";
import { derivePlaylistTargetLufs } from "@/src/flow/music/logic";

function playableTracksFromList(
  list: ReturnType<typeof hook.useCurList>,
): Music[] {
  if (!list) return [];
  const excluded = new Set(list.exclude.map((item) => item.path));
  return list.entries
    .flatMap((entry) => entry.musics)
    .filter((music) => !excluded.has(music.path));
}

function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (total % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function isAudioState(value: unknown): value is AudioState {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<AudioState>;
  const pathOk = v.path === null || typeof v.path === "string";
  return (
    pathOk &&
    typeof v.playing === "boolean" &&
    typeof v.paused === "boolean" &&
    typeof v.position_ms === "number" &&
    (v.duration_ms === null || typeof v.duration_ms === "number")
  );
}

export default function DevSpectrogramOverlay() {
  const isPlaying = hook.useIsPlaying();
  const curPlay = hook.useCurPlay();
  const curList = hook.useCurList();

  const [payload, setPayload] = useState<AudioDebugSpectrogram | null>(null);
  const [audioState, setAudioState] = useState<AudioState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqTokenRef = useRef(0);

  const tracks = useMemo(() => playableTracksFromList(curList), [curList]);
  const target = useMemo(() => derivePlaylistTargetLufs(tracks, -18), [tracks]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let disposed = false;
    const unlisten = crab.evt("audioState")((next: unknown) => {
      if (disposed || !isAudioState(next)) return;
      setAudioState(next);
    });

    return () => {
      disposed = true;
      void unlisten.then((fn: () => void) => fn()).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const timer = window.setInterval(() => {
      void crab.audioStatus().then((result) => {
        if (result.isErr()) return;
        setAudioState(result.unwrap());
      });
    }, 250);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (!isPlaying || !curPlay) {
      setPayload(null);
      setAudioState(null);
      setError(null);
      setLoading(false);
      return;
    }

    const token = ++reqTokenRef.current;
    const width = Math.max(960, Math.floor(window.innerWidth * 0.98));
    const height = Math.max(220, Math.floor(window.innerHeight * 0.46));
    const request: AudioDebugSpectrogramRequest = {
      path: curPlay.path,
      target_lufs: target,
      track_lufs: curPlay.avg_db ?? target,
      track_true_peak_dbtp: curPlay.true_peak_dbtp ?? null,
      width,
      height,
    };

    setLoading(true);
    setError(null);
    setPayload(null);

    void crab.audioDebugSpectrogram(request).then((result) => {
      if (token !== reqTokenRef.current) return;
      setLoading(false);
      if (result.isErr()) {
        setError(result.unwrap_err());
        return;
      }
      setPayload(result.unwrap());
    });
  }, [isPlaying, curPlay, target]);

  const durationMs = payload?.duration_ms ?? audioState?.duration_ms ?? null;
  const positionMs =
    curPlay && audioState?.path === curPlay.path
      ? Math.max(0, audioState.position_ms)
      : 0;
  const progressRatio =
    durationMs && durationMs > 0
      ? Math.min(1, Math.max(0, positionMs / durationMs))
      : null;

  if (!import.meta.env.DEV) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-40 overflow-hidden">
      <div className="absolute inset-0 bg-black/18" />
      {payload ? (
        <div className="absolute inset-0 grid grid-rows-2">
          <div className="relative overflow-hidden border-b border-white/25">
            <img
              src={payload.raw_data_url}
              alt="raw spectrogram"
              className="h-full w-full object-fill opacity-85"
            />
            <div className="absolute left-3 top-2 rounded bg-black/45 px-2 py-1 font-mono text-[11px] text-[#f5f5f5]">
              RAW
            </div>
          </div>
          <div className="relative overflow-hidden">
            <img
              src={payload.processed_data_url}
              alt="processed spectrogram"
              className="h-full w-full object-fill opacity-85"
            />
            <div className="absolute left-3 top-2 rounded bg-black/45 px-2 py-1 font-mono text-[11px] text-[#f5f5f5]">
              GAINED {payload.gain_db.toFixed(2)} dB
            </div>
          </div>
          {progressRatio !== null ? (
            <>
              <div
                className="absolute inset-y-0 z-20 w-[2px] bg-[#9be7ff] shadow-[0_0_12px_rgba(155,231,255,0.95)]"
                style={{
                  left: `calc(${(progressRatio * 100).toFixed(4)}% - 1px)`,
                }}
              />
              <div
                className="absolute top-8 z-20 -translate-x-1/2 rounded bg-black/55 px-2 py-1 font-mono text-[10px] text-[#e5f9ff]"
                style={{ left: `${(progressRatio * 100).toFixed(4)}%` }}
              >
                {formatMs(positionMs)} / {formatMs(durationMs ?? 0)}
              </div>
            </>
          ) : null}
          <div className="absolute right-3 top-2 rounded bg-black/45 px-2 py-1 font-mono text-[10px] text-[#f5f5f5]">
            DEV SPECTROGRAM MASK
          </div>
        </div>
      ) : null}
      {loading ? (
        <div className="absolute bottom-3 right-3 rounded bg-black/45 px-2 py-1 font-mono text-[10px] text-[#f5f5f5]">
          Rendering spectrogram...
        </div>
      ) : null}
      {error ? (
        <div className="absolute bottom-3 right-3 max-w-[48vw] rounded bg-[#7f1d1d]/80 px-2 py-1 font-mono text-[10px] text-[#fee2e2]">
          Spectrogram failed: {error}
        </div>
      ) : null}
    </div>
  );
}
