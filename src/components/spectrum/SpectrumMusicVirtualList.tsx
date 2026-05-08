import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefCallback,
  type RefObject,
  type SetStateAction,
} from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { usePageViewportScrollElementRef } from "../pageViewportScroll";
import type { EditableTitleHandle } from "../EditableTitle";
import {
  MusicSpectrumEditor,
  type MusicSpectrumExitPresentation,
  type MusicSpectrumSelection,
  type MusicSpectrumWaveformPresentation,
} from "./MusicSpectrumEditor";
import { SpectrumPlaybackAction } from "./SpectrumPlaybackAction";
import { createWaveformRenderDataStore, type WaveformRenderDataStore } from "./SpectrumVisualizer";
import {
  areSpectrumPlaybackActionSnapshotsEqual,
  areSpectrumPlaybackIdentitiesEqual,
  isSpectrumPlaybackStatusIdentityForAction,
  type SpectrumMusicEditorViewModel,
  type SpectrumPlaybackActionSnapshot,
  type SpectrumPlaybackIdentity,
} from "./SpectrumPage.view-model";

const SPECTRUM_MUSIC_VIRTUAL_ROW_ESTIMATE_PX = 336;
const SPECTRUM_MUSIC_VIRTUAL_ROW_GAP_PX = 48;
const SPECTRUM_MUSIC_VIRTUAL_OVERSCAN = 3;
const SPECTRUM_MUSIC_VIRTUAL_PADDING_END_PX = 64;
const SPECTRUM_MUSIC_VIRTUAL_CASCADE_START_DELAY_MS = 390;
const SPECTRUM_MUSIC_VIRTUAL_CASCADE_STEP_MS = 70;

export interface SpectrumMusicVirtualListProps {
  editorViewModels: readonly SpectrumMusicEditorViewModel[];
  trackFilePath: string | null;
  editableTitleRefs: RefObject<Map<string, EditableTitleHandle>>;
  exitPresentation?: MusicSpectrumExitPresentation;
  playbackActionSnapshot: SpectrumPlaybackActionSnapshot | null;
  onReset: (id: string) => void;
  onPlaybackAction: (identity: SpectrumPlaybackIdentity) => Promise<void>;
  onSelectionCommit: (id: string, range: MusicSpectrumSelection) => void;
  onTitleChange: (id: string, name: string) => void;
}

export function resolveSpectrumMusicVirtualListHeight(args: { totalSize: number }) {
  return args.totalSize;
}

export function resolveSpectrumMusicVirtualRowTransform(args: {
  scrollMargin: number;
  start: number;
}) {
  return `translateY(${args.start - args.scrollMargin}px)`;
}

export function resolveSpectrumMusicWaveformPresentation(args: {
  admittedIndexes: ReadonlySet<number>;
  isCurrent: boolean;
  rowIndex: number;
}): MusicSpectrumWaveformPresentation {
  return args.isCurrent || args.admittedIndexes.has(args.rowIndex) ? "interactive" : "placeholder";
}

export function resolveSpectrumMusicVirtualRangeIndexes(args: {
  indexes: readonly number[];
  pinnedIndex: number | null;
}) {
  if (args.pinnedIndex === null || args.indexes.includes(args.pinnedIndex)) {
    return [...args.indexes];
  }

  return [...args.indexes, args.pinnedIndex].toSorted((left, right) => left - right);
}

function extractSpectrumMusicVirtualRange(range: Range) {
  return resolveSpectrumMusicVirtualRangeIndexes({
    indexes: defaultRangeExtractor(range),
    pinnedIndex: range.count > 0 ? 0 : null,
  });
}

export function resolveSpectrumMusicVirtualRowPlaybackSnapshot(args: {
  editor: SpectrumMusicEditorViewModel;
  playbackActionSnapshot: SpectrumPlaybackActionSnapshot | null;
}) {
  return args.editor.playbackIdentity !== null &&
    args.playbackActionSnapshot !== null &&
    isSpectrumPlaybackStatusIdentityForAction(
      args.playbackActionSnapshot.identity,
      args.editor.playbackIdentity,
    )
    ? args.playbackActionSnapshot
    : null;
}

function areNullableSpectrumPlaybackIdentitiesEqual(
  left: SpectrumPlaybackIdentity | null,
  right: SpectrumPlaybackIdentity | null,
) {
  if (left === null || right === null) {
    return left === right;
  }

  return areSpectrumPlaybackIdentitiesEqual(left, right);
}

export function areSpectrumMusicEditorViewModelsEqual(
  left: SpectrumMusicEditorViewModel,
  right: SpectrumMusicEditorViewModel,
) {
  return (
    left.handoffTone === right.handoffTone &&
    left.id === right.id &&
    left.interactionDisabled === right.interactionDisabled &&
    left.isCurrent === right.isCurrent &&
    areNullableSpectrumPlaybackIdentitiesEqual(left.playbackIdentity, right.playbackIdentity) &&
    left.selectionEnd === right.selectionEnd &&
    left.selectionStart === right.selectionStart &&
    left.shouldShowResetAction === right.shouldShowResetAction &&
    left.titleLayoutId === right.titleLayoutId &&
    left.titleValue === right.titleValue
  );
}

export interface SpectrumMusicVirtualListRowRenderModel {
  editor: SpectrumMusicEditorViewModel;
  exitPresentation: MusicSpectrumExitPresentation;
  index: number;
  playbackActionSnapshot: SpectrumPlaybackActionSnapshot | null;
  scrollMargin: number;
  start: number;
  trackFilePath: string | null;
  waveformRenderDataStore: WaveformRenderDataStore;
  waveformPresentation: MusicSpectrumWaveformPresentation;
}

export function areSpectrumMusicVirtualListRowRenderModelsEqual(
  left: SpectrumMusicVirtualListRowRenderModel,
  right: SpectrumMusicVirtualListRowRenderModel,
) {
  return (
    left.exitPresentation === right.exitPresentation &&
    left.index === right.index &&
    left.scrollMargin === right.scrollMargin &&
    left.start === right.start &&
    left.trackFilePath === right.trackFilePath &&
    left.waveformRenderDataStore === right.waveformRenderDataStore &&
    left.waveformPresentation === right.waveformPresentation &&
    areSpectrumMusicEditorViewModelsEqual(left.editor, right.editor) &&
    areSpectrumPlaybackActionSnapshotsEqual(
      resolveSpectrumMusicVirtualRowPlaybackSnapshot({
        editor: left.editor,
        playbackActionSnapshot: left.playbackActionSnapshot,
      }),
      resolveSpectrumMusicVirtualRowPlaybackSnapshot({
        editor: right.editor,
        playbackActionSnapshot: right.playbackActionSnapshot,
      }),
    )
  );
}

type SpectrumMusicVirtualListRowProps = SpectrumMusicVirtualListRowRenderModel & {
  editableTitleRefs: RefObject<Map<string, EditableTitleHandle>>;
  measureElement: (node: HTMLDivElement | null) => void;
  onPlaybackAction: (identity: SpectrumPlaybackIdentity) => Promise<void>;
  onReset: (id: string) => void;
  onSelectionCommit: (id: string, range: MusicSpectrumSelection) => void;
  onTitleChange: (id: string, name: string) => void;
};

function areSpectrumMusicVirtualListRowPropsEqual(
  left: SpectrumMusicVirtualListRowProps,
  right: SpectrumMusicVirtualListRowProps,
) {
  return (
    left.editableTitleRefs === right.editableTitleRefs &&
    left.measureElement === right.measureElement &&
    left.onPlaybackAction === right.onPlaybackAction &&
    left.onReset === right.onReset &&
    left.onSelectionCommit === right.onSelectionCommit &&
    left.onTitleChange === right.onTitleChange &&
    areSpectrumMusicVirtualListRowRenderModelsEqual(left, right)
  );
}

const SpectrumMusicVirtualListRow = memo(function SpectrumMusicVirtualListRow({
  editableTitleRefs,
  editor,
  exitPresentation,
  index,
  playbackActionSnapshot,
  scrollMargin,
  start,
  trackFilePath,
  waveformRenderDataStore,
  waveformPresentation,
  measureElement,
  onPlaybackAction,
  onReset,
  onSelectionCommit,
  onTitleChange,
}: SpectrumMusicVirtualListRowProps) {
  const rowRef = useCallback<RefCallback<HTMLDivElement>>(
    (node) => {
      measureElement(node);

      if (!node) {
        editableTitleRefs.current.delete(editor.id);
      }
    },
    [editableTitleRefs, editor.id, measureElement],
  );
  const titleRef = useCallback(
    (handle: EditableTitleHandle | null) => {
      if (handle) {
        editableTitleRefs.current.set(editor.id, handle);
        return;
      }

      editableTitleRefs.current.delete(editor.id);
    },
    [editableTitleRefs, editor.id],
  );
  const rowPlaybackSnapshot = resolveSpectrumMusicVirtualRowPlaybackSnapshot({
    editor,
    playbackActionSnapshot,
  });

  return (
    <div
      ref={rowRef}
      data-index={index}
      className="group/spectrum-music-row absolute top-0 left-0 w-full"
      style={{
        transform: resolveSpectrumMusicVirtualRowTransform({ scrollMargin, start }),
      }}
    >
      <MusicSpectrumEditor
        cascade={!editor.isCurrent}
        ref={titleRef}
        exitPresentation={exitPresentation}
        handoffTone={editor.handoffTone}
        interactionDisabled={editor.interactionDisabled}
        playbackAction={
          <SpectrumPlaybackAction
            identity={editor.playbackIdentity}
            playbackSnapshot={rowPlaybackSnapshot}
            onAction={onPlaybackAction}
          />
        }
        playheadEnabled={editor.isCurrent}
        selection={{
          end: editor.selectionEnd,
          start: editor.selectionStart,
        }}
        shouldShowResetAction={editor.shouldShowResetAction}
        titleLayoutId={editor.titleLayoutId}
        titleValue={editor.titleValue}
        trackFilePath={trackFilePath}
        waveformRenderDataStore={waveformRenderDataStore}
        waveformPresentation={waveformPresentation}
        waveformClassName="left-1/2 w-screen -translate-x-1/2"
        onReset={() => onReset(editor.id)}
        onSelectionCommit={(range) => onSelectionCommit(editor.id, range)}
        onTitleChange={(name) => onTitleChange(editor.id, name)}
      />
    </div>
  );
}, areSpectrumMusicVirtualListRowPropsEqual);

function areIndexSetsEqual(left: ReadonlySet<number>, right: ReadonlySet<number>) {
  if (left.size !== right.size) {
    return false;
  }

  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }

  return true;
}

function commitAdmittedIndexes(
  setAdmittedIndexes: Dispatch<SetStateAction<ReadonlySet<number>>>,
  nextIndexes: ReadonlySet<number>,
) {
  setAdmittedIndexes((current) =>
    areIndexSetsEqual(current, nextIndexes) ? current : nextIndexes,
  );
}

export function SpectrumMusicVirtualList({
  editableTitleRefs,
  editorViewModels,
  exitPresentation = "local",
  playbackActionSnapshot,
  trackFilePath,
  onReset,
  onPlaybackAction,
  onSelectionCommit,
  onTitleChange,
}: SpectrumMusicVirtualListProps) {
  const scrollElementRef = usePageViewportScrollElementRef();
  const listRef = useRef<HTMLDivElement | null>(null);
  const waveformRenderDataStore = useMemo(() => createWaveformRenderDataStore(), []);
  const handlersRef = useRef({
    onPlaybackAction,
    onReset,
    onSelectionCommit,
    onTitleChange,
  });
  const [scrollMargin, setScrollMargin] = useState(0);
  const [admittedIndexes, setAdmittedIndexes] = useState<ReadonlySet<number>>(() => new Set([0]));
  const estimateSize = useCallback(() => SPECTRUM_MUSIC_VIRTUAL_ROW_ESTIMATE_PX, []);
  const handlePlaybackAction = useCallback((identity: SpectrumPlaybackIdentity) => {
    return handlersRef.current.onPlaybackAction(identity);
  }, []);
  const handleReset = useCallback((id: string) => {
    handlersRef.current.onReset(id);
  }, []);
  const handleSelectionCommit = useCallback((id: string, range: MusicSpectrumSelection) => {
    handlersRef.current.onSelectionCommit(id, range);
  }, []);
  const handleTitleChange = useCallback((id: string, name: string) => {
    handlersRef.current.onTitleChange(id, name);
  }, []);
  const getItemKey = useCallback(
    (index: number) => editorViewModels[index]?.id ?? index,
    [editorViewModels],
  );
  const rowVirtualizer = useVirtualizer({
    count: editorViewModels.length,
    estimateSize,
    gap: SPECTRUM_MUSIC_VIRTUAL_ROW_GAP_PX,
    getItemKey,
    getScrollElement: () => scrollElementRef.current,
    overscan: SPECTRUM_MUSIC_VIRTUAL_OVERSCAN,
    paddingEnd: SPECTRUM_MUSIC_VIRTUAL_PADDING_END_PX,
    rangeExtractor: extractSpectrumMusicVirtualRange,
    scrollMargin,
    useAnimationFrameWithResizeObserver: false,
    useFlushSync: false,
  });
  const measureElementRef = useRef(rowVirtualizer.measureElement);
  measureElementRef.current = rowVirtualizer.measureElement;
  const handleMeasureElement = useCallback((node: HTMLDivElement | null) => {
    measureElementRef.current(node);
  }, []);
  const virtualRows = rowVirtualizer.getVirtualItems();
  const listHeight = resolveSpectrumMusicVirtualListHeight({
    totalSize: rowVirtualizer.getTotalSize(),
  });
  const admissionKey = editorViewModels
    .map((editor, index) => `${index}:${editor.id}:${editor.isCurrent ? "current" : "sibling"}`)
    .join("\n");

  useLayoutEffect(() => {
    handlersRef.current = {
      onPlaybackAction,
      onReset,
      onSelectionCommit,
      onTitleChange,
    };
  }, [onPlaybackAction, onReset, onSelectionCommit, onTitleChange]);

  useLayoutEffect(() => {
    const list = listRef.current;
    const scrollElement = scrollElementRef.current;
    if (!list || !scrollElement) {
      return undefined;
    }

    const syncScrollMargin = () => {
      const listTop = list.getBoundingClientRect().top;
      const scrollElementTop = scrollElement.getBoundingClientRect().top;
      const nextScrollMargin = scrollElement.scrollTop + listTop - scrollElementTop;
      setScrollMargin((current) => (current === nextScrollMargin ? current : nextScrollMargin));
    };

    syncScrollMargin();

    const ownerWindow = scrollElement.ownerDocument.defaultView;
    const ResizeObserverCtor = ownerWindow?.ResizeObserver;
    if (!ResizeObserverCtor) {
      ownerWindow?.addEventListener("resize", syncScrollMargin);

      return () => {
        ownerWindow?.removeEventListener("resize", syncScrollMargin);
      };
    }

    const observer = new ResizeObserverCtor(syncScrollMargin);
    observer.observe(scrollElement);
    observer.observe(list);

    return () => {
      observer.disconnect();
    };
  }, [scrollElementRef]);

  useLayoutEffect(() => {
    const baseIndexes = new Set<number>();
    if (editorViewModels.length > 0) {
      baseIndexes.add(0);
    }
    commitAdmittedIndexes(setAdmittedIndexes, baseIndexes);

    const ownerWindow = listRef.current?.ownerDocument.defaultView ?? window;
    const timers: number[] = [];
    editorViewModels.forEach((editor, index) => {
      if (editor.isCurrent || index === 0) {
        return;
      }

      const timer = ownerWindow.setTimeout(
        () => {
          setAdmittedIndexes((current) => {
            if (current.has(index)) {
              return current;
            }

            const next = new Set(current);
            next.add(index);
            return next;
          });
        },
        SPECTRUM_MUSIC_VIRTUAL_CASCADE_START_DELAY_MS +
          (index - 1) * SPECTRUM_MUSIC_VIRTUAL_CASCADE_STEP_MS,
      );
      timers.push(timer);
    });

    return () => {
      for (const timer of timers) {
        ownerWindow.clearTimeout(timer);
      }
    };
  }, [admissionKey]);

  return (
    <div ref={listRef} className="relative" style={{ height: `${listHeight}px` }}>
      {virtualRows.map((virtualRow) => {
        const editor = editorViewModels[virtualRow.index];
        if (!editor) {
          return null;
        }

        return (
          <SpectrumMusicVirtualListRow
            key={virtualRow.key}
            editableTitleRefs={editableTitleRefs}
            editor={editor}
            exitPresentation={exitPresentation}
            index={virtualRow.index}
            measureElement={handleMeasureElement}
            playbackActionSnapshot={playbackActionSnapshot}
            scrollMargin={scrollMargin}
            start={virtualRow.start}
            trackFilePath={trackFilePath}
            waveformRenderDataStore={waveformRenderDataStore}
            waveformPresentation={resolveSpectrumMusicWaveformPresentation({
              admittedIndexes,
              isCurrent: editor.isCurrent,
              rowIndex: virtualRow.index,
            })}
            onPlaybackAction={handlePlaybackAction}
            onReset={handleReset}
            onSelectionCommit={handleSelectionCommit}
            onTitleChange={handleTitleChange}
          />
        );
      })}
    </div>
  );
}
