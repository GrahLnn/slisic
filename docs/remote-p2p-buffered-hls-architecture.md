# Remote P2P Buffered HLS Architecture

## Decision

Remote playback has one audible media object: one `HTMLAudioElement` backed by one
ManagedMediaSource HLS timeline. WebRTC DataChannel transports HLS assets directly between Host
and Hero. Relay transports only pairing, RPC, ICE configuration, and directed signaling.

The live WebRTC RTP audio track is not a cache and cannot satisfy network handover on Safari builds
without `RTCRtpReceiver.jitterBufferTarget`. It is removed after the buffered HLS path becomes the
only playback owner.

## Domain Language

| Term | Meaning |
| --- | --- |
| `PageSession` | Ephemeral Hero identity preserved across Relay reconnect and replaced with the page. |
| `MediaEpoch` | Fresh identity of one prepared and subsequently started HLS resource. |
| `PrimingPrefix` | Sliding live window of local silent HLS segments available before real media. |
| `TimelinePrefix` | Immutable ordered HLS entries and segments published so far. |
| `ForwardReserve` | Media already appended ahead of the native playhead. |
| `AssetRequest` | Idempotent DataChannel request for one manifest or media segment URL. |
| `SupplyPath` | Current ICE-selected path used to refill the forward reserve. |
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
Before the first real track exists, the manifest advances a bounded silent live window. Publication
places the first real segment at the first sequence that the current silent manifest has never
advertised. Waiting has no fixed timeout, and handoff cannot rewrite an advertised segment.

### Asset cache

Objects are finite maps from immutable virtual URL to bytes. Repeating an `AssetRequest` is an
identity operation. A network retry therefore cannot create another media object or advance
playback state.

### Supply paths

Objects are ICE transport epochs. Path changes are morphisms only in the asset-supply category:

```text
refill : SupplyPath x AssetRequest -> AssetCache
```

There is no morphism from a path label, WiFi/4G classification, socket close, or ICE restart to
pause, seek, source replacement, or track advance.

## Universal Properties

### `RemoteP2pHls` is the unique timeline publisher

Given a fresh media epoch, priming prefix, and ordered materialized tracks, `RemoteP2pHls` is the
unique append-preserving manifest and timeline. Host RPC and DataChannel asset reads are projections
of this object; neither stores another order.

### `ForwardReserve` is the colimit of appended segments

ManagedMediaSource appends compatible fetched segments into one native buffer. Once appended, a
segment no longer depends on the supply path that delivered it. A WiFi-to-cellular change can delay
future inclusions but cannot remove an existing prefix from playback.

### `P2pLoader` is the terminal asset consumer

Every hls.js manifest or fragment load factors through one loader. The loader checks the immutable
cache first and uses DataChannel only for a miss. Relay HTTP and Blob fallbacks have no constructors.

### `BoundaryCommit` is a linear coequalizer

The hls.js fragment that actually enters native playout supplies the boundary evidence. Repeated
observations are coequalized by `(mediaEpoch, entryId)`. Exactly one Host `session.next` is
permitted; projected wall time is not boundary evidence.

## Composition Laws

- Page replacement allocates a new `PageSession`; Relay reconnect preserves it.
- Media preparation allocates one `MediaEpoch`; recovery preserves it.
- Timeline publication is append-only and non-commutative.
- Asset retries are idempotent by virtual URL.
- DataChannel recovery may refill the forward reserve but cannot command the audio element.
- Native playback may consume cached media while DataChannel and Relay are unavailable.
- Metadata is a read-only projection of native time into the canonical timeline.

## Checker Properties

1. Relay protocol has no HLS manifest, segment, byte-range, or audio payload route.
2. One page owns one audible audio element and one ManagedMediaSource.
3. The same virtual asset URL always resolves to the same bytes inside an epoch.
4. Appending tracks preserves every existing timeline entry and offset.
5. A cached segment remains readable with DataChannel disconnected.
6. ICE restart preserves media epoch, audio source, current time, and buffered ranges.
7. Playback does not pause or seek because of WiFi/4G classification.
8. Host track advance occurs only after a native boundary commit.
9. Current and next tracks are materialized before the playhead reaches their boundary.
10. Diagnostics observe buffer and transport state but cannot invoke playback commands.
