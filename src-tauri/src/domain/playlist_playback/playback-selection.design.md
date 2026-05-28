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
  prepared startup option for each playlist.
- `playlist_playback::service` owns first-track source elimination, next-track
  planning, recent-history exclusion, and queue refresh.
- `playlist_playback::recommendation` owns audio-style ranking for an already
  materialized candidate universe.
- `player::service` owns playback lifecycle, active request identity, queue
  consumption, and process control.
- `player::strategy` owns only consumption of the queue it is given. It does not
  load playlist records and does not widen the candidate universe.

## Core Invariants

- The playlist row is the only source of playlist membership.
- Startup candidate preparation runs before click through the playable-source
  index. The click path consumes the current prepared option and schedules
  refresh work on miss.
- First-track selection chooses a random playable startup anchor from the
  playlist scope.
- Next-track selection is owned by the recommendation planner and uses the
  playlist-scoped candidate universe.
- The first track is not derived from a deterministic seed, first row, first
  collection, or fixed random seed.
- Random source sampling is live randomness on each request; it must not persist
  a seeded order across sessions.
- Random source preparation must not use a fixed seed and must not become a
  stored playback order.
- The playable index prepares at most one startup option per playlist in the
  background; it cannot define whether a source is a playlist member or whether
  a local file is actually playable.
- Queue refresh may reduce latency or improve recommendation quality, but it
  must not change playlist membership.
- Cache and trace do not construct playable tracks and do not decide fallback.
- The player consumes an explicit queue and never queries playlist membership.
- A late queue refresh for a superseded session is discarded by the session
  owner before it can modify the active queue.
- Repeated refreshes may replace the prepared next track, but they may not create
  duplicate semantic side effects or widen scope outside the playlist.

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
- Invalidation signals after playlist, library, and exclude changes.

`playlist_playback::service` owns:

- Raw sources become `PlaybackTrack` only after their file path is resolved
  against the save root and the file exists.
- Startup options are sampled from the whole playlist selection, not from a
  deterministic prefix of one collection.
- The first playable track is selected by random source sampling.
- The startup queue is `[random first]`; first playback must not wait for
  recommendation queue planning.
- The next queue is produced by the recommendation path. If the model is not
  available in `KeepCurrent` mode, the queue remains `[current]`; it must not
  manufacture a random next track.
- `KeepCurrent` accepts only `audio_style` selection evidence as a complete next
  recommendation; `random_fallback` evidence is treated as unavailable.
- Random recovery is allowed only for `ExcludeCurrent`, where the current track
  has been explicitly removed and the system needs a replacement candidate.
- Recent history filters non-liked tracks without deleting liked tracks.

`playlist_playback::recommendation` owns:

- Audio-style probabilities for an already materialized candidate window.
- Fallback selection metadata when the model cannot rank candidates.

`player::service` owns:

- Session generation checks.
- Active request track identity.
- Ordered consumption of a prepared queue.
- Cancellation and late result rejection.

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
  create a fallback source.
- Idempotence: repeated refresh of the same repo projection may replace the
  snapshot generation, but cannot change playlist membership semantics.
- Evidence: each snapshot carries playlist name, generation, and at most one raw
  source evidence value projected by `playlists::repo`.

## Transitions

`ReadyPlaylist -> PlayingSession`

- Source state: frontend app logic has a ready playlist name.
- Command: `play_playlist(name)`.
- Guard: playlist exists and at least one playable track can be consumed from
  the prepared index snapshot or, during warmup, from the bounded repo sampler.
- Writes: player session queue and active playback request.
- Emits: diagnostic trace, index hit/miss trace, and now-playing events.
- Target state: active playback session.
- Rejection: missing playlist, no playable track, or superseded request.

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

- first-track selection consumes the current prepared playlist-scoped source
  from the playable index;
- bounded repo sampling is only a warmup miss path and schedules index refresh;
- initial queue construction commits only the random first track;
- background next-track planning uses `propose_playlist_playback_queue_with_mode`;
- replay-equivalent checks are covered by sidecar Rust tests for source scope,
  queue shape, fallback, and history filtering.

## Fallback

Audio-style fallback is explicit:

- In `KeepCurrent` mode, model unavailability degrades to the current anchor
  only.
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
current. Refresh requests from startup, ready, playlist mutation, library
mutation, exclude mutation, or playback miss are idempotent preparation signals.

Queue refreshes run asynchronously, but every refresh checks the session handle
before writing. A superseded session cannot update the active queue. Late player
results are owned by `player::service` generation checks.

## Exceptions

There is no exhaustive full-playlist model ranking on every refresh. The
candidate universe is a bounded random window across the selected playlist. This
keeps startup and refresh work bounded while preserving playlist-wide scope. The
exception owner is `playlist_playback::service`; it can be deleted when the
repository offers a cheap full-playlist playable-track iterator with stable
pagination and file-existence filtering.

During a cold startup or immediately after invalidation, the first click can hit
an empty index snapshot before background refresh finishes. In that case
`playlist_playback::service` uses the bounded repo sampler once and schedules a
refresh. This is a scoped warmup exception: it preserves membership semantics
but can still cost more than a hot index hit. The owner is
`playlist_playback::service`; it can be deleted once ready refresh completion is
observable by the UI without blocking interaction.
