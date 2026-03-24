import type { CollectMission, Entry, EntryType, ProcessMsg } from "@/src/cmd/commands";

export type UiMode = "play" | "create" | "edit" | "new_guide";
export type Judge = "Up" | "Down" | null;

export type StartupRouteKind =
  | "startup_unresolved"
  | "startup_probed_empty"
  | "startup_probed_nonempty"
  | "hydrated_empty"
  | "hydrated_playlists"
  | "hydrated_editing"
  | "startup_failed";

export interface StartupRouteResolution {
  kind: StartupRouteKind;
  routeResolved: boolean;
  mode: UiMode;
  phase: "unresolved" | "probed" | "hydrated";
}

export interface StartupRouteSnapshot {
  kind: StartupRouteKind;
}

export type DraftEntryOperationKind =
  | "link_review"
  | "folder_reload"
  | "weblist_update";

export interface DraftEntryOperationState {
  kind: DraftEntryOperationKind;
  key: string;
  inProgress: boolean;
  settled: "idle" | "succeeded" | "failed";
  ownerSessionId: number;
}

export interface DraftOperationTargetSnapshot {
  key: string;
  kind: DraftEntryOperationKind;
  ownerSessionId: number;
  inProgress: boolean;
  settled: "idle" | "succeeded" | "failed";
}

export type WebMaterializationPhase =
  | "pending"
  | "downloading"
  | "persisted"
  | "analyzing"
  | "ready"
  | "failed";

export interface WebMaterializationState {
  phase: WebMaterializationPhase;
  ownerSessionId: number;
  settled: "idle" | "succeeded" | "failed";
  lastError: string | null;
}

export interface MaterializationTargetSnapshot {
  playlistName: string;
  entryIdentity: string;
  ownerSessionId: number;
  phase: WebMaterializationPhase;
  settled: "idle" | "succeeded" | "failed";
  lastError: string | null;
}

export interface DraftLinkState {
  url: string;
  title_or_msg: string;
  entry_type: EntryType | "Unknown";
  count: number | null;
  status: "Ok" | "Err" | null;
  tracking: boolean;
  operation: DraftEntryOperationState | null;
}

export interface DraftMissionState extends Omit<CollectMission, "links"> {
  links: DraftLinkState[];
}

export type DraftOperationEntry = Entry & {
  draftOperation?: DraftEntryOperationState | null;
  materialization?: WebMaterializationState | null;
};

export interface MusicState {
  mode: UiMode;
  routeResolved: boolean;
  startupRoute: StartupRouteKind;
  loading: boolean;
  playlists: import("@/src/cmd/commands").Playlist[];
  /** @deprecated compatibility projection; use focusedListName or editingListName */
  selectedListName: string | null;
  focusedListName?: string | null;
  editingListName?: string | null;
  playbackListName: string | null;
  requestedPlaying: import("@/src/cmd/commands").Music | null;
  confirmedPlaying: import("@/src/cmd/commands").Music | null;
  nowPlaying: import("@/src/cmd/commands").Music | null;
  nowJudge: Judge;
  slot: DraftMissionState | null;
  processMsg: ProcessMsg | null;
  ytdlp: import("@/src/cmd/commands").InstallResult | null;
  ffmpeg: import("@/src/cmd/commands").InstallResult | null;
  savePath: string | null;
  entrySessionId: number;
  closureOwnerSessionId: number;
  playbackEpoch: number;
  playbackSessionId: number | null;
  playbackRequestedListName?: string | null;
}

export type ClosureEventPhase =
  | "deleted"
  | "saved"
  | "downloaded"
  | "analyzed"
  | "failed"
  | "notified"
  | "playback";

export interface ClosureEventContract {
  ownerSessionId: number;
  entryIdentity: string;
  phase: ClosureEventPhase;
  eventId: string;
}

export type ClosureProjectionState =
  | "blocked"
  | "pending_download"
  | "pending_analysis"
  | "notification_missing"
  | "ready"
  | "playable";

export interface ClosureProjection {
  state: ClosureProjectionState;
  playable: boolean;
  interactive: boolean;
  notificationVisible: boolean;
  notificationText: string | null;
  reason:
    | "no_live_owner_chain"
    | "notification_only_hint"
    | "awaiting_download"
    | "awaiting_analysis"
    | "awaiting_notification_projection"
    | "ready_without_playback"
    | "playback_confirmed";
}

export type ProcessHintKind =
  | "analysis"
  | "download"
  | "failure"
  | "generic";

export interface ProcessHintProjection {
  playlistName: string;
  text: string;
  kind: ProcessHintKind;
  assetPath: string | null;
  raw: ProcessMsg;
}

export type SaveAffordance = {
  allowed: boolean;
  visible: boolean;
  reason:
    | "missing_slot"
    | "missing_ffmpeg"
    | "missing_save_path"
    | "duplicate_name"
    | "invalid_mission"
    | "review_in_progress";
};

export type WorkspaceScreen =
  | "unresolved"
  | "guide"
  | "play"
  | "create"
  | "edit";

export interface SaveBoundaryOwnerContext {
  playlistName: string;
  entryIdentity: string | null;
  ownerSessionId: number;
}

export interface SaveBoundaryState {
  active: boolean;
  routeMode: UiMode;
  reconciled: boolean;
  source: "create" | "edit" | null;
  ownerContext: SaveBoundaryOwnerContext | null;
}
