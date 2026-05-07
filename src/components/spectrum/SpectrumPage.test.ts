import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { areSpectrumPlaybackSnapshotsEqual } from "./SpectrumPlaybackAction";
import {
  findSpectrumMusicDraftById,
  resolveSpectrumBackActionVisualState,
  resolveSpectrumCommittedMusicName,
  resolveSpectrumMusicDisplayName,
  resolveSpectrumMusicEditorViewModels,
  resolveSpectrumMusicRangeChange,
  resolveSpectrumPlaybackActionVisualState,
  resolveSpectrumSelectionRange,
  projectSpectrumPlaybackIdentity,
  isSpectrumPlaybackStatusIdentityForAction,
  shouldShowSpectrumDraftResetAction,
} from "./SpectrumPage.view-model";

describe("SpectrumPage", () => {
  test("uses the music draft name as the editable spectrum title", () => {
    assert.equal(
      resolveSpectrumMusicDisplayName({
        musicDraft: {
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

    assert.deepEqual(resolveSpectrumBackActionVisualState({ musicDrafts: [draft] }), {
      kind: "back",
      key: "back",
    });
    assert.deepEqual(
      resolveSpectrumBackActionVisualState({
        musicDrafts: [
          {
            ...draft,
            name: "Disc 1 Prelude",
          },
        ],
      }),
      {
        kind: "check",
        key: "check",
      },
    );
    assert.deepEqual(
      resolveSpectrumBackActionVisualState({
        musicDrafts: [
          {
            ...draft,
            startMs: 8_000,
          },
        ],
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

    assert.equal(shouldShowSpectrumDraftResetAction({ musicDraft: null }), false);
    assert.equal(shouldShowSpectrumDraftResetAction({ musicDraft: draft }), false);
    assert.equal(
      shouldShowSpectrumDraftResetAction({
        musicDraft: {
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
        musicDraft: {
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
        musicDraft: {
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
      resolveSpectrumCommittedMusicName({
        musicDraft: {
          baselineName: "Disc 1 Opening",
          baselineStartMs: 0,
          baselineEndMs: 120_000,
          name: "",
          url: "https://example.com/quiet-morning#disc-1-opening",
          startMs: 0,
          endMs: 120_000,
        },
        renderedName: "",
      }),
      {
        kind: "restore",
        alias: "Disc 1 Opening",
      },
    );
  });

  test("orders the current file music draft first and keeps each draft independent", () => {
    const currentDraft = {
      baselineName: "Track B",
      baselineStartMs: 120_000,
      baselineEndMs: 240_000,
      name: "Track B",
      url: "https://example.com/quiet-morning#b",
      startMs: 125_000,
      endMs: 235_000,
    };
    const siblingDraft = {
      baselineName: "Track A",
      baselineStartMs: 0,
      baselineEndMs: 120_000,
      name: "Track A",
      url: "https://example.com/quiet-morning#a",
      startMs: 0,
      endMs: 120_000,
    };

    const viewModels = resolveSpectrumMusicEditorViewModels({
      activeLayoutId: "playlist-title:Focus Session",
      handoffTone: "solid",
      interactionDisabled: false,
      nowPlayingTrackFilePath: "C:/Music/quiet-morning.m4a",
      nowPlayingTrackEndMs: 240_000,
      nowPlayingTrackStartMs: 120_000,
      nowPlayingTrackUrl: "https://example.com/quiet-morning#b",
      playingPlaylistName: "Focus Session",
      spectrumMusicDrafts: [currentDraft, siblingDraft],
    });

    assert.equal(viewModels[0]?.id, "https://example.com/quiet-morning#b|120000|240000");
    assert.equal(viewModels[0]?.isCurrent, true);
    assert.equal(viewModels[0]?.titleLayoutId, "playlist-title:Focus Session");
    assert.equal(viewModels[0]?.handoffTone, "solid");
    assert.equal(viewModels[0]?.selectionStart, 125);
    assert.equal(viewModels[0]?.selectionEnd, 235);
    assert.deepEqual(viewModels[0]?.playbackIdentity, {
      endMs: 240_000,
      filePath: "C:/Music/quiet-morning.m4a",
      key: "c:/music/quiet-morning.m4a|Focus Session|https://example.com/quiet-morning#b|120000|240000",
      normalizedFilePath: "c:/music/quiet-morning.m4a",
      playlistName: "Focus Session",
      startMs: 120_000,
      url: "https://example.com/quiet-morning#b",
    });
    assert.equal(viewModels[1]?.isCurrent, false);
    assert.equal(viewModels[1]?.titleLayoutId, undefined);
    assert.equal(viewModels[1]?.handoffTone, null);
  });

  test("finds a spectrum music draft through the shared identity rule", () => {
    const draft = {
      baselineName: "Track A",
      baselineStartMs: 0,
      baselineEndMs: 120_000,
      name: "Track A",
      url: "https://example.com/quiet-morning#a",
      startMs: 0,
      endMs: 120_000,
    };

    assert.equal(
      findSpectrumMusicDraftById([draft], "https://example.com/quiet-morning#a|0|120000"),
      draft,
    );
  });

  test("shows pause while the current spectrum track is playing", () => {
    assert.deepEqual(
      resolveSpectrumPlaybackActionVisualState({
        hasCurrentTrack: true,
        canStartTrack: true,
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
        canStartTrack: true,
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

  test("shows start for a complete inactive spectrum track", () => {
    assert.deepEqual(
      resolveSpectrumPlaybackActionVisualState({
        canStartTrack: true,
        hasCurrentTrack: false,
        isPending: false,
        isPresent: true,
        paused: false,
      }),
      {
        ariaLabel: "Start playback",
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
        canStartTrack: false,
        isPending: false,
        isPresent: true,
        paused: false,
      }),
      {
        ariaLabel: "Start playback",
        disabled: true,
        dimmed: true,
        key: "play",
        kind: "play",
      },
    );
    assert.deepEqual(
      resolveSpectrumPlaybackActionVisualState({
        hasCurrentTrack: true,
        canStartTrack: true,
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

  test("projects playback identity once before comparison", () => {
    const identity = projectSpectrumPlaybackIdentity({
      endMs: 120_000,
      filePath: "C:/Music/quiet-morning.m4a",
      playlistName: "Focus Session",
      startMs: 0,
      url: "https://example.com/quiet-morning#a",
    });
    const equivalentStatus = projectSpectrumPlaybackIdentity({
      endMs: 120_000,
      filePath: "c:/music/quiet-morning.m4a",
      playlistName: "Focus Session",
      startMs: 0,
      url: "https://example.com/quiet-morning#a",
    });

    assert.ok(identity);
    assert.equal(isSpectrumPlaybackStatusIdentityForAction(equivalentStatus, identity), true);
    assert.equal(
      projectSpectrumPlaybackIdentity({
        endMs: 0,
        filePath: "C:/Music/quiet-morning.m4a",
        playlistName: "Focus Session",
        startMs: 0,
        url: "https://example.com/quiet-morning#a",
      }),
      null,
    );
  });

  test("does not dim the spectrum playback action only because the page is exiting", () => {
    assert.deepEqual(
      resolveSpectrumPlaybackActionVisualState({
        hasCurrentTrack: true,
        canStartTrack: true,
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
