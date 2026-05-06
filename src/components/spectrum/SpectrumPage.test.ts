import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveSpectrumTitleFadeProps } from "./SpectrumPage";
import { areSpectrumPlaybackSnapshotsEqual } from "./SpectrumPlaybackAction";
import {
  resolveSpectrumBackActionVisualState,
  resolveSpectrumCommittedTitle,
  resolveSpectrumMusicRangeChange,
  resolveSpectrumPlaybackActionVisualState,
  resolveSpectrumSelectionRange,
  resolveSpectrumTitle,
  shouldShowSpectrumDraftResetAction,
} from "./SpectrumPage.view-model";

describe("SpectrumPage", () => {
  test("keeps shared title visible instead of applying page content fade", () => {
    assert.deepEqual(resolveSpectrumTitleFadeProps({ hasSharedTitleLayout: true }), {
      initial: { opacity: 1 },
      animate: { opacity: 1 },
      exit: { opacity: 1 },
      transition: {
        duration: 0.36,
        ease: [0.22, 1, 0.36, 1],
      },
    });
  });

  test("uses regular content fade when no shared title layout exists", () => {
    assert.deepEqual(resolveSpectrumTitleFadeProps({ hasSharedTitleLayout: false }), {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      transition: {
        duration: 0.36,
        ease: [0.22, 1, 0.36, 1],
      },
    });
  });

  test("uses the music title draft as the editable spectrum title", () => {
    assert.equal(
      resolveSpectrumTitle({
        musicTitleDraft: {
          baselineName: "Disc 1 Opening",
          baselineStartMs: 0,
          baselineEndMs: 120_000,
          name: "Disc 1 Prelude",
          url: "https://example.com/quiet-morning#disc-1-opening",
          startMs: 0,
          endMs: 120_000,
        },
        nowPlayingTrackName: "Disc 1 Opening",
        playingPlaylistName: "Focus Session",
      }),
      "Disc 1 Prelude",
    );
  });

  test("switches the back action only when the draft differs from current music data", () => {
    const draft = {
      baselineName: "Disc 1 Opening",
      baselineStartMs: 0,
      baselineEndMs: 120_000,
      name: "Disc 1 Opening",
      url: "https://example.com/quiet-morning#disc-1-opening",
      startMs: 0,
      endMs: 120_000,
    };

    assert.deepEqual(resolveSpectrumBackActionVisualState({ musicTitleDraft: draft }), {
      kind: "back",
      key: "back",
    });
    assert.deepEqual(
      resolveSpectrumBackActionVisualState({
        musicTitleDraft: {
          ...draft,
          name: "Disc 1 Prelude",
        },
      }),
      {
        kind: "check",
        key: "check",
      },
    );
    assert.deepEqual(
      resolveSpectrumBackActionVisualState({
        musicTitleDraft: {
          ...draft,
          startMs: 8_000,
        },
      }),
      {
        kind: "check",
        key: "check",
      },
    );
  });

  test("shows the spectrum draft reset action only when the music draft differs", () => {
    const draft = {
      baselineName: "Disc 1 Opening",
      baselineStartMs: 0,
      baselineEndMs: 120_000,
      name: "Disc 1 Opening",
      url: "https://example.com/quiet-morning#disc-1-opening",
      startMs: 0,
      endMs: 120_000,
    };

    assert.equal(shouldShowSpectrumDraftResetAction({ musicTitleDraft: null }), false);
    assert.equal(shouldShowSpectrumDraftResetAction({ musicTitleDraft: draft }), false);
    assert.equal(
      shouldShowSpectrumDraftResetAction({
        musicTitleDraft: {
          ...draft,
          endMs: 112_000,
        },
      }),
      true,
    );
  });

  test("resolves the spectrum selection from the editable draft first", () => {
    assert.deepEqual(
      resolveSpectrumSelectionRange({
        musicTitleDraft: {
          baselineName: "Disc 1 Opening",
          baselineStartMs: 0,
          baselineEndMs: 120_000,
          name: "Disc 1 Opening",
          url: "https://example.com/quiet-morning#disc-1-opening",
          startMs: 10_000,
          endMs: 90_000,
        },
        nowPlayingTrackEndMs: 120_000,
        nowPlayingTrackStartMs: 0,
      }),
      {
        end: 90,
        start: 10,
      },
    );
  });

  test("does not mix a draft selection with the current playback range", () => {
    assert.deepEqual(
      resolveSpectrumSelectionRange({
        musicTitleDraft: {
          baselineName: "Disc 1 Opening",
          baselineStartMs: 0,
          baselineEndMs: 120_000,
          name: "Disc 1 Opening",
          url: "https://example.com/quiet-morning#disc-1-opening",
          startMs: null,
          endMs: 90_000,
        },
        nowPlayingTrackEndMs: 120_000,
        nowPlayingTrackStartMs: 0,
      }),
      {
        end: 90,
        start: null,
      },
    );
  });

  test("maps spectrum selection seconds back to music range milliseconds", () => {
    assert.deepEqual(resolveSpectrumMusicRangeChange({ start: 8.25, end: 112.75 }), {
      startMs: 8_250,
      endMs: 112_750,
    });
    assert.deepEqual(resolveSpectrumMusicRangeChange({ start: null, end: 90 }), {
      startMs: null,
      endMs: 90_000,
    });
  });

  test("resolves the committed spectrum title before returning to playback", () => {
    assert.deepEqual(
      resolveSpectrumCommittedTitle({
        musicTitleDraft: {
          baselineName: "Disc 1 Opening",
          baselineStartMs: 0,
          baselineEndMs: 120_000,
          name: "",
          url: "https://example.com/quiet-morning#disc-1-opening",
          startMs: 0,
          endMs: 120_000,
        },
        renderedTitle: "",
      }),
      {
        kind: "restore",
        alias: "Disc 1 Opening",
      },
    );
  });

  test("shows pause while the current spectrum track is playing", () => {
    assert.deepEqual(
      resolveSpectrumPlaybackActionVisualState({
        hasCurrentTrack: true,
        isPending: false,
        isPresent: true,
        paused: false,
      }),
      {
        ariaLabel: "Pause playback",
        disabled: false,
        dimmed: false,
        key: "pause",
        kind: "pause",
      },
    );
  });

  test("shows play while the current spectrum track is paused", () => {
    assert.deepEqual(
      resolveSpectrumPlaybackActionVisualState({
        hasCurrentTrack: true,
        isPending: false,
        isPresent: true,
        paused: true,
      }),
      {
        ariaLabel: "Resume playback",
        disabled: false,
        dimmed: false,
        key: "play",
        kind: "play",
      },
    );
  });

  test("disables the spectrum playback action outside active playback", () => {
    assert.deepEqual(
      resolveSpectrumPlaybackActionVisualState({
        hasCurrentTrack: false,
        isPending: false,
        isPresent: true,
        paused: false,
      }),
      {
        ariaLabel: "Pause playback",
        disabled: true,
        dimmed: true,
        key: "pause",
        kind: "pause",
      },
    );
    assert.deepEqual(
      resolveSpectrumPlaybackActionVisualState({
        hasCurrentTrack: true,
        isPending: true,
        isPresent: true,
        paused: false,
      }),
      {
        ariaLabel: "Pause playback",
        disabled: true,
        dimmed: true,
        key: "pause",
        kind: "pause",
      },
    );
  });

  test("does not dim the spectrum playback action only because the page is exiting", () => {
    assert.deepEqual(
      resolveSpectrumPlaybackActionVisualState({
        hasCurrentTrack: true,
        isPending: false,
        isPresent: false,
        paused: false,
      }),
      {
        ariaLabel: "Pause playback",
        disabled: true,
        dimmed: false,
        key: "pause",
        kind: "pause",
      },
    );
  });

  test("keeps equivalent playback snapshots stable", () => {
    assert.equal(areSpectrumPlaybackSnapshotsEqual(null, null), true);
    assert.equal(areSpectrumPlaybackSnapshotsEqual({ paused: false }, { paused: false }), true);
    assert.equal(areSpectrumPlaybackSnapshotsEqual({ paused: true }, { paused: true }), true);
    assert.equal(areSpectrumPlaybackSnapshotsEqual(null, { paused: false }), false);
    assert.equal(areSpectrumPlaybackSnapshotsEqual({ paused: false }, { paused: true }), false);
  });
});
