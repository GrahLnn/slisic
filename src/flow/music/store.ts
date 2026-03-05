import { me } from "@grahlnn/fn";
import { sileo } from "sileo";
import { useSyncExternalStore } from "react";
import { Effect } from "effect";
import { crab } from "@/src/cmd";
import {
  type CollectMission,
  type Entry,
  type InstallResult,
  type LinkSample,
  type Music,
  type Playlist,
  type ProcessMsg,
} from "@/src/cmd/commands";
import {
  avoidRecentlyPlayed,
  canPersistMission,
  derivePlaylistTargetLufs,
  entryKey,
  inferEntryType,
  isValidUrl,
  pushRecentPath,
  sameTrack,
  sampleSoftMin,
} from "./logic";
import { PlaybackCoordinator } from "./playbackCoordinator";

type UiMode = "play" | "create" | "edit" | "new_guide";
type Judge = "Up" | "Down" | null;

export interface MusicState {
  mode: UiMode;
  loading: boolean;
  playlists: Playlist[];
  selectedListName: string | null;
  nowPlaying: Music | null;
  nowJudge: Judge;
  slot: CollectMission | null;
  processMsg: ProcessMsg | null;
  ytdlp: InstallResult | null;
  ffmpeg: InstallResult | null;
  savePath: string | null;
  initialized: boolean;
  linkReviews: string[];
  folderReviews: string[];
  weblistReviews: string[];
  playbackEpoch: number;
}

export function shouldAdvanceOnUnstar(
  snapshot: Pick<MusicState, "mode" | "selectedListName" | "nowPlaying">,
  listName: string,
  musicPath: string,
): boolean {
  return (
    snapshot.mode === "play" &&
    snapshot.selectedListName === listName &&
    snapshot.nowPlaying?.path === musicPath
  );
}

export function hasPlaybackContext(
  snapshot: Pick<MusicState, "mode" | "selectedListName" | "nowPlaying">,
): boolean {
  return (
    snapshot.mode === "play" &&
    (!!snapshot.selectedListName || !!snapshot.nowPlaying)
  );
}

export function shouldHandleAudioEnded(
  snapshot: Pick<MusicState, "mode" | "selectedListName" | "nowPlaying">,
  endedPath: string,
): boolean {
  return (
    snapshot.mode === "play" &&
    !!snapshot.selectedListName &&
    snapshot.nowPlaying?.path === endedPath
  );
}

export function deriveRefreshPatch(
  prev: Pick<MusicState, "mode" | "selectedListName" | "nowPlaying">,
  playlists: Playlist[],
): Pick<MusicState, "playlists" | "selectedListName" | "nowPlaying" | "mode"> {
  const selectedListName =
    prev.selectedListName &&
    playlists.some((playlist) => playlist.name === prev.selectedListName)
      ? prev.selectedListName
      : null;

  const mode: UiMode =
    prev.mode === "create" || prev.mode === "edit"
      ? prev.mode
      : playlists.length === 0
        ? "new_guide"
        : "play";

  return {
    playlists,
    selectedListName,
    nowPlaying: selectedListName ? prev.nowPlaying : null,
    mode,
  };
}

export function buildPostSavePatch(
  hasData: boolean,
  idleEpoch: number,
): Pick<
  MusicState,
  | "mode"
  | "selectedListName"
  | "nowPlaying"
  | "nowJudge"
  | "slot"
  | "processMsg"
  | "playbackEpoch"
> {
  return {
    mode: hasData ? "play" : "new_guide",
    selectedListName: null,
    nowPlaying: null,
    nowJudge: null,
    slot: null,
    processMsg: null,
    playbackEpoch: idleEpoch,
  };
}

function trimmedName(name: string): string {
  const v = name.trim();
  return v.length > 0 ? v : name;
}

export function buildOptimisticPlaylistFromSlot(
  slot: CollectMission,
  anchor?: Playlist | null,
): Playlist {
  return {
    name: trimmedName(slot.name),
    avg_db: anchor?.avg_db ?? null,
    entries: slot.entries,
    exclude: slot.exclude,
  };
}

export function applyOptimisticEditSave(
  playlists: Playlist[],
  anchor: Playlist,
  slot: CollectMission,
): Playlist[] {
  const next = buildOptimisticPlaylistFromSlot(slot, anchor);
  return playlists.map((playlist) =>
    playlist.name === anchor.name ? next : playlist,
  );
}

const initialState: MusicState = {
  mode: "play",
  loading: false,
  playlists: [],
  selectedListName: null,
  nowPlaying: null,
  nowJudge: null,
  slot: null,
  processMsg: null,
  ytdlp: null,
  ffmpeg: null,
  savePath: null,
  initialized: false,
  linkReviews: [],
  folderReviews: [],
  weblistReviews: [],
  playbackEpoch: 0,
};

const listeners = new Set<() => void>();
let state: MusicState = { ...initialState };
let started = false;
const unsubs: Array<() => void> = [];
const recentByList = new Map<string, string[]>();
const playback = new PlaybackCoordinator();

function recentWindowSize(trackCount: number): number {
  if (trackCount <= 1) return 0;
  return Math.min(3, trackCount - 1);
}

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

function setState(next: MusicState | ((prev: MusicState) => MusicState)) {
  state = typeof next === "function" ? next(state) : next;
  emit();
}

function patchState(patch: Partial<MusicState>) {
  setState((prev) => ({ ...prev, ...patch }));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getState() {
  return state;
}

function bumpPlaybackEpoch(): number {
  const epoch = playback.bumpEpoch();
  patchState({ playbackEpoch: epoch });
  return epoch;
}

function isPlaybackContextActive(epoch: number, expectedListName?: string) {
  return playback.isActive(epoch, getState(), expectedListName);
}

function addUnique(items: string[], value: string): string[] {
  return items.includes(value) ? items : [...items, value];
}

function removeValue(items: string[], value: string): string[] {
  return items.filter((item) => item !== value);
}

function hasReviewInProgress(snapshot: MusicState): boolean {
  return (
    snapshot.linkReviews.length > 0 ||
    snapshot.folderReviews.length > 0 ||
    snapshot.weblistReviews.length > 0
  );
}

function patchSlot(mutator: (slot: CollectMission) => CollectMission) {
  setState((prev) => {
    if (!prev.slot) return prev;
    return {
      ...prev,
      slot: mutator(prev.slot),
    };
  });
}

function defaultMission(): CollectMission {
  return {
    name: "",
    folders: [],
    links: [],
    entries: [],
    exclude: [],
  };
}

function missionFromPlaylist(playlist: Playlist): CollectMission {
  return {
    name: playlist.name,
    folders: [],
    links: [],
    entries: playlist.entries,
    exclude: playlist.exclude,
  };
}

function currentList(input = state): Playlist | null {
  if (!input.selectedListName) return null;
  return (
    input.playlists.find(
      (playlist) => playlist.name === input.selectedListName,
    ) ?? null
  );
}

function playableTracks(list: Playlist): Music[] {
  const excluded = new Set(list.exclude.map((item) => item.path));
  return list.entries
    .flatMap((entry) => entry.musics)
    .filter((music) => !excluded.has(music.path));
}

function updateMusicEverywhere(path: string, updater: (music: Music) => Music) {
  setState((prev) => {
    const playlists = prev.playlists.map((playlist) => ({
      ...playlist,
      exclude: playlist.exclude.map((music) =>
        music.path === path ? updater(music) : music,
      ),
      entries: playlist.entries.map((entry) => ({
        ...entry,
        musics: entry.musics.map((music) =>
          music.path === path ? updater(music) : music,
        ),
      })),
    }));

    const nowPlaying =
      prev.nowPlaying?.path === path
        ? updater(prev.nowPlaying)
        : prev.nowPlaying;

    return {
      ...prev,
      playlists,
      nowPlaying,
    };
  });
}

async function applyNextFatigue(music: Music | null | undefined) {
  if (!music) return;
  const result = await crab.fatigue(music);
  if (result.isErr()) return;
  updateMusicEverywhere(music.path, (item) => ({
    ...item,
    fatigue: item.fatigue + 0.1,
  }));
}

async function refreshLists() {
  const result = await crab.readAll();
  if (result.isErr()) {
    throw new Error(result.unwrap_err());
  }

  const playlists = result.unwrap();
  const validNames = new Set(playlists.map((playlist) => playlist.name));
  for (const name of recentByList.keys()) {
    if (!validNames.has(name)) {
      recentByList.delete(name);
    }
  }

  setState((prev) => ({
    ...prev,
    ...deriveRefreshPatch(prev, playlists),
  }));
}

async function refreshTools() {
  const [ytdlp, ffmpeg, savePath] = await Promise.all([
    crab.checkExists(),
    crab.ffmpegCheckExists(),
    crab.resolveSavePath(),
  ]);

  patchState({
    ytdlp: ytdlp.isErr() ? null : (ytdlp.unwrap() ?? null),
    ffmpeg: ffmpeg.isErr() ? null : (ffmpeg.unwrap() ?? null),
    savePath: savePath.isErr() ? null : savePath.unwrap(),
  });
}

function chooseAndPlayNextTask(epoch: number): Effect.Effect<void> {
  return Effect.gen(function* () {
    const snapshot = getState();
    const list = currentList(snapshot);
    if (!list) return;
    if (!isPlaybackContextActive(epoch, list.name)) return;

    const all = playableTracks(list);
    if (all.length === 0) {
      yield* Effect.sync(() =>
        patchState({ nowPlaying: null, nowJudge: null }),
      );
      return;
    }

    const pool = snapshot.nowPlaying
      ? all.filter((music) => !sameTrack(music, snapshot.nowPlaying))
      : all;
    const base = pool.length > 0 ? pool : all;
    const recent = recentByList.get(list.name) ?? [];
    const filtered = avoidRecentlyPlayed(
      base,
      recent,
      recentWindowSize(all.length),
    );
    const candidates = filtered.length > 0 ? filtered : base;
    const chosen = sampleSoftMin(candidates, 0.8);
    if (!chosen) return;
    if (!isPlaybackContextActive(epoch, list.name)) return;

    const target = derivePlaylistTargetLufs(all, -18);
    const track = chosen.avg_db ?? target;
    const truePeak = chosen.true_peak_dbtp ?? null;

    const playResult = yield* Effect.promise(() =>
      crab.audioPlay({
        path: chosen.path,
        target_lufs: target,
        track_lufs: track,
        track_true_peak_dbtp: truePeak,
      }),
    );

    if (!isPlaybackContextActive(epoch, list.name)) return;

    if (playResult.isErr()) {
      yield* Effect.sync(() => {
        sileo.error({
          title: "Play failed",
          description: playResult.unwrap_err(),
        });
      });
      return;
    }

    yield* Effect.sync(() => {
      if (!isPlaybackContextActive(epoch, list.name)) return;
      patchState({ nowPlaying: chosen, nowJudge: null });
      recentByList.set(
        list.name,
        pushRecentPath(recent, chosen.path, recentWindowSize(all.length)),
      );
    });
  });
}

function scheduleNextPlayback(epoch: number) {
  playback.replaceWith(chooseAndPlayNextTask(epoch), epoch);
}

async function ensureEvents() {
  if (started) return;
  started = true;

  const audioEnded = await crab.evt("audioEnded")((payload) => {
    const path =
      payload &&
      typeof payload === "object" &&
      "path" in payload &&
      typeof (payload as { path?: unknown }).path === "string"
        ? (payload as { path: string }).path
        : null;
    if (!path) return;
    const snapshot = getState();
    if (!shouldHandleAudioEnded(snapshot, path)) return;
    void applyNextFatigue(snapshot.nowPlaying);
    const epoch = bumpPlaybackEpoch();
    scheduleNextPlayback(epoch);
  });
  unsubs.push(audioEnded);

  const processMsg = await crab.evt("processMsg")((payload) => {
    patchState({ processMsg: payload as ProcessMsg });
  });
  unsubs.push(processMsg);

  const processResult = await crab.evt("processResult")(async () => {
    await refreshLists();
    patchState({ processMsg: null });
  });
  unsubs.push(processResult);

  const ytdlpChanged = await crab.evt("ytdlpVersionChanged")(async () => {
    await refreshTools();
  });
  unsubs.push(ytdlpChanged);
}

async function safeStop() {
  const snapshot = getState();
  const hadPlayback = hasPlaybackContext(snapshot);
  bumpPlaybackEpoch();
  patchState({
    selectedListName: null,
    nowPlaying: null,
    nowJudge: null,
  });
  await playback.interruptCurrent();
  const stopped = await crab.audioStop();
  if (hadPlayback && stopped.isErr()) {
    sileo.error({
      title: "Stop failed",
      description: stopped.unwrap_err(),
    });
  }
}

async function startPlayByList(name: string) {
  const snapshot = getState();
  if (snapshot.selectedListName === name && snapshot.nowPlaying) {
    await safeStop();
    return;
  }

  patchState({
    selectedListName: name,
    mode: "play",
    nowJudge: null,
  });
  const epoch = bumpPlaybackEpoch();
  scheduleNextPlayback(epoch);
}

async function persistSlot() {
  const snapshot = getState();
  if (hasReviewInProgress(snapshot)) {
    sileo.error({
      title: "Please wait",
      description: "Background checks are still running.",
    });
    return;
  }

  const check = canPersistMission(snapshot.slot);
  if (!check.ok) {
    sileo.error({
      title: "Cannot save",
      description: check.reason,
    });
    return;
  }

  const slot = snapshot.slot;
  if (!slot) return;

  if (snapshot.mode === "edit") {
    const anchor = snapshot.playlists.find(
      (playlist) => playlist.name === snapshot.selectedListName,
    );
    if (!anchor) {
      throw new Error("selected playlist missing");
    }

    const optimisticPlaylists = applyOptimisticEditSave(
      snapshot.playlists,
      anchor,
      slot,
    );
    const idleEpoch = bumpPlaybackEpoch();
    void playback.interruptCurrent();
    patchState({
      ...buildPostSavePatch(optimisticPlaylists.length > 0, idleEpoch),
      playlists: optimisticPlaylists,
      loading: false,
    });

    void (async () => {
      const result = await crab.update(slot, anchor);
      if (result.isErr()) {
        sileo.error({
          title: "Save failed",
          description: result.unwrap_err(),
        });
        await refreshLists();
        return;
      }
      await refreshLists();
      sileo.success({ title: "Playlist saved" });
    })();
    return;
  }

  patchState({ loading: true });
  try {
    const result = await crab.create(slot);
    if (result.isErr()) throw new Error(result.unwrap_err());
    const idleEpoch = bumpPlaybackEpoch();
    await playback.interruptCurrent();
    await refreshLists();
    patchState(buildPostSavePatch(getState().playlists.length > 0, idleEpoch));
    sileo.success({ title: "Playlist saved" });
  } finally {
    patchState({ loading: false });
  }
}

export const action = {
  async run() {
    playback.markActive();
    patchState({ loading: true });
    try {
      await ensureEvents();
      await crab.appReady();
      await Promise.all([refreshLists(), refreshTools()]);
      patchState({ initialized: true });
    } catch (error) {
      sileo.error({
        title: "Initialization failed",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      patchState({ loading: false });
    }
  },
  async next() {
    const snapshot = getState();
    if (snapshot.mode !== "play" || !snapshot.selectedListName) return;
    await applyNextFatigue(snapshot.nowPlaying);
    const epoch = bumpPlaybackEpoch();
    scheduleNextPlayback(epoch);
  },
  async resetLogits() {
    const result = await crab.resetLogits();
    if (result.isErr()) {
      sileo.error({
        title: "Reset failed",
        description: result.unwrap_err(),
      });
      return;
    }

    await refreshLists();
    sileo.success({ title: "Logits reset" });
  },
  async play(playlist: Playlist) {
    await startPlayByList(playlist.name);
  },
  async delete(playlist: Playlist) {
    const result = await crab.delete(playlist.name);
    if (result.isErr()) {
      sileo.error({
        title: "Delete failed",
        description: result.unwrap_err(),
      });
      return;
    }

    if (getState().selectedListName === playlist.name) {
      await safeStop();
    }
    await refreshLists();
  },
  async addNew() {
    await safeStop();
    patchState({
      mode: "create",
      slot: defaultMission(),
      selectedListName: null,
      nowJudge: null,
      processMsg: null,
      linkReviews: [],
      folderReviews: [],
      weblistReviews: [],
    });
  },
  async edit(playlist: Playlist) {
    await safeStop();
    patchState({
      mode: "edit",
      slot: missionFromPlaylist(playlist),
      selectedListName: playlist.name,
      nowJudge: null,
      processMsg: null,
      linkReviews: [],
      folderReviews: [],
      weblistReviews: [],
    });
  },
  async back() {
    const snapshot = getState();
    if (hasReviewInProgress(snapshot)) {
      return;
    }

    await safeStop();

    const hasData = snapshot.playlists.length > 0;
    patchState({
      mode: hasData ? "play" : "new_guide",
      slot: null,
      processMsg: null,
      linkReviews: [],
      folderReviews: [],
      weblistReviews: [],
    });
  },
  setSlot(slot: CollectMission) {
    patchState({ slot });
  },
  async save() {
    await persistSlot();
  },
  async addFolder(path: string) {
    const snapshot = getState();
    if (!snapshot.slot) return;
    if (!path || snapshot.slot.folders.some((folder) => folder.path === path)) {
      return;
    }

    const result = await crab.allAudioRecursive(path);
    if (result.isErr()) {
      sileo.error({
        title: "Folder scan failed",
        description: result.unwrap_err(),
      });
      return;
    }

    const items = result.unwrap();
    patchSlot((slot) => ({
      ...slot,
      folders: [...slot.folders, { path, items }],
    }));
  },
  removeFolder(path: string) {
    patchSlot((slot) => ({
      ...slot,
      folders: slot.folders.filter((folder) => folder.path !== path),
    }));
  },
  async addLink(url: string) {
    const snapshot = getState();
    if (!snapshot.slot) return;

    const value = url.trim();
    if (!isValidUrl(value)) {
      sileo.error({ title: "Invalid URL" });
      return;
    }

    if (snapshot.slot.links.some((link) => link.url === value)) {
      return;
    }

    const pendingLink: LinkSample = {
      url: value,
      title_or_msg: "Detecting...",
      entry_type: "Unknown",
      count: null,
      status: null,
      tracking: false,
    };

    setState((prev) => {
      if (!prev.slot) return prev;
      return {
        ...prev,
        slot: {
          ...prev.slot,
          links: [...prev.slot.links, pendingLink],
        },
        linkReviews: addUnique(prev.linkReviews, value),
      };
    });

    const media = await crab.lookMedia(value);
    setState((prev) => {
      if (!prev.slot) {
        return {
          ...prev,
          linkReviews: removeValue(prev.linkReviews, value),
        };
      }

      const links = prev.slot.links.map((link) => {
        if (link.url !== value) return link;
        if (media.isErr()) {
          return {
            ...link,
            title_or_msg: media.unwrap_err(),
            status: "Err" as const,
          };
        }

        const info = media.unwrap();
        return {
          ...link,
          title_or_msg: info.title,
          entry_type: inferEntryType(info.item_type),
          count: info.entries_count,
          status: "Ok" as const,
        };
      });

      return {
        ...prev,
        slot: {
          ...prev.slot,
          links,
        },
        linkReviews: removeValue(prev.linkReviews, value),
      };
    });
  },
  removeLink(url: string) {
    setState((prev) => {
      if (!prev.slot) return prev;
      return {
        ...prev,
        slot: {
          ...prev.slot,
          links: prev.slot.links.filter((link) => link.url !== url),
        },
        linkReviews: removeValue(prev.linkReviews, url),
      };
    });
  },
  toggleLinkTracking(url: string) {
    patchSlot((slot) => ({
      ...slot,
      links: slot.links.map((link) =>
        link.url === url ? { ...link, tracking: !link.tracking } : link,
      ),
    }));
  },
  addExistingEntry(entry: Entry) {
    patchSlot((slot) => {
      const key = entryKey(entry);
      const exists = slot.entries.some((item) => entryKey(item) === key);
      if (exists) return slot;
      return {
        ...slot,
        entries: [entry, ...slot.entries],
      };
    });
  },
  removeEntry(entry: Entry) {
    const key = entryKey(entry);
    patchSlot((slot) => ({
      ...slot,
      entries: slot.entries.filter((item) => entryKey(item) !== key),
    }));
  },
  removeExclude(path: string) {
    patchSlot((slot) => ({
      ...slot,
      exclude: slot.exclude.filter((item) => item.path !== path),
    }));
  },
  async reloadEntry(entry: Entry) {
    if (!entry.path) return;

    const key = entry.path;
    setState((prev) => ({
      ...prev,
      folderReviews: addUnique(prev.folderReviews, key),
    }));

    const result = await crab.recheckFolder(entry);
    if (result.isErr()) {
      setState((prev) => ({
        ...prev,
        folderReviews: removeValue(prev.folderReviews, key),
      }));
      sileo.error({
        title: "Reload failed",
        description: result.unwrap_err(),
      });
      return;
    }

    const next = result.unwrap();
    setState((prev) => {
      if (!prev.slot) {
        return {
          ...prev,
          folderReviews: removeValue(prev.folderReviews, key),
        };
      }

      return {
        ...prev,
        slot: {
          ...prev.slot,
          entries: prev.slot.entries.map((item) =>
            item.path === next.path ? next : item,
          ),
        },
        folderReviews: removeValue(prev.folderReviews, key),
      };
    });
  },
  async updateWeblist(entry: Entry) {
    const snapshot = getState();
    const playlist = snapshot.selectedListName;
    if (!playlist || !entry.url) return;

    const key = entry.url;
    setState((prev) => ({
      ...prev,
      weblistReviews: addUnique(prev.weblistReviews, key),
    }));

    const result = await crab.updateWeblist(entry, playlist);
    if (result.isErr()) {
      setState((prev) => ({
        ...prev,
        weblistReviews: removeValue(prev.weblistReviews, key),
      }));
      sileo.error({
        title: "Update failed",
        description: result.unwrap_err(),
      });
      return;
    }

    const next = result.unwrap();
    setState((prev) => {
      if (!prev.slot) {
        return {
          ...prev,
          weblistReviews: removeValue(prev.weblistReviews, key),
        };
      }

      return {
        ...prev,
        slot: {
          ...prev.slot,
          entries: prev.slot.entries.map((item) =>
            item.path === next.path ? next : item,
          ),
        },
        weblistReviews: removeValue(prev.weblistReviews, key),
      };
    });
  },
  async up(music: Music) {
    const result = await crab.boost(music);
    if (result.isErr()) return;

    updateMusicEverywhere(music.path, (item) => ({
      ...item,
      user_boost: Math.min(0.9, Math.round((item.user_boost + 0.1) * 10) / 10),
    }));
    patchState({ nowJudge: "Up" });
  },
  async down(music: Music) {
    const result = await crab.fatigue(music);
    if (result.isErr()) return;

    updateMusicEverywhere(music.path, (item) => ({
      ...item,
      fatigue: item.fatigue + 0.1,
      user_boost: Math.max(0, Math.round((item.user_boost - 0.1) * 10) / 10),
    }));
    patchState({ nowJudge: "Down" });
  },
  async cancleUp(music: Music) {
    const result = await crab.cancleBoost(music);
    if (result.isErr()) return;

    updateMusicEverywhere(music.path, (item) => ({
      ...item,
      user_boost: Math.max(0, Math.round((item.user_boost - 0.1) * 10) / 10),
    }));
    patchState({ nowJudge: null });
  },
  async cancleDown(music: Music) {
    const result = await crab.cancleFatigue(music);
    if (result.isErr()) return;

    updateMusicEverywhere(music.path, (item) => ({
      ...item,
      fatigue: Math.max(0, item.fatigue - 0.1),
    }));
    patchState({ nowJudge: null });
  },
  async unstar(music: Music) {
    const list = currentList();
    if (!list) return;

    const snapshot = getState();
    const shouldSwitch = shouldAdvanceOnUnstar(snapshot, list.name, music.path);
    const epoch = bumpPlaybackEpoch();

    setState((prev) => ({
      ...prev,
      playlists: prev.playlists.map((playlist) =>
        playlist.name === list.name
          ? {
              ...playlist,
              exclude: playlist.exclude.some((item) => item.path === music.path)
                ? playlist.exclude
                : [...playlist.exclude, music],
            }
          : playlist,
      ),
      nowPlaying:
        prev.nowPlaying && prev.nowPlaying.path === music.path
          ? null
          : prev.nowPlaying,
      nowJudge: null,
      playbackEpoch: epoch,
    }));

    await playback.interruptCurrent();
    const stopped = await crab.audioStop();
    if (stopped.isErr()) {
      sileo.error({
        title: "Stop failed",
        description: stopped.unwrap_err(),
      });
    }

    // Keep playback continuous: schedule the next track immediately after stop.
    if (shouldSwitch && isPlaybackContextActive(epoch, list.name)) {
      scheduleNextPlayback(epoch);
    }

    const result = await crab.unstar(list, music);
    if (result.isErr()) {
      sileo.error({
        title: "Unstar failed",
        description: result.unwrap_err(),
      });
      await refreshLists();
      return;
    }
  },
  async installYtdlp() {
    const result = await crab.ytdlpDownloadAndInstall();
    if (result.isErr()) {
      sileo.error({
        title: "Install yt-dlp failed",
        description: result.unwrap_err(),
      });
      return;
    }

    patchState({ ytdlp: result.unwrap() });
    sileo.success({ title: "yt-dlp installed" });
  },
  async installFfmpeg() {
    const result = await crab.ffmpegDownloadAndInstall();
    if (result.isErr()) {
      sileo.error({
        title: "Install ffmpeg failed",
        description: result.unwrap_err(),
      });
      return;
    }

    patchState({ ffmpeg: result.unwrap() });
    sileo.success({ title: "ffmpeg installed" });
  },
  async updateSavePath(path: string) {
    const result = await crab.updateSavePath(path);
    if (result.isErr()) {
      sileo.error({
        title: "Save path update failed",
        description: result.unwrap_err(),
      });
      return;
    }

    patchState({ savePath: path });
  },
  async dispose() {
    playback.markDisposed();
    patchState({ playbackEpoch: playback.getEpoch() });
    await playback.interruptCurrent();
    for (const unsub of unsubs.splice(0)) {
      unsub();
    }
    started = false;
  },
};

function useMusicSelector<T>(selector: (state: MusicState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(getState()),
    () => selector(getState()),
  );
}

const MODE = {
  play: me<UiMode>("play"),
  create: me<UiMode>("create"),
  edit: me<UiMode>("edit"),
  new_guide: me<UiMode>("new_guide"),
} as const;

export const hook = {
  useState: () =>
    useMusicSelector((snapshot) =>
      snapshot.mode === "play"
        ? MODE.play
        : snapshot.mode === "create"
          ? MODE.create
          : snapshot.mode === "edit"
            ? MODE.edit
            : MODE.new_guide,
    ),
  useContext: () => useMusicSelector((snapshot) => snapshot),
  useList: () => useMusicSelector((snapshot) => snapshot.playlists),
  useCurPlay: () => useMusicSelector((snapshot) => snapshot.nowPlaying),
  useCurList: () =>
    useMusicSelector((snapshot) =>
      snapshot.selectedListName
        ? (snapshot.playlists.find(
            (playlist) => playlist.name === snapshot.selectedListName,
          ) ?? null)
        : null,
    ),
  useSlot: () => useMusicSelector((snapshot) => snapshot.slot),
  useMsg: () => useMusicSelector((snapshot) => snapshot.processMsg),
  useJudge: () => useMusicSelector((snapshot) => snapshot.nowJudge),
  useIsPlaying: () =>
    useMusicSelector(
      (snapshot) => !!snapshot.selectedListName && !!snapshot.nowPlaying,
    ),
  useIsReview: () =>
    useMusicSelector(
      (snapshot) =>
        snapshot.linkReviews.length > 0 ||
        snapshot.folderReviews.length > 0 ||
        snapshot.weblistReviews.length > 0,
    ),
  useAllReview: () => useMusicSelector((snapshot) => snapshot.linkReviews),
  useAllFolderReview: () =>
    useMusicSelector((snapshot) => snapshot.folderReviews),
  useAllWeblistReview: () =>
    useMusicSelector((snapshot) => snapshot.weblistReviews),
};
