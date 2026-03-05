import type {
  CollectMission,
  Entry,
  EntryType,
  Music,
} from "@/src/cmd/commands";

export function inferEntryType(itemType: string): EntryType {
  if (itemType === "playlist") return "WebList";
  if (itemType === "video") return "WebVideo";
  return "Unknown";
}

export function isValidUrl(input: string): boolean {
  try {
    const parsed = new URL(input);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function sameTrack(
  a: Music | null | undefined,
  b: Music | null | undefined,
): boolean {
  return !!a && !!b && a.path === b.path;
}

export function computeLogit(music: Music): number {
  return (music.base_bias + music.fatigue) * (1 - music.user_boost);
}

export function sampleSoftMin(
  items: Music[],
  temperature = 0.8,
  rng: () => number = Math.random,
): Music | null {
  if (items.length === 0) return null;
  const invT = 1 / Math.max(temperature, 1e-6);
  const scaled = items.map((item) => -computeLogit(item) * invT);
  const max = Math.max(...scaled);
  const exps = scaled.map((value) => Math.exp(value - max));
  const sum = exps.reduce((acc, value) => acc + value, 0);

  let random = rng() * sum;
  for (let index = 0; index < exps.length; index += 1) {
    random -= exps[index];
    if (random <= 0) return items[index];
  }

  return items[items.length - 1];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];

  const pos = clamp(p, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const t = pos - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}

export function derivePlaylistTargetLufs(
  tracks: Music[],
  fallback = -18,
): number {
  const lufs = tracks
    .map((track) => track.avg_db)
    .filter((value): value is number => typeof value === "number")
    .filter((value) => Number.isFinite(value))
    .filter((value) => value >= -40 && value <= -6)
    .sort((a, b) => a - b);

  if (lufs.length === 0) {
    return fallback;
  }

  // Conservative baseline: use a lower quantile to avoid one-sided loud outliers
  // driving target upward and forcing unsafe boost on quieter items.
  const base = percentile(lufs, 0.35);
  return clamp(base, -21, -15.5);
}

export function avoidRecentlyPlayed(
  items: Music[],
  recentPaths: string[],
  windowSize: number,
): Music[] {
  if (items.length <= 1 || windowSize <= 0 || recentPaths.length === 0) {
    return items;
  }

  const blocked = new Set(recentPaths.slice(-windowSize));
  const filtered = items.filter((item) => !blocked.has(item.path));
  return filtered.length > 0 ? filtered : items;
}

export function pushRecentPath(
  recentPaths: string[],
  path: string,
  windowSize: number,
): string[] {
  if (windowSize <= 0) {
    return [];
  }

  const deduped = [...recentPaths.filter((item) => item !== path), path];
  return deduped.slice(-windowSize);
}

export function entryKey(entry: Entry): string {
  return entry.path ?? entry.url ?? entry.name;
}

export function canPersistMission(slot: CollectMission | null): {
  ok: boolean;
  reason?: string;
} {
  if (!slot) {
    return { ok: false, reason: "Playlist data is missing." };
  }

  if (!slot.name.trim()) {
    return { ok: false, reason: "Playlist name is required." };
  }

  if (slot.folders.length + slot.links.length + slot.entries.length === 0) {
    return {
      ok: false,
      reason: "Add at least one folder, link or entry before saving.",
    };
  }

  return { ok: true };
}
