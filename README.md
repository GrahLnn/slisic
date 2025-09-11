# Slisic

A compact music player built around smart shuffle and consistent listening experience.

## Features

- Download and manage media from most major streaming platforms (powered by yt-dlp) or import from local folders.
- Shuffle playback driven by user-guided probability distributions — randomness tuned to feel natural.
- Loudness normalization (based on LUFS) for a consistent listening volume across different tracks.
- Automatically split and name media with embedded chapter information (powered by FFmpeg).

## Technology

- [Tauri](https://tauri.app/) for cross-platform desktop framework
- [React](https://react.dev/) for UI
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) for media extraction
- [FFmpeg](https://ffmpeg.org/) for media processing and chapter splitting

## Getting Started

### Development

```bash
// Clone the repository
bun install
bun tauri dev
```

## License

This project is licensed under the [MIT](./LICENSE) License.
