import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { areSpectrumPlaybackSnapshotsEqual } from "./SpectrumPlaybackAction";
import {
  areSpectrumPlaybackActionSnapshotsEqual,
  createSpectrumTitlePathTracePayload,
  createSpectrumTitlePathTraceSignature,
  findSpectrumMusicDraftById,
  resolveSpectrumBackActionVisualState,
  resolveSpectrumBackTitleCommitTargets,
  resolveSpectrumCommittedMusicName,
  resolveSpectrumMusicDisplayName,
  resolveSpectrumMusicEditorViewModels,
  resolveSpectrumPlaybackActionSnapshot,
  resolveSpectrumMusicRangeChange,
  resolveSpectrumPlaybackActionVisualState,
  resolveSpectrumPlaybackRestoreEffect,
  resolveSpectrumSelectionRange,
  projectSpectrumPlaybackIdentity,
  isSpectrumPlaybackStatusIdentityForAction,
  shouldCommitSpectrumPlaybackActionSnapshot,
  shouldShowSpectrumDraftResetAction,
  type SpectrumMusicEditorViewModel,
} from "./SpectrumPage.view-model";

function createSpectrumMusicEditorFixture(
  overrides: Partial<SpectrumMusicEditorViewModel> = {},
): SpectrumMusicEditorViewModel {
  return {
    handoffTone: null,
    id: "music:1",
    interactionDisabled: false,
    isCurrent: false,
    playbackIdentity: null,
    selectionEnd: null,
    selectionStart: null,
    shouldShowResetAction: false,
    titleLayoutId: undefined,
    titleValue: "Focus Session",
    ...overrides,
  };
}

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

  test("summarizes title path trace data without storing full title text", () => {
    const editor = createSpectrumMusicEditorFixture({
      id: "music:1",
      titleLayoutId: "playlist-title:Focus",
      titleValue: "Focus Session",
    });

    assert.deepEqual(
      createSpectrumTitlePathTracePayload({
        activeLayoutId: "playlist-title:Focus",
        editorViewModels: [editor],
        spectrumMusicDraftCount: 1,
        trackFilePath: "C:/Music/focus.wav",
      }),
      {
        activeLayoutId: "playlist-title:Focus",
        currentEditorId: null,
        editorCount: 1,
        editors: [
          {
            id: "music:1",
            index: 0,
            isCurrent: false,
            playbackKey: null,
            selectionEnd: null,
            selectionStart: null,
            shouldShowResetAction: false,
            titleLayoutId: "playlist-title:Focus",
            titleLength: 13,
          },
        ],
        spectrumMusicDraftCount: 1,
        trackFilePath: "C:/Music/focus.wav",
      },
    );
  });

  test("keeps title path trace signatures stable for identical semantics", () => {
    const editor = createSpectrumMusicEditorFixture({
      id: "music:1",
      selectionEnd: 20,
      selectionStart: 10,
      titleLayoutId: "playlist-title:Focus",
      titleValue: "Focus Session",
    });
    const first = createSpectrumTitlePathTraceSignature({
      activeLayoutId: "playlist-title:Focus",
      editorViewModels: [editor],
      spectrumMusicDraftCount: 1,
      trackFilePath: "C:/Music/focus.wav",
    });
    const second = createSpectrumTitlePathTraceSignature({
      activeLayoutId: "playlist-title:Focus",
      editorViewModels: [{ ...editor }],
      spectrumMusicDraftCount: 1,
      trackFilePath: "C:/Music/focus.wav",
    });
    const changed = createSpectrumTitlePathTraceSignature({
      activeLayoutId: "playlist-title:Focus",
      editorViewModels: [{ ...editor, selectionEnd: 30 }],
      spectrumMusicDraftCount: 1,
      trackFilePath: "C:/Music/focus.wav",
    });

    assert.equal(first, second);
    assert.notEqual(first, changed);
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
            endMs: null,
            startMs: null,
          },
        ],
      }),
      {
        kind: "back",
        key: "back",
      },
    );
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
          endMs: null,
          startMs: null,
        },
      }),
      false,
    );
    assert.equal(
      shouldShowSpectrumDraftResetAction({
        musicDraft: {
          ...draft,
          endMs: 112_000,
        },
      }),
      true,
    );
    assert.equal(
      shouldShowSpectrumDraftResetAction({
        musicDraft: {
          ...draft,
          deleteRequested: true,
        },
      }),
      false,
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

  test("does not schedule title commits for range-only spectrum edits", () => {
    const draft = {
      baselineName: "Track A",
      baselineStartMs: 0,
      baselineEndMs: 120_000,
      name: "Track A",
      url: "https://example.com/quiet-morning#a",
      startMs: 8_000,
      endMs: 90_000,
    };
    const editorViewModels = resolveSpectrumMusicEditorViewModels({
      activeLayoutId: "playlist-title:Focus Session",
      handoffTone: "solid",
      interactionDisabled: false,
      nowPlayingTrackFilePath: "C:/Music/quiet-morning.m4a",
      nowPlayingTrackEndMs: 120_000,
      nowPlayingTrackStartMs: 0,
      nowPlayingTrackUrl: "https://example.com/quiet-morning#a",
      playingPlaylistName: "Focus Session",
      spectrumMusicDrafts: [draft],
    });

    assert.deepEqual(
      resolveSpectrumBackTitleCommitTargets({
        editorViewModels,
        musicDrafts: [draft],
      }),
      [],
    );
  });

  test("schedules a title commit only for the edited spectrum music", () => {
    const editedDraft = {
      baselineName: "Track A",
      baselineStartMs: 0,
      baselineEndMs: 120_000,
      name: "",
      url: "https://example.com/quiet-morning#a",
      startMs: 0,
      endMs: 120_000,
    };
    const untouchedDraft = {
      baselineName: "Track B",
      baselineStartMs: 120_000,
      baselineEndMs: 240_000,
      name: "Track B",
      url: "https://example.com/quiet-morning#b",
      startMs: 120_000,
      endMs: 240_000,
    };
    const editorViewModels = resolveSpectrumMusicEditorViewModels({
      activeLayoutId: "playlist-title:Focus Session",
      handoffTone: "solid",
      interactionDisabled: false,
      nowPlayingTrackFilePath: "C:/Music/quiet-morning.m4a",
      nowPlayingTrackEndMs: 120_000,
      nowPlayingTrackStartMs: 0,
      nowPlayingTrackUrl: "https://example.com/quiet-morning#a",
      playingPlaylistName: "Focus Session",
      spectrumMusicDrafts: [editedDraft, untouchedDraft],
    });

    assert.deepEqual(
      resolveSpectrumBackTitleCommitTargets({
        editorViewModels,
        musicDrafts: [editedDraft, untouchedDraft],
      }).map((target) => ({
        id: target.editor.id,
        title: target.title,
      })),
      [
        {
          id: "https://example.com/quiet-morning#a|0|120000",
          title: {
            kind: "restore",
            alias: "Track A",
          },
        },
      ],
    );
  });

  test("keeps deleted spectrum music out of visible editors and title commits", () => {
    const deletedDraft = {
      baselineName: "Track A",
      baselineStartMs: 0,
      baselineEndMs: 120_000,
      deleteRequested: true,
      name: "Track A",
      url: "https://example.com/quiet-morning#a",
      startMs: 0,
      endMs: 120_000,
    };
    const visibleDraft = {
      baselineName: "Track B",
      baselineStartMs: 120_000,
      baselineEndMs: 240_000,
      name: "",
      url: "https://example.com/quiet-morning#b",
      startMs: 120_000,
      endMs: 240_000,
    };

    const viewModels = resolveSpectrumMusicEditorViewModels({
      activeLayoutId: "playlist-title:Focus Session",
      handoffTone: "solid",
      interactionDisabled: false,
      nowPlayingTrackFilePath: "C:/Music/quiet-morning.m4a",
      nowPlayingTrackEndMs: 120_000,
      nowPlayingTrackStartMs: 0,
      nowPlayingTrackUrl: "https://example.com/quiet-morning#a",
      playingPlaylistName: "Focus Session",
      spectrumMusicDrafts: [deletedDraft, visibleDraft],
    });

    assert.equal(viewModels.length, 1);
    assert.equal(viewModels[0]?.id, "https://example.com/quiet-morning#b|120000|240000");
    assert.equal(viewModels[0]?.titleLayoutId, "playlist-title:Focus Session");
    assert.equal(viewModels[0]?.handoffTone, "solid");
    assert.deepEqual(
      resolveSpectrumBackTitleCommitTargets({
        editorViewModels: viewModels,
        musicDrafts: [deletedDraft, visibleDraft],
      }).map((target) => target.editor.id),
      ["https://example.com/quiet-morning#b|120000|240000"],
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

  test("blocks playback snapshot commits after spectrum exit presentation starts", () => {
    assert.equal(
      shouldCommitSpectrumPlaybackActionSnapshot({
        isPresent: true,
        pageExitStarted: false,
        pageRenderFrozen: false,
      }),
      true,
    );
    assert.equal(
      shouldCommitSpectrumPlaybackActionSnapshot({
        isPresent: false,
        pageExitStarted: false,
        pageRenderFrozen: false,
      }),
      false,
    );
    assert.equal(
      shouldCommitSpectrumPlaybackActionSnapshot({
        isPresent: true,
        pageExitStarted: false,
        pageRenderFrozen: true,
      }),
      false,
    );
    assert.equal(
      shouldCommitSpectrumPlaybackActionSnapshot({
        isPresent: true,
        pageExitStarted: true,
        pageRenderFrozen: false,
      }),
      false,
    );
  });

  test("keeps spectrum back restore inert when the primary track is already playing", () => {
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
    assert.deepEqual(
      resolveSpectrumPlaybackRestoreEffect({
        identity,
        statusIdentity: equivalentStatus,
        statusPaused: false,
        storedPositionMs: 8_000,
      }),
      {
        kind: "none",
        reason: "already-playing",
      },
    );
    assert.deepEqual(
      resolveSpectrumPlaybackRestoreEffect({
        identity,
        statusIdentity: equivalentStatus,
        statusPaused: true,
        storedPositionMs: 8_000,
      }),
      {
        kind: "restore-paused",
        positionMs: 8_000,
      },
    );
    assert.deepEqual(
      resolveSpectrumPlaybackRestoreEffect({
        identity,
        statusIdentity: null,
        statusPaused: false,
        storedPositionMs: 8_000,
      }),
      {
        kind: "none",
        reason: "identity-mismatch",
      },
    );
    assert.deepEqual(
      resolveSpectrumPlaybackRestoreEffect({
        identity,
        statusIdentity: equivalentStatus,
        statusPaused: true,
        storedPositionMs: null,
      }),
      {
        kind: "none",
        reason: "missing-resume-position",
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

  test("keeps playback action snapshots stable across playback position polling", () => {
    const base = {
      endMs: 120_000,
      filePath: "C:/Music/quiet-morning.m4a",
      playlistName: "Focus Session",
      startMs: 0,
      url: "https://example.com/quiet-morning#a",
    };
    const first = resolveSpectrumPlaybackActionSnapshot({
      ...base,
      paused: false,
    });
    const later = resolveSpectrumPlaybackActionSnapshot({
      ...base,
      paused: false,
    });
    const paused = resolveSpectrumPlaybackActionSnapshot({
      ...base,
      paused: true,
    });
    const otherTrack = resolveSpectrumPlaybackActionSnapshot({
      ...base,
      startMs: 8_250,
    });

    assert.ok(first);
    assert.ok(later);
    assert.ok(paused);
    assert.ok(otherTrack);
    assert.equal(areSpectrumPlaybackActionSnapshotsEqual(first, later), true);
    assert.equal(areSpectrumPlaybackActionSnapshotsEqual(first, paused), false);
    assert.equal(areSpectrumPlaybackActionSnapshotsEqual(first, otherTrack), false);
  });
});
