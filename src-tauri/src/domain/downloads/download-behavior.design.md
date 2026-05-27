# Download Behavior Design

## Behavior

The download system turns a user supplied collection URL into a stable playlist
collection on disk. It probes the root URL, projects it into a complete ordered
leaf plan, downloads each leaf into a scoped temporary artifact, commits each
artifact into its final collection-relative path, persists collection metadata,
and then removes the completed leaf from the resumable task record. The task row
keeps only residual work and diagnostic counters; completed music identity is
owned by the collection and its manifest.

## Participants

- `yt_dlp`: owns external probing and audio artifact creation.
- `collection_import`: owns collection identity, final file paths, music rows,
  manifests, and file moves from temporary to stable paths.
- `downloads::service`: owns task lifecycle, leaf scheduling, retry policy,
  recovery decisions, and terminal task status.
- `LeafPipelineState`: owns worker composition, ready queues, active counters,
  and future launch order.
- `LeafDownloadWindow`: owns adaptive download parallelism only.

## Core Invariants

- A playlist plan is complete or explicit failure. The system must not silently
  turn a partial root probe into a completed task.
- A leaf can be consumed as completed only after its audio file is committed to
  a stable collection-relative path and its music metadata is persisted.
- Completed music evidence is owned only by `Collection.musics` and the
  collection manifest. `DownloadTask.leafs` is residual work, not a history log.
- Resume must rebuild its plan from residual task leafs when they exist. It must
  not root-probe already materialized music to rediscover completed work.
- A temporary artifact is not a stable file. It can only be consumed by the leaf
  commit path that owns the matching leaf context.
- A leftover temporary artifact can be recovered only when the target is
  unambiguous. Ambiguous residue is rejected instead of guessing.
- Re-running the same task is idempotent: materialized leaves are absent from
  the residual queue, final files are reused only for still-residual leaves, and
  uncommitted temporary artifacts are either committed once or rejected
  explicitly.
- Download failures and post-download commit failures are leaf-local for list
  downloads. One failed leaf cannot stop the remaining leaf pipeline.
- Task terminal status is derived from residual failures plus consumed
  completion count. A task with unresolved non-terminal leaves cannot be marked
  `Completed`.
- Cache, existing files, and temporary residue are acceleration or recovery
  evidence only. They do not define playlist membership.

## Owned Invariants

`yt_dlp` owns:

- Root probe output reflects every entry the provider exposes for that playlist
  probe.
- Audio download success returns a readable local file path.

`collection_import` owns:

- Final relative paths stay inside the collection folder.
- The temporary marker is removed during finalization.
- File replacement is scoped to the target leaf URL and group.
- Manifest writes reflect persisted collection state.

`downloads::service` owns:

- Leaf identity is indexed by task, leaf URL, and group context.
- Active worker counters match worker events.
- Existing final files and residual temporary files are consumed through the
  same leaf completion semantics as fresh downloads.
- Completed leafs are garbage collected from the task row after collection
  persistence succeeds.
- Residual leafs carry the group context needed to resume without re-expanding a
  root playlist.
- Unresolved leaves are terminally rejected before task status is finalized.

`LeafDownloadWindow` owns:

- Future parallelism changes only from worker download outcomes.
- Manifest, metadata, and file move errors do not become scheduler signals.

## Stable Domains

`RawUrl -> NormalizedUrl`

- Owner: `downloads::service::normalize_url`.
- Total: no.
- Failure: explicit URL parse or unsupported-scheme error.

`RootProbe -> CollectionSyncPlan`

- Owner: `downloads::service::resolve_collection_plan`.
- Total: no.
- Failure: probe failure, empty downloadable list, or unsupported nested depth.

`ResidualDownloadTask -> CollectionSyncPlan`

- Owner: `downloads::service::residual_collection_plan`.
- Total: no.
- Failure: missing collection identity or collection folder on a residual task.
- Eliminates: root probe and manifest-to-completed-leaf reconstruction during
  resume.

`DownloadedTempFile -> CommittedLeafFile`

- Owner: `collection_import::finalize_downloaded_leaf`.
- Total: no.
- Failure: invalid path, blocked final path, failed remove, or failed move.

`ResidualTempFiles -> RecoverableLeafArtifact`

- Owner: `downloads::service`.
- Total: no.
- Failure: no file, partial artifact, or multiple matching temporary files.

## Transitions

Queued task + root probe success -> Resolving plan:

- Writes: task collection fields and leaf queue.
- Emits: persisted task snapshot.
- Rejection: root probe failure or empty downloadable collection.

Queued/failed/interrupted leaf + metadata success -> Prepared leaf:

- Writes: title, duration, chapter count.
- Emits: ready download entry or recovered completion.
- Rejection: leaf-local failed preparation.

Prepared leaf + fresh download success -> Commit leaf:

- Writes: stable file, music entries, manifest, and removes residual leaf.
- Emits: task change signal.
- Rejection: leaf-local failed download or failed commit.

Prepared leaf + existing final file -> Commit existing file:

- Writes: music entries, manifest, and removes residual leaf.
- Emits: task change signal.
- Rejection: metadata persistence failure.

Prepared leaf + unambiguous temp residue -> Commit recovered temp:

- Writes: stable file, music entries, manifest, and removes residual leaf.
- Emits: task change signal.
- Rejection: ambiguous residue or failed commit.

Pipeline drained -> Terminal task:

- Guard: no active workers, no ready downloads, no pending preparations.
- Writes: failed status for unresolved leaves, then task terminal status.
- Rejection: any unresolved leaf becomes explicit failed evidence.

## Checker Coverage

Focused tests must cover:

- Root playlist probe arguments request YouTube continuation pages.
- 116-entry YouTube playlists are not capped at the initial 100-entry page.
- Existing final files complete leaves without redownload.
- Completed leaves are removed from `DownloadTask.leafs`; the task row contains
  only residual work.
- Resume from residual task leafs does not root-probe completed music.
- Exact residual temp files are committed and removed.
- Cross-task residual temp files recover only when the stable title match is
  unique.
- Ambiguous residual temp files are rejected.
- A list commit failure marks only that leaf failed and later leaves still
  complete.
- Terminal task status cannot be `Completed` when unresolved leaves remain.

## Effects

- `YtDlpEffect`: external process execution, owned by `yt_dlp`.
- `FileCommitEffect`: remove, rename, and directory creation, owned by
  `collection_import`.
- `RepoEffect`: task and collection persistence, owned by repositories.
- `TraceEffect`: logs only. Removing trace must not change behavior.

## Exceptions

None.
