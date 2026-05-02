import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveSpectrumTitleFadeProps } from "./SpectrumPage";
import { areSpectrumPlaybackSnapshotsEqual } from "./SpectrumPlaybackAction";
import {
  resolveSpectrumBackActionVisualState,
  resolveSpectrumCommittedTitle,
  resolveSpectrumPlaybackActionVisualState,
  resolveSpectrumTitle,
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
          name: "Disc 1 Prelude",
          url: "https://example.com/quiet-morning#disc-1-opening",
          start: 0,
          end: 120,
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
      name: "Disc 1 Opening",
      url: "https://example.com/quiet-morning#disc-1-opening",
      start: 0,
      end: 120,
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
          name: "Disc 1 Opening",
        },
      }),
      {
        kind: "back",
        key: "back",
      },
    );
  });

  test("resolves the committed spectrum title before returning to playback", () => {
    assert.deepEqual(
      resolveSpectrumCommittedTitle({
        musicTitleDraft: {
          baselineName: "Disc 1 Opening",
          name: "",
          url: "https://example.com/quiet-morning#disc-1-opening",
          start: 0,
          end: 120,
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
        key: "pause",
        kind: "pause",
      },
    );
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
