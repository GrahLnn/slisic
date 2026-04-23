import { useCallback, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { me } from "@grahlnn/fn";
import { getName } from "@tauri-apps/api/app";
import { documentDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { cn } from "@/lib/utils";
import { icons } from "@/src/assets/icons";
import { crab } from "@/src/cmd";
import { action as appLogicAction, hook as appLogicHook } from "@/src/flow/appLogic";
import { action as playlistCommitAction } from "@/src/flow/playlistCommit";
import { action as pasteDownloadAction, hook as pasteDownloadHook } from "@/src/flow/pasteDownload";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import {
  createPlayListFromDraft,
  createConfigSidebarItemRef,
  createConfigSidebarItems,
  playlistTitleLayoutId,
  resolveDraftCommitTitle,
  resolvePlaylistsWithPreview,
  type ConfigSidebarItemRef,
} from "@/src/flow/appLogic/core";
import { collectionTitleLayoutTransition } from "./collectionTitle";
import {
  ArcTrackList,
  type ArcTrackPopInsertionPlanner,
  type ArcTrackPushTransitionSource,
} from "./ArcTrackList";
import { CoverTool } from "./coverTool";
import { EditableTitle, type EditableTitleHandle } from "./EditableTitle";
import { useListConfigGhostTransition } from "./ListConfig.ghost-transition";
import { usePageRenderFreeze } from "./usePageRenderFreeze";
import {
  resolveListConfigToolLabelAffordance,
  resolveListConfigCollectionUpdatesToolText,
  resolveListConfigSavePath,
  resolveListConfigToolLabelTextClassName,
  resolveListConfigViewModel,
  shouldShowListConfigAutoDownloadIcon,
  type ListConfigEmptyState,
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

const iconStrokeTransition = {
  duration: 0.22,
  ease: [0.22, 1, 0.36, 1],
} as const;

const LIST_CONFIG_GHOST_NODE_OWNER = {
  arcTrack: "arc-track",
  toolLabel: "tool-label",
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

type ListConfigRenderData = {
  savePath: string;
  viewModel: ReturnType<typeof resolveListConfigViewModel>;
};

type ListConfigToolLabelRowProps = {
  item: ListConfigToolLabelItem;
  activeGhostLayoutId: string | null;
  interactionDisabled: boolean;
  registerGhostNode: (layoutId: string, ownerId: string, node: HTMLDivElement | null) => void;
  onRemoveDraftItem: (source: {
    layoutId: string;
    ref: ConfigSidebarItemRef;
    sourceNode: HTMLDivElement | null;
  }) => void;
  onDeleteCandidateItem: (id: string) => void;
};

function waitForNextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function ListConfigToolLabelRow({
  item,
  activeGhostLayoutId,
  interactionDisabled,
  registerGhostNode,
  onRemoveDraftItem,
  onDeleteCandidateItem,
}: ListConfigToolLabelRowProps) {
  const sourceNodeRef = useRef<HTMLDivElement | null>(null);
  const handleRootNodeChange = useCallback(
    (node: HTMLDivElement | null) => {
      sourceNodeRef.current = node;
      registerGhostNode(item.id, LIST_CONFIG_GHOST_NODE_OWNER.toolLabel, node);
    },
    [item.id, registerGhostNode],
  );

  return (
    <motion.div
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
          interactionDisabled={interactionDisabled}
          onRootNodeChange={item.kind === "playlist" ? handleRootNodeChange : undefined}
          layoutId={item.kind === "playlist" && activeGhostLayoutId !== item.id ? item.id : undefined}
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
      </div>
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
}): ListConfigRenderData {
  if (args.titleValue === undefined && args.titleLayoutId === undefined) {
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

export function ListConfig() {
  const isPresent = useIsPresent();
  const editableTitleRef = useRef<EditableTitleHandle | null>(null);
  const {
    activeLayoutId,
    collections,
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
  const libraryItems = createConfigSidebarItems(collections);
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
      candidateItems,
      previousEmptyState: emptyStateRef.current,
    }),
  } satisfies ListConfigRenderData;
  const pageRenderFreeze = usePageRenderFreeze(liveRenderData);
  const renderData = pageRenderFreeze.renderValue;
  const { savePath: renderedSavePath, viewModel } = renderData;
  emptyStateRef.current = viewModel.emptyState;
  const {
    activeLayoutId: activeGhostLayoutId,
    dismissHoverSignal,
    isAnimating: isGhostAnimating,
    registerGhostNode,
    startGhostTransition,
  } = useListConfigGhostTransition();
  const popInsertionPlannerRef = useRef<ArcTrackPopInsertionPlanner | null>(null);
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

  async function handleChangeSavePath() {
    try {
      const defaultSavePath = renderedSavePath || (await getDefaultListConfigSavePath());
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
          appLogicAction.changeSavePath(resolveListConfigSavePath(meta.save_path, selectedPath));
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
        pageRenderFreeze.freeze();
        pasteDownloadAction.reset();
        appLogicAction.back();
        return;
      }

      const titleResolution = resolveDraftCommitTitle({
        draft,
        draftBaseline,
        playlists: resolvePlaylistsWithPreview(playlists, pendingPlaylistPreview),
      });
      const committedDraft = {
        ...draft,
        name: titleResolution.name,
      };
      const committedPlaylist = createPlayListFromDraft(committedDraft);
      const commitRequest = {
        playlist: committedPlaylist,
        previousName: draft.mode === "edit" ? (draftBaseline?.name ?? null) : null,
      };

      playlistCommitAction.commit(commitRequest);

      await editableTitleRef.current?.commitResolvedValue({
        value: titleResolution.name,
        animateTyping: titleResolution.kind !== "keep",
      });

      const committedReturnLayoutId = playlistTitleLayoutId(committedPlaylist.name);
      flushSync(() => {
        appLogicAction.changeDraftName(titleResolution.name);
        pageRenderFreeze.freeze(
          createFrozenListConfigRenderData({
            renderData: liveRenderData,
            titleValue: committedPlaylist.name,
            titleLayoutId: committedReturnLayoutId,
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
    if (isDeletePending || isBackNavigationPending) {
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
      const result = await crab.deletePlaylist(playlistName);

      result.match({
        Ok: () => {
          flushSync(() => {
            appLogicAction.deletePlaylist(playlistName);
            pageRenderFreeze.freeze(
              createFrozenListConfigRenderData({
                renderData: liveRenderData,
                titleLayoutId: null,
              }),
            );
          });
          pasteDownloadAction.reset();
          appLogicAction.back();
        },
        Err: (error) => {
          console.error("Failed to delete playlist", {
            playlistName,
            error,
          });
          setIsDeletePending(false);
        },
      });
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
        <motion.div {...contentFadeProps} className="flex items-center gap-4">
          <EditableTitle
            ref={editableTitleRef}
            autoFocus={viewModel.title.autoFocus}
            className={cn("text-4xl font-bold", "w-fit")}
            handoffTone={viewModel.title.handoffTone}
            interactionDisabled={viewModel.interactionFlags.isTitleInteractionDisabled}
            layoutId={isDeletePending ? undefined : viewModel.title.layoutId}
            placeholder={viewModel.title.placeholder}
            style={{ fontFamily: "var(--font-noto-sans)" }}
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
                viewModel.interactionFlags.isToolListInteractionDisabled && "pointer-events-none",
              )}
            >
              <AnimatePresence initial={false}>
                {viewModel.toolLabelItems.map((item) => (
                  <ListConfigToolLabelRow
                    key={item.id}
                    item={item}
                    activeGhostLayoutId={activeGhostLayoutId}
                    interactionDisabled={viewModel.interactionFlags.isToolListInteractionDisabled}
                    registerGhostNode={registerGhostNode}
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
      {viewModel.interactionFlags.shouldRenderArcTrack && (
        <ArcTrackList
          items={viewModel.arcTrackItems}
          dismissHoverSignal={dismissHoverSignal}
          interactionDisabled={
            !viewModel.interactionFlags.shouldRenderArcTrack || isGhostAnimating
          }
          onGhostNodeChange={handleArcTrackGhostNodeChange}
          onPopInsertionPlannerChange={handlePopInsertionPlannerChange}
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
