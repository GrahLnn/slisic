import { useRef, useState } from "react";
import { me, type ME } from "@grahlnn/fn";
import { getName } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { documentDir, join } from "@tauri-apps/api/path";
import { cn } from "@/lib/utils";
import { icons } from "@/src/assets/icons";
import { crab } from "@/src/cmd";
import {
  action as appLogicAction,
  hook as appLogicHook,
} from "@/src/flow/appLogic";
import {
  action as pasteDownloadAction,
  hook as pasteDownloadHook,
} from "@/src/flow/pasteDownload";
import type {
  ConfigSidebarItem,
  CollectionTitleHandoff,
  CollectionTitleTone,
  ConfigDraft,
} from "@/src/flow/appLogic/core";
import type {
  ConfigCandidateItem,
  ConfigCandidateItemStatus,
} from "@/src/flow/pasteDownload/core";
import { ArcTrackList } from "./ArcTrackList";
import { ToolLabel, MaskL, MaskR } from "./toollabel";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { CoverTool } from "./coverTool";
import {
  collectionTitleLayoutTransition,
  CREATE_COLLECTION_TITLE,
} from "./collectionTitle";
import { EditableTitle } from "./EditableTitle";
import { recordUiTrace } from "@/src/debug/uiTrace";

export interface ListConfigTitleSnapshot {
  layoutId: string;
  value: string;
  placeholder?: string;
}

export function createListConfigTitleSnapshot(
  activeLayoutId: string | null,
  draft: ConfigDraft | null,
): ListConfigTitleSnapshot | null {
  if (!activeLayoutId || !draft) {
    return null;
  }

  return {
    layoutId: activeLayoutId,
    value: draft.name,
    placeholder: draft.mode === "create" ? CREATE_COLLECTION_TITLE : undefined,
  };
}

export function resolveListConfigTitleViewModel(args: {
  activeLayoutId: string | null;
  draft: ConfigDraft | null;
  titleToneHandoff: CollectionTitleHandoff | null;
  previousSnapshot: ListConfigTitleSnapshot | null;
}) {
  const snapshot =
    createListConfigTitleSnapshot(args.activeLayoutId, args.draft) ??
    args.previousSnapshot;
  const layoutId = snapshot?.layoutId;

  return {
    snapshot,
    autoFocus: Boolean(args.activeLayoutId && args.draft?.mode === "create"),
    handoffTone:
      layoutId && args.titleToneHandoff?.layoutId === layoutId
        ? args.titleToneHandoff.tone
        : null,
    layoutId,
    placeholder: snapshot?.placeholder,
    value: snapshot?.value ?? "",
  } as {
    snapshot: ListConfigTitleSnapshot | null;
    autoFocus: boolean;
    handoffTone: CollectionTitleTone | null;
    layoutId: string | undefined;
    placeholder?: string;
    value: string;
  };
}

export function resolveListConfigToolListInteractionDisabled(args: {
  isAnimating: boolean;
  isPresent: boolean;
}) {
  return !args.isPresent;
}

export const LIST_CONFIG_EMPTY_STATE_TEXT =
  "Nothing here yet.\nPaste a link to download from the web, or import a local music folder to get started.";

export type ListConfigEmptyStateKind = "keep" | "show" | "hide";
export type ListConfigEmptyStateSignal = ME<ListConfigEmptyStateKind>;
export type ListConfigEmptyState = ME<boolean>;

export function shouldShowListConfigEmptyState(args: {
  draft: ConfigDraft | null;
  candidateItemCount: number;
}): ListConfigEmptyStateSignal {
  if (!args.draft) {
    return me<ListConfigEmptyStateKind>("keep");
  }

  if (args.candidateItemCount > 0) {
    return me<ListConfigEmptyStateKind>("hide");
  }

  return me<ListConfigEmptyStateKind>(
    args.draft.collections.length === 0 && args.draft.groups.length === 0
      ? "show"
      : "hide",
  );
}

export interface ListConfigPlaylistToolLabelItem {
  kind: "playlist";
  id: string;
  text: string;
  sourceKind: ConfigSidebarItem["kind"];
  enableUpdates: boolean | null;
}

export interface ListConfigCandidateToolLabelItem {
  kind: "candidate";
  id: string;
  text: string;
  status: ConfigCandidateItemStatus;
}

export type ListConfigToolLabelItem =
  | ListConfigPlaylistToolLabelItem
  | ListConfigCandidateToolLabelItem;

export interface ListConfigPlaylistSidebarItem extends ConfigSidebarItem {
  enableUpdates: boolean | null;
}

function normalizeListConfigSidebarName(name: string) {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function createListConfigSidebarItemId(
  item: Pick<ConfigSidebarItem, "kind" | "url">,
) {
  return `playlist:${item.kind}:${item.url}`;
}

export function createListConfigPlaylistSidebarItems(
  draft: ConfigDraft | null,
): ListConfigPlaylistSidebarItem[] {
  if (!draft) {
    return [];
  }

  const items: ListConfigPlaylistSidebarItem[] = [];
  const seenUrls = new Set<string>();
  const collectionNames = new Set(
    draft.collections.map((collection) =>
      normalizeListConfigSidebarName(collection.name),
    ),
  );

  for (const collection of draft.collections) {
    if (seenUrls.has(collection.url)) {
      continue;
    }

    seenUrls.add(collection.url);
    items.push({
      kind: "collection",
      name: collection.name,
      url: collection.url,
      folder: collection.folder,
      enableUpdates: collection.enable_updates,
    });
  }

  for (const group of draft.groups) {
    if (collectionNames.has(normalizeListConfigSidebarName(group.name))) {
      continue;
    }

    if (seenUrls.has(group.url)) {
      continue;
    }

    seenUrls.add(group.url);
    items.push({
      kind: "group",
      name: group.name,
      url: group.url,
      folder: group.folder,
      enableUpdates: null,
    });
  }

  return items;
}

export function createListConfigPlaylistToolLabelItems(
  items: readonly ListConfigPlaylistSidebarItem[],
): ListConfigPlaylistToolLabelItem[] {
  return items.map((item) => ({
    kind: "playlist",
    id: createListConfigSidebarItemId(item),
    text: item.name,
    sourceKind: item.kind,
    enableUpdates: item.enableUpdates,
  }));
}

export function createListConfigCandidateToolLabelItems(
  items: readonly ConfigCandidateItem[],
): ListConfigCandidateToolLabelItem[] {
  return items.map((item) => ({
    kind: "candidate",
    id: item.id,
    text: item.displayText,
    status: item.status,
  }));
}

export function resolveListConfigToolLabelItems(
  args: {
    playlistItems: readonly ListConfigPlaylistSidebarItem[];
    candidateItems: readonly ConfigCandidateItem[];
  },
  removedItemIds: ReadonlySet<string>,
): ListConfigToolLabelItem[] {
  return [
    ...createListConfigCandidateToolLabelItems(args.candidateItems),
    ...createListConfigPlaylistToolLabelItems(args.playlistItems).filter(
      (item) => !removedItemIds.has(item.id),
    ),
  ];
}

export function createListConfigArcTrackItems(args: {
  libraryItems: readonly ConfigSidebarItem[];
  playlistItems: readonly ConfigSidebarItem[];
  candidateItems: readonly ConfigCandidateItem[];
}) {
  const foregroundUrls = new Set(args.playlistItems.map((item) => item.url));

  for (const item of args.candidateItems) {
    if (!item.sourceUrl) {
      continue;
    }

    if (
      item.status === "invalid_url" ||
      item.status === "probe_failed" ||
      item.status === "enqueue_failed"
    ) {
      continue;
    }

    foregroundUrls.add(item.sourceUrl);
  }

  return args.libraryItems
    .filter((item) => !foregroundUrls.has(item.url));
}

export function resolveListConfigToolLabelTextClassName(
  item: ListConfigToolLabelItem,
): string {
  return me(item).match("kind", {
    playlist: (): string => "text-[12px] text-[#404040] dark:text-[#a3a3a3]",
    candidate: ({ status }): string =>
      cn(
        "text-[12px] text-[#404040] dark:text-[#a3a3a3]",
        (status === "invalid_url" ||
          status === "probe_failed" ||
          status === "enqueue_failed") &&
          "line-through opacity-70",
      ),
  });
}

export function resolveListConfigShouldShowDeleteOnlyTool(
  status: ConfigCandidateItemStatus,
): boolean {
  return (
    status === "invalid_url" ||
    status === "probe_failed" ||
    status === "enqueue_failed"
  );
}

export function shouldShowListConfigCandidateDeleteTool(
  item: ListConfigToolLabelItem,
): boolean {
  return me(item).match("kind", {
    playlist: (): boolean => false,
    candidate: ({ status }): boolean =>
      resolveListConfigShouldShowDeleteOnlyTool(status),
  });
}

export function shouldShowListConfigPlaylistHoverTool(
  item: ListConfigToolLabelItem,
): boolean {
  return me(item).match("kind", {
    playlist: (): boolean => true,
    candidate: ({ status }): boolean => status === "resolved",
  });
}

export function shouldShowListConfigEnableUpdateTool(
  item: ListConfigToolLabelItem,
): boolean {
  return me(item).match("kind", {
    candidate: (): boolean => false,
    playlist: ({ sourceKind, enableUpdates }): boolean =>
      sourceKind === "collection" && enableUpdates !== null,
  });
}

export function shouldShowListConfigAutoDownloadIcon(
  item: ListConfigToolLabelItem,
): boolean {
  return me(item).match("kind", {
    candidate: (): boolean => false,
    playlist: ({ sourceKind, enableUpdates }): boolean =>
      sourceKind === "collection" && enableUpdates === true,
  });
}

function resolveListConfigToolLabelTool(args: {
  item: ListConfigToolLabelItem;
  onPopPlaylistItem: () => void;
  onDeleteCandidateItem: () => void;
}) {
  if (shouldShowListConfigPlaylistHoverTool(args.item)) {
    const shouldShowEnableUpdateTool = shouldShowListConfigEnableUpdateTool(
      args.item,
    );

    return (
      <div
        className={cn(
          "flex w-full items-center",
          shouldShowEnableUpdateTool ? "justify-between" : "justify-end",
        )}
      >
        {shouldShowEnableUpdateTool && (
          <div className="flex h-fit">
            <CoverTool text="Enable Update" />
            <MaskR />
          </div>
        )}
        <div className="flex h-fit">
          <MaskL />
          <CoverTool text="Pop" onClick={args.onPopPlaylistItem} />
        </div>
      </div>
    );
  }

  if (!shouldShowListConfigCandidateDeleteTool(args.item)) {
    return undefined;
  }

  return (
    <div className="flex h-fit">
      <CoverTool text="Delete" onClick={args.onDeleteCandidateItem} />
      <MaskR />
    </div>
  );
}

export function resolveListConfigEmptyState(
  emptyStateSignal: ListConfigEmptyStateSignal,
  previousEmptyState: ListConfigEmptyState | null,
) {
  return emptyStateSignal.match({
    keep: () => previousEmptyState ?? me(false),
    show: () => me(true),
    hide: () => me(false),
  });
}

export function resolveListConfigSavePath(
  savePath: string | null | undefined,
  defaultSavePath: string,
) {
  return savePath ?? defaultSavePath;
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

export function ListConfig() {
  const isPresent = useIsPresent();
  const {
    activeLayoutId,
    configSidebarItems,
    draft,
    savePath,
    titleToneHandoff,
  } = appLogicHook.useContext();
  const { items: candidateItems } = pasteDownloadHook.useContext();
  const titleSnapshotRef = useRef<ListConfigTitleSnapshot | null>(null);
  const emptyStateRef = useRef<ListConfigEmptyState | null>(null);
  const renderSequenceRef = useRef(0);
  const [isToolListAnimating, setIsToolListAnimating] = useState(true);
  const [removedToolLabelItemIds, setRemovedToolLabelItemIds] = useState<
    Set<string>
  >(() => new Set());
  const titleViewModel = resolveListConfigTitleViewModel({
    activeLayoutId,
    draft,
    titleToneHandoff,
    previousSnapshot: titleSnapshotRef.current,
  });

  if (titleViewModel.snapshot) {
    titleSnapshotRef.current = titleViewModel.snapshot;
  }

  // Portal overlays render under document.body, so exit transitions still need
  // an explicit interactivity gate instead of relying on ancestor
  // pointer-events. Entry animations should stay interactive.
  const isToolListInteractionDisabled =
    resolveListConfigToolListInteractionDisabled({
      isAnimating: isToolListAnimating,
      isPresent,
    });
  const emptyState = resolveListConfigEmptyState(
    shouldShowListConfigEmptyState({
      draft,
      candidateItemCount: candidateItems.length,
    }),
    emptyStateRef.current,
  );
  emptyStateRef.current = emptyState;
  const playlistSidebarItems = createListConfigPlaylistSidebarItems(draft);
  const toolLabelItems = resolveListConfigToolLabelItems(
    {
      playlistItems: playlistSidebarItems,
      candidateItems,
    },
    removedToolLabelItemIds,
  );
  const arcTrackItems = createListConfigArcTrackItems({
    libraryItems: configSidebarItems,
    playlistItems: playlistSidebarItems,
    candidateItems,
  });
  const shouldShowEmptyState = emptyState.match({
    true: () => true,
    false: () => false,
  });
  const renderSequence = ++renderSequenceRef.current;

  recordUiTrace("list-config", "render", {
    activeLayoutId,
    configSidebarItemCount: configSidebarItems.length,
    candidateItemCount: candidateItems.length,
    draftCollectionCount: draft?.collections.length ?? null,
    draftGroupCount: draft?.groups.length ?? null,
    draftMode: draft?.mode ?? null,
    draftName: draft?.name ?? null,
    isPresent,
    isToolListAnimating,
    playlistSidebarItemCount: playlistSidebarItems.length,
    removedToolLabelItemCount: removedToolLabelItemIds.size,
    renderSequence,
    arcTrackItemCount: arcTrackItems.length,
    shouldShowEmptyState,
    toolLabelItemCount: toolLabelItems.length,
  });

  async function handleChangeSavePath() {
    try {
      const defaultSavePath =
        savePath || (await getDefaultListConfigSavePath());
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

  const contentFadeProps = {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: collectionTitleLayoutTransition,
  } as const;

  return (
    <div
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
              pasteDownloadAction.reset();
              appLogicAction.back();
            }}
            className={cn(
              "group relative isolate inline-flex w-fit cursor-pointer select-none py-2 pr-2",
              "before:absolute before:inset-y-0 before:-left-2 before:right-0 before:-z-10",
              "before:rounded-[25px] before:bg-transparent before:transition before:duration-300",
              "before:[corner-shape:squircle_squircle_squircle_squircle]",
              "hover:before:bg-[#e5e5e5] dark:hover:before:bg-[#262626]",
            )}
          >
            <icons.arrowDown className="rotate-90 text-[#737373] dark:text-[#8a8a8a] group-hover:text-[#262626] dark:group-hover:text-[#d4d4d4] transition duration-300" />
          </button>
        </motion.div>
        <EditableTitle
          autoFocus={titleViewModel.autoFocus}
          className={cn("text-4xl font-bold", "w-fit")}
          handoffTone={titleViewModel.handoffTone}
          interactionDisabled={!isPresent}
          layoutId={titleViewModel.layoutId}
          placeholder={titleViewModel.placeholder}
          style={{ fontFamily: "var(--font-noto-sans)" }}
          value={titleViewModel.value}
          onChange={appLogicAction.changeDraftName}
        />
        <motion.div {...contentFadeProps}>
          <ToolLabel
            className="mt-2"
            textClassName="text-sm trim-cap text-[#404040] dark:text-[#a3a3a3]"
            text={savePath}
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

      {emptyState.match({
        true: () => (
          <motion.div
            {...contentFadeProps}
            onAnimationStart={() => {
              recordUiTrace("list-config/empty-state", "animation-start", {
                renderSequence,
              });
            }}
            onAnimationComplete={() => {
              recordUiTrace("list-config/empty-state", "animation-complete", {
                renderSequence,
              });
            }}
          >
            <p
              className={cn(
                "relative z-10 mt-4 max-w-xl cursor-default select-none whitespace-pre-line text-pretty text-sm leading-6",
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
              "relative z-10 flex flex-col",
              isToolListInteractionDisabled && "pointer-events-none",
            )}
            onAnimationStart={() => {
              recordUiTrace("list-config/tool-list", "animation-start", {
                renderSequence,
                toolLabelItemCount: toolLabelItems.length,
              });
              setIsToolListAnimating(true);
            }}
            onAnimationComplete={() => {
              recordUiTrace("list-config/tool-list", "animation-complete", {
                renderSequence,
                toolLabelItemCount: toolLabelItems.length,
              });
              setIsToolListAnimating(false);
            }}
          >
            <AnimatePresence initial={false}>
              {toolLabelItems.map((item) => (
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
                    <motion.div layoutId={item.id}>
                      <ToolLabel
                        className={cn("")}
                        hoverMode="group"
                        interactionDisabled={isToolListInteractionDisabled}
                        toolLayer="portal"
                        text={item.text}
                        textClassName={resolveListConfigToolLabelTextClassName(
                          item,
                        )}
                        tool={resolveListConfigToolLabelTool({
                          item,
                          onPopPlaylistItem: () =>
                            me(item).match("kind", {
                              playlist: () => {
                                setRemovedToolLabelItemIds((current) => {
                                  const next = new Set(current);
                                  next.add(item.id);
                                  return next;
                                });
                              },
                              candidate: () => {
                                pasteDownloadAction.delete(item.id);
                              },
                            }),
                          onDeleteCandidateItem: () => {
                            pasteDownloadAction.delete(item.id);
                          },
                        })}
                      />
                    </motion.div>
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
      {arcTrackItems.length > 0 && (
        <ArcTrackList
          items={arcTrackItems}
          onPushItem={appLogicAction.pushDraftSidebarItem}
          motionProps={contentFadeProps}
        />
      )}
    </div>
  );
}
