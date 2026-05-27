# Playlist Playback Selection

## Behavior

Playlist playback turns a committed playlist row into a running playback session.
The user action supplies only the playlist name. The backend owns track
selection, queue planning, recommendation fallback, refresh, and cancellation.

## Participants

- `playlists::repo` owns playlist selection projection and random raw source
  lookup inside the selected playlist scope.
- `playlist_playback::service` owns the playable candidate universe, first-track
  selection, next-track planning, recent-history exclusion, and queue refresh.
- `playlist_playback::recommendation` owns audio-style ranking for an already
  materialized candidate universe.
- `player::service` owns playback lifecycle, active request identity, queue
  consumption, and process control.
- `player::strategy` owns only consumption of the queue it is given. It does not
  load playlist records and does not widen the candidate universe.

## Core Invariants

- The playlist row is the only source of playlist membership.
- First-track selection chooses a random playable startup anchor from the
  playlist scope.
- Next-track selection is owned by the recommendation planner and uses the
  playlist-scoped candidate universe.
- The first track is not derived from a deterministic seed, first row, first
  collection, or fixed random seed.
- Random source sampling is live randomness on each request; it must not persist
  a seeded order across sessions.
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
- Random raw source lookup stays inside selected `collections`, `groups`, and
  `extra`.
- Excluded music identities are filtered before a raw source is returned.

`playlist_playback::service` owns:

- Raw sources become `PlaybackTrack` only after their file path is resolved
  against the save root and the file exists.
- Candidate windows are sampled from the whole playlist selection, not from a
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

## Transitions

`ReadyPlaylist -> PlayingSession`

- Source state: frontend app logic has a ready playlist name.
- Command: `play_playlist(name)`.
- Guard: playlist exists and at least one playable track can be sampled.
- Writes: player session queue and active playback request.
- Emits: diagnostic trace and now-playing events.
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

- first-track selection uses random playlist-scoped source sampling;
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

## Async And Cancellation

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
