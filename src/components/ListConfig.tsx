import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { me } from "@grahlnn/fn";
import { cn } from "@/lib/utils";
import { icons } from "@/src/assets/icons";
import { action as appLogicAction, hook as appLogicHook } from "@/src/flow/appLogic";
import { action as playlistCommitAction } from "@/src/flow/playlistCommit";
import { action as pasteDownloadAction, hook as pasteDownloadHook } from "@/src/flow/pasteDownload";
import { AnimatePresence, motion, useAnimationControls, useIsPresent } from "motion/react";
import {
  createConfigSidebarItemRef,
  createConfigSidebarItemsFromLibrary,
  resolvePlaylistDraftCommit,
  resolvePlaylistsWithPreview,
  type ConfigSidebarItemRef,
} from "@/src/flow/appLogic/core";
import {
  collectionTitleLayoutTransition,
  collectionTitleTextHoverClassName,
  collectionTitleTextRetainHoverClassName,
  useCollectionTitleRetainedHoverVisual,
} from "./collectionTitle";
import { resolveBackActionVisualState } from "./ListConfig.back-action";
import { BackActionIcon } from "./ListConfig.back-action-icon";
import {
  ArcTrackList,
  type ArcTrackPopInsertionPlanner,
  type ArcTrackProgrammaticPushController,
  type ArcTrackPushTransitionSource,
} from "./ArcTrackList";
import { CoverTool } from "./coverTool";
import { EditableTitle, type EditableTitleHandle } from "./EditableTitle";
import { useListConfigGhostTransition } from "./ListConfig.ghost-transition";
import { usePageRenderFreeze } from "./usePageRenderFreeze";
import {
  resolveListConfigToolLabelAffordance,
  resolveListConfigCollectionUpdatesToolText,
  resolveListConfigExcludeToolLabelTextClassName,
  resolveListConfigPasteTarget,
  resolveListConfigToolLabelTextClassName,
  resolveListConfigViewModel,
  shouldShowListConfigAutoDownloadIcon,
  type ListConfigEmptyState,
  type ListConfigExcludeToolLabelItem,
  type ListConfigExtraToolLabelItem,
  type ListConfigPlaylistToolLabelItem,
  type ListConfigToolLabelItem,
} from "./ListConfig.view-model";
import { ToolLabel, MaskL, MaskR } from "./toollabel";

export const LIST_CONFIG_EMPTY_STATE_TEXT =
  "Nothing here yet.\nPaste a link to download from the web, or import a local music folder to get started.";

const contentFadeProps = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: collectionTitleLayoutTransition,
} as const;

const toolLabelRowHeightTransition = {
  duration: 0.24,
  ease: [0.22, 1, 0.36, 1],
} as const;

const duplicateToolLabelShakeTransition = {
  duration: 0.46,
  ease: [0.16, 1, 0.3, 1],
} as const;

export type ListConfigDuplicateShakeState = {
  layoutId: string;
  signal: number;
};

export type ListConfigDuplicateShakeDecision = "ignore" | "discard" | "shake";

const LIST_CONFIG_GHOST_NODE_OWNER = {
  arcTrack: "arc-track",
  toolLabel: "tool-label",
} as const;

function resolveListConfigToolLabelTool(args: {
  item: ListConfigToolLabelItem;
  resolveSourceNode: () => HTMLDivElement | null;
  onRemoveDraftItem: (source: {
    layoutId: string;
    ref: ConfigSidebarItemRef;
    sourceNode: HTMLDivElement | null;
  }) => void;
  onDeleteCandidateItem: (id: string) => void;
}): ReactNode {
  if (args.item.kind === "playlist") {
    const playlistItem = args.item;
    const collectionUpdatesToolText = resolveListConfigCollectionUpdatesToolText(playlistItem);

    return (
      <div
        className={cn(
          "flex w-full items-center",
          collectionUpdatesToolText ? "justify-between" : "justify-end",
        )}
      >
        {collectionUpdatesToolText && (
          <div className="flex h-fit">
            <CoverTool
              text={collectionUpdatesToolText}
              onClick={() => {
                if (
                  playlistItem.sourceKind !== "collection" ||
                  playlistItem.enableUpdates === null
                ) {
                  return;
                }

                appLogicAction.setCollectionUpdates(
                  playlistItem.ref.url,
                  !playlistItem.enableUpdates,
                );
              }}
            />
            <MaskR />
          </div>
        )}
        <div className="flex h-fit">
          <MaskL />
          <CoverTool
            text="Pop"
            onClick={() => {
              args.onRemoveDraftItem({
                layoutId: playlistItem.id,
                ref: playlistItem.ref,
                sourceNode: args.resolveSourceNode(),
              });
            }}
          />
        </div>
      </div>
    );
  }

  const candidateItem = args.item;

  return me(resolveListConfigToolLabelAffordance(candidateItem)).match({
    playlist: () => undefined,
    passive: () => undefined,
    "candidate-delete": () => (
      <div className="flex h-fit">
        <CoverTool
          text="Delete"
          onClick={() => {
            args.onDeleteCandidateItem(candidateItem.candidateId);
          }}
        />
        <MaskR />
      </div>
    ),
  });
}

function FnButton({
  disabled = false,
  text,
  onClick,
}: {
  disabled?: boolean;
  text: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        "group relative isolate inline-flex h-7 w-fit items-center justify-center",
        "cursor-pointer select-none text-xs leading-none outline-none transition duration-300 ease-in-out",
        "text-[#525252] dark:text-[#e5e5e5] hover:text-[#262626] hover:dark:text-[#d4d4d4]",
        "before:absolute before:inset-y-0 before:-left-2.5 before:-right-2.5 before:-z-10",
        "before:rounded-[25px] before:bg-transparent before:transition before:duration-300",
        "before:[corner-shape:squircle_squircle_squircle_squircle]",
        "hover:before:bg-[#e7eced] dark:hover:before:bg-[#383838]",
        "disabled:pointer-events-none disabled:opacity-50",
      )}
      onClick={onClick}
    >
      {text}
    </button>
  );
}

type ListConfigRenderData = {
  savePath: string;
  viewModel: ReturnType<typeof resolveListConfigViewModel>;
};

type ListConfigToolLabelRowProps = {
  item: ListConfigToolLabelItem;
  activeGhostLayoutId: string | null;
  activeGhostTargetOwnerId: string | null;
  dismissHoverSignal: number;
  duplicateShakeSignal: number;
  interactionDisabled: boolean;
  registerGhostNode: (layoutId: string, ownerId: string, node: HTMLDivElement | null) => void;
  onDuplicateShakeConsumed: (signal: number) => void;
  onRemoveDraftItem: (source: {
    layoutId: string;
    ref: ConfigSidebarItemRef;
    sourceNode: HTMLDivElement | null;
  }) => void;
  onDeleteCandidateItem: (id: string) => void;
};

type ListConfigExcludeToolLabelRowProps = {
  item: ListConfigExcludeToolLabelItem;
  dismissHoverSignal: number;
  interactionDisabled: boolean;
  isRemoving: boolean;
  onRemoveExcludeItem: (item: ListConfigExcludeToolLabelItem) => Promise<boolean>;
  onRemoveExcludeItemStart: (item: ListConfigExcludeToolLabelItem) => void;
};

type ListConfigExtraToolLabelRowProps = {
  item: ListConfigExtraToolLabelItem;
  dismissHoverSignal: number;
  interactionDisabled: boolean;
  isRemoving: boolean;
  onRemoveExtraItem: (item: ListConfigExtraToolLabelItem) => Promise<boolean>;
  onRemoveExtraItemStart: (item: ListConfigExtraToolLabelItem) => void;
};

function waitForNextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

export function shouldHideListConfigToolLabelRowContent(args: {
  activeGhostLayoutId: string | null;
  activeGhostTargetOwnerId: string | null;
  item: ListConfigToolLabelItem;
}) {
  return (
    args.item.kind === "playlist" &&
    args.activeGhostLayoutId === args.item.id &&
    args.activeGhostTargetOwnerId === LIST_CONFIG_GHOST_NODE_OWNER.arcTrack
  );
}

function ListConfigToolLabelRow({
  item,
  activeGhostLayoutId,
  activeGhostTargetOwnerId,
  dismissHoverSignal,
  duplicateShakeSignal,
  interactionDisabled,
  registerGhostNode,
  onDuplicateShakeConsumed,
  onRemoveDraftItem,
  onDeleteCandidateItem,
}: ListConfigToolLabelRowProps) {
  const sourceNodeRef = useRef<HTMLDivElement | null>(null);
  const isDuplicateShakeReadyRef = useRef(false);
  const shakeControls = useAnimationControls();
  const shouldHideRowContent = shouldHideListConfigToolLabelRowContent({
    item,
    activeGhostLayoutId,
    activeGhostTargetOwnerId,
  });
  const handleRootNodeChange = useCallback(
    (node: HTMLDivElement | null) => {
      sourceNodeRef.current = node;
      registerGhostNode(item.id, LIST_CONFIG_GHOST_NODE_OWNER.toolLabel, node);
    },
    [item.id, registerGhostNode],
  );

  useEffect(() => {
    const duplicateShakeDecision = resolveListConfigDuplicateShakeDecision({
      duplicateShakeSignal,
      isRowReady: isDuplicateShakeReadyRef.current,
    });

    if (duplicateShakeDecision === "ignore") {
      return;
    }

    onDuplicateShakeConsumed(duplicateShakeSignal);
    if (duplicateShakeDecision === "discard") {
      return;
    }

    void shakeControls.start({
      x: [0, -14, 10, -7, 4, -2, 0],
      transition: duplicateToolLabelShakeTransition,
    });
  }, [duplicateShakeSignal, onDuplicateShakeConsumed, shakeControls]);

  useEffect(() => {
    isDuplicateShakeReadyRef.current = true;
    return () => {
      isDuplicateShakeReadyRef.current = false;
    };
  }, []);

  return (
    <motion.div
      className="group overflow-y-clip overflow-x-visible"
      initial={{ height: 0 }}
      animate={{ height: "auto" }}
      exit={{ height: 0 }}
      transition={toolLabelRowHeightTransition}
    >
      <motion.div
        animate={shakeControls}
        className={cn(
          "flex items-center backdrop-blur-md w-fit gap-2 pr-1.5 py-2",
          "rounded-full",
          shouldHideRowContent && "invisible",
        )}
      >
        <ToolLabel
          className={cn("")}
          dismissHoverSignal={dismissHoverSignal}
          hoverMode="group"
          interactionDisabled={interactionDisabled}
          onRootNodeChange={item.kind === "playlist" ? handleRootNodeChange : undefined}
          layoutId={
            item.kind === "playlist" && activeGhostLayoutId !== item.id ? item.id : undefined
          }
          toolLayer="portal"
          text={item.text}
          textClassName={resolveListConfigToolLabelTextClassName(item)}
          tool={resolveListConfigToolLabelTool({
            item,
            resolveSourceNode: () => sourceNodeRef.current,
            onRemoveDraftItem,
            onDeleteCandidateItem,
          })}
        />
        {shouldShowListConfigAutoDownloadIcon(item) && <icons.autoDownload size={12} />}
      </motion.div>
    </motion.div>
  );
}

function ListConfigExcludeToolLabelRow({
  item,
  dismissHoverSignal,
  interactionDisabled,
  isRemoving,
  onRemoveExcludeItem,
  onRemoveExcludeItemStart,
}: ListConfigExcludeToolLabelRowProps) {
  return (
    <motion.div
      className="group overflow-visible"
      initial={{ height: 0 }}
      animate={{ height: isRemoving ? 0 : "auto" }}
      exit={{ height: 0 }}
      transition={{
        ...toolLabelRowHeightTransition,
        delay: isRemoving ? 0.14 : 0,
      }}
    >
      <motion.div
        className="flex w-fit items-center py-1.5 pr-1.5"
        initial={{ opacity: 0 }}
        animate={{ opacity: isRemoving ? 0 : 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
      >
        <ToolLabel
          dismissHoverSignal={dismissHoverSignal}
          hoverMode="group"
          interactionDisabled={interactionDisabled || isRemoving}
          text={item.text}
          textClassName={resolveListConfigExcludeToolLabelTextClassName()}
          toolLayer="portal"
          tool={
            <div className="flex h-fit">
              <CoverTool
                text="Restore"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (isRemoving) {
                    return;
                  }
                  flushSync(() => {
                    onRemoveExcludeItemStart(item);
                  });
                  void onRemoveExcludeItem(item).then((didRemove) => {
                    if (!didRemove) {
                      onRemoveExcludeItemStart(item);
                    }
                  });
                }}
              />
              <MaskR />
            </div>
          }
        />
      </motion.div>
    </motion.div>
  );
}

function ListConfigExtraToolLabelRow({
  item,
  dismissHoverSignal,
  interactionDisabled,
  isRemoving,
  onRemoveExtraItem,
  onRemoveExtraItemStart,
}: ListConfigExtraToolLabelRowProps) {
  return (
    <motion.div
      className="group overflow-visible"
      initial={{ height: 0 }}
      animate={{ height: isRemoving ? 0 : "auto" }}
      exit={{ height: 0 }}
      transition={{
        ...toolLabelRowHeightTransition,
        delay: isRemoving ? 0.14 : 0,
      }}
    >
      <motion.div
        className="flex w-fit items-center py-1.5 pr-1.5"
        initial={{ opacity: 0 }}
        animate={{ opacity: isRemoving ? 0 : 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
      >
        <ToolLabel
          dismissHoverSignal={dismissHoverSignal}
          hoverMode="group"
          interactionDisabled={interactionDisabled || isRemoving}
          text={item.text}
          textClassName={resolveListConfigExcludeToolLabelTextClassName()}
          toolLayer="portal"
          tool={
            <div className="flex h-fit">
              <CoverTool
                text="Remove"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (isRemoving) {
                    return;
                  }
                  flushSync(() => {
                    onRemoveExtraItemStart(item);
                  });
                  void onRemoveExtraItem(item).then((didRemove) => {
                    if (!didRemove) {
                      onRemoveExtraItemStart(item);
                    }
                  });
                }}
              />
              <MaskR />
            </div>
          }
        />
      </motion.div>
    </motion.div>
  );
}

async function waitForTitleShareSourceReady() {
  await waitForNextFrame();
  await waitForNextFrame();
}

function createFrozenListConfigRenderData(args: {
  renderData: ListConfigRenderData;
  titleValue?: string;
  titleLayoutId?: string | null;
  titleHoverVisual?: ListConfigRenderData["viewModel"]["title"]["titleHoverVisual"];
}): ListConfigRenderData {
  if (
    args.titleValue === undefined &&
    args.titleLayoutId === undefined &&
    args.titleHoverVisual === undefined
  ) {
    return args.renderData;
  }

  const currentTitle = args.renderData.viewModel.title;
  const titleLayoutId =
    args.titleLayoutId === undefined ? currentTitle.layoutId : (args.titleLayoutId ?? undefined);
  const titleValue = args.titleValue ?? currentTitle.value;

  return {
    ...args.renderData,
    viewModel: {
      ...args.renderData.viewModel,
      title: {
        ...currentTitle,
        layoutId: titleLayoutId,
        titleHoverVisual: args.titleHoverVisual ?? currentTitle.titleHoverVisual,
        value: titleValue,
        snapshot: titleLayoutId
          ? {
              layoutId: titleLayoutId,
              value: titleValue,
              placeholder: currentTitle.placeholder,
            }
          : null,
      },
    },
  };
}

function resolveListConfigTitleHoverClassName(
  titleHoverVisual: ListConfigRenderData["viewModel"]["title"]["titleHoverVisual"],
) {
  switch (titleHoverVisual) {
    case "hold":
      return collectionTitleTextHoverClassName;
    case "retain":
      return collectionTitleTextRetainHoverClassName;
    case "none":
      return undefined;
  }
}

function RetainedConfigTitle({
  editableTitleRef,
  titleHoverVisual,
  ...props
}: ComponentProps<typeof EditableTitle> & {
  editableTitleRef: RefObject<EditableTitleHandle | null>;
  titleHoverVisual: ListConfigRenderData["viewModel"]["title"]["titleHoverVisual"];
}) {
  const retainRequestKey = `${props.layoutId ?? "__config-title"}:${props.value}`;
  const retainedTitleHoverVisual = useCollectionTitleRetainedHoverVisual(
    titleHoverVisual,
    retainRequestKey,
  );

  return (
    <EditableTitle
      ref={editableTitleRef}
      {...props}
      textClassName={resolveListConfigTitleHoverClassName(retainedTitleHoverVisual)}
    />
  );
}

export function resolveToolLabelShakeSignal(
  duplicateShakeState: ListConfigDuplicateShakeState | null,
  item: ListConfigToolLabelItem,
) {
  return duplicateShakeState?.layoutId === item.id ? duplicateShakeState.signal : 0;
}

export function resolveListConfigDuplicateShakeDecision(args: {
  duplicateShakeSignal: number;
  isRowReady: boolean;
}): ListConfigDuplicateShakeDecision {
  if (args.duplicateShakeSignal <= 0) {
    return "ignore";
  }

  return args.isRowReady ? "shake" : "discard";
}

export function consumeListConfigDuplicateShakeState(
  current: ListConfigDuplicateShakeState | null,
  signal: number,
) {
  return current?.signal === signal ? null : current;
}

function createListConfigPasteItemsSnapshot(
  items: readonly ListConfigToolLabelItem[],
): ListConfigPlaylistToolLabelItem[] {
  return items.filter((item): item is ListConfigPlaylistToolLabelItem => item.kind === "playlist");
}

export function ListConfig() {
  const isPresent = useIsPresent();
  const editableTitleRef = useRef<EditableTitleHandle | null>(null);
  const {
    activeLayoutId,
    configLibrary,
    draft,
    draftBaseline,
    pendingPlaylistPreview,
    pendingPlaylistName,
    playlists,
    savePath,
    titleToneHandoff,
  } = appLogicHook.useContext();
  const { items: candidateItems } = pasteDownloadHook.useContext();
  const emptyStateRef = useRef<ListConfigEmptyState | null>(null);
  const [isBackNavigationPending, setIsBackNavigationPending] = useState(false);
  const [isDeletePending, setIsDeletePending] = useState(false);
  const [isImportPending, setIsImportPending] = useState(false);
  const [removingExcludeItemIds, setRemovingExcludeItemIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [removingExtraItemIds, setRemovingExtraItemIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const libraryItems = createConfigSidebarItemsFromLibrary(configLibrary);
  const liveRenderData = {
    savePath,
    viewModel: resolveListConfigViewModel({
      activeLayoutId,
      draft,
      draftBaseline,
      pendingPlaylistName,
      titleToneHandoff,
      isPresent,
      libraryItems,
      excludeItems: configLibrary.excludes,
      excludeAvailability: configLibrary.exclude_availability,
      collectionGroupMemberships: configLibrary.collection_group_memberships,
      candidateItems,
      previousEmptyState: emptyStateRef.current,
    }),
  } satisfies ListConfigRenderData;
  const pageRenderFreeze = usePageRenderFreeze(liveRenderData);
  const renderData = pageRenderFreeze.renderValue;
  const { savePath: renderedSavePath, viewModel } = renderData;
  const visibleExcludeToolLabelItems = viewModel.excludeToolLabelItems.filter(
    (item) => !removingExcludeItemIds.has(item.id),
  );
  const visibleExtraToolLabelItems = viewModel.extraToolLabelItems.filter(
    (item) => !removingExtraItemIds.has(item.id),
  );
  emptyStateRef.current = viewModel.emptyState;
  const backActionVisualState = resolveBackActionVisualState({
    hasDraftChanges: viewModel.hasDraftChanges,
    isImporting: isImportPending,
    isParsing: viewModel.isBackActionParsing,
  });
  const isBackActionLocked =
    isBackNavigationPending || viewModel.interactionFlags.isBackActionInteractionLocked;
  const [duplicateShakeState, setDuplicateShakeState] =
    useState<ListConfigDuplicateShakeState | null>(null);
  const duplicateShakeSequenceRef = useRef(0);
  const {
    activeLayoutId: activeGhostLayoutId,
    activeTargetOwnerId: activeGhostTargetOwnerId,
    dismissHoverSignal,
    registerGhostNode,
    startGhostTransition,
  } = useListConfigGhostTransition();
  const popInsertionPlannerRef = useRef<ArcTrackPopInsertionPlanner | null>(null);
  const arcTrackProgrammaticPushControllerRef = useRef<ArcTrackProgrammaticPushController | null>(
    null,
  );
  const handleArcTrackGhostNodeChange = useCallback(
    (layoutId: string, node: HTMLDivElement | null) => {
      registerGhostNode(layoutId, LIST_CONFIG_GHOST_NODE_OWNER.arcTrack, node);
    },
    [registerGhostNode],
  );
  const handlePopInsertionPlannerChange = useCallback(
    (planner: ArcTrackPopInsertionPlanner | null) => {
      popInsertionPlannerRef.current = planner;
    },
    [],
  );
  const handleProgrammaticPushControllerChange = useCallback(
    (controller: ArcTrackProgrammaticPushController | null) => {
      arcTrackProgrammaticPushControllerRef.current = controller;
    },
    [],
  );
  const handleDuplicateShakeConsumed = useCallback((signal: number) => {
    setDuplicateShakeState((current) => consumeListConfigDuplicateShakeState(current, signal));
  }, []);
  const markExcludeItemRemoving = useCallback((item: ListConfigExcludeToolLabelItem) => {
    setRemovingExcludeItemIds((current) => {
      const next = new Set(current);
      if (next.has(item.id)) {
        next.delete(item.id);
      } else {
        next.add(item.id);
      }
      return next;
    });
  }, []);
  const handleRemoveExcludeItem = useCallback(async (item: ListConfigExcludeToolLabelItem) => {
    const didRemove = await appLogicAction.removeExclude(item.music);
    if (didRemove) {
      setRemovingExcludeItemIds((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
    }
    return didRemove;
  }, []);
  const markExtraItemRemoving = useCallback((item: ListConfigExtraToolLabelItem) => {
    setRemovingExtraItemIds((current) => {
      const next = new Set(current);
      if (next.has(item.id)) {
        next.delete(item.id);
      } else {
        next.add(item.id);
      }
      return next;
    });
  }, []);
  const handleRemoveExtraItem = useCallback(async (item: ListConfigExtraToolLabelItem) => {
    appLogicAction.removeDraftExtra(item.music);
    setRemovingExtraItemIds((current) => {
      const next = new Set(current);
      next.delete(item.id);
      return next;
    });
    return true;
  }, []);

  async function handleChangeSavePath() {
    await appLogicAction.chooseSavePath(renderedSavePath);
  }

  async function handleImportCollection() {
    if (isImportPending) {
      return;
    }

    setIsImportPending(true);
    try {
      await appLogicAction.importLocalCollection(renderedSavePath);
    } finally {
      setIsImportPending(false);
    }
  }

  async function handlePasteAction() {
    try {
      const clipboardText = await readText();
      const pasteTarget = resolveListConfigPasteTarget({
        text: clipboardText,
        playlistItems: createListConfigPasteItemsSnapshot(viewModel.toolLabelItems),
        candidateItems,
        arcTrackItems: viewModel.arcTrackItems,
      });

      if (pasteTarget?.kind === "foreground-duplicate") {
        duplicateShakeSequenceRef.current += 1;
        setDuplicateShakeState({
          layoutId: pasteTarget.layoutId,
          signal: duplicateShakeSequenceRef.current,
        });
        return;
      }

      if (pasteTarget?.kind === "arc-track-push") {
        const didPush =
          arcTrackProgrammaticPushControllerRef.current?.pushItemByLayoutId(pasteTarget.layoutId) ??
          false;

        if (didPush) {
          return;
        }
      }

      pasteDownloadAction.pasteText(clipboardText);
    } catch (error) {
      console.error("Failed to read clipboard for paste download", error);
    }
  }

  async function handleBackAction() {
    if (isBackActionLocked) {
      return;
    }

    try {
      setIsBackNavigationPending(true);
      if (!viewModel.hasDraftChanges || !draft) {
        pageRenderFreeze.freeze(
          createFrozenListConfigRenderData({
            renderData: liveRenderData,
            titleHoverVisual: "retain",
          }),
        );
        pasteDownloadAction.reset();
        appLogicAction.back();
        return;
      }

      const commit = resolvePlaylistDraftCommit({
        draft,
        draftBaseline,
        playlists: resolvePlaylistsWithPreview(playlists, pendingPlaylistPreview),
      });

      playlistCommitAction.commit(commit);

      await editableTitleRef.current?.commitResolvedValue({
        value: commit.titleResolution.name,
        animateTyping: commit.titleResolution.kind !== "keep",
      });

      flushSync(() => {
        appLogicAction.changeDraftName(commit.titleResolution.name);
        pageRenderFreeze.freeze(
          createFrozenListConfigRenderData({
            renderData: liveRenderData,
            titleValue: commit.request.playlist.name,
            titleLayoutId: commit.layoutId,
            titleHoverVisual: "retain",
          }),
        );
      });
      await waitForTitleShareSourceReady();
      pasteDownloadAction.reset();
      appLogicAction.back();
    } catch (error) {
      console.error("Failed to complete the config back transition", error);
      setIsBackNavigationPending(false);
    }
  }

  async function handleDeletePlaylistAction() {
    if (isDeletePending || isBackActionLocked) {
      return;
    }

    if (!draft || draft.mode !== "edit") {
      pageRenderFreeze.freeze();
      pasteDownloadAction.reset();
      appLogicAction.back();
      return;
    }

    const playlistName = draftBaseline?.name ?? draft.name;
    if (!playlistName) {
      pageRenderFreeze.freeze();
      pasteDownloadAction.reset();
      appLogicAction.back();
      return;
    }

    setIsDeletePending(true);

    try {
      const didDeletePlaylist = await appLogicAction.deletePlaylist(playlistName);

      if (!didDeletePlaylist) {
        setIsDeletePending(false);
        return;
      }

      flushSync(() => {
        pageRenderFreeze.freeze(
          createFrozenListConfigRenderData({
            renderData: liveRenderData,
            titleLayoutId: null,
          }),
        );
      });
      pasteDownloadAction.reset();
      appLogicAction.back();
    } catch (error) {
      console.error("Failed to delete playlist", {
        playlistName,
        error,
      });
      setIsDeletePending(false);
    }
  }

  return (
    <div
      data-page-state="config"
      className={cn(
        "relative flex flex-col w-160 mx-auto mt-24",
        !isPresent && "pointer-events-none",
      )}
    >
      <div className={cn("relative z-20 flex flex-col")}>
        <motion.div {...contentFadeProps}>
          <button
            type="button"
            aria-disabled={isBackActionLocked}
            onClick={(event) => {
              if (isBackActionLocked) {
                event.preventDefault();
                event.stopPropagation();
                return;
              }

              void handleBackAction();
            }}
            className={cn(
              "group relative isolate inline-flex w-fit select-none py-2 pr-2",
              isBackActionLocked ? "cursor-wait" : "cursor-pointer",
              isBackNavigationPending && "pointer-events-none",
              "before:absolute before:inset-y-0 before:-left-2 before:right-0 before:-z-10",
              "before:rounded-[25px] before:bg-transparent before:transition before:duration-300",
              "before:[corner-shape:squircle_squircle_squircle_squircle]",
              "hover:before:bg-[#e5e5e5] dark:hover:before:bg-[#262626]",
            )}
          >
            <BackActionIcon visualState={backActionVisualState} />
          </button>
        </motion.div>
        <motion.div {...contentFadeProps} className="flex items-center gap-4">
          <RetainedConfigTitle
            editableTitleRef={editableTitleRef}
            autoFocus={viewModel.title.autoFocus}
            className={cn("text-4xl font-bold", "w-fit")}
            handoffTone={viewModel.title.handoffTone}
            interactionDisabled={viewModel.interactionFlags.isTitleInteractionDisabled}
            layoutId={isDeletePending ? undefined : viewModel.title.layoutId}
            placeholder={viewModel.title.placeholder}
            style={{ fontFamily: "var(--font-noto-sans)" }}
            titleNativeHoverEnabled={viewModel.title.titleNativeHoverEnabled}
            titleHoverVisual={viewModel.title.titleHoverVisual}
            value={viewModel.title.value}
            onChange={appLogicAction.changeDraftName}
          />
          {draft?.mode === "edit" ? (
            <button
              type="button"
              disabled={isDeletePending}
              onClick={() => {
                void handleDeletePlaylistAction();
              }}
              className={cn(
                "group p-2 [corner-shape:squircle_squircle_squircle_squircle] rounded-[25px] transition",
                "hover:bg-[#e5e5e5] dark:hover:bg-[#262626]",
                "disabled:pointer-events-none",
              )}
            >
              <icons.trashXmark
                className={cn(
                  "opacity-20 transition group-hover:opacity-70 group-hover:text-red-600",
                  isDeletePending && "opacity-70 text-red-600",
                )}
              />
            </button>
          ) : null}
        </motion.div>
        <motion.div {...contentFadeProps}>
          <ToolLabel
            className="mt-2"
            textClassName="text-sm trim-cap text-[#404040] dark:text-[#a3a3a3]"
            text={renderedSavePath}
            tool={
              <>
                <CoverTool text="Change" onClick={handleChangeSavePath} />
                <MaskR />
              </>
            }
          />
          <div className="h-24" />
          <div className="flex justify-between">
            <div className="flex gap-5">
              <FnButton
                text="Paste"
                onClick={() => {
                  void handlePasteAction();
                }}
              />
              <FnButton
                disabled={isImportPending}
                text={isImportPending ? "Importing" : "Import"}
                onClick={handleImportCollection}
              />
            </div>

            <div>{/*<FnButton text="Save" />*/}</div>
          </div>
          <div className="h-2" />
        </motion.div>
      </div>

      <div className="relative z-10 overflow-visible flex flex-col gap-8">
        <div className="relative overflow-visible">
          {viewModel.emptyState.match({
            true: () => (
              <motion.div {...contentFadeProps} className="pointer-events-none">
                <p
                  className={cn(
                    "max-w-xl cursor-default select-none whitespace-pre-line text-pretty text-sm leading-6",
                    "text-[#525252] dark:text-[#a3a3a3]",
                  )}
                >
                  {LIST_CONFIG_EMPTY_STATE_TEXT}
                </p>
              </motion.div>
            ),
            false: () => (
              <motion.div
                {...contentFadeProps}
                className={cn(
                  "flex flex-col",
                  viewModel.interactionFlags.isToolListInteractionDisabled && "pointer-events-none",
                )}
              >
                <AnimatePresence initial={false}>
                  {viewModel.toolLabelItems.map((item) => (
                    <ListConfigToolLabelRow
                      key={item.id}
                      item={item}
                      activeGhostLayoutId={activeGhostLayoutId}
                      activeGhostTargetOwnerId={activeGhostTargetOwnerId}
                      dismissHoverSignal={dismissHoverSignal}
                      duplicateShakeSignal={resolveToolLabelShakeSignal(duplicateShakeState, item)}
                      interactionDisabled={viewModel.interactionFlags.isToolListInteractionDisabled}
                      registerGhostNode={registerGhostNode}
                      onDuplicateShakeConsumed={handleDuplicateShakeConsumed}
                      onRemoveDraftItem={({ layoutId, ref, sourceNode }) => {
                        popInsertionPlannerRef.current?.({
                          layoutId,
                          sourceNode,
                        });
                        startGhostTransition({
                          layoutId,
                          sourceNode,
                          targetOwnerId: LIST_CONFIG_GHOST_NODE_OWNER.arcTrack,
                        });
                        appLogicAction.removeDraftItem(ref);
                      }}
                      onDeleteCandidateItem={(id) => {
                        pasteDownloadAction.delete(id);
                      }}
                    />
                  ))}
                </AnimatePresence>
              </motion.div>
            ),
          })}
        </div>
        {viewModel.extraToolLabelItems.length > 0 ? (
          <motion.div
            {...contentFadeProps}
            animate={isPresent ? contentFadeProps.animate : contentFadeProps.exit}
            className="flex flex-col overflow-visible"
          >
            <AnimatePresence initial={false}>
              {visibleExtraToolLabelItems.length > 0 ? (
                <motion.div
                  {...contentFadeProps}
                  className="cursor-default select-none text-sm text-[#525252] dark:text-[#d4d4d4]"
                >
                  Extra
                </motion.div>
              ) : null}
            </AnimatePresence>
            <div
              className={cn(
                "flex flex-col overflow-visible",
                viewModel.interactionFlags.isToolListInteractionDisabled && "pointer-events-none",
              )}
            >
              <AnimatePresence initial={false}>
                {viewModel.extraToolLabelItems.map((item) => (
                  <ListConfigExtraToolLabelRow
                    key={item.id}
                    item={item}
                    dismissHoverSignal={dismissHoverSignal}
                    interactionDisabled={viewModel.interactionFlags.isToolListInteractionDisabled}
                    isRemoving={removingExtraItemIds.has(item.id)}
                    onRemoveExtraItem={handleRemoveExtraItem}
                    onRemoveExtraItemStart={markExtraItemRemoving}
                  />
                ))}
              </AnimatePresence>
            </div>
          </motion.div>
        ) : null}
        {viewModel.excludeToolLabelItems.length > 0 ? (
          <motion.div
            {...contentFadeProps}
            animate={isPresent ? contentFadeProps.animate : contentFadeProps.exit}
            className="flex flex-col overflow-visible"
          >
            <AnimatePresence initial={false}>
              {visibleExcludeToolLabelItems.length > 0 ? (
                <motion.div
                  {...contentFadeProps}
                  className="cursor-default select-none text-sm text-[#525252] dark:text-[#d4d4d4]"
                >
                  Exclude
                </motion.div>
              ) : null}
            </AnimatePresence>
            <div
              className={cn(
                "flex flex-col overflow-visible",
                viewModel.interactionFlags.isToolListInteractionDisabled && "pointer-events-none",
              )}
            >
              <AnimatePresence initial={false}>
                {viewModel.excludeToolLabelItems.map((item) => (
                  <ListConfigExcludeToolLabelRow
                    key={item.id}
                    item={item}
                    dismissHoverSignal={dismissHoverSignal}
                    interactionDisabled={viewModel.interactionFlags.isToolListInteractionDisabled}
                    isRemoving={removingExcludeItemIds.has(item.id)}
                    onRemoveExcludeItem={handleRemoveExcludeItem}
                    onRemoveExcludeItemStart={markExcludeItemRemoving}
                  />
                ))}
              </AnimatePresence>
            </div>
          </motion.div>
        ) : null}
      </div>
      {viewModel.interactionFlags.shouldRenderArcTrack && (
        <ArcTrackList
          items={viewModel.arcTrackItems}
          dismissHoverSignal={dismissHoverSignal}
          onGhostNodeChange={handleArcTrackGhostNodeChange}
          onPopInsertionPlannerChange={handlePopInsertionPlannerChange}
          onProgrammaticPushControllerChange={handleProgrammaticPushControllerChange}
          onPushItem={(source: ArcTrackPushTransitionSource) => {
            const sourceNode = source.sourceNode;
            const layoutRef = createConfigSidebarItemRef(source.item);

            startGhostTransition({
              layoutId: source.layoutId,
              sourceNode,
              targetOwnerId: LIST_CONFIG_GHOST_NODE_OWNER.toolLabel,
            });
            appLogicAction.includeDraftItem(layoutRef);
          }}
          motionProps={contentFadeProps}
        />
      )}
    </div>
  );
}
