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
import { cn } from "@/lib/utils";
import { icons } from "@/src/assets/icons";
import { usePageViewportScrollElementRef } from "../pageViewportScroll";
import type { EditableTitleHandle } from "../EditableTitle";
import {
  MusicSpectrumEditor,
  type MusicSpectrumExitPresentation,
  type MusicSpectrumSelection,
} from "./MusicSpectrumEditor";
import { SpectrumPlaybackAction } from "./SpectrumPlaybackAction";
import {
  createWaveformRenderDataStore,
  type TrackSpectrumPlaybackControl,
  type TrackSpectrumPlaybackStatusCommit,
  type WaveformRenderDataStore,
} from "./SpectrumVisualizer";
import {
  areSpectrumPlaybackActionSnapshotsEqual,
  areSpectrumPlaybackIdentitiesEqual,
  isSpectrumPlaybackStatusIdentityForAction,
  type SpectrumMusicEditorViewModel,
  type SpectrumPlaybackActionKind,
  type SpectrumPlaybackActionSnapshot,
  type SpectrumPlaybackIdentity,
} from "./SpectrumPage.view-model";

const SPECTRUM_MUSIC_VIRTUAL_ROW_ESTIMATE_PX = 336;
const SPECTRUM_MUSIC_EDITOR_ROW_CONTENT_HEIGHT_PX = 280;
const SPECTRUM_MUSIC_VIRTUAL_ROW_GAP_PX = 48;
const SPECTRUM_MUSIC_VIRTUAL_OVERSCAN = 3;
const SPECTRUM_MUSIC_VIRTUAL_PADDING_END_PX = 64;
const SPECTRUM_MUSIC_VIRTUAL_CASCADE_START_DELAY_MS = 390;
const SPECTRUM_MUSIC_VIRTUAL_CASCADE_STEP_MS = 70;

export type SpectrumMusicRowAdmission = "admitted" | "deferred";

export interface SpectrumMusicVirtualListProps {
  editorViewModels: readonly SpectrumMusicEditorViewModel[];
  trackFilePath: string | null;
  editableTitleRefs: RefObject<Map<string, EditableTitleHandle>>;
  exitPresentation?: MusicSpectrumExitPresentation;
  playbackActionSnapshot: SpectrumPlaybackActionSnapshot | null;
  onDelete: (id: string) => void;
  onActivateNewTitle?: (id: string) => void;
  onReset: (id: string) => void;
  onPlaybackAction: (
    identity: SpectrumPlaybackIdentity,
    action: SpectrumPlaybackActionKind,
  ) => Promise<void>;
  onPlaybackControlReady: (
    identity: SpectrumPlaybackIdentity | null,
    control: TrackSpectrumPlaybackControl | null,
  ) => void;
  onSelectionCommit: (
    id: string,
    range: MusicSpectrumSelection,
    commitPlaybackStatus?: TrackSpectrumPlaybackStatusCommit,
  ) => void;
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

export function resolveSpectrumMusicRowAdmission(args: {
  admittedIndexes: ReadonlySet<number>;
  isCurrent: boolean;
  rowIndex: number;
}): SpectrumMusicRowAdmission {
  return args.isCurrent || args.admittedIndexes.has(args.rowIndex) ? "admitted" : "deferred";
}

export function createSpectrumMusicAdmissionIdentityKey(
  editors: readonly SpectrumMusicEditorViewModel[],
) {
  return editors
    .map((editor, index) => `${index}:${editor.id}:${editor.isCurrent ? "current" : "sibling"}`)
    .join("\n");
}

export function createSpectrumMusicAdmissionScheduleKey(
  editors: readonly SpectrumMusicEditorViewModel[],
) {
  return editors
    .map((editor, index) => `${index}:${editor.isCurrent ? "current" : "sibling"}`)
    .join("\n");
}

export function resolveSpectrumMusicAdmissionScheduleRows(scheduleKey: string) {
  return scheduleKey.split("\n").flatMap((entry) => {
    const [indexValue, status] = entry.split(":");
    const index = Number(indexValue);

    return Number.isInteger(index)
      ? [
          {
            index,
            isCurrent: status === "current",
          },
        ]
      : [];
  });
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
    left.isNewTitle === right.isNewTitle &&
    left.showWaveform === right.showWaveform &&
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
  isPlaybackActive: boolean;
  isNewTitle: boolean;
  playbackActionSnapshot: SpectrumPlaybackActionSnapshot | null;
  rowAdmission: SpectrumMusicRowAdmission;
  scrollMargin: number;
  start: number;
  trackFilePath: string | null;
  waveformRenderDataStore: WaveformRenderDataStore;
}

export function areSpectrumMusicVirtualListRowRenderModelsEqual(
  left: SpectrumMusicVirtualListRowRenderModel,
  right: SpectrumMusicVirtualListRowRenderModel,
) {
  return (
    left.exitPresentation === right.exitPresentation &&
    left.index === right.index &&
    left.isPlaybackActive === right.isPlaybackActive &&
    left.isNewTitle === right.isNewTitle &&
    left.rowAdmission === right.rowAdmission &&
    left.scrollMargin === right.scrollMargin &&
    left.start === right.start &&
    left.trackFilePath === right.trackFilePath &&
    left.waveformRenderDataStore === right.waveformRenderDataStore &&
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
  onActivateNewTitle?: (id: string) => void;
  onDelete: (id: string) => void;
  onPlaybackAction: (
    identity: SpectrumPlaybackIdentity,
    action: SpectrumPlaybackActionKind,
  ) => Promise<void>;
  onPlaybackControlReady: (
    identity: SpectrumPlaybackIdentity | null,
    control: TrackSpectrumPlaybackControl | null,
  ) => void;
  onReset: (id: string) => void;
  onSelectionCommit: (
    id: string,
    range: MusicSpectrumSelection,
    commitPlaybackStatus?: TrackSpectrumPlaybackStatusCommit,
  ) => void;
  onTitleChange: (id: string, name: string) => void;
};

export function areSpectrumMusicVirtualListRowPropsEqual(
  left: SpectrumMusicVirtualListRowProps,
  right: SpectrumMusicVirtualListRowProps,
) {
  return (
    left.editableTitleRefs === right.editableTitleRefs &&
    left.measureElement === right.measureElement &&
    left.onActivateNewTitle === right.onActivateNewTitle &&
    left.onDelete === right.onDelete &&
    left.onPlaybackAction === right.onPlaybackAction &&
    left.onPlaybackControlReady === right.onPlaybackControlReady &&
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
  isPlaybackActive,
  isNewTitle,
  playbackActionSnapshot,
  rowAdmission,
  scrollMargin,
  start,
  trackFilePath,
  waveformRenderDataStore,
  measureElement,
  onActivateNewTitle,
  onDelete,
  onPlaybackAction,
  onPlaybackControlReady,
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
  const playbackIdentity = editor.playbackIdentity;

  return (
    <div
      ref={rowRef}
      data-index={index}
      className="group/spectrum-music-row absolute top-0 left-0 w-full"
      style={{
        transform: resolveSpectrumMusicVirtualRowTransform({ scrollMargin, start }),
      }}
    >
      {rowAdmission === "admitted" ? (
        <MusicSpectrumEditor
          cascade={!editor.isCurrent}
          ref={titleRef}
          exitPresentation={exitPresentation}
          handoffTone={editor.handoffTone}
          interactionDisabled={editor.interactionDisabled}
          titleIsNew={isNewTitle}
          titleAction={
            editor.isNewTitle ? null : (
              <button
                type="button"
                aria-label="Delete music"
                onClick={() => onDelete(editor.id)}
                className={cn(
                  "group relative isolate inline-flex size-8 items-center justify-center rounded-[25px] p-2",
                  "text-[#737373] transition duration-300 [corner-shape:squircle_squircle_squircle_squircle]",
                  "before:absolute before:inset-0 before:-z-10 before:rounded-[25px] before:bg-transparent",
                  "before:transition before:duration-300 before:[corner-shape:squircle_squircle_squircle_squircle]",
                  "hover:text-red-600 hover:before:bg-[#e5e5e5]",
                  "dark:text-[#8a8a8a] dark:hover:text-red-400 dark:hover:before:bg-[#262626]",
                )}
              >
                <icons.trashXmark size={18} />
              </button>
            )
          }
          waveformStartAction={
            editor.showWaveform ? (
              <SpectrumPlaybackAction
                identity={editor.playbackIdentity}
                playbackSnapshot={rowPlaybackSnapshot}
                onAction={onPlaybackAction}
              />
            ) : null
          }
          playheadEnabled={isPlaybackActive}
          selection={{
            end: editor.selectionEnd,
            start: editor.selectionStart,
          }}
          shouldShowResetAction={editor.shouldShowResetAction}
          titleLayoutId={editor.titleLayoutId}
          titleValue={editor.titleValue}
          trackFilePath={trackFilePath}
          waveformVisible={editor.showWaveform}
          waveformRenderDataStore={waveformRenderDataStore}
          waveformClassName="left-1/2 w-screen -translate-x-1/2"
          onReset={() => onReset(editor.id)}
          onPlaybackControlReady={
            playbackIdentity === null
              ? undefined
              : (control) => onPlaybackControlReady(playbackIdentity, control)
          }
          onSelectionCommit={(range, commitPlaybackStatus) =>
            onSelectionCommit(editor.id, range, commitPlaybackStatus)
          }
          onNewTitleActivate={
            isNewTitle && onActivateNewTitle ? () => onActivateNewTitle(editor.id) : undefined
          }
          onTitleChange={(name) => onTitleChange(editor.id, name)}
        />
      ) : (
        <div aria-hidden style={{ height: SPECTRUM_MUSIC_EDITOR_ROW_CONTENT_HEIGHT_PX }} />
      )}
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
  onDelete,
  onActivateNewTitle,
  onPlaybackAction,
  onPlaybackControlReady,
  onReset,
  onSelectionCommit,
  onTitleChange,
}: SpectrumMusicVirtualListProps) {
  const scrollElementRef = usePageViewportScrollElementRef();
  const listRef = useRef<HTMLDivElement | null>(null);
  const waveformRenderDataStore = useMemo(() => createWaveformRenderDataStore(), []);
  const handlersRef = useRef({
    onActivateNewTitle,
    onDelete,
    onPlaybackAction,
    onPlaybackControlReady,
    onReset,
    onSelectionCommit,
    onTitleChange,
  });
  const [scrollMargin, setScrollMargin] = useState(0);
  const [admittedIndexes, setAdmittedIndexes] = useState<ReadonlySet<number>>(() => new Set([0]));
  const estimateSize = useCallback(() => SPECTRUM_MUSIC_VIRTUAL_ROW_ESTIMATE_PX, []);
  const handlePlaybackAction = useCallback(
    (identity: SpectrumPlaybackIdentity, action: SpectrumPlaybackActionKind) => {
      return handlersRef.current.onPlaybackAction(identity, action);
    },
    [],
  );
  const handlePlaybackControlReady = useCallback(
    (identity: SpectrumPlaybackIdentity | null, control: TrackSpectrumPlaybackControl | null) => {
      handlersRef.current.onPlaybackControlReady(identity, control);
    },
    [],
  );
  const handleDelete = useCallback((id: string) => {
    handlersRef.current.onDelete(id);
  }, []);
  const handleActivateNewTitle = useCallback((id: string) => {
    handlersRef.current.onActivateNewTitle?.(id);
  }, []);
  const handleReset = useCallback((id: string) => {
    handlersRef.current.onReset(id);
  }, []);
  const handleSelectionCommit = useCallback(
    (
      id: string,
      range: MusicSpectrumSelection,
      commitPlaybackStatus?: TrackSpectrumPlaybackStatusCommit,
    ) => {
      handlersRef.current.onSelectionCommit(id, range, commitPlaybackStatus);
    },
    [],
  );
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
  const admissionIdentityKey = createSpectrumMusicAdmissionIdentityKey(editorViewModels);
  const admissionScheduleKey = createSpectrumMusicAdmissionScheduleKey(editorViewModels);

  useLayoutEffect(() => {
    handlersRef.current = {
      onActivateNewTitle,
      onDelete,
      onPlaybackAction,
      onPlaybackControlReady,
      onReset,
      onSelectionCommit,
      onTitleChange,
    };
  }, [
    onActivateNewTitle,
    onDelete,
    onPlaybackAction,
    onPlaybackControlReady,
    onReset,
    onSelectionCommit,
    onTitleChange,
  ]);

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
    const admissionRows = resolveSpectrumMusicAdmissionScheduleRows(admissionScheduleKey);
    const baseIndexes = new Set<number>();
    if (admissionRows.length > 0) {
      baseIndexes.add(0);
    }
    commitAdmittedIndexes(setAdmittedIndexes, baseIndexes);

    const ownerWindow = listRef.current?.ownerDocument.defaultView ?? window;
    const timers: number[] = [];
    admissionRows.forEach((row) => {
      if (row.isCurrent || row.index === 0) {
        return;
      }

      const timer = ownerWindow.setTimeout(
        () => {
          setAdmittedIndexes((current) => {
            if (current.has(row.index)) {
              return current;
            }

            const next = new Set(current);
            next.add(row.index);
            return next;
          });
        },
        SPECTRUM_MUSIC_VIRTUAL_CASCADE_START_DELAY_MS +
          (row.index - 1) * SPECTRUM_MUSIC_VIRTUAL_CASCADE_STEP_MS,
      );
      timers.push(timer);
    });

    return () => {
      for (const timer of timers) {
        ownerWindow.clearTimeout(timer);
      }
    };
  }, [admissionIdentityKey, admissionScheduleKey]);

  return (
    <div ref={listRef} className="relative" style={{ height: `${listHeight}px` }}>
      {virtualRows.map((virtualRow) => {
        const editor = editorViewModels[virtualRow.index];
        if (!editor) {
          return null;
        }

        const rowAdmission = resolveSpectrumMusicRowAdmission({
          admittedIndexes,
          isCurrent: editor.isCurrent,
          rowIndex: virtualRow.index,
        });

        return (
          <SpectrumMusicVirtualListRow
            key={virtualRow.key}
            editableTitleRefs={editableTitleRefs}
            editor={editor}
            exitPresentation={exitPresentation}
            index={virtualRow.index}
            isPlaybackActive={
              editor.showWaveform &&
              resolveSpectrumMusicVirtualRowPlaybackSnapshot({
                editor,
                playbackActionSnapshot,
              }) !== null
            }
            isNewTitle={editor.isNewTitle}
            measureElement={handleMeasureElement}
            playbackActionSnapshot={playbackActionSnapshot}
            rowAdmission={rowAdmission}
            scrollMargin={scrollMargin}
            start={virtualRow.start}
            trackFilePath={trackFilePath}
            waveformRenderDataStore={waveformRenderDataStore}
            onActivateNewTitle={handleActivateNewTitle}
            onDelete={handleDelete}
            onPlaybackControlReady={handlePlaybackControlReady}
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
