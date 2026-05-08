import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  areSpectrumMusicVirtualListRowRenderModelsEqual,
  areSpectrumMusicVirtualListRowPropsEqual,
  areSpectrumMusicEditorViewModelsEqual,
  resolveSpectrumMusicVirtualRowPlaybackSnapshot,
  resolveSpectrumMusicVirtualListHeight,
  resolveSpectrumMusicVirtualRangeIndexes,
  resolveSpectrumMusicVirtualRowTransform,
  resolveSpectrumMusicWaveformPresentation,
} from "./SpectrumMusicVirtualList";
import { createWaveformRenderDataStore } from "./SpectrumVisualizer";
import type {
  SpectrumMusicEditorViewModel,
  SpectrumPlaybackActionSnapshot,
  SpectrumPlaybackIdentity,
} from "./SpectrumPage.view-model";

function createPlaybackIdentity(id: string): SpectrumPlaybackIdentity {
  return {
    endMs: 30_000,
    filePath: `C:/music/${id}.mp3`,
    key: `c:/music/${id}.mp3|playlist|${id}|0|30000`,
    normalizedFilePath: `c:/music/${id}.mp3`,
    playlistName: "playlist",
    startMs: 0,
    url: id,
  };
}

function createEditor(
  id: string,
  overrides: Partial<SpectrumMusicEditorViewModel> = {},
): SpectrumMusicEditorViewModel {
  return {
    handoffTone: null,
    id,
    interactionDisabled: false,
    isCurrent: id === "alpha",
    playbackIdentity: createPlaybackIdentity(id),
    selectionEnd: 30,
    selectionStart: 0,
    shouldShowResetAction: false,
    titleLayoutId: undefined,
    titleValue: id,
    ...overrides,
  };
}

function createPlaybackSnapshot(
  identity: SpectrumPlaybackIdentity,
  paused: boolean,
): SpectrumPlaybackActionSnapshot {
  return {
    identity,
    paused,
  };
}

const testWaveformRenderDataStore = createWaveformRenderDataStore();

function createRowRenderModel(
  editor: SpectrumMusicEditorViewModel,
  overrides: Partial<Parameters<typeof areSpectrumMusicVirtualListRowRenderModelsEqual>[0]> = {},
): Parameters<typeof areSpectrumMusicVirtualListRowRenderModelsEqual>[0] {
  return {
    editor,
    exitPresentation: "local",
    index: 0,
    playbackActionSnapshot: null,
    scrollMargin: 0,
    start: 0,
    trackFilePath: "C:/music/current.mp3",
    waveformRenderDataStore: testWaveformRenderDataStore,
    waveformPresentation: "interactive",
    ...overrides,
  };
}

function createRowProps(
  editor: SpectrumMusicEditorViewModel,
  overrides: Partial<Parameters<typeof areSpectrumMusicVirtualListRowPropsEqual>[0]> = {},
): Parameters<typeof areSpectrumMusicVirtualListRowPropsEqual>[0] {
  return {
    ...createRowRenderModel(editor),
    editableTitleRefs: { current: new Map() },
    measureElement: () => undefined,
    onDelete: () => undefined,
    onPlaybackAction: async () => undefined,
    onReset: () => undefined,
    onSelectionCommit: () => undefined,
    onTitleChange: () => undefined,
    ...overrides,
  };
}

describe("SpectrumMusicVirtualList", () => {
  test("keeps virtual list height owned by the virtualizer total size", () => {
    assert.equal(resolveSpectrumMusicVirtualListHeight({ totalSize: 960 }), 960);
  });

  test("positions rows from virtualizer coordinates without extra row math", () => {
    assert.equal(
      resolveSpectrumMusicVirtualRowTransform({ scrollMargin: 128, start: 384 }),
      "translateY(256px)",
    );
  });

  test("pins the current music row while preserving sorted virtual indexes", () => {
    assert.deepEqual(
      resolveSpectrumMusicVirtualRangeIndexes({
        indexes: [5, 6, 7],
        pinnedIndex: 0,
      }),
      [0, 5, 6, 7],
    );
  });

  test("does not duplicate the pinned row when it is already virtualized", () => {
    assert.deepEqual(
      resolveSpectrumMusicVirtualRangeIndexes({
        indexes: [0, 1, 2],
        pinnedIndex: 0,
      }),
      [0, 1, 2],
    );
  });

  test("keeps an empty virtual range empty", () => {
    assert.deepEqual(
      resolveSpectrumMusicVirtualRangeIndexes({
        indexes: [],
        pinnedIndex: null,
      }),
      [],
    );
  });

  test("keeps the current music waveform interactive before sibling rows are admitted", () => {
    assert.equal(
      resolveSpectrumMusicWaveformPresentation({
        admittedIndexes: new Set([0]),
        isCurrent: true,
        rowIndex: 0,
      }),
      "interactive",
    );
  });

  test("keeps sibling waveforms as placeholders until the list admits them", () => {
    assert.equal(
      resolveSpectrumMusicWaveformPresentation({
        admittedIndexes: new Set([0]),
        isCurrent: false,
        rowIndex: 1,
      }),
      "placeholder",
    );
    assert.equal(
      resolveSpectrumMusicWaveformPresentation({
        admittedIndexes: new Set([0, 1]),
        isCurrent: false,
        rowIndex: 1,
      }),
      "interactive",
    );
  });

  test("compares editor view models by row-owned semantic fields", () => {
    const editor = createEditor("alpha");
    assert.equal(areSpectrumMusicEditorViewModelsEqual(editor, { ...editor }), true);
    assert.equal(
      areSpectrumMusicEditorViewModelsEqual(editor, {
        ...editor,
        selectionStart: 4,
      }),
      false,
    );
    assert.equal(
      areSpectrumMusicEditorViewModelsEqual(editor, {
        ...editor,
        playbackIdentity: createPlaybackIdentity("beta"),
      }),
      false,
    );
  });

  test("keeps non-target rows stable when one draft range is committed", () => {
    const firstEditor = createEditor("alpha");
    const secondEditor = createEditor("beta", {
      isCurrent: false,
    });

    assert.equal(
      areSpectrumMusicVirtualListRowRenderModelsEqual(
        createRowRenderModel(firstEditor),
        createRowRenderModel({ ...firstEditor }),
      ),
      true,
    );
    assert.equal(
      areSpectrumMusicVirtualListRowRenderModelsEqual(
        createRowRenderModel(secondEditor, { index: 1, start: 384 }),
        createRowRenderModel(
          {
            ...secondEditor,
            selectionEnd: 24,
          },
          { index: 1, start: 384 },
        ),
      ),
      false,
    );
  });

  test("projects playback state only onto the row with the matching playback identity", () => {
    const firstEditor = createEditor("alpha");
    const secondEditor = createEditor("beta", {
      isCurrent: false,
    });
    const firstSnapshot = createPlaybackSnapshot(firstEditor.playbackIdentity!, false);
    const secondSnapshot = createPlaybackSnapshot(secondEditor.playbackIdentity!, true);

    assert.deepEqual(
      resolveSpectrumMusicVirtualRowPlaybackSnapshot({
        editor: firstEditor,
        playbackActionSnapshot: firstSnapshot,
      }),
      firstSnapshot,
    );
    assert.equal(
      resolveSpectrumMusicVirtualRowPlaybackSnapshot({
        editor: secondEditor,
        playbackActionSnapshot: firstSnapshot,
      }),
      null,
    );
    assert.equal(
      areSpectrumMusicVirtualListRowRenderModelsEqual(
        createRowRenderModel(firstEditor, { playbackActionSnapshot: firstSnapshot }),
        createRowRenderModel({ ...firstEditor }, { playbackActionSnapshot: secondSnapshot }),
      ),
      false,
    );
    assert.equal(
      areSpectrumMusicVirtualListRowRenderModelsEqual(
        createRowRenderModel(secondEditor, { index: 1, playbackActionSnapshot: null, start: 384 }),
        createRowRenderModel(
          { ...secondEditor },
          { index: 1, playbackActionSnapshot: firstSnapshot, start: 384 },
        ),
      ),
      true,
    );
  });

  test("keeps row memoization sensitive to the delete handler", () => {
    const editor = createEditor("alpha");
    const props = createRowProps(editor);

    assert.equal(
      areSpectrumMusicVirtualListRowPropsEqual(props, {
        ...props,
        onDelete: () => undefined,
      }),
      false,
    );
  });
});
