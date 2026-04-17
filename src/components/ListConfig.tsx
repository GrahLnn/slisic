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
import { action as pasteDownloadAction } from "@/src/flow/pasteDownload";
import type {
  ConfigSidebarItem,
  CollectionTitleHandoff,
  CollectionTitleTone,
  ConfigDraft,
} from "@/src/flow/appLogic/core";
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
  return args.isAnimating || !args.isPresent;
}

export const LIST_CONFIG_EMPTY_STATE_TEXT =
  "Nothing here yet.\nPaste a link to download from the web, or import a local music folder to get started.";

export type ListConfigEmptyStateKind = "keep" | "show" | "hide";
export type ListConfigEmptyStateSignal = ME<ListConfigEmptyStateKind>;
export type ListConfigEmptyState = ME<boolean>;

export function shouldShowListConfigEmptyState(draft: ConfigDraft | null) {
  if (!draft) {
    return me<ListConfigEmptyStateKind>("keep");
  }

  return me<ListConfigEmptyStateKind>(
    draft.collections.length === 0 && draft.groups.length === 0
      ? "show"
      : "hide",
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

function createListConfigToolLabelItems(items: readonly ConfigSidebarItem[]) {
  return items.map((item) => ({
    id: `${item.kind}:${item.url}`,
    text: item.name,
  }));
}

export function resolveListConfigToolLabelItems(
  items: readonly ConfigSidebarItem[],
  removedItemIds: ReadonlySet<string>,
) {
  return createListConfigToolLabelItems(items).filter(
    (item) => !removedItemIds.has(item.id),
  );
}

function FnButton({
  text,
  onClick,
}: {
  text: string;
  onClick?: () => void;
}) {
  return (
    <div
      className={cn(
        "w-fit h-fit",
        // "flex items-center justify-between",
        // "flex items-center justify-between w-fit gap-2 whitespace-nowrap",
        "[corner-shape:squircle_squircle_squircle_squircle] rounded-[25px] outline-none",
        "cursor-pointer transition duration-300 ease-in-out",
        // "data-[size=default]:h-9 data-[size=sm]:h-8",
        "px-2 py-1 text-sm",
        "text-xs text-[#525252] dark:text-[#e5e5e5] hover:text-[#262626] hover:dark:text-[#d4d4d4]",
        "hover:bg-[#e7eced] dark:hover:bg-[#383838]",
        // open && "bg-[#f1f5f9] dark:bg-[#1a1a1b]",
      )}
      onClick={onClick}
    >
      {text}
    </div>
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

  // Portal overlays render under document.body, so exit transitions need an
  // explicit interactivity gate instead of relying on ancestor pointer-events.
  const isToolListInteractionDisabled =
    resolveListConfigToolListInteractionDisabled({
      isAnimating: isToolListAnimating,
      isPresent,
    });
  const emptyState = resolveListConfigEmptyState(
    shouldShowListConfigEmptyState(draft),
    emptyStateRef.current,
  );
  emptyStateRef.current = emptyState;
  const toolLabelItems = resolveListConfigToolLabelItems(
    configSidebarItems,
    removedToolLabelItemIds,
  );
  const shouldShowEmptyState = emptyState.match({
    true: () => true,
    false: () => false,
  });
  const renderSequence = ++renderSequenceRef.current;

  recordUiTrace("list-config", "render", {
    activeLayoutId,
    configSidebarItemCount: configSidebarItems.length,
    draftCollectionCount: draft?.collections.length ?? null,
    draftGroupCount: draft?.groups.length ?? null,
    draftMode: draft?.mode ?? null,
    draftName: draft?.name ?? null,
    isPresent,
    isToolListAnimating,
    removedToolLabelItemCount: removedToolLabelItemIds.size,
    renderSequence,
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
            onClick={appLogicAction.back}
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
            <div className="flex gap-2">
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
                "relative z-10 mt-14 max-w-xl cursor-default select-none whitespace-pre-line text-pretty text-sm leading-6",
                "text-[#525252] dark:text-[#a3a3a3]",
              )}
            >
              {LIST_CONFIG_EMPTY_STATE_TEXT}
            </p>
          </motion.div>
        ),
        false: () => (
          <>
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
                      <motion.div layoutId={item.text}>
                        <ToolLabel
                          className={cn("")}
                          hoverMode="group"
                          interactionDisabled={isToolListInteractionDisabled}
                          toolLayer="portal"
                          text={item.text}
                          textClassName="text-[12px] text-[#404040] dark:text-[#a3a3a3]"
                          tool={
                            <div className="flex justify-between w-full items-center">
                              <div className="flex h-fit">
                                <CoverTool text="Enable Update" />
                                <MaskR />
                              </div>
                              <div className="flex h-fit">
                                <MaskL />
                                <CoverTool
                                  text="Pop"
                                  onClick={() => {
                                    setRemovedToolLabelItemIds((current) => {
                                      const next = new Set(current);
                                      next.add(item.id);
                                      return next;
                                    });
                                  }}
                                />
                              </div>
                            </div>
                          }
                        />
                      </motion.div>
                      <icons.autoDownload size={12} />
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </motion.div>
            <ArcTrackList
              items={toolLabelItems.map((item) => item.text)}
              motionProps={contentFadeProps}
            />
          </>
        ),
      })}
    </div>
  );
}
