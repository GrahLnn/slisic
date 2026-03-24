# ffplayr

`ffplayr` is an FFmpeg-backed audio playback engine for Rust.

It provides:

- async `play`, `pause`, `resume`, `stop`, and `status`
- a higher-level `Playback` API for normal library use
- optional loudness-aware gain planning via `PlaybackNormalization`
- optional event hooks through `AudioEventSink`
- debug helpers for spectrogram and pipeline probe generation

## Status

This crate currently uses `ffmpeg` for decoding, filtering, and resampling, then sends PCM to the output device through `rodio`/`cpal`.

## Example

```rust,no_run
use ffplayr::{Playback, PlaybackNormalization, PlaybackRequest};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let playback = Playback::new("C:/tools/ffmpeg/bin/ffmpeg.exe")?;

    playback.play("C:/music/track.webm").await?;

    playback
        .play_request(
            PlaybackRequest::new("C:/music/track.flac").with_normalization(
                PlaybackNormalization {
                    target_lufs: -16.0,
                    integrated_lufs: Some(-19.4),
                    true_peak_dbtp: Some(-1.2),
                },
            ),
        )
        .await?;

    playback.stop().await?;
    Ok(())
}
```

## Design

- `Playback` is the recommended public entry point.
- `PlaybackBuilder` customizes the ffmpeg path, event sink, and default normalization policy.
- `AudioEngine` remains available for lower-level integrations.
