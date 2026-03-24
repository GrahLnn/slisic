import type { Entry, ProcessMsg } from "@/src/cmd/commands";
import type {
  ClosureEventContract,
  ClosureEventPhase,
  DraftEntryOperationKind,
  DraftEntryOperationState,
  DraftLinkState,
  DraftMissionState,
  DraftOperationEntry,
  WebMaterializationPhase,
  WebMaterializationState,
} from "./store.types";
import type { CollectMission, Playlist } from "@/src/cmd/commands";

export function createDraftOperation(
  kind: DraftEntryOperationKind,
  key: string,
  ownerSessionId: number,
): DraftEntryOperationState {
  return { kind, key, ownerSessionId, inProgress: true, settled: "idle" };
}

export function settleDraftOperation(
  operation: DraftEntryOperationState,
  settled: "succeeded" | "failed",
): DraftEntryOperationState {
  return { ...operation, inProgress: false, settled };
}

export function getDraftEntryOperation(entry: Entry): DraftEntryOperationState | null {
  return (entry as DraftOperationEntry).draftOperation ?? null;
}

export function getEntryMaterialization(entry: Entry): WebMaterializationState | null {
  return (entry as DraftOperationEntry).materialization ?? null;
}

export function setDraftEntryOperation(
  entry: Entry,
  operation: DraftEntryOperationState | null,
): Entry {
  const next: DraftOperationEntry = { ...(entry as DraftOperationEntry) };
  if (operation) next.draftOperation = operation;
  else delete next.draftOperation;
  return next;
}

export function setEntryMaterialization(
  entry: Entry,
  materialization: WebMaterializationState | null,
): Entry {
  const next: DraftOperationEntry = { ...(entry as DraftOperationEntry) };
  if (materialization) next.materialization = materialization;
  else delete next.materialization;
  return next;
}

export function setDraftLinkOperation(
  link: DraftLinkState,
  operation: DraftEntryOperationState | null,
): DraftLinkState {
  return { ...link, operation };
}

export function cloneEntryWithoutDraftOperation(entry: Entry): Entry {
  return setEntryMaterialization(setDraftEntryOperation(entry, null), null);
}

export function cloneLinkWithoutDraftOperation(link: DraftLinkState): DraftLinkState {
  return setDraftLinkOperation(link, null);
}

export function cloneMissionWithoutDraftOperations(
  mission: DraftMissionState,
): DraftMissionState {
  return {
    ...mission,
    entries: mission.entries.map(cloneEntryWithoutDraftOperation),
    links: mission.links.map(cloneLinkWithoutDraftOperation),
  };
}

export function deriveEntryIdentity(entry: Entry): string | null {
  return entry.url ?? entry.path ?? null;
}

export function derivePersistedOwnerMaterializationKey(entry: Entry): string | null {
  if (entry.url && entry.path) return `url-path:${entry.url}::${entry.path}`;
  if (entry.path) return `path:${entry.path}`;
  if (entry.url && entry.name) return `url-name:${entry.url}::${entry.name}`;
  if (entry.url) return `url:${entry.url}`;
  return null;
}

export function derivePersistedOwnerIdentity(entry: Entry): string | null {
  return derivePersistedOwnerMaterializationKey(entry);
}

export function deriveClosureOwnerIdentityFromMission(
  slot: CollectMission | null | undefined,
): string | null {
  if (!slot) return null;
  for (const entry of slot.entries) {
    const identity = derivePersistedOwnerIdentity(entry);
    if (identity) return identity;
  }
  return null;
}

export function deriveProcessMsgIdentityHint(hint: ProcessMsg): string | null {
  const prefix = "Analyzing loudness 1/1: ";
  if (!hint.str.startsWith(prefix)) return null;
  const assetPath = hint.str.slice(prefix.length).trim();
  if (assetPath.length === 0) return null;
  return `path:${assetPath}`;
}

export function deriveWebMaterializationPhase(entry: Entry): WebMaterializationPhase | null {
  if (entry.entry_type !== "WebList" && entry.entry_type !== "WebVideo") {
    return null;
  }
  if (entry.downloaded_ok !== true) {
    return entry.musics.length > 0 ? "downloading" : "pending";
  }
  const hasCanonicalReadyMusic = entry.musics.some(
    (music) =>
      music.normalization_status === "Ready" &&
      music.integrated_lufs != null &&
      music.analysis_version != null,
  );
  if (hasCanonicalReadyMusic) return "ready";
  const hasPersistedAnalysisIdentity = entry.musics.some(
    (music) =>
      music.analyzed_at_ms != null ||
      music.analysis_version != null ||
      music.integrated_lufs != null ||
      music.normalization_status === "Pending" ||
      music.normalization_status === "Ready" ||
      music.normalization_status === "Failed",
  );
  if (!hasPersistedAnalysisIdentity) {
    return entry.musics.length > 0 ? "persisted" : "downloading";
  }
  if (entry.musics.some((music) => music.normalization_status === "Failed")) {
    return "failed";
  }
  if (entry.musics.length === 0) return "downloading";
  const hasAnalyzingMusic = entry.musics.some(
    (music) =>
      music.normalization_status !== "Failed" &&
      (music.normalization_status === "Pending" ||
        music.integrated_lufs == null ||
        music.analysis_version == null),
  );
  return hasAnalyzingMusic ? "analyzing" : "persisted";
}

export function deriveEntryOwnedMaterialization(
  entry: Entry,
  ownerSessionId: number,
  lastError: string | null = null,
): WebMaterializationState | null {
  const phase = deriveWebMaterializationPhase(entry);
  if (!phase) return null;
  return {
    phase,
    ownerSessionId,
    settled:
      phase === "ready" || phase === "persisted" || phase === "analyzing"
        ? "succeeded"
        : phase === "failed"
          ? "failed"
          : "idle",
    lastError,
  };
}

export function syncEntryOwnedMaterialization(
  entry: Entry,
  ownerSessionId: number,
  lastError: string | null = null,
): Entry {
  return setEntryMaterialization(
    entry,
    deriveEntryOwnedMaterialization(entry, ownerSessionId, lastError),
  );
}

export function replaceEntryByIdentity(entries: Entry[], identity: string, next: Entry): Entry[] {
  let matched = false;
  const updatedEntries = entries.map((item) => {
    if (deriveEntryIdentity(item) !== identity) return item;
    matched = true;
    return next;
  });
  return matched ? updatedEntries : entries;
}

export function isEditingWorkspace(mode: string): boolean {
  return mode === "create" || mode === "edit";
}

export function setPlaylistEntryMaterializationByIdentity(
  playlists: Playlist[],
  playlistName: string,
  entryIdentity: string,
  ownerSessionId: number,
  materialization: WebMaterializationState | null,
): Playlist[] {
  return playlists.map((playlist) => {
    if (playlist.name !== playlistName) return playlist;
    let entryMatched = false;
    const entries = playlist.entries.map((entry) => {
      if (deriveEntryIdentity(entry) !== entryIdentity) return entry;
      const currentMaterialization = getEntryMaterialization(entry);
      if (currentMaterialization?.ownerSessionId !== ownerSessionId) return entry;
      entryMatched = true;
      return setEntryMaterialization(entry, materialization);
    });
    if (!entryMatched) return playlist;
    return { ...playlist, entries };
  });
}

export function carryForwardPersistedMaterializationOwnership(
  playlists: Playlist[],
  previousPlaylists: Playlist[],
  defaultOwnerSessionId: number,
): Playlist[] {
  return playlists.map((playlist) => {
    const previousPlaylist = previousPlaylists.find((item) => item.name === playlist.name);
    const previousMaterializationByOwnerIdentity = new Map<string, WebMaterializationState>();
    for (const entry of previousPlaylist?.entries ?? []) {
      const entryIdentity = derivePersistedOwnerIdentity(entry);
      const materialization = getEntryMaterialization(entry);
      if (!entryIdentity || !materialization) continue;
      previousMaterializationByOwnerIdentity.set(entryIdentity, materialization);
    }
    let changed = false;
    const entries = playlist.entries.map((entry) => {
      const entryIdentity = derivePersistedOwnerIdentity(entry);
      if (!entryIdentity) return entry;
      const previousMaterialization = previousMaterializationByOwnerIdentity.get(entryIdentity);
      const nextMaterialization = deriveEntryOwnedMaterialization(
        entry,
        previousMaterialization?.ownerSessionId ?? defaultOwnerSessionId,
        previousMaterialization?.lastError ?? null,
      );
      if (!nextMaterialization) return entry;
      if (!previousMaterialization) {
        changed = true;
        return setEntryMaterialization(entry, nextMaterialization);
      }
      if (
        nextMaterialization.ownerSessionId === previousMaterialization.ownerSessionId &&
        nextMaterialization.phase === previousMaterialization.phase &&
        nextMaterialization.settled === previousMaterialization.settled &&
        nextMaterialization.lastError === previousMaterialization.lastError
      ) {
        return setEntryMaterialization(entry, previousMaterialization);
      }
      changed = true;
      return setEntryMaterialization(entry, nextMaterialization);
    });
    if (!changed) {
      return previousPlaylist === playlist ? playlist : { ...playlist, entries };
    }
    return { ...playlist, entries };
  });
}

function buildClosureEventId(
  ownerSessionId: number,
  entryIdentity: string,
  phase: ClosureEventPhase,
): string {
  return `${ownerSessionId}:${entryIdentity}:${phase}`;
}

export function createClosureEventContract(
  ownerSessionId: number,
  entryIdentity: string,
  phase: ClosureEventPhase,
): ClosureEventContract {
  return {
    ownerSessionId,
    entryIdentity,
    phase,
    eventId: buildClosureEventId(ownerSessionId, entryIdentity, phase),
  };
}
