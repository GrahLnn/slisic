import type { PlayList } from "@/src/cmd";
import type {
  CollectionTitleHandoff,
  CollectionTitleTone,
  PlaylistUpsertResult,
} from "@/src/flow/appLogic/core";
import {
  CREATE_COLLECTION_LAYOUT_ID,
  playlistTitleLayoutId,
  resolvePlaylistsWithPreview,
} from "@/src/flow/appLogic/core";
import type { MainStateT } from "@/src/flow/appLogic/events";
import {
  resolveTitleSharePageTransition,
  shouldSuppressTitleShareFade,
  type TitleSharePageTransition,
} from "@/src/flow/appLogic/titleShare";
import { collectionTitleLayoutTransition } from "./collectionTitle";

const contentFadeProps = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: collectionTitleLayoutTransition,
} as const;

export type PlayListPageCommitGesture = "primary-and-secondary" | "secondary-only";

export interface PlayListPageRenderData {
  pageState: MainStateT;
  activeLayoutId: string | null;
  hasPlayList: boolean | null;
  playlists: PlayList[];
  pendingPlaylistPreview: PlaylistUpsertResult | null;
  titleToneHandoff: CollectionTitleHandoff | null;
  pressedLayoutId: string | null;
}

export interface PlayListPageItemViewModel {
  key: string;
  text: string;
  layoutId?: string;
  handoffTone: CollectionTitleTone | null;
  suppressFade: boolean;
  isCommitted: boolean;
  commitGesture: PlayListPageCommitGesture;
  playlistName?: string;
}

export interface PlayListPageViewModel {
  visiblePlaylists: PlayList[];
  visibleLayoutIds: string[];
  transition: TitleSharePageTransition;
  committedLayoutId: string | null;
  shouldRenderContent: boolean;
  itemViewModels: PlayListPageItemViewModel[];
  createItemViewModel: PlayListPageItemViewModel;
}

export function shouldCommitPlayListPageItem(args: {
  button: number;
  gesture: PlayListPageCommitGesture;
}) {
  return args.gesture === "primary-and-secondary"
    ? args.button === 0 || args.button === 2
    : args.button === 2;
}

export function shouldEnablePlayListPageTitleShare(
  pageState: MainStateT,
) {
  return pageState === "ready" || pageState === "play";
}

export function shouldRenderPlayListPageContent(args: {
  hasPlayList: boolean | null;
  visiblePlaylistCount: number;
  hasPendingPreview: boolean;
  hasActiveLayoutId: boolean;
  hasTitleToneHandoff: boolean;
}) {
  return (
    args.hasPlayList !== null ||
    args.visiblePlaylistCount > 0 ||
    args.hasPendingPreview ||
    args.hasActiveLayoutId ||
    args.hasTitleToneHandoff
  );
}

export function resolvePlayListPageItemFadeProps(args: {
  isPresent: boolean;
  suppressFade: boolean;
}) {
  if (args.suppressFade) {
    return {
      initial: contentFadeProps.animate,
      animate: contentFadeProps.animate,
    } as const;
  }

  return {
    initial: contentFadeProps.initial,
    animate: args.isPresent ? contentFadeProps.animate : contentFadeProps.exit,
  } as const;
}

export function resolvePlayListPageTexts(playlists: readonly PlayList[]) {
  return playlists.map((playlist) => playlist.name);
}

export function resolvePlayListPageViewModel(
  renderData: PlayListPageRenderData,
): PlayListPageViewModel {
  const visiblePlaylists = resolvePlaylistsWithPreview(
    renderData.playlists,
    renderData.pendingPlaylistPreview,
  );
  const titleShareEnabled = shouldEnablePlayListPageTitleShare(
    renderData.pageState,
  );
  const texts = resolvePlayListPageTexts(visiblePlaylists);
  const transition = resolveTitleSharePageTransition({
    activeLayoutId: renderData.activeLayoutId,
    titleToneHandoff: renderData.titleToneHandoff,
    pressedLayoutId: renderData.pressedLayoutId,
  });
  const committedLayoutId = transition.committedLayoutId;
  const shouldRenderContent = shouldRenderPlayListPageContent({
    hasPlayList: renderData.hasPlayList,
    visiblePlaylistCount: visiblePlaylists.length,
    hasPendingPreview: renderData.pendingPlaylistPreview !== null,
    hasActiveLayoutId: renderData.activeLayoutId !== null,
    hasTitleToneHandoff: renderData.titleToneHandoff !== null,
  });

  const itemViewModels = visiblePlaylists.map((playlist, index) => {
    const text = texts[index] ?? playlist.name;
    const itemLayoutId = playlistTitleLayoutId(playlist.name);

    return {
      key: playlist.name,
      text,
      layoutId: titleShareEnabled ? itemLayoutId : undefined,
      handoffTone:
        transition.returnTargetLayoutId === itemLayoutId
          ? renderData.titleToneHandoff?.tone ?? null
          : null,
      suppressFade: shouldSuppressTitleShareFade(itemLayoutId, transition),
      isCommitted: committedLayoutId === itemLayoutId,
      commitGesture: "secondary-only" as const,
      playlistName: playlist.name,
    } satisfies PlayListPageItemViewModel;
  });

  return {
    visiblePlaylists,
    visibleLayoutIds: visiblePlaylists.map((playlist) =>
      playlistTitleLayoutId(playlist.name),
    ),
    transition,
    committedLayoutId,
    shouldRenderContent,
    itemViewModels,
    createItemViewModel: {
      key: "create",
      text: "Create a List",
      layoutId: titleShareEnabled ? CREATE_COLLECTION_LAYOUT_ID : undefined,
      handoffTone:
        transition.returnTargetLayoutId === CREATE_COLLECTION_LAYOUT_ID
          ? renderData.titleToneHandoff?.tone ?? null
          : null,
      suppressFade: shouldSuppressTitleShareFade(
        CREATE_COLLECTION_LAYOUT_ID,
        transition,
      ),
      isCommitted: committedLayoutId === CREATE_COLLECTION_LAYOUT_ID,
      commitGesture: "primary-and-secondary",
    },
  };
}
