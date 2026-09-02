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
  planning, startup queue composition, recent-history exclusion, the listener-
  owned inverse-FSRS safety memory, and queue refresh.
- `playlist_playback::recommendation` owns symbolic program compilation and
  persistent symbolic traversal for an already materialized candidate universe;
  committed traversal state may survive a later playback cycle for the same
  playlist, while in-flight proposals never cross the session boundary. Its
  invalidation token is playlist-scoped; first-slot cargo consumption, refill,
  and loudness enrichment use a separate preparation revision.
- `player::service` owns playback lifecycle, active request identity, queue
  consumption, producer-terminal coordination, and process control.
- `player::strategy` owns only consumption of the queue it is given. It does not
  load playlist records and does not widen the candidate universe.

## Core Invariants

- The playlist row is the only source of playlist membership.
- Startup candidate preparation runs before click through the playable-source
  index. Program startup, ready, library, playlist, exclude, and
  prepared-source consumption are the scheduling inputs. The play action
  consumes prepared evidence; it does not own first-track preparation, and a
  prepared first-slot miss is not a scheduler.
- The player-submit success path consumes the current prepared option by
  playlist and generation. Consumption immediately schedules replacement
  preparation for that playlist.
- First-track preparation chooses a centerless symbolic-program startup anchor from
  the playlist scope when a stable model exists. If no stable model exists
  during cold start, it prepares a playlist-scoped repository random source in
  the same backend first-slot pool.
- Prepared first-slot snapshots carry source kind evidence. A later
  audio-style-model-available refresh may replace an unconsumed
  `random_fallback` snapshot, but it must not replace an unconsumed
  `symbolic_program` snapshot.
- Startup next-track selection is part of the post-acceptance backend queue
  fill transaction. Once the centerless first-track anchor is accepted by the
  player session, the recommendation planner must be invoked in the background.
- A playlist session uses an open-queue exhaustion policy: an empty queue after
  a completed track is a temporary producer gap and remains `Preparing` until
  the queue producer commits a next track or explicitly marks the producer
  terminal. Finite player sessions retain immediate ordered exhaustion.
- Later next-track selection is owned by the recommendation planner and uses
  the playlist-scoped candidate universe.
- The first track is not derived from a deterministic seed, first row, first
  collection, or fixed random seed.
- Centerless startup sampling uses the stable published symbolic program
  encoding inside the playlist scope. Its draw is live per prepared-source refresh and
  must not persist a seeded order across sessions. The repository random
  projection is allowed only when no stable model exists; it is cold-start
  preparation, not click-path fallback.
- The playable index prepares at most one startup option per playlist in the
  background; it cannot define whether a source is a playlist member or whether
  a local file is actually playable.
- Ready, startup, and prepared-source-consumed refreshes fill a missing
  prepared startup option; they do not replace an unconsumed option.
- Queue refresh may reduce latency, fill later continuations, or improve
  recommendation quality, but it must not change playlist membership.
- The symbolic program is the primary route. Its candidate universe is the
  current model's concrete members resolved inside the selected playlist, not
  the startup sampler's bounded window. Random degradation retains its own
  bounded candidate window and does not establish symbolic coverage.
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
- Model-available refresh is a quality-upgrade signal, not a generic ready
  signal. It is allowed to replace only cold-start random fallback snapshots and
  must keep unconsumed audio-style snapshots.
- Invalidation signals after playlist, library, and exclude changes.

`playlist_playback::service` owns:

- Raw sources become `PlaybackTrack` only after their file path is resolved
  against the save root and the file exists.
- Startup options are sampled by centerless symbolic-program selection inside the
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
- If `stable` exists but cannot rank the current anchor in `KeepCurrent` mode,
  the queue planner uses the persistent symbolic traversal session over embedded
  candidates from the already materialized playlist-scoped model-member scope to
  compose `[current, symbolic_program_next]`.
- If no stable model exists, or symbolic traversal cannot produce a distinct
  embedded next track, the queue planner uses the already materialized
  playlist-scoped SQL random candidate window to compose `[current,
  random_next]`.
- `KeepCurrent` accepts only `symbolic_program` selection evidence as a complete
  recommendation. Service-owned SQL random fallback is an explicit
  queue-planning degradation path, not symbolic-program evidence.
- Random recovery is also allowed for `ExcludeCurrent`, where the current track
  has been explicitly removed and the system needs a replacement candidate.
- Temporal memory is keyed by stable music identity and survives playlist
  session boundaries. Actual playback, not planning or queue preparation, owns
  exposure updates. Model-generation-local basin identifiers are never
  persisted in this listener-owned memory.

`playlist_playback::recommendation` owns:

- Symbolic program compilation and persistent traversal for the resolved
  model-member scope.
- Content evidence is the hard scheduling identity. Stable tracks with the same
  complete-file SHA-256 and playback range occupy one symbolic position even
  when their source URL or local path differs; unavailable or unreadable
  evidence remains identity-local and is never merged from title or embedding
  similarity alone.
- A generation-local extreme topology block may receive sublinear symbolic
  capacity (`ceil(sqrt(class_count))`) when reciprocal similarity and both
  outgoing and incoming neighborhood-overlap checks agree. The block does not
  become content identity: its concrete content classes remain materializations
  of those capacity slots. Strong block membership is considered across the
  complete compiled candidate row; the smaller neighborhood prefix is only the
  topology-profile comparison surface and cannot split a large equal-similarity
  block through stable tie ordering.
- Scope coverage and recent history operate on symbolic positions. Concrete
  URLs and paths are selected deterministically only after traversal, rotating
  across later coverage epochs instead of multiplying a class inside one epoch.
- Within-region opportunity selection may exchange the next symbolic position
  with an unheard position in the same class-majority acoustic basin and the
  same concrete-member basin for the current epoch. Within the active program
  it does not change the basin itinerary or regenerate native style-departure
  marks from basin labels.
  The proposed exchange is a conjugation of the active cyclic permutation;
  traversal state and the prepared output change together. The immutable atlas
  and its orbit index remain shared. The path-local exchange is cleared on
  program departure or coverage entry, not by resetting listener history.
- Opportunity priority and acoustic arrangement have separate owners within
  selection. A class receives a persistent random ticket for a coverage epoch;
  current inverse FSRS retrievability and Like transform that ticket's priority.
  Geometry may arrange candidates only within a bounded band of the earliest
  remaining priorities, rather than buying a fresh chance to prefer the same
  acoustically central classes at every step.
- The current priority is `1 - exp(-E / a)`, where `E = -ln(U)` is the
  epoch-owned ticket and `a = (1 - R) * (16 if liked else 1)`. A zero rate has
  priority one. The eligible band ends at the minimum remaining priority plus
  0.20; centered incoming cosine supplies `exp(32 * (cosine - max_cosine))`
  weights only inside that band. Exhausting the admissible band, or having no
  positive opportunity rate, falls back to the native next class.
  A class receives one opportunity regardless of alias count; its memory value is
  the strongest existing alias trace and its preference is the current liked
  state of any admitted member. Like is an earlier opportunity, not a fatigue
  exemption or a training label. Familiarity changes priority rather than
  falsely recording an unplayed position as heard in this coverage epoch.
- Source-recovery admissibility compares each proposed exchange against the
  initial active native cycle, using its minimum recovery, short-return ratio,
  and four normalized recovery pressures. This baseline does not ratchet after
  an accepted exchange. Inadmissible proposals are removed from the current
  weighted draw; the original next position remains a valid coverage fallback.
- Session-owned proposal randomness is checkpointed with the path. An
  unconsumed proposal, rollback, or committed-session snapshot cannot silently
  redraw the next opportunity. Preparing an option does not update temporal
  memory. The existing neural-fatigue formation and normal auxiliary retain
  their original authority; neither Like nor the opportunity draw replaces
  the neural fatigue bound with a normal-tail threshold.
- On a fixed admitted scope, exchanging only two unheard positions in a single
  cyclic permutation leaves the heard prefix intact and the remaining suffix
  a permutation of the same classes. Identity fallback still consumes the next
  unheard class, including when all familiarity weights are zero. Concrete
  member rotation is unchanged across coverage epochs. This is a traversal
  property, not a claim that every track has a uniform first-hit distribution,
  that arbitrary restarts retain progress, or that tracks outside the model
  have become part of the symbolic scope.
- The within-program trace argument is not a new global neural-fatigue proof
  across program or coverage-epoch joins. Those joins retain the existing native
  transition mechanism and are observed separately from within-cycle runs.
- A scope revision invalidates materialization reuse without deleting the
  traversal frontier. When the scope signature changes, realized positions from
  the current coverage epoch are transported through shared member identities;
  newly admitted positions remain unrealized. An unchanged signature keeps the
  exact execution state and atlas, but accepts refreshed mutable metadata for
  both class representatives and concrete materializations. Refreshed candidate
  metadata takes precedence over a stale copy of the currently playing track.
- Transported history need not be a contiguous prefix of a newly scoped
  program. If every immediate departure is already heard but the active
  program is one complete cycle, traversal uses its first return to an unheard
  position, skipping heard vertices without replaying or clearing them. This
  exceptional departure follows the effective successor law, including its
  path overlay. Each output still consumes exactly one new position; ordinary
  uninterrupted prefixes and complete-epoch transitions use the existing path.
  A genuinely disconnected multi-cycle program retains its explicit failure
  behavior rather than acquiring an arbitrary escape edge.
- The canonical content partition and topology-capacity partition are signed as
  part of the derived symbolic encoding. A stable model refreshes that derived
  encoding when its schema or partition signature no longer matches, without
  decoding audio embeddings again.
- Explicit random degradation metadata when symbolic traversal cannot rank or
  reach a candidate.
- The double-buffered model lifecycle: `stable` serves playback and first-slot
  reads; `nightly` receives progressive training output; each complete nightly
  snapshot may atomically replace `stable` when the stable surface is idle; the
  first successful progressive promotion wakes first-slot preparation because
  model availability changed; later progressive promotions do not wake an
  already full first-slot pool; the final training snapshot must replace
  `stable` when training completes and may notify first-slot preparation.
- The model lifecycle is independent from playback behavior. Startup and stable
  library-input changes are the only training schedulers. First-slot
  preparation and next-track planning can observe model readiness and emit
  diagnostics, but they cannot request or debounce training.
- Training input is a flat model-runtime projection over completed `Music`
  rows. The repository view returns an absolute media path plus embedding
  identity/range fields; group, collection, owner, and playback-source scope are
  not training fields and cannot decide whether a track is trainable.
- Training leaf decoding is concurrent and bounded. Workers produce only
  embedding results or leaf-local failures. A heartbeat owner collects completed
  worker results, publishes `nightly` progress snapshots, and promotes `stable`
  through the same double-buffer rule. Transient download files such as `.part`,
  Slisic temporary stems, and cache `.tmp` files are outside the stable media
  input domain and must not enter decoding.
- Training worker count is a model-runtime scheduling decision based on pending
  track count, available CPU parallelism, tensor backend availability, and a
  bounded cap. Playback, first-slot preparation, and playlist repositories do
  not own that number, and no user-facing behavior may depend on a fixed worker
  count.
- Cache opening is not cache maintenance. The embedding cache may lazily ignore
  and rebuild stale or invalid per-track entries when that track is requested,
  but whole-cache cleanup is an explicit maintenance action and cannot sit on
  the training startup hot path.

`player::service` owns:

- Session generation checks.
- Active request track identity.
- Ordered consumption of a prepared queue.
- Playlist open-queue waiting and producer-terminal coordination.
- Cancellation and late result rejection.
- Track-boundary queue exhaustion reporting for finite sessions. The playlist
  owner may intentionally leave the queue open while its background producer
  is resolving the next track.

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
  stable symbolic-program centerless sampling or through cold-start repository random
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
- background next-track planning uses the persistent
  `propose_playlist_symbolic_next_track` session immediately after player
  acceptance when the startup queue lacks a next track, and later when the
  active anchor changed or the queue lacks a next track;
- next-track planning reads `stable` first and traverses the symbolic program
  over the resolved playlist-scoped model-member scope when `stable` exists but lacks
  the anchor embedding; SQL random is used only when `stable` is absent or
  symbolic traversal cannot produce a distinct next track;
- queue refresh from periodic fill and download-change events is gated per
  session, and rechecks the active queue after entering the gate so an
  unconsumed next track cannot be replaced by duplicate sampling;
- replay-equivalent checks are covered by sidecar Rust tests for source scope,
  queue shape, fallback, and history filtering.

## Fallback

Symbolic-program degradation is explicit:

- First-slot cold start may use repository random projection only when no stable
  model exists, and only in the backend preparation pool.
- A cold-start random fallback first slot remains replaceable by the first
  stable model-available event until it is consumed. Once replaced by
  `symbolic_program`, ordinary ready/model progress events cannot churn it before
  consumption.
- In `KeepCurrent` mode, a stable model with a missing anchor embedding uses
  the persistent symbolic traversal session over embedded candidates from the
  model-member scope already materialized by the playback queue planner.
- In `KeepCurrent` mode, symbolic obstruction or complete model unavailability
  degrades to a
  playlist-scoped SQL random next track after the current anchor, using only the
  candidate window already materialized by the playback queue planner.
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
Cache hit and miss only change whether symbolic-program traversal or an
explicit degraded path is used.

The playable-source index is not a semantic cache. It is a preparation owner
with explicit generation and invalidation. Hit and miss can change latency, but
cannot change playlist membership, file-existence checks, fallback ownership, or
recommendation policy.

## Async And Cancellation

The playable index owns generation numbers for async refreshes. A late global or
playlist refresh may finish, but it can only commit if its generation is still
current. Refresh requests from startup, ready, or prepared-source consumption are
idempotent fill signals: they do not replace an unconsumed prepared source. A
play action that observes a missing prepared snapshot does not schedule
first-slot preparation; it only reports the miss. Playlist mutation, library
mutation, and exclude mutation are invalidating signals and may replace prepared
evidence. Prepared-source consumption is generation-guarded, so repeated
consumption or a late consumption of a replaced snapshot cannot remove newer
prepared evidence.

Queue refreshes run asynchronously, but every refresh checks the session handle
before writing. The queue-fill loop does not re-plan solely because the audio
style model generation changed; new model output is observed when the anchor
changes or the current queue lacks an unconsumed next track. A superseded session
cannot update the active queue. Late player results are owned by
`player::service` generation checks.

The player session consumes only the queue it is given. Finite ordered sessions
finish when their queue is exhausted. Playlist sessions are explicitly open
queues: reaching the end after a completed track enters `Preparing` and waits
for a track-revision signal from the queue producer. Only an explicit producer
terminal signal (no candidates, no distinct candidate, or an unrecoverable
queue-worker error) allows the player to emit `Finished`; a temporary
recommendation gap cannot return the UI to `ready`.

## Exceptions

There is no full-library model rebuild on every refresh. Native symbolic
selection resolves the model's concrete member identities against the current
playlist and reuses that materialized scope until a relevant revision changes.
Playable tracks outside the current model remain outside the symbolic coverage
claim; the repository-random degradation path is separate evidence.

There is no cold-click bounded sampler exception in the playback-start path.
During a cold startup or immediately after invalidation, a missing prepared
index snapshot is an explicit startup miss. Model-unavailable preparation does
not commit an empty prepared snapshot. It prepares a repository-random source in
the backend first-slot pool only when no stable model exists, but it does not
authorize `playlist_playback::service` to rebuild first-track startup inside the
play action. The replacement preparation owner remains
`playlist_playback::playable_index`.
