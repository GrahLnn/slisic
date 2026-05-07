import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefCallback,
  type RefObject,
  type SetStateAction,
} from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { usePageViewportScrollElementRef } from "../pageViewportScroll";
import type { EditableTitleHandle } from "../EditableTitle";
import {
  MusicSpectrumEditor,
  type MusicSpectrumSelection,
  type MusicSpectrumWaveformPresentation,
} from "./MusicSpectrumEditor";
import type { SpectrumMusicEditorViewModel } from "./SpectrumPage.view-model";

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
  renderPlaybackAction: (editor: SpectrumMusicEditorViewModel) => ReactNode;
  onReset: (id: string) => void;
  onSelectionChange: (id: string, range: MusicSpectrumSelection) => void;
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

function SpectrumMusicVirtualListRow({
  editableTitleRefs,
  editor,
  index,
  renderPlaybackAction,
  scrollMargin,
  start,
  trackFilePath,
  waveformPresentation,
  measureElement,
  onReset,
  onSelectionChange,
  onTitleChange,
}: {
  editableTitleRefs: RefObject<Map<string, EditableTitleHandle>>;
  editor: SpectrumMusicEditorViewModel;
  index: number;
  renderPlaybackAction: (editor: SpectrumMusicEditorViewModel) => ReactNode;
  scrollMargin: number;
  start: number;
  trackFilePath: string | null;
  waveformPresentation: MusicSpectrumWaveformPresentation;
  measureElement: (node: HTMLDivElement | null) => void;
  onReset: (id: string) => void;
  onSelectionChange: (id: string, range: MusicSpectrumSelection) => void;
  onTitleChange: (id: string, name: string) => void;
}) {
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

  return (
    <div
      ref={rowRef}
      data-index={index}
      className="absolute top-0 left-0 w-full"
      style={{
        transform: resolveSpectrumMusicVirtualRowTransform({ scrollMargin, start }),
      }}
    >
      <MusicSpectrumEditor
        cascade={!editor.isCurrent}
        ref={titleRef}
        handoffTone={editor.handoffTone}
        interactionDisabled={editor.interactionDisabled}
        playbackAction={renderPlaybackAction(editor)}
        playheadEnabled={editor.isCurrent}
        selection={{
          end: editor.selectionEnd,
          start: editor.selectionStart,
        }}
        shouldShowResetAction={editor.shouldShowResetAction}
        titleLayoutId={editor.titleLayoutId}
        titleValue={editor.titleValue}
        trackFilePath={trackFilePath}
        waveformPresentation={waveformPresentation}
        waveformClassName="left-1/2 w-screen -translate-x-1/2"
        onReset={() => onReset(editor.id)}
        onSelectionChange={(range) => onSelectionChange(editor.id, range)}
        onTitleChange={(name) => onTitleChange(editor.id, name)}
      />
    </div>
  );
}

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
  setAdmittedIndexes((current) => (areIndexSetsEqual(current, nextIndexes) ? current : nextIndexes));
}

export function SpectrumMusicVirtualList({
  editableTitleRefs,
  editorViewModels,
  renderPlaybackAction,
  trackFilePath,
  onReset,
  onSelectionChange,
  onTitleChange,
}: SpectrumMusicVirtualListProps) {
  const scrollElementRef = usePageViewportScrollElementRef();
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [admittedIndexes, setAdmittedIndexes] = useState<ReadonlySet<number>>(() => new Set([0]));
  const estimateSize = useCallback(() => SPECTRUM_MUSIC_VIRTUAL_ROW_ESTIMATE_PX, []);
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
  const virtualRows = rowVirtualizer.getVirtualItems();
  const listHeight = resolveSpectrumMusicVirtualListHeight({
    totalSize: rowVirtualizer.getTotalSize(),
  });
  const measureElement = rowVirtualizer.measureElement;
  const admissionKey = editorViewModels
    .map((editor, index) => `${index}:${editor.id}:${editor.isCurrent ? "current" : "sibling"}`)
    .join("\n");

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
            index={virtualRow.index}
            measureElement={measureElement}
            renderPlaybackAction={renderPlaybackAction}
            scrollMargin={scrollMargin}
            start={virtualRow.start}
            trackFilePath={trackFilePath}
            waveformPresentation={resolveSpectrumMusicWaveformPresentation({
              admittedIndexes,
              isCurrent: editor.isCurrent,
              rowIndex: virtualRow.index,
            })}
            onReset={onReset}
            onSelectionChange={onSelectionChange}
            onTitleChange={onTitleChange}
          />
        );
      })}
    </div>
  );
}
