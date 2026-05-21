import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  areSpectrumMusicVirtualListRowRenderModelsEqual,
  areSpectrumMusicVirtualListRowPropsEqual,
  areSpectrumMusicEditorViewModelsEqual,
  createSpectrumMusicAdmissionIdentityKey,
  createSpectrumMusicAdmissionScheduleKey,
  resolveSpectrumMusicViewportAdmissionPlan,
  resolveSpectrumMusicAdmissionExtraHeight,
  resolveSpectrumMusicAdmissionDeferredRows,
  resolveSpectrumMusicVirtualViewportRows,
  resolveSpectrumMusicVirtualRowPlaybackSnapshot,
  resolveSpectrumMusicVirtualListHeight,
  resolveSpectrumMusicVirtualRangeIndexes,
  resolveSpectrumMusicVirtualRowTransform,
  resolveSpectrumMusicAdmissionScheduleRows,
  resolveSpectrumMusicRowAdmission,
  shouldAdmitSpectrumMusicViewportRows,
  shouldRunSpectrumMusicAdmissionIdleCallback,
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
    isNewTitle: false,
    showWaveform: true,
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
    isPlaybackActive: false,
    playbackActionSnapshot: null,
    rowAdmission: "admitted",
    scrollMargin: 0,
    start: 0,
    trackFilePath: "C:/music/current.mp3",
    waveformRenderDataStore: testWaveformRenderDataStore,
    isNewTitle: false,
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
    onActivateNewTitle: () => undefined,
    onDelete: () => undefined,
    onPlaybackAction: async () => undefined,
    onPlaybackControlReady: () => undefined,
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

  test("admits real viewport rows only after viewport movement makes them urgent", () => {
    assert.equal(
      shouldAdmitSpectrumMusicViewportRows({
        previousViewportStart: null,
        viewportAdmissionStarted: false,
        viewportStart: 0,
      }),
      false,
    );
    assert.equal(
      shouldAdmitSpectrumMusicViewportRows({
        previousViewportStart: 0,
        viewportAdmissionStarted: false,
        viewportStart: 384,
      }),
      true,
    );
    assert.equal(
      shouldAdmitSpectrumMusicViewportRows({
        previousViewportStart: 384,
        viewportAdmissionStarted: true,
        viewportStart: 0,
      }),
      true,
    );
    assert.deepEqual(
      resolveSpectrumMusicVirtualViewportRows({
        rows: [
          {
            admitted: true,
            index: 0,
            isCurrent: true,
            size: 336,
            start: 0,
          },
          {
            admitted: false,
            index: 4,
            isCurrent: false,
            size: 336,
            start: 1_344,
          },
          {
            admitted: false,
            index: 5,
            isCurrent: false,
            size: 336,
            start: 1_680,
          },
        ],
        viewport: {
          clientHeight: 336,
          scrollTop: 1_344,
        },
      }).map((row) => row.index),
      [4],
    );
    assert.deepEqual(
      resolveSpectrumMusicVirtualViewportRows({
        extraHeight: 336,
        rows: [
          {
            admitted: false,
            index: 3,
            isCurrent: false,
            size: 336,
            start: 1_008,
          },
          {
            admitted: false,
            index: 4,
            isCurrent: false,
            size: 336,
            start: 1_344,
          },
          {
            admitted: false,
            index: 5,
            isCurrent: false,
            size: 336,
            start: 1_680,
          },
        ],
        viewport: {
          clientHeight: 336,
          scrollTop: 1_344,
        },
      }).map((row) => row.index),
      [3, 4, 5],
    );
    assert.equal(resolveSpectrumMusicAdmissionExtraHeight({ clientHeight: 779 }), 2_337);
  });

  test("projects urgent viewport admission before the commit effect catches up", () => {
    const plan = resolveSpectrumMusicViewportAdmissionPlan({
      admittedIndexes: new Set([0, 1, 2]),
      previousViewportStart: 0,
      viewport: {
        clientHeight: 336,
        scrollTop: 1_344,
      },
      viewportAdmissionStarted: true,
      virtualRows: [
        {
          index: 0,
          isCurrent: true,
          size: 336,
          start: 0,
        },
        {
          index: 3,
          size: 336,
          start: 1_008,
        },
        {
          index: 4,
          size: 336,
          start: 1_344,
        },
        {
          index: 5,
          size: 336,
          start: 1_680,
        },
      ],
    });

    assert.deepEqual(plan.missingViewportIndexes, [3, 4, 5]);
    assert.deepEqual(Array.from(plan.nextAdmittedIndexes), [0, 1, 2, 3, 4, 5]);
    assert.equal(plan.nextAdmittedIndexes.has(4), true);
  });

  test("keeps first mount admission constrained until viewport movement starts", () => {
    const admittedIndexes = new Set([0]);
    const plan = resolveSpectrumMusicViewportAdmissionPlan({
      admittedIndexes,
      previousViewportStart: null,
      viewport: {
        clientHeight: 336,
        scrollTop: 0,
      },
      viewportAdmissionStarted: false,
      virtualRows: [
        {
          index: 0,
          isCurrent: true,
          size: 336,
          start: 0,
        },
        {
          index: 1,
          size: 336,
          start: 336,
        },
      ],
    });

    assert.equal(plan.nextAdmittedIndexes, admittedIndexes);
    assert.deepEqual(plan.missingViewportIndexes, []);
  });

  test("admits the current music row before sibling rows enter the editor pipeline", () => {
    assert.equal(
      resolveSpectrumMusicRowAdmission({
        admittedIndexes: new Set([0]),
        isCurrent: true,
        rowIndex: 3,
      }),
      "admitted",
    );
    assert.equal(
      resolveSpectrumMusicRowAdmission({
        admittedIndexes: new Set([0]),
        isCurrent: false,
        rowIndex: 1,
      }),
      "deferred",
    );
    assert.equal(
      resolveSpectrumMusicRowAdmission({
        admittedIndexes: new Set([0, 1]),
        isCurrent: false,
        rowIndex: 1,
      }),
      "admitted",
    );
  });

  test("keeps admission scheduling keyed to row identity and current status only", () => {
    const editors = [
      createEditor("alpha", {
        isCurrent: true,
        titleValue: "Alpha",
      }),
      createEditor("beta", {
        isCurrent: false,
        titleValue: "Beta",
      }),
    ];

    assert.equal(
      createSpectrumMusicAdmissionIdentityKey(editors),
      "0:alpha:current\n1:beta:sibling",
    );
    assert.equal(createSpectrumMusicAdmissionScheduleKey(editors), "0:current\n1:sibling");
    assert.deepEqual(resolveSpectrumMusicAdmissionScheduleRows("0:current\n1:sibling"), [
      {
        index: 0,
        isCurrent: true,
      },
      {
        index: 1,
        isCurrent: false,
      },
    ]);
    assert.equal(
      createSpectrumMusicAdmissionScheduleKey([
        {
          ...editors[0]!,
          titleValue: "Alpha Renamed",
        },
        editors[1]!,
      ]),
      "0:current\n1:sibling",
    );
  });

  test("keeps sibling admission idle-gated after the current row", () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      index,
      isCurrent: index === 0,
    }));

    assert.deepEqual(resolveSpectrumMusicAdmissionDeferredRows({ rows }), [
      { index: 1, isCurrent: false },
      { index: 2, isCurrent: false },
      { index: 3, isCurrent: false },
      { index: 4, isCurrent: false },
    ]);

    assert.equal(
      shouldRunSpectrumMusicAdmissionIdleCallback({
        didTimeout: false,
        timeRemainingMs: 7,
      }),
      false,
    );
    assert.equal(
      shouldRunSpectrumMusicAdmissionIdleCallback({
        didTimeout: false,
        timeRemainingMs: 8,
      }),
      true,
    );
    assert.equal(
      shouldRunSpectrumMusicAdmissionIdleCallback({
        didTimeout: true,
        timeRemainingMs: 0,
      }),
      true,
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

  test("keeps row memoization sensitive to admission changes", () => {
    const editor = createEditor("beta", {
      isCurrent: false,
    });

    assert.equal(
      areSpectrumMusicVirtualListRowRenderModelsEqual(
        createRowRenderModel(editor, {
          rowAdmission: "deferred",
        }),
        createRowRenderModel(editor, {
          rowAdmission: "admitted",
        }),
      ),
      false,
    );
  });

  test("keeps row memoization sensitive to new-title entry state", () => {
    const editor = createEditor("beta", {
      isCurrent: false,
    });

    assert.equal(
      areSpectrumMusicVirtualListRowRenderModelsEqual(
        createRowRenderModel(editor, {
          isNewTitle: false,
        }),
        createRowRenderModel(editor, {
          isNewTitle: true,
        }),
      ),
      false,
    );
  });

  test("keeps row memoization sensitive to playhead ownership changes", () => {
    const editor = createEditor("beta", {
      isCurrent: false,
    });

    assert.equal(
      areSpectrumMusicVirtualListRowRenderModelsEqual(
        createRowRenderModel(editor, {
          isPlaybackActive: false,
        }),
        createRowRenderModel(editor, {
          isPlaybackActive: true,
        }),
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

  test("keeps row memoization sensitive to the new-title activation handler", () => {
    const editor = createEditor("alpha");
    const props = createRowProps(editor);

    assert.equal(
      areSpectrumMusicVirtualListRowPropsEqual(props, {
        ...props,
        onActivateNewTitle: () => undefined,
      }),
      false,
    );
  });
});
