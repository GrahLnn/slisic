import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { me } from "@grahlnn/fn";
import { getName } from "@tauri-apps/api/app";
import { documentDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { cn } from "@/lib/utils";
import { icons } from "@/src/assets/icons";
import { crab } from "@/src/cmd";
import { flushSync } from "react-dom";
import {
  action as appLogicAction,
  hook as appLogicHook,
} from "@/src/flow/appLogic";
import { action as playlistCommitAction } from "@/src/flow/playlistCommit";
import {
  action as pasteDownloadAction,
  hook as pasteDownloadHook,
} from "@/src/flow/pasteDownload";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import {
  createPlayListFromDraft,
  createConfigSidebarItemRef,
  createConfigSidebarItems,
  resolveDraftCommitTitle,
  type ConfigSidebarItemRef,
} from "@/src/flow/appLogic/core";
import { collectionTitleLayoutTransition } from "./collectionTitle";
import {
  ArcTrackList,
  type ArcTrackPushTransitionSource,
} from "./ArcTrackList";
import { CoverTool } from "./coverTool";
import { EditableTitle, type EditableTitleHandle } from "./EditableTitle";
import {
  type ListConfigTitleSnapshot,
  resolveListConfigToolLabelAffordance,
  resolveListConfigCollectionUpdatesToolText,
  resolveListConfigSavePath,
  resolveListConfigToolLabelTextClassName,
  resolveListConfigViewModel,
  shouldShowListConfigAutoDownloadIcon,
  type ListConfigEmptyState,
  type ListConfigToolLabelItem,
} from "./ListConfig.view-model";
import { recordUiTrace, registerUiTraceNode, sampleUiTraceFrames } from "@/src/debug/uiTrace";
import { ToolLabel, MaskL, MaskR } from "./toollabel";

export const LIST_CONFIG_EMPTY_STATE_TEXT =
  "Nothing here yet.\nPaste a link to download from the web, or import a local music folder to get started.";

const contentFadeProps = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: collectionTitleLayoutTransition,
} as const;

const iconStrokeTransition = {
  duration: 0.22,
  ease: [0.22, 1, 0.36, 1],
} as const;

function BackActionIcon({ hasDraftChanges }: { hasDraftChanges: boolean }) {
  return (
    <span className="relative block size-4.5">
      <AnimatePresence initial={false} mode="wait">
        {hasDraftChanges ? (
          <motion.svg
            key="check"
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 18 18"
            className={cn(
              "absolute inset-0 block",
              "text-[#737373] dark:text-[#8a8a8a] group-hover:text-[#262626] dark:group-hover:text-[#d4d4d4]",
            )}
          >
            <motion.path
              d="M2.75 9.25L6.75 14.25L15.25 3.75"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              exit={{ pathLength: 0 }}
              transition={iconStrokeTransition}
            />
          </motion.svg>
        ) : (
          <motion.svg
            key="back"
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 18 18"
            className={cn(
              "absolute inset-0 block rotate-90",
              "text-[#737373] dark:text-[#8a8a8a] group-hover:text-[#262626] dark:group-hover:text-[#d4d4d4]",
            )}
          >
            <motion.line
              x1="9"
              y1="15.25"
              x2="9"
              y2="2.75"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              exit={{ pathLength: 0 }}
              transition={iconStrokeTransition}
            />
            <motion.polyline
              points="13.25 11 9 15.25 4.75 11"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              exit={{ pathLength: 0 }}
              transition={iconStrokeTransition}
            />
          </motion.svg>
        )}
      </AnimatePresence>
    </span>
  );
}

function resolveListConfigToolLabelTool(args: {
  item: ListConfigToolLabelItem;
  onRemoveDraftItem: (ref: ConfigSidebarItemRef) => void;
  onDeleteCandidateItem: (id: string) => void;
}): ReactNode {
  if (args.item.kind === "playlist") {
    const playlistItem = args.item;
    const collectionUpdatesToolText =
      resolveListConfigCollectionUpdatesToolText(playlistItem);

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
              args.onRemoveDraftItem(playlistItem.ref);
            }}
          />
        </div>
      </div>
    );
  }

  return me(resolveListConfigToolLabelAffordance(args.item)).match({
    playlist: () => undefined,
    passive: () => undefined,
    "candidate-delete": () => (
      <div className="flex h-fit">
        <CoverTool
          text="Delete"
          onClick={() => {
            args.onDeleteCandidateItem(args.item.id);
          }}
        />
        <MaskR />
      </div>
    ),
  });
}

export async function getDefaultListConfigSavePath() {
  return join(await documentDir(), await getName());
}

function FnButton({ text, onClick }: { text: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      className={cn(
        "group relative isolate inline-flex h-7 w-fit items-center justify-center",
        "cursor-pointer select-none text-xs leading-none outline-none transition duration-300 ease-in-out",
        "text-[#525252] dark:text-[#e5e5e5] hover:text-[#262626] hover:dark:text-[#d4d4d4]",
        "before:absolute before:inset-y-0 before:-left-2.5 before:-right-2.5 before:-z-10",
        "before:rounded-[25px] before:bg-transparent before:transition before:duration-300",
        "before:[corner-shape:squircle_squircle_squircle_squircle]",
        "hover:before:bg-[#e7eced] dark:hover:before:bg-[#383838]",
      )}
      onClick={onClick}
    >
      {text}
    </button>
  );
}

type ListConfigRenderSnapshot = {
  savePath: string;
  viewModel: ReturnType<typeof resolveListConfigViewModel>;
};

type ListConfigGhostTransition = {
  layoutId: string;
  cloneNode: HTMLDivElement;
};

const LIST_CONFIG_GHOST_Z_INDEX = 180;

function hideGhostTarget(node: HTMLDivElement | null) {
  if (!node) {
    return;
  }

  node.style.opacity = "0";
}

function showGhostTarget(node: HTMLDivElement | null) {
  if (!node) {
    return;
  }

  node.style.opacity = "";
}

function createGhostClone(sourceNode: HTMLDivElement) {
  const sourceRect = sourceNode.getBoundingClientRect();
  const cloneNode = sourceNode.cloneNode(true) as HTMLDivElement;
  const sourceStyle = window.getComputedStyle(sourceNode);
  const overlayNodes = cloneNode.querySelectorAll<HTMLElement>("[data-tool-label-overlay='true']");
  const removedOverlayCount = overlayNodes.length;

  overlayNodes.forEach((node) => {
    node.remove();
  });

  cloneNode.style.position = "fixed";
  cloneNode.style.left = `${sourceRect.left}px`;
  cloneNode.style.top = `${sourceRect.top}px`;
  cloneNode.style.width = `${sourceRect.width}px`;
  cloneNode.style.height = `${sourceRect.height}px`;
  cloneNode.style.margin = "0";
  cloneNode.style.pointerEvents = "none";
  // Keep the flying ghost above the page content but below ToolLabel overlays
  // so a pre-hovered target can reveal its tool layer on time.
  cloneNode.style.zIndex = `${LIST_CONFIG_GHOST_Z_INDEX}`;
  cloneNode.style.transform = sourceStyle.transform;
  cloneNode.style.transformOrigin = sourceStyle.transformOrigin;
  cloneNode.style.opacity = sourceStyle.opacity;

  sourceNode.ownerDocument.body.appendChild(cloneNode);

  return {
    cloneNode,
    removedOverlayCount,
  };
}

function createBackRenderSnapshot(
  snapshot: ListConfigRenderSnapshot,
  title: string,
): ListConfigRenderSnapshot {
  const currentTitle = snapshot.viewModel.title;

  return {
    ...snapshot,
    viewModel: {
      ...snapshot.viewModel,
      title: {
        ...currentTitle,
        value: title,
        snapshot: currentTitle.layoutId
          ? {
              layoutId: currentTitle.layoutId,
              value: title,
              placeholder: currentTitle.placeholder,
            }
          : null,
      },
    },
  };
}

export function ListConfig() {
  const isPresent = useIsPresent();
  const rootRef = useRef<HTMLDivElement>(null);
  const editableTitleRef = useRef<EditableTitleHandle | null>(null);
  const {
    activeLayoutId,
    collections,
    draft,
    draftBaseline,
    pendingPlaylistName,
    playlists,
    savePath,
    titleToneHandoff,
  } = appLogicHook.useContext();
  const { items: candidateItems } = pasteDownloadHook.useContext();
  const titleSnapshotRef = useRef<ListConfigTitleSnapshot | null>(null);
  const emptyStateRef = useRef<ListConfigEmptyState | null>(null);
  const [renderSnapshot, setRenderSnapshot] =
    useState<ListConfigRenderSnapshot | null>(null);
  const [activeGhostLayoutId, setActiveGhostLayoutId] = useState<string | null>(
    null,
  );
  const [arcTrackHoverDismissSignal, setArcTrackHoverDismissSignal] = useState(0);
  const [isBackNavigationPending, setIsBackNavigationPending] = useState(false);
  const ghostTransitionRef = useRef<ListConfigGhostTransition | null>(null);
  const ghostTargetNodeRegistryRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const libraryItems = createConfigSidebarItems(collections);
  const liveViewModel = resolveListConfigViewModel({
    activeLayoutId,
    draft,
    draftBaseline,
    pendingPlaylistName,
    titleToneHandoff,
    isPresent,
    libraryItems,
    candidateItems,
    previousTitleSnapshot: titleSnapshotRef.current,
    previousEmptyState: emptyStateRef.current,
  });
  const liveRenderSnapshot = {
    savePath,
    viewModel: liveViewModel,
  } satisfies ListConfigRenderSnapshot;
  const renderData = renderSnapshot ?? liveRenderSnapshot;
  const { savePath: renderedSavePath, viewModel } = renderData;

  if (viewModel.title.snapshot) {
    titleSnapshotRef.current = viewModel.title.snapshot;
  }
  emptyStateRef.current = viewModel.emptyState;

  useLayoutEffect(() => {
    registerUiTraceNode({
      scope: "list-config/root",
      key: "root",
      node: rootRef.current,
      data: {
        activeGhostLayoutId,
        arcTrackHoverDismissSignal,
        toolLabelItemCount: viewModel.toolLabelItems.length,
      },
    });

    return () => {
      registerUiTraceNode({
        scope: "list-config/root",
        key: "root",
        node: null,
      });
    };
  }, [activeGhostLayoutId, arcTrackHoverDismissSignal, viewModel.toolLabelItems.length]);

  useLayoutEffect(() => {
    const ghostTransition = ghostTransitionRef.current;

    if (!activeGhostLayoutId || !ghostTransition) {
      return;
    }

    const targetNode = ghostTargetNodeRegistryRef.current.get(activeGhostLayoutId);

    if (!targetNode) {
      recordUiTrace("list-config/ghost", "target-missing", {
        activeGhostLayoutId,
        registeredTargets: Array.from(ghostTargetNodeRegistryRef.current.keys()),
      });
      return;
    }

    const targetRect = targetNode.getBoundingClientRect();
    recordUiTrace("list-config/ghost", "animation-start", {
      activeGhostLayoutId,
      dismissSignal: arcTrackHoverDismissSignal,
      targetRect: {
        height: Number(targetRect.height.toFixed(3)),
        left: Number(targetRect.left.toFixed(3)),
        top: Number(targetRect.top.toFixed(3)),
        width: Number(targetRect.width.toFixed(3)),
      },
    });
    sampleUiTraceFrames({
      label: `ghost:${activeGhostLayoutId}`,
      scope: "list-config/ghost",
    });
    hideGhostTarget(targetNode);

    const animation = ghostTransition.cloneNode.animate(
      [
        {
          left: ghostTransition.cloneNode.style.left,
          top: ghostTransition.cloneNode.style.top,
          width: ghostTransition.cloneNode.style.width,
          height: ghostTransition.cloneNode.style.height,
          transform: ghostTransition.cloneNode.style.transform || "none",
        },
        {
          left: `${targetRect.left}px`,
          top: `${targetRect.top}px`,
          width: `${targetRect.width}px`,
          height: `${targetRect.height}px`,
          transform: "none",
        },
      ],
      {
        duration: 360,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "forwards",
      },
    );

    animation.finished
      .catch(() => {})
      .finally(() => {
        recordUiTrace("list-config/ghost", "animation-finish", {
          activeGhostLayoutId,
          dismissSignal: arcTrackHoverDismissSignal,
        });
        showGhostTarget(targetNode);
        registerUiTraceNode({
          scope: "list-config/ghost",
          key: ghostTransition.layoutId,
          node: null,
        });
        ghostTransition.cloneNode.remove();

        if (ghostTransitionRef.current?.layoutId === ghostTransition.layoutId) {
          ghostTransitionRef.current = null;
        }

        setActiveGhostLayoutId((current) =>
          current === ghostTransition.layoutId ? null : current,
        );
      });

    return () => {
      recordUiTrace("list-config/ghost", "animation-cleanup", {
        activeGhostLayoutId,
        dismissSignal: arcTrackHoverDismissSignal,
      });
      animation.cancel();
      showGhostTarget(targetNode);
    };
  }, [activeGhostLayoutId, arcTrackHoverDismissSignal, viewModel.toolLabelItems]);

  async function handleChangeSavePath() {
    try {
      const defaultSavePath =
        renderedSavePath || (await getDefaultListConfigSavePath());
      const selectedPath = await open({
        directory: true,
        multiple: false,
        defaultPath: defaultSavePath,
      });

      if (typeof selectedPath !== "string") {
        return;
      }

      const result = await crab.saveMetaInfo({
        save_path: selectedPath,
      });

      result.match({
        Ok: (meta) => {
          appLogicAction.changeSavePath(
            resolveListConfigSavePath(meta.save_path, selectedPath),
          );
        },
        Err: (error) => {
          console.error("Failed to persist the selected save path", error);
        },
      });
    } catch (error) {
      console.error("Failed to choose a save path", error);
    }
  }

  async function handleBackAction() {
    if (isBackNavigationPending) {
      return;
    }

    setIsBackNavigationPending(true);

    try {
      if (!viewModel.hasDraftChanges || !draft) {
        setRenderSnapshot(liveRenderSnapshot);
        pasteDownloadAction.reset();
        appLogicAction.back();
        return;
      }

      const titleResolution = resolveDraftCommitTitle({
        draft,
        draftBaseline,
        playlists,
      });
      const committedDraft = {
        ...draft,
        name: titleResolution.name,
      };
      const committedPlaylist = createPlayListFromDraft(committedDraft);

      playlistCommitAction.commit({
        playlist: committedPlaylist,
        previousName: draft.mode === "edit" ? draftBaseline?.name ?? null : null,
      });

      await editableTitleRef.current?.commitResolvedValue({
        value: titleResolution.name,
        animateTyping: titleResolution.kind !== "keep",
      });

      appLogicAction.changeDraftName(titleResolution.name);
      setRenderSnapshot(
        createBackRenderSnapshot(
          {
            savePath: renderedSavePath,
            viewModel,
          },
          committedPlaylist.name,
        ),
      );
      pasteDownloadAction.reset();
      appLogicAction.back();
    } catch (error) {
      console.error("Failed to complete the config back transition", error);
      setIsBackNavigationPending(false);
    }
  }

  return (
    <div
      ref={rootRef}
      className={cn(
        "relative flex flex-col w-160 mx-auto mt-24",
        !isPresent && "pointer-events-none",
      )}
    >
      <div className={cn("relative z-20 flex flex-col")}>
        <motion.div {...contentFadeProps}>
          <button
            type="button"
            onClick={() => {
              void handleBackAction();
            }}
            className={cn(
              "group relative isolate inline-flex w-fit cursor-pointer select-none py-2 pr-2",
              isBackNavigationPending && "pointer-events-none",
              "before:absolute before:inset-y-0 before:-left-2 before:right-0 before:-z-10",
              "before:rounded-[25px] before:bg-transparent before:transition before:duration-300",
              "before:[corner-shape:squircle_squircle_squircle_squircle]",
              "hover:before:bg-[#e5e5e5] dark:hover:before:bg-[#262626]",
            )}
          >
            <BackActionIcon hasDraftChanges={viewModel.hasDraftChanges} />
          </button>
        </motion.div>
        <EditableTitle
          ref={editableTitleRef}
          autoFocus={viewModel.title.autoFocus}
          className={cn("text-4xl font-bold", "w-fit")}
          handoffTone={viewModel.title.handoffTone}
          interactionDisabled={
            viewModel.interactionFlags.isTitleInteractionDisabled
          }
          layoutId={viewModel.title.layoutId}
          placeholder={viewModel.title.placeholder}
          style={{ fontFamily: "var(--font-noto-sans)" }}
          value={viewModel.title.value}
          onChange={appLogicAction.changeDraftName}
        />
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
              <FnButton text="Paste" onClick={pasteDownloadAction.paste} />
              <FnButton text="Import" />
            </div>

            <div>{/*<FnButton text="Save" />*/}</div>
          </div>
          <div className="h-2" />
        </motion.div>
      </div>

      <div className="relative z-10 overflow-visible">
        {viewModel.emptyState.match({
          true: () => (
            <motion.div
              {...contentFadeProps}
              className="pointer-events-none absolute inset-x-0 top-0"
            >
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
                viewModel.interactionFlags.isToolListInteractionDisabled &&
                  "pointer-events-none",
              )}
            >
              <AnimatePresence initial={false}>
                {viewModel.toolLabelItems.map((item) => (
                  <motion.div
                    key={item.id}
                    className="group"
                    initial={{ paddingTop: "0.5rem", paddingBottom: "0.5rem" }}
                    animate={{ paddingTop: "0.5rem", paddingBottom: "0.5rem" }}
                    exit={{ height: 0, paddingTop: 0, paddingBottom: 0 }}
                  >
                    <div
                      className={cn(
                        "flex items-center backdrop-blur-md w-fit gap-2 pr-1.5",
                        "rounded-full",
                      )}
                    >
                      <ToolLabel
                        className={cn("")}
                        hoverMode="group"
                        interactionDisabled={
                          viewModel.interactionFlags
                            .isToolListInteractionDisabled
                        }
                        onRootNodeChange={
                          item.kind === "playlist"
                            ? (node) => {
                                const registry = ghostTargetNodeRegistryRef.current;
                                registerUiTraceNode({
                                  scope: "list-config/tool-label",
                                  key: item.id,
                                  node,
                                  data: {
                                    itemId: item.id,
                                    text: item.text,
                                  },
                                });

                                if (!node) {
                                  registry.delete(item.id);
                                  return;
                                }

                                registry.set(item.id, node);
                              }
                            : undefined
                        }
                        layoutId={
                          item.kind === "playlist" &&
                          activeGhostLayoutId !== item.id
                            ? item.id
                            : undefined
                        }
                        toolLayer="portal"
                        text={item.text}
                        textClassName={resolveListConfigToolLabelTextClassName(
                          item,
                        )}
                        tool={resolveListConfigToolLabelTool({
                          item,
                          onRemoveDraftItem: (ref) => {
                            appLogicAction.removeDraftItem(ref);
                          },
                          onDeleteCandidateItem: (id) => {
                            pasteDownloadAction.delete(id);
                          },
                        })}
                      />
                      {shouldShowListConfigAutoDownloadIcon(item) && (
                        <icons.autoDownload size={12} />
                      )}
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </motion.div>
          ),
        })}
      </div>
      {viewModel.interactionFlags.shouldRenderArcTrack && (
        <ArcTrackList
          items={viewModel.arcTrackItems}
          dismissHoverSignal={arcTrackHoverDismissSignal}
          interactionDisabled={
            !viewModel.interactionFlags.shouldRenderArcTrack ||
            activeGhostLayoutId !== null
          }
          suppressedLayoutIds={
            activeGhostLayoutId ? new Set([activeGhostLayoutId]) : undefined
          }
          onPushItem={(source: ArcTrackPushTransitionSource) => {
            const sourceNode = source.sourceNode;
            const layoutRef = createConfigSidebarItemRef(source.item);

            recordUiTrace("list-config/push", "start", {
              activeGhostLayoutId,
              dismissSignal: arcTrackHoverDismissSignal,
              item: {
                kind: source.item.kind,
                name: source.item.name,
                url: source.item.url,
              },
              layoutId: source.layoutId,
              sourceNodePresent: Boolean(sourceNode),
            });
            ghostTransitionRef.current?.cloneNode.remove();
            ghostTransitionRef.current = null;

            if (sourceNode) {
              registerUiTraceNode({
                scope: "list-config/ghost",
                key: source.layoutId,
                node: null,
              });
              const ghostClone = createGhostClone(sourceNode);
              ghostTransitionRef.current = {
                layoutId: source.layoutId,
                cloneNode: ghostClone.cloneNode,
              };
              registerUiTraceNode({
                scope: "list-config/ghost",
                key: source.layoutId,
                node: ghostTransitionRef.current.cloneNode,
                data: {
                  layoutId: source.layoutId,
                },
              });
              recordUiTrace("list-config/ghost", "clone-created", {
                layoutId: source.layoutId,
                removedOverlayCount: ghostClone.removedOverlayCount,
              });
              flushSync(() => {
                setArcTrackHoverDismissSignal((current) => current + 1);
                setActiveGhostLayoutId(source.layoutId);
              });
            }

            appLogicAction.includeDraftItem(layoutRef);
          }}
          motionProps={contentFadeProps}
        />
      )}
    </div>
  );
}
