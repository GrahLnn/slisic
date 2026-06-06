# Module Algebra Migration Ledger

## Status

This ledger is the durable migration record for making Slisic modules behave
like a small Ya-inspired algebra of owned behavior. The current source reality
is the repository at `f3b375e Keep spectrum range edits off live playback
origin`. Previous module-first extraction attempts were reverted. They are not
current implementation facts.

The migration is paused at the contract stage until interaction contracts are
locked. Slisic UX contains product behavior that can look like incidental
timing, loading, hover, or optimistic state. Those tricks are not noise. A
module slice is invalid when it preserves type shape but changes interaction
timing, candidate visibility, title feedback, play admission, spectrum commit
behavior, hover leases, or backend/frontend evidence ownership.

## Purpose

The goal is not to decorate the codebase with category-theory names. The goal
is to make every behavior path have one smallest lawful description:

```text
classify intent -> owned operator -> Evidence | Stops -> projection
```

Every module must eventually be classifiable as one of these forms:

```text
Functor      : A -> B
Operator     : A -> Stops<B>
Interpreter  : Instruction -> Evidence | Stops
Product      : A x B x C used only through projections/components
Journal      : Observation only
```

The migration must proceed by interaction contract, not by folder. A backend
service, frontend machine, component model, Tauri command adapter, and Rust
domain may belong to the same vertical behavior slice.

## Ya Reference

Local reference: `C:/Users/admin/ya`.

Source anchors:

- `Ya/Algebra/Definition.hs`: `Category`, `Functor`, `Transformation`,
  `Component`, identity and composition preservation.
- `Ya/Program/Patterns.hs`: `Stops`, `Valid`, `Error`, `Break`, `Wrong`,
  `Transition`, `Event`, `State`, `Scope`, and `Instruction`.
- `Ya/Algebra/Effectful.hs`: `JNT` as structured composition of inner state and
  effect shape.

Slisic translation:

- `Functor` means a pure projection that preserves identity and composition.
  It cannot run effects, invent evidence, or consult hidden runtime state.
- `Operator` means one owner of one morphism family. It returns evidence or a
  named `Stops` branch.
- `Interpreter` means an external effect runner. It returns evidence; it does
  not own semantic truth.
- `Transformation` means cross-owner substitution that commutes with projection
  over the same identity axes.
- `State` means the fixed point of accepted events, not a waiting room for
  unresolved effects.
- `Scope` and `Lease` are explicit coordinates. Open and close are operators.
  Reset by field deletion is illegal.

## First-Class Terms

Only these names are first-class module algebra terms:

```text
Shape
Chart
Scope
Event
Stops
Instruction
Demand
Lease
Evidence
Journal
```

Derived patterns stay derived:

```text
Horizon = Chart-local Demand + Scope
PresentationLease = Lease
PreparedCredential = Lease
CommitFrame = Instruction JNT State interpreted into Evidence
ExperienceDelta = Event over Chart
ShapeDeltaPlan = Instruction payload
```

## Contract-First Migration Gate

No code migration slice may start unless it records all of the following:

```text
Interaction contract:
Current source anchors:
Target kind:
Owner:
Domain:
Codomain:
Stops:
Interpreter boundary:
UX timing preserved:
Checker:
Negative paths:
Deleted or absorbed special path:
```

The slice is blocked when any field cannot be filled without implementation
accidents. A slice is also blocked when the checker only verifies a helper
function while the user-visible path remains unprotected.

## Internal Framework Algebra

Slisic internal framework code must be classified by the morphism it owns, not
by folder, technology, or whether it is frontend/backend code. A module may
compose multiple classified parts internally, but its public seam must expose
one smallest lawful description.

Ya anchors:

- `Functor` preserves identity and composition. In Slisic this is a pure
  projection such as `Shape -> ViewModel`, `Draft -> ComparableKey`,
  `Evidence -> Projection`, or `Geometry -> LayoutInstruction`.
- `Transformation` commutes across owners. In Slisic this is a scoped
  substitution such as playback identity substitution, title-share arrow
  composition, or accepted commit evidence reflected against a baseline.
- `Stops` preserves negative future information. A rejected path must carry a
  reason such as `stale-epoch`, `closed-frame`, `not-pending-first-track`, or
  `endpoint-mismatch`; silent no-op is not a valid success.
- `Instruction JNT State` means an effectful interpretation of an instruction
  against accepted state. In Slisic this is where Tauri commands, player
  requests, download workers, persistence, model training, and provider probes
  belong. The interpreter returns evidence; it does not own semantic truth.

Allowed public shapes:

```text
Functor:
  A -> B
  owns no effects, no clocks, no mutable lifecycle, no hidden cache truth

Operator:
  A -> Evidence | Stops<reason>
  owns one morphism family, including its negative paths

Transformation:
  A_owner x B_owner x Scope -> B_owner | Stops<reason>
  substitutes across owners only when the identity axes commute

Interpreter:
  Instruction x Runtime -> Evidence | Stops<reason>
  owns external effects, retries, process IO, and diagnostics only

Product:
  A x B x C
  carries coordinates; it must be consumed through named projections

Journal:
  Observation*
  records traces; it cannot decide state
```

Disallowed public shapes:

- `Manager`: too vague. Rename by the morphism it owns.
- `Runtime`: allowed only at interpreter boundaries. It must not become a
  second domain model.
- `Machine`: allowed as a composition shell. Its internal transitions must be
  reducible to named operators, functors, and interpreters.
- `Service`: allowed only when it has a declared algebraic public seam. A
  service that owns admission, planning, recovery, persistence, broadcast, and
  tail measurements is a product waiting to be decomposed by contract.
- `Model`: allowed only when it is a pure projection or a local chart. A model
  that owns effects or global truth has crossed its boundary.

UX law:

Human experience is a semantic domain, not decoration. Hover retention,
loading matrix timing, title handoff weight, stationary-pointer scroll behavior,
pending first-track text, optimistic draft visibility, spectrum back timing,
and paste title feedback are lawful behavior when they preserve user
orientation. They may be functorized, but they must not be erased. A refactor
is invalid when it preserves data correctness while changing these experience
coordinates without a contract and checker.

UX trick classification:

```text
Title handoff:
  Endpoint x Arrow -> HoverVisualLease
  kind: Transformation + Lease projection

Config hover overlay:
  Pointer x ScrollHorizon x ItemGeometry -> HoverLease or Stops
  kind: Operator

Paste loading matrix:
  CandidateProjection -> BackActionIconProjection
  kind: Functor over candidate evidence, not a global download state

Pending first-track text:
  PlaybackRequest x DownloadEvidence -> PreparingProjection | Stops
  kind: Operator with strict predicate

Spectrum range edit:
  DraftRange -> DraftChartPatch
  kind: Chart-local event; player restart is not implied

Arc/list ghost motion:
  SourceGeometry x TargetGeometry x Lease -> MotionInstruction
  kind: Functor with explicit lease close
```

## Current Internal Framework Classification

This table records current classification. It is an audit ledger, not a claim
that every module is already deep enough.

| Module or cluster                                            | Current kind                             | Smallest lawful description                                                                 | Owner                              | Current risk                                                                                                              | Required direction                                                                                        |
| ------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/flow/*/events.ts`                                       | Product + event vocabulary               | `DomainEventNames x PayloadTypes x Invokers`                                                | Event vocabulary owner             | Can become a second semantic source if payload helpers start deciding behavior.                                           | Keep as vocabulary and command adapter only; behavior belongs in named operators.                         |
| `src/flow/*/src.ts`                                          | Interpreter setup                        | `Actors x Types -> MachineFactory`                                                          | XState setup shell                 | Low when thin; bad if machine setup hides behavior.                                                                       | Keep thin.                                                                                                |
| `src/flow/*/api.ts` / `runtime.ts`                           | Interpreter facade                       | `Instruction -> actor.send / external subscription`                                         | UI/runtime adapter                 | Can accidentally own lifecycle policy, as seen in pending playback wakeups before extraction.                             | Only translate UI/app events into instructions; delegate policy to operators.                             |
| `src/flow/appLogic/core.ts`                                  | Wide Product + many functors             | `AppShapeProduct -> Draft/List/Library projections`                                         | App shape coordinate owner         | Too wide: Shape projection, chart state, runtime scope, leases, pending evidence, and reset semantics are close together. | Keep projections pure; extract lifecycle operators only when a vertical checker exists.                   |
| `src/flow/appLogic/machine.ts`                               | Composition shell                        | `Event x Context -> ChartPatch + Instruction`                                               | App chart composer                 | High semantic density; easy to turn accepted evidence into current-context patching.                                      | Treat as composition layer; move repeated morphism families into named operators with Stops.              |
| `src/flow/appLogic/index.ts`                                 | Interpreter facade + request epoch owner | `UI command -> backend instruction -> Evidence event`                                       | Frontend action facade             | It still mixes action IO, epochs, and wakeup scheduling.                                                                  | Continue extracting request-scoped owners only after checker-backed slices.                               |
| `src/flow/appLogic/playlistPlaybackPendingWakeup.ts`         | Operator                                 | `PendingPlaybackRequest -> WakeupDemand or Stops`                                           | Pending first-track wakeup owner   | Good deep module; owns coalescing and stale request closure.                                                              | Use as pattern for async liveness owners.                                                                 |
| `src/flow/appLogic/spectrumEditTransaction.ts`               | Transformation + functor                 | `Baseline x OptimisticEvidence x AcceptedEvidence -> Projection or Stops or Reject`         | Spectrum commit reflection owner   | Good direction; baseline makes evidence reflection explicit.                                                              | Extend this baseline law to playlist commits and other optimistic patches.                                |
| `src/flow/appLogic/spectrumMusicCommitTransaction.ts`        | Operator                                 | `Drafts -> CommitPlan or Stops` and `CommitPlan -> Instructions`                            | Spectrum commit plan owner         | Good if it remains plan-only.                                                                                             | Keep player/session effects outside.                                                                      |
| `src/flow/appLogic/spectrumOpenTransaction.ts`               | Operator                                 | `OpenIntent x CurrentProjection -> OpenInstruction or Stops`                                | Spectrum open scope owner          | Good if it only checks current source identity.                                                                           | Preserve source identity as Scope.                                                                        |
| `src/flow/appLogic/playbackExcludeTransaction.ts`            | Operator + projection                    | `ExcludeIntent x PlaybackProjection -> ExcludeInstruction or Stops`                         | Exclude current playback owner     | Good if it keeps immediate playback action explicit.                                                                      | Keep player skip as interpreter evidence, not projection truth.                                           |
| `src/flow/appLogic/titleShare.ts`                            | Transformation + Lease functor           | `EndpointArrow x Endpoint -> TitleShareInstruction or Stops`                                | Shared title motion owner          | Strong module; already declares partial composition.                                                                      | Treat as model for UX trick algebra.                                                                      |
| `src/flow/appLogic/musicTitle.ts`                            | Functor cluster + partial operators      | `SpectrumDrafts -> MusicEdits/Creates/Deletes`                                              | Music identity projection owner    | Some update helpers still depend on coordinate matching against old range/name.                                           | Tie all accepted evidence to baseline or explicit rebase.                                                 |
| `src/flow/pasteDownload/core.ts`                             | Functor cluster                          | `CandidateEvidence -> CandidateProjection`                                                  | Paste candidate projection owner   | Good when pure; must not start effects.                                                                                   | Keep display text/check status as projection over evidence.                                               |
| `src/flow/pasteDownload/machine.ts`                          | Candidate operator composer              | `PasteText -> UrlResolution -> sibling Instructions -> CandidateEvents`                     | Candidate-scoped async owner       | Now better after title queue; still a composition shell.                                                                  | Keep URL resolution, title probe, and enqueue as sibling effects.                                         |
| `src/flow/pasteDownload/titleProbeQueue.ts`                  | Liveness operator                        | `TitleProbeDemand -> RootTitleEvidence or Stops`                                            | Title probe queue owner            | Good deep module; owns concurrency, cancellation, replacement.                                                            | Do not add download semantics here.                                                                       |
| `src/flow/playlistCommit/*`                                  | Commit operator                          | `DraftCommitPlan -> PersistenceInstructions -> Evidence`                                    | Playlist commit owner              | Needs same baseline/reflection law as spectrum edit.                                                                      | Make stale commit Stops explicit before broader refactor.                                                 |
| `src/flow/bootstrap/*`                                       | Startup interpreter + projection         | `StartupInstruction -> BootstrapEvidence -> ReadyProjection`                                | App bootstrap owner                | Startup effects can poison ready projection if mixed.                                                                     | Keep training/cache failures as evidence, not library truth.                                              |
| `src/components/ListConfig.view-model.ts`                    | Functor                                  | `AppShape x CandidateProjection x AnimationMemory -> ConfigViewModel`                       | Config projection owner            | Strong checker coverage; risk is treating paste/hover UX as incidental.                                                   | Keep UX timing encoded as projection facts, not CSS side effects.                                         |
| `src/components/ListConfig.tsx`                              | Interpreter + renderer                   | `ViewModel -> DOM + UI instructions`                                                        | React render adapter               | Large file; can leak behavior into event handlers.                                                                        | Push behavior to view-model/operators; keep rendering ergonomic.                                          |
| `src/components/ListConfig.back-action.ts`                   | Functor                                  | `CandidateProjection x DraftState -> BackActionIcon`                                        | Back affordance projection owner   | Good; must preserve loading matrix semantics.                                                                             | Do not derive from global download state.                                                                 |
| `src/components/toolLabelHoverLease.ts`                      | Lease operator                           | `Pointer x ScrollViewport x ItemGeometry -> HoverLease or Stops`                            | Hover lease owner                  | Good direction; UX trick must remain first-class.                                                                         | Extend to all portal hover surfaces.                                                                      |
| `src/components/toolLabelOverlayGeometry.ts`                 | Geometry functor + horizon interpreter   | `AnchorGeometry x Viewport -> OverlayStyle` and `AnchorElement -> ScrollHorizon`            | Tool label overlay geometry owner  | Good when geometry remains a projection and scroll containers remain sync signals.                                        | Keep hover admission in `toolLabelHoverLease.ts`; geometry only supplies coordinates and horizon targets. |
| `src/components/toolLabelPointerTracker.ts`                  | Journal + sync operator                  | `DocumentPointerEvents -> PointerEvidenceJournal + HoverSyncDemand`                         | Document pointer evidence owner    | Good when it stays observational; bad if it starts deciding hover truth.                                                  | Keep hover semantics in `toolLabelHoverLease.ts`; tracker only records evidence and requests sync.        |
| `src/components/ListConfig.ghost-*`                          | Geometry/motion functors                 | `SourceGeometry x TargetGeometry x Lease -> MotionInstruction`                              | Ghost transition owner             | Good when pure; risk is hidden DOM assumptions.                                                                           | Keep geometry facts explicit and tested.                                                                  |
| `src/components/ArcTrackList.tsx`                            | Renderer + projection                    | `ArcItems x HoverLease -> DOM`                                                              | Arc list render adapter            | Portal hover and stationary scroll are easy to regress.                                                                   | Keep hover lease external; render only interprets lease.                                                  |
| `src/components/playListTitleHandoff.model.ts`               | Lease operator                           | `TitleSource x Stage -> HandoffLease or Stops`                                              | Playlist title handoff owner       | Strong deep module; UX semantic.                                                                                          | Align app-level title share with same Lease language.                                                     |
| `src/components/playListPlaybackSurface.model.ts`            | Chart functor                            | `MachinePlayback x VisualMemory -> PlaybackSurfaceProjection`                               | Playback surface chart owner       | Good, but must not decide backend acceptance.                                                                             | Keep as projection only.                                                                                  |
| `src/components/PlayListPage.view-model.ts`                  | Functor                                  | `AppChart -> PlaylistPageViewModel`                                                         | Playlist page projection owner     | Must preserve preparing, title locks, and return handoffs.                                                                | Keep pending first-track as projection over evidence.                                                     |
| `src/components/spectrum/SpectrumVisualizer.model.ts`        | Chart-local Product + operators          | `WaveformHorizon x DraftRange x PlaybackScope -> SpectrumChartPatch`                        | Spectrum chart owner               | Rich but local; should become reusable Horizon pattern later.                                                             | Do not collapse start/end into one playback range command.                                                |
| `src-tauri/src/domain/downloads/service.rs`                  | Wide service Product + interpreters      | `TaskAdmission x RootTitleProbe x LeafPipeline x Recovery x Broadcast`                      | Downloads domain service           | Too many owners in one file; path-level contracts now protect paste feedback.                                             | Split by vertical contracts only: admission, root shell evidence, leaf pipeline, tail evidence, recovery. |
| `src-tauri/src/domain/downloads/planning.rs`                 | Operator + interpreter boundary          | `RootProbe x ResidualEvidence -> CollectionPlan or Stops`                                   | Download planning owner            | Good planning owner; root shell and root full probes must stay separate.                                                  | Keep shell probe as title evidence, full probe as plan evidence.                                          |
| `src-tauri/src/domain/downloads/yt_dlp.rs`                   | External interpreter adapter             | `ProviderInstruction -> ProviderEvidence or Error`                                          | yt-dlp interpreter                 | Must not invent fallback semantic titles.                                                                                 | Crash/error is preferable to false evidence.                                                              |
| `src-tauri/src/domain/collection_import.rs`                  | Persistence operator + projection        | `CollectionShellPlan x LocalAudioDurationEvidence -> CollectionEvidence`                     | Collection shell/persistence owner | Strong but can become semantic source for URL normalization if overused.                                                  | Keep URL identity normalization explicit; local decoded duration owns full-file `Music.end_ms`.           |
| `src-tauri/src/domain/playlist_playback/playable_index.rs`   | Lease/credential operator                | `LibraryShape -> PreparedCredentialPool`                                                    | First-slot credential owner        | Strong backend deep module; needs shared frontend language.                                                               | Treat credentials as Lease instances consumed linearly.                                                   |
| `src-tauri/src/domain/playlist_playback/service.rs`          | Wide service Product                     | `PlaybackIntent -> StartedEvidence or Stops<pending_first_track>` plus queue recommendation | Playlist playback owner            | Still mixes start, recommendation, history, trace, exclusion, queue refresh.                                              | Extract only along checked contracts; do not block play on recommender/loudness.                          |
| `src-tauri/src/domain/playlist_playback/recommendation.rs`   | Model/evidence operator                  | `AudioEmbeddings x CandidateSet -> QueueProposal or Stops`                                  | Recommendation owner               | Training/cache/proposal are close; previous bugs came from retraining conditions.                                         | Separate persisted evidence, missing evidence Stops, and background training interpreter.                 |
| `src-tauri/src/domain/player/service.rs`                     | Interpreter + session operator           | `PlaybackInstruction -> PlayerEvidence`                                                     | Player session owner               | Must keep start/end independent and playback immediate.                                                                   | Player accepts play first; tail measurements are background.                                              |
| `src-tauri/src/domain/player/track_identity_substitution.rs` | Transformation                           | `OldTrackIdentity x NewEvidence x Session -> SessionPatch or Stops`                         | Player identity substitution owner | Good algebraic boundary.                                                                                                  | Use as reference for commit reflect/rebase.                                                               |
| `src-tauri/src/domain/player/waveform.rs`                    | Interpreter + cache                      | `AudioRangeDemand -> WaveformEvidence`                                                      | Waveform evidence owner            | Cache must not own semantic truth.                                                                                        | Keep cache observational/accelerating only; decoded file duration is the shared coordinate.               |
| `src-tauri/src/domain/playlists/repo.rs`                     | Persistence Product + projections        | `StoreInstruction -> PersistedEvidence`                                                     | Playlist persistence owner         | Store writes, views, memberships, exclude availability are co-located.                                                    | Split projection from persistence only under commit/rebase checker.                                       |
| `src-tauri/src/domain/meta/*`                                | Persistence interpreter                  | `MetaInstruction -> MetaEvidence`                                                           | App metadata owner                 | Low risk if it stays simple.                                                                                              | Keep as interpreter.                                                                                      |

## Algebraic Deepening Rules From This Audit

1. A queue is an operator only for liveness. It may own concurrency,
   coalescing, cancellation, retry, and stale-result closure. It must not own
   domain evidence construction.
2. A renderer is an interpreter of projection instructions. It may own DOM,
   focus, pointer capture, animation execution, and accessibility attributes.
   It must not decide whether a backend event is accepted.
3. A view model is a functor. It may preserve UX trick coordinates, but it must
   not run effects or consult mutable runtime state.
4. A service file may contain many functions, but a public service seam is only
   valid when it names its operator. Otherwise it is a product and must be
   consumed through smaller projections/operators.
5. A cache is a journal or acceleration interpreter. It cannot decide semantic
   truth. Missing cache evidence returns `Stops<missing-evidence>` or triggers
   a background instruction.
6. A fallback title, fallback track, fallback queue, or fallback UX state is a
   real branch and must be named. If it cannot be named without lying, the path
   should fail loudly instead of producing false evidence.
7. A UX trick that keeps the human oriented is a lease, chart, horizon,
   projection, or transformation. It is invalid to erase it in the name of
   simplifying state.
8. A state machine transition is not itself the theory. It is a composition
   shell over named events, operators, functors, interpreters, and Stops.
9. Every async result must carry enough owner coordinates to answer: which
   request, epoch, candidate, playlist, session, chart, or lease can accept it.
10. The shortest description wins only when it preserves the user-visible
    behavior. A shorter implementation that loses title timing, hover leases,
    preparing text, or spectrum no-restart behavior is not lawful.

## Interaction Contract Ledger

### 1. Paste Import Title-First Contract

Behavior:

```text
ClipboardText
  -> UrlResolution
  -> RootTitleEvidence | PreparedCollectionShell | DownloadTaskEvidence
  -> CandidateProjection
```

Contract:

- Pasting a valid URL must create or update a visible candidate promptly.
- Title probing, prepared-shell creation, and task enqueue are sibling effects.
- Full playlist expansion, download execution, audio parsing, and loudness
  measurement must not block title feedback.
- A title may arrive before or after task evidence.
- A check icon is legal once the draft has committable shell evidence.
- A loading matrix must end when title/shell evidence makes the candidate
  actionable, even if background work continues.
- No fallback title such as `YouTube video <id>` may be persisted or projected
  as semantic title evidence.
- Background downloads must not lock paste admission or title probes.

Owners:

- `src/flow/pasteDownload/core.ts`: candidate reflection functor.
- `src/flow/pasteDownload/machine.ts`: candidate-scoped operator and async
  ownership.
- `src/flow/pasteDownload/titleProbeQueue.ts`: title-probe liveness operator.
  It owns bounded concurrency, candidate-scope cancellation, and late-evidence
  rejection. It does not own download admission, provider expansion, or
  candidate projection.
- `src/components/ListConfig*`: render projection only.
- `src-tauri/src/domain/downloads/service.rs`: task admission and provider
  root-title command.
- `src-tauri/src/domain/collection_import.rs`: prepared collection shell.

Checkers:

- `src/flow/pasteDownload/machine.test.ts`
  - admits later pasted URLs while an earlier URL is still resolving;
  - starts root title probing and enqueue as sibling effects after resolution;
  - starts later title probes while an earlier title probe is still running.
- `src/flow/pasteDownload/titleProbeQueue.test.ts`
  - bounds default concurrency;
  - runs probes concurrently;
  - drops late evidence after cancellation or candidate-scope replacement.
- `src/flow/pasteDownload/core.test.ts`
- `src/components/ListConfig*.test.ts`
- `src-tauri/src/domain/downloads/service.test.rs`

Closed paths:

- No `enqueue -> full playlist expansion -> title -> frontend` dependency.
- No ffplayr or loudness dependency in paste feedback.
- No UI lock caused by active download workers.
- No module-global actor sink for async title evidence.

### 2. Config Hover Lease And Scroll Horizon Contract

Behavior:

```text
Pointer x ScrollViewport x ItemGeometry -> Stops<HoverLease>
HoverLease -> PortalOverlayProjection
```

Contract:

- Hover overlay is a presentation lease, not item state.
- Scroll movement changes the horizon. If the pointer leaves the owning item by
  scroll, the lease closes even when the physical pointer does not move.
- If scrolling moves a new item under the stationary pointer, that new item may
  acquire the hover lease.
- Overlay projection must be clipped or closed according to the owning item and
  viewport lease. Portal rendering cannot bypass lease closure.
- Hover must not change font weight unless explicitly designed by the item
  model.
- Wheel behavior must remain continuous. Hover handling cannot quantize scroll.

Owners:

- `src/components/toolLabelHoverLease*`: lease operator.
- `src/components/toolLabelOverlayGeometry.ts`: portal geometry functor and
  scroll horizon interpreter.
- `src/components/toolLabelPointerTracker.ts`: pointer evidence journal and
  sync-demand operator.
- `src/components/ListConfig*`: config item projection.
- `src/components/ArcTrackList*`: arc item projection and geometry.

Checkers:

- `src/components/toolLabelHoverLease.test.ts`
- `src/components/toolLabelOverlayGeometry.test.ts`
- `src/components/toolLabelPointerTracker.test.ts`
- `src/components/ListConfig.ghost-*.test.ts`
- `src/components/ArcTrackList.test.ts`

Closed paths:

- No DOM portal overlay that survives a closed lease.
- No hover-driven semantic item mutation.
- No document pointer tracker that owns hover truth.
- No scroll path whose behavior depends on whether the pointer recently moved.

### 3. Playlist Pending First-Track Contract

Behavior:

```text
PlaylistClick -> playPlaylist(name) -> Valid(started) | Stops(pending_first_track)
```

Contract:

- `play` means accepted playback, not click intent.
- `pending_first_track` is a real rejected morphism with evidence.
- The UI shows `preparing` only when the selected playlist has no playable
  current music and the backend is preparing/downloading the first playable
  source for that playlist.
- `preparing` is not a generic loading state for all play clicks.
- When first-track evidence becomes playable, the pending path must continue
  into accepted playback promptly. It must not return to `ready` and require
  manual clicking.
- Playback acceptance must not wait for loudness measurement, next-track
  recommendation, candidate-window materialization, or model training.

Owners:

- `src/flow/appLogic/index.ts`: action facade and request epoch.
- `src/flow/appLogic/machine.ts`: Chart projection.
- `src-tauri/src/domain/playlist_playback/playable_index.rs`: prepared
  first-slot credentials.
- `src-tauri/src/domain/playlist_playback/service.rs`: backend start operator.
- `src-tauri/src/domain/player/service.rs`: player acceptance interpreter.

Checkers:

- `src/flow/appLogic/machine.test.ts`
  - pending first-track remains `ready + preparing` evidence;
  - accepted playback after pending first-track enters `play` and clears the
    pending request.
- `src/flow/appLogic/playlistPlaybackPendingWakeup.test.ts`
  - download-task wakeup demand is created only for
    `phase=preparing, reason=pending_first_track`;
  - stale wakeups close as `Stops` and do not start playback.
- `src-tauri/src/domain/playlist_playback/playable_index.test.rs`
- `src-tauri/src/domain/playlist_playback/service.test.rs`
- `src-tauri/src/domain/player/service.test.rs`

Closed paths:

- No synchronous first-track preparation on the click path.
- No `playStarting` page state.
- No loudness or recommendation delay before first track playback.

### 4. Accepted Playback And Now-Playing Evidence Contract

Behavior:

```text
BackendStartedEvidence x PlayerNowPlayingEvidence -> PlayProjection
```

Contract:

- Accepted playback and now-playing events are independently owned.
- They may arrive in either order.
- Early now-playing evidence may be cached by pending playlist coordinate, but
  cannot project `play` by itself.
- Late or stale now-playing evidence must be ignored unless it matches the
  current playlist/session/request identity.
- When accepted playback arrives, matching cached now-playing evidence should
  project atomically with the play page.

Owners:

- `src/flow/appLogic/index.ts`: frontend request epoch.
- `src/flow/appLogic/machine.ts`: accepted projection.
- `src-tauri/src/domain/player/service.rs`: now-playing feedback.

Checkers:

- `src/flow/appLogic/machine.test.ts`
- `src-tauri/src/domain/player/track_identity_substitution.test.rs`

Closed paths:

- No trace/log event as state.
- No stale now-playing projection after stop, back, same-playlist toggle, or
  newer play intent.

### 5. Spectrum Range Commit Contract

Behavior:

```text
SpectrumDraftRange -> PlaylistMusicIdentityUpdate -> PlayerIdentitySubstitution
```

Contract:

- `start_ms` is the playback origin signal.
- `end_ms` is the end gate signal.
- Editing range in the spectrum draft must not restart current playback when
  playback is active and not paused.
- `back/check` returns to play immediately. Persistence is a background
  epoch-owned effect.
- A paused spectrum preview may issue exactly one scoped player request before
  back when the committed identity needs to preserve paused preview position.
- Accepted persistence may request identity substitution, but substitution must
  not resume playback merely because persistence completed.

Owners:

- `src/components/spectrum/SpectrumVisualizer.model.ts`: draft and geometry.
- `src/flow/appLogic/machine.ts`: page and optimistic projection.
- `src-tauri/src/domain/playlists/repo.rs`: persisted music identity.
- `src-tauri/src/domain/player/track_identity_substitution.rs`: substitution
  transformation.
- `src-tauri/src/domain/player/service.rs`: active playback session.

Checkers:

- `src/components/spectrum/SpectrumVisualizer.test.ts`
- `src/flow/appLogic/machine.test.ts`
- `src-tauri/src/domain/player/service.test.rs`
- `src-tauri/src/domain/player/strategy.test.rs`
- `src-tauri/src/domain/player/track_identity_substitution.test.rs`

Closed paths:

- No range-as-single-control model that restarts playback whenever either bound
  changes.
- No persistence result that becomes playback command ownership.

### 6. Title Handoff Contract

Behavior:

```text
SourceTitleLease x ReturnSurface -> ChartPatch
```

Contract:

- Playlist title handoff is presentation lease behavior, not playlist identity
  mutation.
- Title handoff must retain the old title through the visible transition and
  release it explicitly.
- App-level title tone and playlist title handoff must share lease language,
  not field-passing accidents.

Owners:

- `src/components/playListTitleHandoff.model.ts`
- `src/components/playListTitleReturnSurface.model.ts`
- `src/flow/appLogic/machine.ts`

Checkers:

- `src/components/playListTitleHandoff.model.test.ts`
- `src/components/playListTitleReturnSurface.model.test.ts`
- `src/flow/appLogic/machine.test.ts`

Closed paths:

- No title reset by deleting fields.
- No title animation that changes persistent playlist identity.

### 7. Optimistic Commit Baseline Contract

Behavior:

```text
OptimisticPlan x BaselineShape -> CommitEvidence -> Reflect | Rebase | Reject
```

Contract:

- Optimistic projection must carry its baseline.
- Accepted backend evidence must reflect against the baseline or explicitly
  rebase.
- Updating a music or collection by old range/name coordinates is legal only
  when the baseline coordinate is still valid.
- Stale commit evidence returns `Stops`; it cannot silently patch the current
  unrelated shape.

Owners:

- `src/flow/playlistCommit/*`: commit queue owner.
- `src/flow/appLogic/core.ts`: app shape product and draft projection.
- `src/flow/appLogic/musicTitle.ts`: title/range projection helpers.
- `src-tauri/src/domain/playlists/repo.rs`: accepted persistence evidence.

Checkers:

- `src/flow/playlistCommit/*.test.ts`
- `src/flow/appLogic/machine.test.ts`
- `src-tauri/src/domain/playlists/*.test.rs`

Closed paths:

- No current-context patching of evidence accepted for an older transaction
  unless an explicit rebase operator accepts it.
- No playlist persistence evidence may clear or publish a preview unless it
  reflects against the active `PlaylistCommitFrame`.
- No spectrum accepted update/delete evidence may silently succeed when its
  target coordinate is absent from the commit baseline.

### 8. Startup Bootstrap And Ready Projection Contract

Behavior:

```text
StartupEvidence x LibraryProjection x FirstSlotPool -> ReadyProjection
```

Contract:

- Deleting the database may trigger initial model training because there is no
  persisted evidence.
- Startup transaction conflicts may retry or recover; they must not poison
  later ready behavior.
- Ready projection must not hide existing playable playlists.
- First-slot preparation is process-lifetime backend pool work. It is not a UI
  loading requirement for entering ready.
- Hot reload or app bootstrap must not collapse playlist items into only
  `Create a list` when playlist data exists.

Owners:

- `src/flow/bootstrap/index.ts`
- `src/flow/appLogic/index.ts`
- `src/flow/appLogic/machine.ts`
- `src-tauri/src/domain/playlist_playback/playable_index.rs`
- `src-tauri/src/domain/playlist_playback/recommendation.rs`

Checkers:

- `src/flow/appLogic/machine.test.ts`
- `src-tauri/src/domain/playlist_playback/playable_index.test.rs`
- `src-tauri/src/domain/playlist_playback/recommendation*.test.rs`

Closed paths:

- No cache/training failure as ready-state deletion.
- No ready-entry effect that silently redefines library truth.

### 9. Download Pipeline Contract

Behavior:

```text
TaskAdmission -> RootTitleEvidence -> LeafPipeline -> CollectionEvidence
```

Contract:

- Task admission is separate from title probing and leaf execution.
- URL parsing and root title probing must stay available while downloads run.
- Provider leaf expansion may be concurrent when safe, but cannot delay the
  frontend title/check feedback path.
- Media duration and loudness evidence belong at the tail of materialized music
  work, not at paste admission.
- Local file duration is decoded frame evidence in the same coordinate system as
  waveform analysis; provider duration and old manifest end values are only
  boundary hints.
- Manifest recovery must decode existing local files before accepting a
  full-file `Music.end_ms`; it must preserve partial ranges that do not target
  the file tail.
- Recovery resumes residual work and emits task evidence; it does not own
  frontend candidate lifecycle.

Owners:

- `src-tauri/src/domain/downloads/service.rs`
- `src-tauri/src/domain/downloads/yt_dlp.rs`
- `src-tauri/src/domain/collection_import.rs`
- `src-tauri/src/domain/playlists/repo.rs`
- `src-tauri/src/domain/player/waveform.rs` when media probing is required.

Checkers:

- `src-tauri/src/domain/downloads/service.test.rs`
- `src-tauri/src/domain/collection_import.test.rs`
- `src/flow/pasteDownload/*.test.ts`

Closed paths:

- No one-URL full recursive expansion before frontend signal.
- No active download worker as global URL parsing lock.
- No fallback provider title derived from URL id.
- No waveform-cache manifest as persisted music duration truth.
- No UI compensation for wrong persisted file-tail end.

### 10. Loudness Evidence Contract

Behavior:

```text
MusicRange x AudioFile -> LoudnessEvidence
LoudnessEvidence x PlaybackRequest -> PlayerGainInstruction
```

Contract:

- `Music.loudness` is owned evidence for the marked music interval.
- A value of `0` means missing/unmeasured evidence, not semantic silence.
- Download tail work may request loudness evidence after file persistence.
- Runtime startup may restore only explicitly pending loudness tasks from the
  local pending-task file; it must not scan the library for `loudness == 0`.
- Same-turn playback must start immediately when a prepared first credential is
  already available, even when loudness is missing.
- The already accepted `pending_first_track`/`Preparing...` branch may wait for
  `LoudnessEvidence` after the backend first track is resolved and before it is
  submitted to the player. This wait consumes the loudness owner result; it does
  not let playback measure by itself or scan the library.
- Missing loudness may trigger a background measurement and database update.
- First-slot preparation may promote an accepted prepared first credential to
  the front of the loudness evidence queue when its loudness is still missing.
- First-track consumption may promote the resolved first track to the front of
  the loudness evidence queue when its loudness is still missing.
- Next-track selection may promote the selected next track to the front of the
  loudness evidence queue when its loudness is still missing.
- `ffplayr` may implement the measurement capability, but the Slisic domain
  owns when evidence is accepted and persisted.

Owners:

- `src-tauri/src/domain/loudness_evidence.rs`: queue, measurement, persistence.
- `src-tauri/src/domain/downloads/service.rs`: tail request scheduling.
- `src-tauri/src/domain/player/service.rs`: playback request and gain use.
- `ffplayr`: measurement interpreter capability.
- `src-tauri/src/domain/playlists/repo.rs`: persistence.

Checkers:

- `src-tauri/src/domain/downloads/service.test.rs`
- `src-tauri/src/domain/player/service.test.rs`
- `src-tauri/src/domain/playlists/*.test.rs`

Closed paths:

- No loudness measurement on the same-turn play-click critical path.
- No waiting-first loudness measurement outside the already accepted
  `Preparing...` branch.
- No UI paste dependency on loudness.
- No loudness evidence request may change the selected next track.
- No startup or idle library scan for missing loudness evidence.
- No FirstSlot preparation or local cargo restore may scan the library or block
  on loudness measurement.

## Current Source Classification

This table records current source risk. It does not claim migration completion.

| Area                                        | Current risk                                                                                      | Required direction                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `src/flow/appLogic/*`                       | AppSpace, Chart, runtime effects, request epochs, and reset behavior are still close together.    | Extract only after a contract names which page transition and checker are preserved. |
| `src/flow/pasteDownload/*`                  | Candidate-local ownership is mostly explicit, but regressions show timing contracts are fragile.  | Protect title-first/check-icon/paste-admission before changing surrounding runtime.  |
| `src/components/ListConfig*`                | Config layout, paste affordance, hover, and scroll horizon can interfere.                         | Treat hover and scroll as lease/horizon behavior, not CSS polish.                    |
| `src/components/ArcTrackList*`              | Portal hover and stationary-pointer scroll behavior are presentation leases.                      | Lock geometry/lease tests before visual refactors.                                   |
| `src/components/spectrum/*`                 | Draft range, playback scope, waveform demand, and commit projection are co-located.               | Preserve independent start/end signals and background persistence semantics.         |
| `src-tauri/src/domain/downloads/service.rs` | Admission, root title, leaf work, recovery, broadcasts, and tail measurements are close together. | Split by interaction contract: paste feedback first, tail pipeline later.            |
| `src-tauri/src/domain/playlist_playback/*`  | First-slot pool, playback start, recommendation, training, and queue refresh are intertwined.     | Keep first-track click path bounded by prepared credential and player acceptance.    |
| `src-tauri/src/domain/player/*`             | Session, range guard, loudness, waveform, and scope effects are coupled.                          | Preserve no-restart range substitution and immediate playback.                       |
| `src-tauri/src/domain/playlists/repo.rs`    | Store writes, view projection, collection membership, and exclude availability are co-located.    | Split persistence from projection only when commit/rebase contracts are covered.     |

## Reverted Attempt Record

The following slices were attempted before this ledger was corrected and then
reverted from source. They must not be treated as completed work:

- appLogic runtime interpreter extraction
- playback mode runtime extraction
- downloads root title probe extraction
- Rust fixture projection extraction
- player playback range guard extraction
- audio style model evidence extraction
- audio style embedding cache extraction
- audio style embedding pipeline extraction
- audio style candidate selection extraction
- audio style route pressure extraction

Some of these ideas may be reintroduced, but only after a contract-first record
names the UX path, owner, `Stops`, interpreter boundary, and checker. Reusing a
reverted file split without re-deriving it from interaction contracts is
invalid.

## Slice Selection Rule

The next slice must be a vertical behavior slice. Recommended order:

1. Paste import contract checker reinforcement.
2. Playlist pending-first-track checker reinforcement.
3. Spectrum range no-restart checker reinforcement.
4. Config hover lease and scroll horizon checker reinforcement.
5. Only then extract or deepen the smallest owner that a failing or missing
   checker proves.

Backend-only cleanup is not a legal next slice when it can change frontend
timing. Frontend-only cleanup is not legal when backend evidence timing is part
of the same interaction.

## Generalization Rule

When a later change reveals that an earlier migration step encoded a special
case of a more general algebraic rule, the special case must not remain as a
parallel path.

Required action:

1. Delete the special path when the general path covers it.
2. Or rewrite the special path as a named instance of the general path.
3. Update this ledger with the decision and the checker.

Compatibility shims are allowed only for explicitly retained user-facing or
persisted formats. Database compatibility is not assumed during this migration
unless explicitly stated.

## Validation Ledger

Current ledger update:

- Source reconciliation: current code is `f3b375e`; previous module extraction
  work is not present.
- Toolchain: frontend uses Bun scripts in `package.json`; backend uses Cargo in
  `src-tauri/Cargo.toml`.
- Ya reference read: `Definition.hs`, `Patterns.hs`, and `Effectful.hs`.
- Code changes: no production source changed. Added one sidecar checker in
  `src/flow/pasteDownload/machine.test.ts` for concurrent paste admission while
  an earlier URL is still resolving.
- Tests: `bun test src/flow/pasteDownload/machine.test.ts` passed.

Pending first-track update:

- Added `src/flow/appLogic/playlistPlaybackPendingWakeup.ts` as a small
  operator for `PendingPlaybackRequest -> WakeupDemand or Stops`.
- Updated `src/flow/appLogic/index.ts` to use that owner for download-task
  wakeups while leaving the action facade and backend start interpreter in
  place.
- Added `src/flow/appLogic/playlistPlaybackPendingWakeup.test.ts` to lock the
  strict preparing condition and stale request negative path.
- Tests:
  `bun test src/flow/appLogic/playlistPlaybackPendingWakeup.test.ts src/flow/appLogic/machine.test.ts src/components/PlayListPage.test.ts src/flow/pasteDownload/machine.test.ts`
  passed.
- Typecheck: `bun run typecheck` passed.

Paste title-probe queue update:

- Added `src/flow/pasteDownload/titleProbeQueue.ts` as the liveness operator
  for `TitleProbeDemand -> RootTitleEvidence or Stops`.
- The queue captures the candidate-local sink in each demand. Async title
  evidence is scoped by candidate id plus a replacement token, so cancellation
  and candidate replacement close stale future paths instead of silently
  projecting late titles.
- Updated `src/flow/pasteDownload/machine.ts` so URL resolution maps new URLs
  into two sibling effects: `TitleProbeQueue.enqueue` and
  `enqueueCollectionDownload`. Title probing is no longer represented as a
  module-global actor sink.
- Source reconciliation:
  `src-tauri/src/domain/downloads/service.rs::probe_download_root_title_with_client`
  still calls `probe_root_shell_with_limit`, while full collection work calls
  `resolve_collection_plan`. `src-tauri/src/domain/downloads/planning.rs`
  keeps root shell probes on `ROOT_SHELL_PROBE_SLOTS`, separate from full root
  probes on `ROOT_PROBE_SLOTS`.
- Tests:
  `bun test src/flow/pasteDownload/titleProbeQueue.test.ts src/flow/pasteDownload/machine.test.ts`
  passed.
- Typecheck: `bun run typecheck` passed.

Internal framework algebra audit:

- Added `Internal Framework Algebra` to classify modules by public morphism,
  not by folder or implementation technology.
- Ya reference refreshed from:
  `C:/Users/admin/ya/Ya/Algebra/Definition.hs`,
  `C:/Users/admin/ya/Ya/Algebra/Effectful.hs`, and
  `C:/Users/admin/ya/Ya/Program/Patterns.hs`.
- Added `Current Internal Framework Classification` covering frontend flow
  machines, appLogic operators, paste download operators, UX view models,
  hover/ghost/title handoff models, spectrum chart models, Rust download,
  playlist playback, recommendation, player, playlist repo, and meta domains.
- Added UX law: human-orientation behavior is semantic. Loading matrix timing,
  hover retention, stationary-pointer scroll, title handoff weight, pending
  first-track text, optimistic draft visibility, spectrum back timing, and
  paste title feedback may be functorized but cannot be erased.
- Added deepening rules for queues, renderers, view models, service files,
  caches, fallbacks, UX leases/charts/horizons, state-machine composition,
  async owner coordinates, and shortest lawful descriptions.
- Code changes: no runtime source changed in this audit step.
- Typecheck: `bun run typecheck` passed.

Playlist commit-frame update:

- Updated `src/flow/playlistCommit/core.ts` so queued commits are
  `PlaylistCommitFrame` values, not bare draft requests.
- Added `reflectPlaylistCommitEvidence` as the owner of
  `PlaylistCommitFrame x PlaylistUpsertResult -> accepted | Reject | Stops`.
- Updated `src/flow/playlistCommit/machine.ts` so success evidence is reflected
  before publishing `playlistUpserted`. Rejected evidence closes the current
  optimistic preview but does not publish a playlist.
- Added `src/flow/playlistCommit/machine.test.ts` coverage for mismatched
  persistence evidence.
- Tests: `bun test src/flow/playlistCommit/machine.test.ts` passed.
- Typecheck: `bun run typecheck` passed.

Spectrum accepted-evidence baseline update:

- Updated `src/flow/appLogic/spectrumEditTransaction.ts` so accepted update
  and delete evidence must target music coordinates present in the commit
  baseline before projection can be accepted.
- Added `src/flow/appLogic/spectrumEditTransaction.test.ts` coverage for
  missing baseline target rejection.
- Updated `src/flow/appLogic/musicTitle.test.ts` to reflect the current
  `Music.loudness = 0` schema for pending spectrum creates.
- Tests:
  `bun test src/flow/appLogic/spectrumEditTransaction.test.ts src/flow/appLogic/musicTitle.test.ts src/flow/appLogic/machine.test.ts`
  passed.
- Typecheck: `bun run typecheck` passed.

Owner-scoped app reset update:

- Updated `src/flow/appLogic/core.ts` so `resetContextWith` accepts
  `ContextResetPatch` grouped by `shape`, `runtime`, `chart`, `lease`,
  `transaction`, `pending`, and `journal` owners.
- Updated `src/flow/appLogic/machine.ts` reset call sites to patch context
  through those owner coordinates instead of a flat kept-field bag.
- This makes chart close, lease release, and transaction close explicit at
  every reset seam. Reset is now a lifecycle operation with grouped owner
  preservation, not accidental field deletion.
- Added `src/flow/appLogic/core.test.ts` coverage that chart, lease, and
  transaction fields reset unless their owner patches preserve them.
- Updated `src/components/playListPlaybackSurface.model.ts` so playback surface
  liked state remains visual evidence: only `true` projects as liked, while
  `false` and missing evidence stay `null`. Backend default false no longer
  becomes surface-owned UI evidence.
- Tests:
  `bun test src/flow/appLogic/core.test.ts src/flow/appLogic/machine.test.ts src/components/ListConfig.test.ts src/components/PlayListPage.test.ts src/components/playListTitleHandoff.model.test.ts src/components/playListPlaybackSurface.model.test.ts`
  passed.
- Wider behavior tests:
  `bun test src/flow/pasteDownload/titleProbeQueue.test.ts src/flow/pasteDownload/machine.test.ts src/flow/pasteDownload/core.test.ts src/flow/appLogic/playlistPlaybackPendingWakeup.test.ts src/flow/appLogic/spectrumEditTransaction.test.ts src/flow/appLogic/musicTitle.test.ts src/flow/appLogic/core.test.ts src/flow/appLogic/machine.test.ts src/flow/playlistCommit/machine.test.ts src/components/ListConfig.test.ts src/components/PlayListPage.test.ts`
  passed with 187 tests.
- Typecheck: `bun run typecheck` passed.

ToolLabel pointer tracker update:

- Added `src/components/toolLabelPointerTracker.ts` as the document-level
  pointer evidence journal and hover-sync-demand operator.
- Updated `src/components/toollabel.tsx` to consume the tracker by import while
  keeping hover lease semantics in `src/components/toolLabelHoverLease.ts`.
- The tracker records pointer/wheel evidence and owns retain/release listener
  lifecycle. It does not decide whether hover is open.
- Added `src/components/toolLabelPointerTracker.test.ts` coverage for
  one-listener-per-document retain, release-at-zero cleanup, pointer evidence
  updates, clear-on-leave/blur, wheel sync requests, and unsubscribe behavior.
- Tests:
  `bun test src/components/toollabel.test.ts src/components/toolLabelHoverLease.test.ts src/components/toolLabelPointerTracker.test.ts src/components/ListConfig.test.ts src/components/ArcTrackList.test.ts`
  passed with 82 tests.
- Typecheck: `bun run typecheck` passed.
- Local static checks:
  `bunx oxfmt --check src/components/toollabel.tsx src/components/toolLabelPointerTracker.ts src/components/toolLabelPointerTracker.test.ts`
  passed.
- Local lint:
  `bunx oxlint src/components/toollabel.tsx src/components/toolLabelPointerTracker.ts src/components/toolLabelPointerTracker.test.ts`
  passed.

ToolLabel overlay geometry update:

- Added `src/components/toolLabelOverlayGeometry.ts` as the owner of portal
  overlay geometry projection and scroll horizon collection.
- Updated `src/components/toollabel.tsx` to import geometry and horizon helpers
  while keeping overlay rendering, hover lease admission, and pointer evidence
  ownership in their existing modules.
- Added `src/components/toolLabelOverlayGeometry.test.ts` coverage for left and
  right portal style projection, stable rect equality, scrollable overflow
  classification, nearest-to-farthest scroll container collection, and owner
  window propagation.
- Tests:
  `bun test src/components/toolLabelOverlayGeometry.test.ts src/components/toollabel.test.ts src/components/toolLabelHoverLease.test.ts src/components/toolLabelPointerTracker.test.ts src/components/ListConfig.test.ts src/components/ArcTrackList.test.ts`
  passed with 87 tests.
- Typecheck: `bun run typecheck` passed.
- Local static checks:
  `bunx oxfmt --check src/components/toollabel.tsx src/components/toolLabelOverlayGeometry.ts src/components/toolLabelOverlayGeometry.test.ts`
  passed.
- Local lint:
  `bunx oxlint src/components/toollabel.tsx src/components/toolLabelOverlayGeometry.ts src/components/toolLabelOverlayGeometry.test.ts`
  passed.
