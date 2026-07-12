# Remote Playback Liveness Proof

## Unique Final Goal

After one user play gesture on iOS/Arc, one native HLS media session must continue producing
ordered audible audio in the foreground, background, and lock screen across stable, constrained,
flapping, and changing network paths. It may stop only after an explicit user pause/stop or after
sustained physical throughput below the encoded bitrate has exhausted every committed byte.

## 1. Definitions And Scope

- `AudiblePlayout` is evidence from the one native `HTMLAudioElement`: advancing media time while
  decoded real-media fragments cross native playback boundaries. Metadata, a Media Session clock,
  ICE state, and a moving silent priming segment are not audible evidence.
- `SupplyEpoch` is one PeerConnection and its HLS DataChannel writer. It is live only while every
  published foreground request receives response-header or chunk progress within its lease.
- `DeliveryWindow` is the finite map from transmitted `(requestId, chunkIndex)` identities to their
  byte lengths. Capacity is released only by Hero acknowledging the matching accepted chunk;
  duplicate acknowledgements are identities.
- `ForegroundRequest` is an HLS playback manifest, reserve manifest needed to construct the current
  playback prefix, or media segment demanded by native HLS. `ReserveRequest` is speculative cache
  demand and cannot consume foreground capacity or determine playout legality.
- `CommittedPrefix` is the maximal contiguous sequence of immutable media segments present in
  IndexedDB. Memory buffers and host-side prepared tracks are not committed cache evidence.
- `PrimingPrefix` is silent media belonging to the same HLS media source. It may preserve native
  session eligibility while real media is prepared, but it must never advance track metadata,
  consume real-track time, or count as successful playback.
- Requests are equal by `(MediaEpoch, URL)`. Repetition is idempotent. A priority change preserves
  request identity and may only move from reserve to foreground.
- Timeline order is exact. Existing entries and offsets cannot be reordered or rewritten. Empty
  timelines expose only priming media. Invalid epochs, stale responses, malformed URLs, and late
  async completions are rejected without changing native time or the committed prefix.
- Degradation to relay audio or a second audible media element is forbidden. Relay remains pairing,
  RPC, ICE configuration, and signaling only.

## 2. Completion Standard

The task is complete only when the Unique Final Goal is established for:

1. stable WiFi and cellular paths;
2. effective throughput above bitrate with latency, jitter, and temporary loss;
3. WiFi/cellular handover while foregrounded, backgrounded, or locked;
4. a DataChannel that remains ICE-connected but stops delivering asset progress;
5. playlist start, every track boundary, explicit stop, reconnect, and page refresh;
6. empty, one-track, short-track, and multi-track timelines.

Every critical transition needs independently runnable evidence. Simulation proves only the modeled
transport state. Browser tests prove native state. A real headed iOS/WebKit or user-device trace is
required for background audibility.

## 3. Results That Are Not Complete

The following do not imply the Unique Final Goal:

- ICE, PeerConnection, Relay, or DataChannel reporting connected;
- a manifest request being published;
- a manifest or timeline revision arriving;
- buffer growth while native audio is paused or silent;
- isolated scheduler, cache, or simulation tests passing;
- foreground-only Chromium playback;
- eventual recovery that skips unheard media time;
- extending silent priming without restoring real-media supply;
- replacing P2P audio with relay transport.

## 4. Method Family Registry

| Family | Core mechanism | Strictly established result | Exact gap | Status | Reopen condition |
| --- | --- | --- | --- | --- | --- |
| Queue tuning | Reserve/foreground queue sizing | Prevents known unpublished-request starvation | Published requests can still receive zero progress | refuted | New queue invariant that proves end-to-end progress |
| Infinite priming | Extend silent HLS indefinitely | Preserves one media source while waiting | Cannot produce audible audio when supply is dead | blocked | Independent proof that supply recovery is bounded |
| Dual DataChannel | Separate metadata and media SCTP streams | Can isolate application queues | Association congestion/retransmission may remain shared | exploring | Real browser trace showing independent progress under loss |
| Local SCTP capacity lease | Treat Host `buffered_amount` decrease as delivery progress and terminate the SupplyEpoch after five seconds without decrease | Bounds a locally observed SCTP queue | Windows/macOS WebRTC implementations do not provide a reliable portable progress observation; a healthy high-RTT path is falsely terminated | refuted | A WebRTC implementation guarantee that makes the observation portable |
| Application delivery window | Hero acknowledges each accepted chunk identity; acknowledgements release a bounded Host window | Network lab proves delayed local SCTP accounting cannot stop progress; Rust negotiated-DataChannel test transfers an asset larger than twice the window; zero delivery still expires the Hero asset lease | Real iOS/Arc background and lock-screen execution remains unproved | promising | N/A |
| Supply lease | Foreground asset progress terminates a truly dead SupplyEpoch and replays immutable demand | State tests prove terminal replacement, automatic replay, native-time preservation, and reserve/foreground lease separation | Real iOS/Arc background and lock-screen execution remains unproved | promising | N/A |
| SafariDriver | Headed macOS Safari with trusted WebDriver input | Session creation, navigation, relay/P2P connection, and HLS timeline delivery are observable | Both element-click and W3C pointer actions block before returning a trusted play gesture | blocked | A driver/input mechanism that produces a bounded trusted click |
| Relay media | Move HLS bytes through relay | Avoids the current P2P writer | Violates the P2P media requirement | refuted | Product requirement explicitly changes |

Blocked families are not described as nearly complete. They reopen only under the condition listed
above.

## 5. Required Artifact Per Iteration

Each branch must produce at least one of:

- a state transition and invariant;
- a minimal replayable failure trace;
- a failing then passing public-seam test;
- a transport simulation with an explicit modeled boundary;
- a concrete counterexample;
- a precise unproved gap.

Status text without such an artifact is not progress.

## 6. Adversarial Review

An independent review must check every candidate against:

1. ICE connected while foreground asset progress is zero;
2. two reserve requests already in flight when a manifest arrives;
3. promotion before and after host asset publication;
4. loss during one binary frame and during handover;
5. background or lock immediately after the user gesture;
6. first real fragment beginning at track position zero;
7. native time freezing during silence, stalls, and SupplyEpoch replacement;
8. stale response rejection after replacement;
9. no relay media, second audio element, hidden seek, or skipped range;
10. physical throughput below bitrate as the only allowed involuntary exhaustion case.

The reviewer reports a concrete counterexample or an itemized pass. A summary approval is invalid.

### First Independent Review

The first review rejected completion with four executable counterexamples:

1. replacement rejected the original demand and depended on a future loader retry;
2. reserve-to-foreground promotion inherited an almost-expired reserve lease;
3. the Rust writer bounded drain waiting but not `send().await`, and drain progress did not renew
   the lease;
4. a stale answer could erase a newer generation's signaling replay.

All four now have failing-then-passing sidecar tests. A subsequent generalized-constraint review
found the same reject-before-replacement defect on DataChannel close; that path now uses the same
automatic-demand-replay invariant and has its own failing-then-passing test.

The remaining review failure is environmental:
browser-side recovery timers and callbacks are not proven to execute while iOS/Arc is locked. A
desktop simulation or foreground Safari run cannot discharge that obligation.

### Second Independent Review

The second review passed timeout replay, promotion, stale-answer replay, and the three modeled Rust
writer trajectories, then found four further finite-lifecycle gaps:

1. the first `buffered_amount()` future could itself remain pending;
2. replacement `createOffer()` could remain pending while replay demand had no active lease;
3. demand waiting for a channel survived dispose until its timeout;
4. a late old-channel frame could collide with a reused 32-bit request ID.

These now have explicit guards and sidecar evidence: the initial getter is leased, negotiation is
leased and retries through a fresh SupplyEpoch, reset/dispose rejects ready waiters immediately,
old-channel messages are rejected by channel identity, and request IDs skip every live pending ID.

### Third Independent Review

The third review rejected the claim that only device evidence remained. It found four additional
counterexamples:

1. a second failure of the same replayed demand was suppressed by session failure-level dedupe;
2. a stale answer from an earlier negotiation in the same SupplyEpoch could clear a newer offer;
3. an unbounded `try_recv` drain could starve the Rust writer before any send lease applied;
4. malformed chunk totals could throw inside an unobserved async DataChannel handler.

The implementation now treats every foreground asset failure as a terminal fact while
`P2pAssetSupply.replace` owns idempotency, identifies signaling by
`(SupplyEpoch, NegotiationRevision)`, limits response ingestion before each scheduled frame, and
validates aggregate chunk length with an observed handler failure path. These changes have
failing-then-passing sidecar tests. A further independent review is required before reducing the
remaining gap to real iOS/Arc scheduling and audibility.

### Fourth Independent Review

The fourth review found that accepted progress, offer deduplication, queue memory, retry frequency,
and disposal still lacked complete bounds. The implementation now:

- renews an asset lease only for a first valid header or a unique in-range chunk;
- rechecks channel identity after asynchronous Blob conversion;
- deduplicates offers by socket, SDP, generation, and negotiation revision;
- uses fixed-capacity response and unmatched-promotion storage;
- leases every host and browser negotiation await and applies exponential replacement backoff;
- rejects ICE waiters on close and makes connect-after-dispose an identity operation.

Each item has an independently runnable sidecar counterexample. Another review must still verify
that these bounds compose before the remaining obligation can be reduced to device evidence.

### Fifth Independent Review

The fifth review found five compositional counterexamples that the earlier local bounds did not
exclude:

1. an unordered binary chunk could arrive before its header and be discarded permanently;
2. a silently lost answer had no total lease and could leave the browser in `have-local-offer`;
3. a full bounded Rust response queue rejected and lost an already resolved foreground asset;
4. stale unmatched promotions could occupy the fixed set forever and suppress newer promotions;
5. four separately leased host negotiation phases admitted a total wait near four leases.

The receiver now retains a bounded preheader chunk prefix and validates it when the header arrives.
Every unanswered negotiation owns one total deadline; expiry substitutes a new SupplyEpoch while
retaining the same demand, including across consecutive lost answers. Rust response publication now
uses bounded asynchronous backpressure instead of overflow loss, unmatched promotions evict the
oldest stale identity, and all host negotiation phases share one total lease. Browser offer creation
and local-description installation also share one lease, and stale asynchronous answer completion
cannot clear a newer epoch's lease. All five counterexamples have failing-then-passing sidecar tests.
A sixth independent review must verify their composition before deployment.

### Sixth Independent Review

The sixth review rejected completion with five further composition failures:

1. FIFO eviction could let invalid promotions displace a real pending promotion;
2. preheader storage bounded chunk count but not bytes per frame or aggregate bytes;
3. a timed-out host negotiation retained its partially mutated peer;
4. an initial browser negotiation timeout retained its half-open peer and had no automatic retry;
5. a DataChannel closing during replacement could hit the replacement guard and reject replay demand.

The outbound scheduler now registers accepted request identities before domain resolution and accepts
promotion only for a registered live request. Asset completion or an error retires that identity.
Browser frames are bounded to the protocol's 16 KiB message size and preheader storage has an
aggregate byte bound. Host negotiation failure atomically removes and closes only the exact peer
that timed out. Browser initial negotiation failure resets that peer and enters bounded replacement
retry. A close during replacement preserves replay demand and schedules another ownership transfer;
the retry reschedules while a prior replacement is still settling. These counterexamples now have
sidecar tests. A seventh independent review is the remaining software-review obligation.

### Seventh Independent Review

The seventh review found one final generation-identity counterexample: an `open` callback already
queued by an obsolete channel could run after a replacement channel closed, clear the new
replacement retry, and resolve ready waiters with the obsolete channel. DataChannel `open` now
checks canonical channel identity before changing any state, matching the existing identity guards
on `close`, `message`, Blob continuation, answer, and negotiation completion. The replacement-close
test now injects this exact late-old-open interleaving. An eighth independent review is required
before the software obligation can be marked closed.

### Eighth Independent Review

The eighth review found that candidate and error signaling did not yet share answer's canonical
generation identity. A delayed candidate without a generation, or an unversioned error, could
mutate retry or ICE state in a replacement generation. Offer, answer, candidate, and error protocol
types now require generation identity; error also carries the negotiation revision. Browser
handlers reject every stale generation and reject stale nonzero error revisions. Host errors echo
the generation and revision of the signal that failed. A sidecar test proves stale candidate and
error signals cannot mutate a replacement generation. A ninth independent review is required
before closing the software obligation.

### Ninth Independent Review

The ninth review found that an asset requested before DataChannel open still lacked canonical
ownership: `requestAsset` waited for the channel before creating a queued demand, so channel-open
timeout could reject the promise and leak its desired priority. Asset demand is now inserted into
the canonical queue at the API boundary, independent of transport readiness. Answer application
starts a channel-open lease; expiry substitutes a new SupplyEpoch while replaying the same queued
demand. Completion or terminal reset releases its desired priority. The regression test proves a
foreground demand survives a never-opened channel, is fulfilled by the replacement generation, and
leaves no priority state behind. A tenth independent review is required before closing the software
obligation.

### Tenth Independent Review

The tenth review found no reachable software counterexample for permanent demand loss, stale
generation mutation, unbounded protocol state, false completion, or an unrecoverable half-state.
The software obligation is closed by the composition of canonical queued demand, answer and
channel-open leases, cross-generation replay, strict signaling identity, bounded backpressure,
and exact peer discard. The remaining obligation is empirical: a real iOS/Arc trace must show
audible foreground, background, and lock-screen playout plus Wi-Fi/cellular handover recovery.

### Eleventh Independent Review

Production cellular traces refuted the tenth review's capacity-composition premise. Two independent
counterexamples were found:

1. the Host treated five seconds without a decrease in its local SCTP `buffered_amount` observation
   as a dead supply path, although Hero could still accept chunks; on Windows this repeatedly closed
   healthy `SupplyEpoch`s under cellular RTT;
2. Hero owned a six-second startup cache prefix while the Host independently required sixty seconds,
   so the same readiness fact was accepted by one side and rejected by the other.

The first counterexample is removed by an application-level delivery window keyed by
`(requestId, chunkIndex)`. Hero acknowledges only valid accepted chunks, duplicate ACKs are
idempotent, malformed or stale chunks are not acknowledged, and the Host admits no more than the
strict byte bound before waiting for matching evidence. The existing network lab now distinguishes
local SCTP observation from physical delivery and proves three trajectories: the old capacity lease
falsely rebuilds, removing it without delivery evidence stalls until the asset lease rebuilds, and
the ACK window completes without rebuild. A zero-throughput trajectory still rebuilds exactly once.
A negotiated Windows DataChannel test transfers more than twice the window and checks every chunk
coordinate and acknowledgement.

The second counterexample is removed by making Hero the unique startup-prefix owner. The Host now
validates only positive finite current-transaction readiness and cannot strengthen the threshold.
The remaining obligation is empirical device evidence for audible background/lock-screen playback
and Wi-Fi/cellular handover after deployment; it is not discharged by the simulations.

### Twelfth Independent Review

The twelfth review rejected three edge cases left by the first ACK-window implementation:

1. canceling a request did not release its already transmitted delivery identities;
2. a valid chunk arriving before its header did not renew the asset lease, while an arbitrarily
   large preheader chunk index could later renew and acknowledge invalid progress;
3. the ACK-loss experiment skipped Hero's two-stage foreground failure policy and therefore did not
   prove that the same immutable demand crossed a real `SupplyEpoch` replacement.

`CancelThrough` now removes exactly the superseded request identities from both the scheduler and
delivery window. Preheader chunks are bounded by frame size, aggregate bytes, count, and index before
they can renew progress or be acknowledged; a unique valid preheader chunk renews progress, while
duplicates are idempotently acknowledged without renewal. The negotiated Rust DataChannel test now
uses production's unordered mode. The Hero public-path test publishes the same URL twice on the
original peer, receives exactly one full Host window on the first attempt, observes two bounded
foreground timeouts, replaces the supply, and completes the same URL from an explicit replacement
header and chunk zero. A final independent rereview passed these counterexamples. The software
obligation is therefore closed; only the real-device empirical obligation stated above remains.

## 7. Resource Allocation

Investigation remains split among independent mechanisms until evidence permits composition:

- native playout and Media Session ownership;
- P2P request/response liveness;
- cache-prefix and boundary correctness;
- network/handover transport;
- iOS background lifecycle.

Work moves toward branches that produce new falsifiable evidence. Repeated queue or timeout tuning
without a new invariant receives no further work.

## 8. Stop Conditions

Completion requires all of the following:

1. the Unique Final Goal is satisfied;
2. no unproved same-strength liveness assumption remains;
3. every scope case in Section 2 is covered;
4. request identity, timeline order, native time, and cache-prefix quantities are exact;
5. adversarial review passes;
6. every review gap is fixed and re-reviewed;
7. a real headed mobile trace demonstrates continuous audible boundaries.

Search failure, passing unit tests, an elegant reduction, a healthy ICE state, or a large committed
reserve is not a stop condition.

## Ownership And Public Seams

| Owner | Owns | Depends on | Must not own | Public seam |
| --- | --- | --- | --- | --- |
| `NativePlayout` | one audio source, native time, audible boundaries | committed media bytes | ICE recovery, recommendation | audio events and boundary callback |
| `AssetSupply` | SupplyEpoch and per-request progress leases | signaling reachability | playback time, metadata | request/progress/failure facts |
| `AssetRepository` | immutable URL resolution and committed prefix | current AssetSupply | recovery policy, track advance | `load(URL)` |
| `Recovery` | substitution of a terminal SupplyEpoch | liveness facts | pause, seek, source replacement | transition/effect definition |
| `PrimingPublisher` | silent prefix until handoff | native manifest demand | readiness truth, track time | priming manifest projection |

`PrimingPublisher` owns one `ProtectedSequence` per handoff transaction. Its manifest projection is
monotone only below that boundary while the transaction is open. Readiness, Host offer, Hero
commit, and the first real timeline entry all carry the same sequence; no participant derives a
replacement boundary from a later native time sample. Once selected, that sequence is affine within
the media epoch: retries may replay it but cannot create a second handoff identity.

## Candidate Transition

```text
ForegroundPublished(epoch, request)
  -> Progress(epoch, request, header-or-chunk)*
  -> Completed(epoch, request)

ForegroundLeaseExpired(epoch, request)
  -> TerminalSupply(epoch)
  -> ReplaceSupply(epoch + 1)
  -> ReplayImmutableDemand(epoch + 1, request.URL)
```

`ForegroundLeaseExpired` cannot pause, seek, replace the HLS source, advance metadata, or discard
the committed prefix. A reserve timeout cannot terminate an otherwise progressing SupplyEpoch.
