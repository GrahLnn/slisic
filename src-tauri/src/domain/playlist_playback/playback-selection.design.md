# Playlist Playback Selection

## Behavior

Playlist playback turns a committed playlist row into a running playback session.
The user action supplies only the playlist name. The backend owns track
selection, queue planning, recommendation fallback, refresh, and cancellation.

## Participants

- `playlists::repo` owns playlist selection projection and raw source projection
  inside the selected playlist scope.
- `playlist_playback::playable_index` owns process-lifetime playable-source
  preparation, generation-stamped refresh, invalidation, and the current
  centerless prepared startup option for each playlist.
- `playlist_playback::service` owns first-track source elimination, next-track
  planning, startup queue composition, recent-history exclusion, and queue
  refresh.
- `playlist_playback::recommendation` owns audio-style ranking for an already
  materialized candidate universe.
- `player::service` owns playback lifecycle, active request identity, queue
  consumption, and process control.
- `player::strategy` owns only consumption of the queue it is given. It does not
  load playlist records and does not widen the candidate universe.

## Core Invariants

- The playlist row is the only source of playlist membership.
- Startup candidate preparation runs before click through the playable-source
  index. Program startup, ready, library, playlist, exclude, playback miss, and
  prepared-source consumption are the only scheduling inputs. The play action
  consumes prepared evidence; it does not own first-track preparation.
- The player-submit success path consumes the current prepared option by
  playlist and generation. Consumption immediately schedules replacement
  preparation for that playlist.
- First-track preparation chooses a centerless audio-style startup anchor from
  the playlist scope when a stable model exists. If no stable model exists
  during cold start, it prepares a playlist-scoped repository random source in
  the same backend first-slot pool.
- Startup next-track selection is part of the post-acceptance backend queue
  fill transaction. Once the centerless first-track anchor is accepted by the
  player session, the recommendation planner must be invoked in the background.
- Later next-track selection is owned by the recommendation planner and uses
  the playlist-scoped candidate universe.
- The first track is not derived from a deterministic seed, first row, first
  collection, or fixed random seed.
- Centerless startup sampling uses the stable published audio-style model
  inside the playlist scope. Its draw is live per prepared-source refresh and
  must not persist a seeded order across sessions. The repository random
  projection is allowed only when no stable model exists; it is cold-start
  preparation, not click-path fallback.
- The playable index prepares at most one startup option per playlist in the
  background; it cannot define whether a source is a playlist member or whether
  a local file is actually playable.
- Ready, startup, playback-miss, and prepared-source-consumed refreshes fill a
  missing prepared startup option; they do not replace an unconsumed option.
- Queue refresh may reduce latency, fill later continuations, or improve
  recommendation quality, but it must not change playlist membership.
- Queue refresh is driven by anchor consumption or a missing next track. Model
  generation changes, download changes, and repeated ready transitions may
  improve future inputs, but must not replace an already prepared unconsumed
  next track for the same anchor.
- Cache and trace do not construct playable tracks and do not decide fallback.
- The player consumes an explicit queue and never queries playlist membership.
- A late queue refresh for a superseded session is discarded by the session
  owner before it can modify the active queue.
- Repeated refreshes may replace the prepared next track, but they may not create
  duplicate semantic side effects or widen scope outside the playlist.
- Download, local-import, or recovery paths that persist playable `Music` must
  notify the playable-source index after the database write succeeds.

## Owned Invariants

`playlists::repo` owns:

- Playlist rows project to `PlaylistPlaybackSelection`.
- Raw source projection stays inside selected `collections`, `groups`, and
  `extra`.
- Collection and group sampling uses lightweight owner refs; `extra` is one
  explicit owner domain whose member music refs are sampled only after that
  domain is selected.
- Excluded music identities are filtered before a raw source is returned.

`playlist_playback::playable_index` owns:

- Startup and ready-time refresh scheduling.
- Generation-stamped snapshot commits and stale refresh rejection.
- Current prepared source lookup for first-track startup.
- Prepared startup source consumption by playlist and generation. Consumption
  removes only that playlist snapshot and schedules replacement preparation.
- Non-invalidating refreshes fill only absent startup options. Playlist,
  library, and exclude invalidation may replace existing startup options because
  membership or availability changed.
- Invalidation signals after playlist, library, and exclude changes.

`playlist_playback::service` owns:

- Raw sources become `PlaybackTrack` only after their file path is resolved
  against the save root and the file exists.
- Startup options are sampled by centerless audio-style selection inside the
  whole playlist scope, not from a deterministic prefix of one collection.
- Startup queue composition is `[centerless first]`. It is a fast handoff from
  prepared first-track evidence to `player`, not a recommendation planning
  point.
- Existing unconsumed next-track work is linear. The same anchor keeps its
  current queue until the player consumes it or the queue no longer contains a
  next track.
- Download-completion refresh observes the same rule as periodic queue fill:
  newly available candidates are not allowed to replace an unconsumed next track
  for the same anchor.
- The first continuation queue is produced by the recommendation path
  immediately after playback starts. Queue planning must use the newest
  published model that can rank the current anchor; a newer in-progress model
  that does not cover the anchor must not block a completed older model from
  serving the queue.
- If no stable model can rank the current anchor in `KeepCurrent` mode, the
  queue planner uses the already materialized playlist-scoped SQL random
  candidate window to compose `[current, random_next]`.
- `KeepCurrent` accepts only `audio_style` selection evidence as a complete
  audio-style recommendation. Service-owned SQL random fallback is a separate
  queue-planning degradation path, not audio-style evidence.
- Random recovery is also allowed for `ExcludeCurrent`, where the current track
  has been explicitly removed and the system needs a replacement candidate.
- Recent history filters non-liked tracks without deleting liked tracks.

`playlist_playback::recommendation` owns:

- Audio-style probabilities for an already materialized candidate window.
- Fallback selection metadata when the model cannot rank candidates.
- The double-buffered model lifecycle: `stable` serves playback and first-slot
  reads; `nightly` receives progressive training output; completed `nightly`
  snapshots replace `stable` atomically and then notify first-slot preparation.

`player::service` owns:

- Session generation checks.
- Active request track identity.
- Ordered consumption of a prepared queue.
- Cancellation and late result rejection.
- Track-boundary queue exhaustion reporting. It does not wait for ordered queue
  supply as a normal continuation path; the upstream playlist playback owner
  must provide the continuation before the boundary is reached.

## Stable Domains

`RawPlaylistSource -> PlayablePlaylistTrack`

- Owner: `playlist_playback::service`.
- Total: no.
- Failure: missing path, missing file, duplicate source, excluded current track,
  or no source inside the selected playlist.
- Idempotence: projecting the same raw source under the same save root gives the
  same playable track or the same absence reason.
- Evidence: the resulting `PlaybackTrack` carries playlist name, canonical music
  id, resolved file path, source music, range, and liked state.

`PreparedPlayableSource -> StartupSourceOption`

- Owner: `playlist_playback::playable_index`.
- Total: no.
- Failure: missing snapshot is an index miss; it schedules refresh but does not
  create a click-path fallback source.
- Idempotence: repeated non-invalidating refresh of the same repo projection
  does not replace an unconsumed snapshot. Invalidating refresh may replace the
  snapshot because playlist membership, library availability, or exclude state
  changed.
- Evidence: each snapshot carries playlist name, generation, and at most one raw
  source evidence value projected by `playlists::repo`, either selected through
  stable audio-style centerless sampling or through cold-start repository random
  projection when stable is absent.

## Transitions

`ReadyPlaylist -> PlayingSession`

- Source state: frontend app logic has a ready playlist name.
- Command: `play_playlist(name)`.
- Guard: playlist exists and a playable first-track anchor can be consumed from
  the prepared index snapshot.
- Writes: first-track startup queue and active playback request.
- Emits: diagnostic trace, index hit/miss trace, prepared-source consumption
  signal, and now-playing events.
- Target state: active playback session.
- Rejection: missing playlist, missing prepared startup evidence, no playable
  track, superseded request, or player submit failure. Rejected startup does not
  consume a prepared source.

`PreparedStartupSource(first) -> StartupQueue(first)`

- Source state: a generation-stamped prepared startup source has resolved to a
  playable first-track anchor.
- Command: startup queue composition inside `play_playlist(name)`.
- Guard: the same playback start request is still current.
- Writes: no player state until the single-track startup queue is ready.
- Emits: startup diagnostic trace.
- Target state: explicit single-track startup queue.
- Rejection: superseded request or unplayable prepared source. Rejection must
  not become hidden candidate-window fetching inside the play action.

`PlayingSession(current) -> PreparedQueue(current, next?)`

- Source state: active playback session.
- Command: queue fill or refresh tick.
- Guard: session is current.
- Writes: current session track queue.
- Emits: selection diagnostic log.
- Target state: same active playback session with a refreshed prepared queue.
- Rejection: superseded session or empty candidate universe.

## Derived Interpreters

There is no separate state-machine DSL for this service yet. The single
transition owner is the `playlist_playback::service` queue planning path:

- first-track selection reads the current prepared playlist-scoped source from
  the playable index;
- first-track selection does not call the bounded repo sampler on the play path;
- player-submit receives the single-track startup queue and startup track;
- player-submit success consumes that prepared source by playlist and generation;
- consuming a prepared startup source deletes only that source; the replacement
  preparation commits as a separate refresh instead of being blocked by
  consumption itself;
- model-backed first-slot preparation belongs only to the playable index; it is
  not a hidden play-click compatibility path;
- initial queue construction commits only the centerless prepared first track;
- background next-track planning uses `propose_playlist_playback_queue_with_mode`
  immediately after player acceptance when the startup queue lacks a next track,
  and later when the active anchor changed or the queue lacks a next track;
- next-track planning reads `stable` first and falls back to the same
  playlist-scoped SQL random candidate window when `stable` is absent,
  incomplete for the anchor, or unable to produce a distinct next track;
- replay-equivalent checks are covered by sidecar Rust tests for source scope,
  queue shape, fallback, and history filtering.

## Fallback

Audio-style fallback is explicit:

- First-slot cold start may use repository random projection only when no stable
  model exists, and only in the backend preparation pool.
- In `KeepCurrent` mode, model unavailability degrades to a playlist-scoped SQL
  random next track after the current anchor, using only the candidate window
  already materialized by the playback queue planner.
- A partially refreshed model is not allowed to starve playback queue planning
  when a completed older model still covers the active anchor.
- In `ExcludeCurrent` mode, it can choose randomly from the already materialized
  playlist-scoped candidate universe.
- It cannot load additional playlist records.
- It cannot construct `PlaybackTrack` from raw sources.
- It cannot override playlist membership, file existence, exclusions, or current
  session ownership.

## Cache

Audio-style embedding cache can accelerate model availability. It does not
define whether a track belongs to the playlist or whether a track is playable.
Cache hit and miss only change whether audio-style ranking or an explicit
degraded path is used.

The playable-source index is not a semantic cache. It is a preparation owner
with explicit generation and invalidation. Hit and miss can change latency, but
cannot change playlist membership, file-existence checks, fallback ownership, or
recommendation policy.

## Async And Cancellation

The playable index owns generation numbers for async refreshes. A late global or
playlist refresh may finish, but it can only commit if its generation is still
current. Refresh requests from startup, ready, prepared-source consumption, or
playback miss are idempotent fill signals: they do not replace an unconsumed
prepared source. Playlist mutation, library mutation, and exclude mutation are
invalidating signals and may replace prepared evidence. Prepared-source
consumption is generation-guarded, so repeated consumption or a late consumption
of a replaced snapshot cannot remove newer prepared evidence.

Queue refreshes run asynchronously, but every refresh checks the session handle
before writing. The queue-fill loop does not re-plan solely because the audio
style model generation changed; new model output is observed when the anchor
changes or the current queue lacks an unconsumed next track. A superseded session
cannot update the active queue. Late player results are owned by
`player::service` generation checks.

The player session consumes only the queue it is given. In ordered playlist
playback, reaching the end of the queue is a terminal observation for that
queue, not a signal to block and wait for upstream planning. The upstream
playlist playback owner must have supplied the first continuation from its
background queue-planning loop before the first track can finish.

## Exceptions

There is no exhaustive full-playlist model ranking on every refresh. The
candidate universe is a bounded random window across the selected playlist. This
keeps startup and refresh work bounded while preserving playlist-wide scope. The
exception owner is `playlist_playback::service`; it can be deleted when the
repository offers a cheap full-playlist playable-track iterator with stable
pagination and file-existence filtering.

There is no cold-click bounded sampler exception in the playback-start path.
During a cold startup or immediately after invalidation, a missing prepared
index snapshot is an explicit startup miss. Model-unavailable preparation does
not commit an empty prepared snapshot. It prepares a repository-random source in
the backend first-slot pool only when no stable model exists, but it does not
authorize `playlist_playback::service` to rebuild first-track startup inside the
play action. The replacement preparation owner remains
`playlist_playback::playable_index`.
