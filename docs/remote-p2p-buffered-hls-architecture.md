# Remote P2P Buffered HLS Architecture

## Status

This is the canonical remote-playback architecture. It supersedes
`remote-share-webrtc-architecture.md`. The current implementation is migrating toward this model;
rules labelled as migration removals describe code that still exists but must not be extended.

## Decision

Remote playback has one audible media object: one `HTMLAudioElement` backed by one
ManagedMediaSource HLS timeline. One `RemotePlaybackSession` owns the composition of control,
supply, timeline, asset, and native playout facts. WebRTC DataChannel transports HLS assets directly
between Host and Hero. Relay transports only pairing, RPC, ICE configuration, and directed
signaling.

The live WebRTC RTP audio track is not a cache and cannot satisfy network handover on Safari builds
without `RTCRtpReceiver.jitterBufferTarget`. It is removed after the buffered HLS path becomes the
only playback owner.

## Domain Language

| Term | Meaning |
| --- | --- |
| `PageSession` | Ephemeral Hero identity preserved across Relay reconnect and replaced with the page. |
| `RelayEpoch` | Monotone identity of one Relay WebSocket connection. |
| `SupplyEpoch` | Monotone identity of one ICE-selected asset-supply path. |
| `MediaEpoch` | Fresh identity of one prepared and subsequently started HLS resource. |
| `PrimingPrefix` | Sliding live window of local silent HLS segments available before real media. |
| `TimelinePrefix` | Immutable ordered HLS entries and segments published so far. |
| `ForwardReserve` | Media already appended ahead of the native playhead. |
| `AssetRepository` | Memory, IndexedDB, and P2P resolution of immutable epoch assets. |
| `AssetScheduler` | The unique priority owner for foreground and reserve asset demand. |
| `AssetRequest` | Idempotent DataChannel request for one manifest or media segment URL. |
| `SctpAdmissionWindow` | Bounded local DataChannel send queue observed through high/low watermarks. |
| `SupplyPath` | Current ICE-selected path used to refill the forward reserve. |
| `StartupReadiness` | Monotone evidence that the required first-track prefix is committed to IndexedDB. |
| `ProtectedSequence` | The first sequence never advertised as priming, chosen once by Hero at readiness. |
| `BoundaryCommit` | Exactly-once Host session advance after native playback crosses an entry. |

## Categories

### Timeline prefixes

Objects are finite prefixes `T0 <= T1 <= ...`. A morphism exists only when every entry and segment
of the source remains at the same offset in the target. The canonical timeline is their filtered
colimit:

```text
T∞ = colim(T0 -> T1 -> T2 -> ...)
```

Recommendation may append a future track. It cannot replace or shift media already published.
Before `StartupReadiness`, the playback manifest advances a bounded silent live window while the
reserve manifest exposes prepared immutable assets. Readiness is accepted only after the required
contiguous cache prefix is persistent. The Host then places the first real segment at the first
sequence that the silent manifest has never advertised. Waiting has no fixed timeout, and handoff
cannot rewrite an advertised segment.

Hero is the unique owner of `ProtectedSequence` because it owns the priming manifest already seen
by native HLS. Publishing readiness freezes the priming prefix at that sequence. The Host may only
offer the same sequence, Hero may only commit the same sequence, and the accepted real-media
timeline must start at that sequence. A rejected offer, expired handoff lease, or replaced supply
replays the same transaction identity; only accepting the committed timeline or resetting the media
epoch releases it. Therefore native-time progress and supply-path changes cannot extend priming
across the pending real-media boundary or rewrite a committed timeline prefix.

Hero is also the unique owner of the required startup prefix because only Hero can observe the
native manifest, persistent cache prefix, and protected sequence together. The Host validates that
readiness is positive, finite, and belongs to the current transaction; it must not recompute a
second duration threshold. This keeps readiness a single cross-process fact instead of two drifting
policies.

Timeline publication belongs to the active P2P control sink. A handoff commit and its resulting
timeline revision are one transaction on that sink; appended tracks use the same publication
primitive. Relay carries peer discovery and WebRTC signaling only. Consequently a Relay delay,
reconnect, or network-interface change cannot become a hidden prerequisite for exposing committed
media, and the presence of the control sink rather than a browser connection-state label is the
authoritative publication capability.

### Asset cache

Objects are finite maps from immutable virtual URL to bytes. Hero resolves each segment through a
short memory cache, then the current epoch's IndexedDB repository, then P2P. Repeating an
`AssetRequest` is an identity operation. A network retry therefore cannot create another media
object or advance playback state.

All network demand factors through one `AssetScheduler`. It publishes one current asset request and
one lookahead request so mobile request latency overlaps the current transfer. The host owns one
frame scheduler and one DataChannel writer. Every frame retains its request and chunk coordinates.
The scheduler projects the exact byte size of its current atomic header/chunk candidate without
consuming it. The writer supplies current capacity; insufficient capacity leaves scheduler state
unchanged, so queued control changes are ingested before the next projection. The writer then
interprets scheduled frames into one concurrent send window bounded by the SCTP high watermark;
it does not await physical completion before admitting the next independent frame. Native HLS
demand has strict priority over
reserve requests that have not yet been published; reserve demand may use only measured surplus
supply. Loading an asset for native HLS also persists that same value. There is no independent
mirror worker that downloads the same timeline beside hls.js. Reserve materialization belongs to
this scheduler and becomes part of `CachePrefix` only after its IndexedDB write commits; an HLS
buffer target or host-side prepared track is not cache evidence. Cache hit and miss alter latency
only, never timeline order, track state, or playback time.

Playback-manifest visibility is the greatest contiguous reserve prefix that satisfies both the
temporal projection frontier and local byte evidence on the unreleased playback suffix. Completed
tracks are historical quotient objects and need no future readability; memory and committed
persistent storage are evidence for every remaining segment. A prefetch target is not evidence.
For each timeline revision, the reserve manifest is the immutable inventory of every prepared
track in that revision. It is never a playout-relative window; temporal bounding belongs only to
Hero's playback-manifest projection. Therefore moving the playhead cannot change the meaning of an
already cached reserve revision or hide the first segment of the next prepared track.
Increasing desired reserve therefore drives materialization but cannot expose an unmaterialized
future segment to native HLS.

`ReserveManifest` is indexed by `(MediaEpoch, TimelineRevision, ReserveUrl)`. Re-reading one index
is identity on network demand and returns the committed value or joins its single in-flight load.
Only a new control revision may construct a new reserve-manifest request.

### Supply paths

Objects are `SupplyEpoch`s. Path changes are morphisms only in the asset-supply category:

```text
refill : SupplyPath x AssetRequest -> AssetCache
```

There is no morphism from a path label, WiFi/4G classification, socket close, or ICE restart to
pause, seek, source replacement, or track advance.

A `RelayEpoch` is evidence that signaling reachability changed, not proof that media stopped. A new
Relay epoch requests supply-path revalidation. Asset completion, timeout, and measured throughput
are supply facts. Only the session transition model may turn those facts into `RestartSupply`; UI
callbacks and diagnostics cannot directly command ICE.

ICE `connected` is transport evidence, not DataChannel liveness evidence. Every PeerConnection is
identified by a monotone `SupplyEpoch` carried by offers, answers, and candidates. An asset request
timeout terminates only that request and releases the scheduler lane; hls.js may request the same
immutable URL again. Only a terminal DataChannel or PeerConnection fact may replace the supply
epoch, and stale signaling cannot enter that replacement. Playback media epoch, source, native
time, buffered ranges, and persistent assets are invariant under this substitution.

Each asset owns its own progress lease. Only that asset's response header or chunk renews the lease;
an unrelated timeline update cannot keep a lost request occupying the bounded request window. A
slow asset cannot create a replacement loop. The writer admits 16 KiB protocol frames into a
concurrent send colimit bounded by the SCTP high watermark. A completed send removes exactly its
own bytes from that window. The writer also observes DataChannel capacity, and resumes after the
local buffered amount reaches the low watermark.
`buffered_amount` is local capacity evidence only: delayed or
stale observation may delay admission, but it cannot declare a dead `SupplyEpoch`. Hero's accepted
response header and unique valid chunks are the only end-to-end asset-progress evidence. Progress
is keyed by immutable asset URL, so an unrelated reserve completion cannot erase a foreground
request's timeout evidence. Peer replacement explicitly cancels its writer lifetime; it does not
wait for a stale WebRTC `readyState` observation. Assets are bounded to 8 MiB and each Hero owns at
most 64 pending or queued demands. A lossy
path therefore cannot create an unbounded sender queue, while application RTT cannot serialize
every 64 KiB of otherwise sustainable cellular delivery.

## Behavior Object

```text
RemotePlaybackSession =
  ControlState(RelayEpoch)
  x SupplyState(SupplyEpoch)
  x TimelineState(MediaEpoch, TimelinePrefix)
  x AssetState(CachePrefix, SupplyMetrics)
  x PlayoutState(NativeTime, NativeFlow, ForwardReserve)
```

The product is interpreted by one transition definition. Components do not infer sibling state.
In particular, Relay does not infer audible flow, cache does not infer timeline legality, metadata
does not infer native playback, and ICE does not infer track boundaries.

Legal session states are:

```text
Idle -> Preparing -> Playing <-> SupplyRecovering -> Playing
                     |                              |
                     +----------> Paused <---------+
Any -> Closed
```

`SupplyRecovering` preserves media epoch, source identity, native time, and every buffered range.
It returns to a healthy supply state only through a new connected supply epoch; pause and explicit
session close remain legal orthogonal transitions. Buffer exhaustion is a playout fact, not
permission to seek, replace the source, or advance a track.

## Ownership

### `RemotePlaybackSession`

Owns legal cross-domain transitions, epoch substitution, cancellation, and command deduplication.
It does not own sockets, bytes, manifests, cache storage, or DOM media effects.

### `RelayControl`

Owns one WebSocket epoch, RPC correlation, signaling replay, and ICE-server projection. It emits
facts such as `RelayConnected(epoch)` and `RelayDisconnected(epoch)`. It cannot restart ICE.

### `AssetSupply`

Owns PeerConnection, DataChannel, candidate application, one in-flight negotiation, one current and
one lookahead asset request, request coordinates, and supply metrics. It interprets `RestartSupply`
while preserving PeerConnection and media epoch. It cannot pause audio or mutate the timeline.

### `TimelinePublisher`

Owns append-only timeline and manifest projection. It cannot observe network labels or native
playback state.

### `AssetRepository`

Owns memory and IndexedDB lifecycle plus idempotent URL resolution. It cannot create playback
state. The `AssetScheduler` inside this owner is the only network-demand queue.

### `NativePlayout`

Owns one HLS instance, one audio element, native play/pause evidence, buffered ranges, fragment
entry, boundary evidence, persistent playback intent, and Media Session projection. Explicit pause
clears playback intent. A passive pause at an exhausted live edge preserves intent, so buffering a
new fragment resumes the same media element without replacing its source or synthesizing a second
playback clock. It cannot issue RPC or ICE commands.

### `ReservePolicy`

Is a pure function from supply observations and native buffer observations to desired forward
reserve. It owns no timers, requests, sockets, cache values, or playback effects.

## Universal Properties

### `RemoteP2pHls` is the unique timeline publisher

Given a fresh media epoch, priming prefix, and ordered materialized tracks, `RemoteP2pHls` is the
unique append-preserving manifest and timeline. Host RPC and DataChannel asset reads are projections
of this object; neither stores another order. Relay notifications and manifest-response DataChannel
frames may both carry the same timeline value. The client joins them monotonically by media epoch
and revision, so transport availability cannot delay native-boundary metadata or regress it.

### `ForwardReserve` is the colimit of appended segments

ManagedMediaSource appends compatible fetched segments into one native buffer. Once appended, a
segment no longer depends on the supply path that delivered it. A WiFi-to-cellular change can delay
future inclusions but cannot remove an existing prefix from playback.

### `P2pLoader` is the terminal asset consumer

Every hls.js manifest or fragment load factors through one loader. The loader checks memory and
IndexedDB before using DataChannel for a miss. Relay HTTP and Blob fallbacks have no constructors.
DataChannel delivery is reliable but unordered because request and chunk coordinates already
provide deterministic reassembly. The browser publishes a two-request demand window and labels
each request with its semantic priority. The host schedules frames independently, while the bounded
send window interprets several scheduled frames concurrently. Foreground control remains
preemptive at every admission boundary without turning physical frame completion into stop-and-wait.

The scheduler satisfies the naturality law

```text
reassemble(interpret(schedule(decompose(asset)))) = asset
```

`decompose` assigns immutable `(requestId, chunkIndex)` coordinates, `schedule` may interleave
objects by semantic priority, `interpret` admits their send futures into the bounded concurrent
window, and `reassemble` is order-independent. The capacity projection equals the emitted
transmission, and capacity is observed before `schedule`, so waiting cannot capture a stale priority
decision. Path latency changes completion time only; it cannot
change chunk multiplicity, coordinates, reconstructed bytes, or the scheduler's priority decisions. The send window is
the maximal colimit of currently admitted frames whose total encoded size does not exceed the high
watermark.

### `RemotePlaybackSession` is the unique recovery factorization

Every recovery stimulus factors through one transition function:

```text
RelayEpochChanged ----\
SupplyDisconnected ----> RemotePlaybackSession ----> RestartSupply
AssetSupplyDeficit ----/
```

No stimulus calls both Relay and media recovery independently. Repeated facts in the same epoch
coequalize to one recovery command. A late answer or asset result captured by an older epoch has no
legal commit path.

### `BoundaryCommit` is a linear coequalizer

The hls.js fragment that actually enters native playout supplies the boundary evidence. Repeated
observations are coequalized by `(mediaEpoch, entryId)`. Exactly one Host `session.next` is
permitted; projected wall time is not boundary evidence.

## Composition Laws

- Page replacement allocates a new `PageSession`; Relay reconnect preserves it.
- Relay reconnect allocates a new `RelayEpoch`; successful ICE replacement allocates a new
  `SupplyEpoch`.
- Media preparation allocates one `MediaEpoch`; recovery preserves it.
- Timeline publication is append-only and non-commutative.
- Asset retries are idempotent by virtual URL.
- Session recovery may command DataChannel recovery but cannot command the audio element.
- Native playback may consume cached media while DataChannel and Relay are unavailable.
- Every asset loaded into native HLS is persisted by the same repository operation.
- Metadata is a read-only projection of native time into the canonical timeline.

The following compositions are intentionally invalid:

- `RelayDisconnected -> Pause`.
- `NetworkLabelChanged -> ReplaceSource`.
- `CacheMiss -> AdvanceTrack`.
- `Diagnostic -> RecoveryCommand`.
- Parallel `ForegroundFetch + MirrorFetch` for the same timeline prefix.

## Migration Removals

1. Remove page-level fan-out that independently calls `transport.recover` and
   `media.recover/restart`; page code submits facts to `RemotePlaybackSession` only.
2. Extract PeerConnection and DataChannel signaling from `P2pHlsController` into `AssetSupply`.
3. Replace the independent persistent mirror worker with one priority `AssetScheduler`; HLS loads
   persist on success and reserve demand uses only surplus capacity.
4. Extract HLS/audio/Media Session ownership into `NativePlayout`.
5. Make reserve planning pure and feed its result into the single asset scheduler.
6. Delete RTP-era media ownership and every fallback path that can construct a second audible
   object.

## Checker Properties

1. Relay protocol has no HLS manifest, segment, byte-range, or audio payload route.
2. One page owns one audible audio element and one ManagedMediaSource.
3. The same virtual asset URL always resolves to the same bytes inside an epoch.
4. Appending tracks preserves every existing timeline entry and offset.
5. A persisted segment remains readable with DataChannel disconnected.
6. ICE restart preserves media epoch, audio source, current time, and buffered ranges.
7. Playback does not pause or seek because of WiFi/4G classification.
8. Host track advance occurs only after a native boundary commit.
9. Current and next tracks are materialized before the playhead reaches their boundary.
10. Diagnostics observe buffer and transport state but cannot invoke playback commands.
11. One fact in one epoch produces at most one recovery command.
12. A Relay epoch change revalidates supply even when the browser still reports ICE `connected`.
13. Foreground HLS and reserve caching never compete through separate network workers.
14. Late signal and asset completions from an older epoch cannot commit.
15. A prepared track is absent from the playback manifest until the Host accepts cache readiness.
16. The Host cannot recompute or strengthen Hero's startup-readiness threshold.
17. The local concurrent send window is bounded by the SCTP high watermark.
18. Local queue observation can delay admission but cannot terminate a `SupplyEpoch`.
19. Only Hero asset progress or a terminal transport/send fact participates in supply liveness.
20. Only progress for the same asset identity clears its foreground timeout evidence.
21. Peer replacement cancels every writer wait even if WebRTC state remains stale.
22. Asset bytes, chunks, published requests, and queued requests all have explicit finite bounds.
23. Playback manifests expose only the greatest contiguous unreleased prefix backed by local bytes.
24. Re-reading one timeline revision cannot create another reserve-manifest network request.
25. Every committed timeline revision is published through the current P2P control sink, never Relay.
26. A reserve revision contains every prepared track and is invariant under playout movement.
