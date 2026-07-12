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
- `SctpAdmissionWindow` is the finite local DataChannel send queue bounded by high and low
  watermarks. Its observation controls admission only; it is not end-to-end delivery evidence and
  cannot terminate a `SupplyEpoch`.
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
| Dual DataChannel with attempt closure | Reliable ordered control plus partially reliable coordinate media; each media attempt ends with reliable closure evidence | Captured initial-cellular and two-second handover production E2E both preserve uninterrupted native time; missing coordinates are repaired without replaying delivered chunks | Real iOS/Arc background and lock-screen execution remains unproved | promising | N/A |
| Local SCTP capacity death lease | Treat Host `buffered_amount` decrease as delivery progress and terminate the SupplyEpoch after five seconds without decrease | Bounds a locally observed SCTP queue | Windows/macOS WebRTC implementations do not provide portable delivery progress; a healthy high-RTT path is falsely terminated | refuted | A portable implementation guarantee that local accounting proves remote delivery |
| Local SCTP bounded admission | Use high/low `buffered_amount` watermarks only to bound the sender queue; never infer transport death | Negotiated unordered DataChannel transfers more than twice the window without application ACK; slow-drain and delayed-observation tests preserve the writer until channel close | Real iOS/Arc background and lock-screen execution remains unproved | promising | N/A |
| Application delivery window | Release each 64 KiB Host window only after browser chunk acknowledgements | Bounds unacknowledged application bytes | Initial-cellular trace measures about 145 kbps effective throughput on a physically sustainable path and the replay experiment reproduces buffer exhaustion | refuted | A non-stop-and-wait protocol whose sustainable throughput is independent of browser ACK latency |
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
Browser media frames are bounded to the protocol's 1,200 byte message size and preheader storage has an
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

### Thirteenth Independent Review

The initial-cellular production trace refuted the twelfth review's ACK-window throughput premise.
Startup handoff was bounded and the first real boundary began at track position `0.077 s`, but the
next 18 foreground segments averaged about `145 kbps` effective throughput on a path that could
sustain the `192 kbps` media rate. The browser ACK round trip released each `64 KiB` application
window, so high and variable cellular RTT became serialized send permission. Forward reserve fell
from about `13.5 s` to zero and native HLS stalled even though the PeerConnection remained live.

The replayable network experiment uses the measured service cycles and produces `7.415 s` of
starvation with application-ACK admission; the same `340 kbps` physical path has zero starvation
when local SCTP admission is used. The ACK protocol is therefore removed rather than tuned. The
Host now uses `buffered_amount` only as a bounded local high/low watermark, never as a liveness
lease. Hero remains the unique owner of end-to-end asset progress and replaces a SupplyEpoch only
after its foreground request receives no valid header or chunk progress. A real negotiated
unordered DataChannel transfers more than twice the local high watermark without browser ACKs,
while sidecar tests retain explicit writer cancellation, channel-close, replay, malformed-frame, background,
handover, single-source, timeline, and native-boundary invariants.

The automated obligation is a fresh captured initial-cellular trace and a loss/recovery handover
trace. Real iOS/Arc background and lock-screen playback remains a separate empirical obligation.

### Fourteenth Independent Review

The captured initial-cellular trace refuted reliable SCTP media even after local bounded admission:
`16 KiB` messages under `300 +/- 150 ms` delay and `5%` loss collapsed a `52 KiB` segment to roughly
ten seconds. Setting partial reliability on the same channel restored media throughput but also made
startup control lossy. Fixed repair timers then mistook not-yet-sent chunks for missing chunks and
created duplicate-response pressure.

The accepted protocol assigns each invariant one owner. Reliable ordered control owns requests,
timeline, handoff, and `asset_attempt_finished`. Unordered `maxRetransmits=0` media owns only
`1,200` byte coordinate frames. Hero computes a missing-coordinate complement only after the Host
closes that exact attempt; one short cross-stream reorder grace precedes the next repair attempt.
The original network namespace harness now passes both a session that starts inside the captured
cellular profile and a playback session with a two-second total-loss handover. Neither trace emits
native waiting, pause, or SupplyEpoch replacement after the real boundary.

### Fourteenth Independent Review

The independent rereview rejected four remaining paths. First, the Host still treated a five-second
pending `send()` as transport death. Second, any unrelated segment completion cleared a foreground
request's retry evidence. Third, a stale-open WebRTC state could leave an old writer polling
forever. Fourth, post-header asset bytes and queued demands lacked explicit protocol bounds.

The Host send deadline is removed: send completion has no time-based liveness meaning, while an
actual send error remains a terminal transport fact. Each peer now owns an explicit writer
lifetime consumed by queue wait, send wait, and capacity wait; replacement, close, discard, and
global shutdown cancel it before closing WebRTC. Hero carries the immutable asset URL through
failure and progress facts, and only success for the same URL clears its foreground timeout
evidence. The protocol rejects assets above `8 MiB`, mismatched chunk counts, and more than 64
pending or queued Hero demands; Host rejects an oversized body before enqueueing it.

New sidecar counterexamples cover a slow successful send, cancellation of pending send and
stale-open capacity waits, unrelated progress between repeated foreground timeouts, oversized
headers and Host bodies, and queued-demand overflow. The remaining stop condition is still the
fresh real-device evidence described above.

The follow-up review found four boundary errors in those fixes: timeout evidence used one URL slot
instead of a set, a writer cancelled before subscribing could miss the transition, the 8 MiB asset
bound required 513 chunks while preheader storage allowed only 512, and `close_all` awaited each
WebRTC close before canceling later writers. Timeout evidence is now a finite URL set cleared only
by matching success or a new healthy SupplyEpoch. Idle writer receive checks the current lifetime
value before waiting. Preheader count and bytes derive from the same maximum asset bound, with an
exact 8 MiB all-chunks-before-header test. Global close broadcasts cancellation to every writer
before awaiting any transport close. The corresponding counterexamples pass.

The next review exposed five ownership edges. Writer cancellation now uses `watch::send_replace`,
so cancellation is retained even when no DataChannel receiver exists yet. Every P2P asset success,
including manifests, emits matching URL progress. ICE `connected` no longer clears asset evidence;
only an explicit new `SupplyEpoch` open does. The timeout URL set has a finite 64-entry recovery
bound. Finally, an oversized Host asset emits a deterministic `ok:false` response before returning
its local error, so protocol-capacity failure cannot masquerade as transport death. Production-
sequence tests cover zero-receiver cancellation, manifest success, ICE reconnect without asset
progress, new-epoch reset, finite timeout evidence, and the oversized error frame.

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
