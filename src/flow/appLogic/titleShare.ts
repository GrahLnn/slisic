import {
  createCollectionTitleHandoff,
  normalizeDraftName,
  playlistTitleLayoutId,
  type CollectionTitleHandoff,
  type CollectionTitleTone,
  type ConfigDraft,
  type ConfigDraftCollectionRef,
} from "./core";
import type { Music } from "@/src/cmd";

export interface TitleSharePageTransition {
  outgoingSourceLayoutId: string | null;
  returnTargetLayoutId: string | null;
  committedLayoutId: string | null;
}

export type TitleShareHoverVisual = "none" | "hold" | "retain";
export type TitleShareRetainLease = "timed" | "stage-only";

export type TitleShareEndpointKind = "config" | "list" | "play" | "spectrum";

export interface TitleShareEndpoint {
  kind: TitleShareEndpointKind;
  layoutId: string;
}

export type TitleShareArrowKind =
  | "config-to-list"
  | "identity"
  | "list-to-config"
  | "list-to-play"
  | "play-to-list"
  | "play-to-spectrum"
  | "spectrum-to-play";

export interface TitleShareArrow {
  kind: TitleShareArrowKind;
  source: TitleShareEndpoint | null;
  target: TitleShareEndpoint | null;
  targetRetainLease: TitleShareRetainLease;
}

export interface TitleShareInstruction {
  titleHoverVisual: TitleShareHoverVisual;
  titleHoverRetainLease: TitleShareRetainLease;
}

export type TitleShareCompositionResult =
  | {
      arrow: TitleShareArrow;
      kind: "composed";
    }
  | {
      kind: "rejected";
      reason: "missing-endpoint" | "endpoint-mismatch" | "undeclared-composition";
    };

export const NO_TITLE_SHARE_INSTRUCTION: TitleShareInstruction = {
  titleHoverVisual: "none",
  titleHoverRetainLease: "timed",
};

/**
 * Behavior:
 *   Shared title motion is a typed arrow between page endpoints. The arrow owns
 *   visual weight evidence and its release rule; pages only provide endpoint
 *   facts and interpret the resulting instruction.
 *
 * Core invariants:
 *   - A target cannot manufacture retain weight without arrow evidence.
 *   - Source and target roles are matched by full endpoint kind + layout id.
 *   - Composition is partial. Only declared endpoint pairs may collapse into a
 *     new arrow; otherwise callers must keep the intermediate page transition.
 *   - Effects, Torph stages, playback status and config commits do not create
 *     arrows. They can only consume arrow instructions.
 */
export function createTitleShareEndpoint(
  kind: TitleShareEndpointKind,
  layoutId: string | null | undefined,
): TitleShareEndpoint | null {
  return layoutId
    ? {
        kind,
        layoutId,
      }
    : null;
}

export function createTitleShareArrow(args: {
  kind: TitleShareArrowKind;
  source?: TitleShareEndpoint | null;
  target?: TitleShareEndpoint | null;
  targetRetainLease?: TitleShareRetainLease;
}): TitleShareArrow {
  return {
    kind: args.kind,
    source: args.source ?? null,
    target: args.target ?? null,
    targetRetainLease: args.targetRetainLease ?? "timed",
  };
}

export function areTitleShareEndpointsEqual(
  left: TitleShareEndpoint | null | undefined,
  right: TitleShareEndpoint | null | undefined,
) {
  return !!left && !!right && left.kind === right.kind && left.layoutId === right.layoutId;
}

export function resolveTitleShareArrowKind(args: {
  sourceKind: TitleShareEndpointKind;
  targetKind: TitleShareEndpointKind;
}): TitleShareArrowKind | null {
  if (args.sourceKind === args.targetKind) {
    return "identity";
  }

  if (args.sourceKind === "list" && args.targetKind === "play") {
    return "list-to-play";
  }

  if (args.sourceKind === "play" && args.targetKind === "list") {
    return "play-to-list";
  }

  if (args.sourceKind === "list" && args.targetKind === "config") {
    return "list-to-config";
  }

  if (args.sourceKind === "config" && args.targetKind === "list") {
    return "config-to-list";
  }

  if (args.sourceKind === "play" && args.targetKind === "spectrum") {
    return "play-to-spectrum";
  }

  if (args.sourceKind === "spectrum" && args.targetKind === "play") {
    return "spectrum-to-play";
  }

  return null;
}

export function resolveTitleShareEndpointInstruction(args: {
  arrow: TitleShareArrow | null;
  endpoint: TitleShareEndpoint | null;
  sourceEnabled?: boolean;
}): TitleShareInstruction {
  if (!args.arrow || !args.endpoint) {
    return NO_TITLE_SHARE_INSTRUCTION;
  }

  if (
    args.sourceEnabled !== false &&
    areTitleShareEndpointsEqual(args.endpoint, args.arrow.source)
  ) {
    return {
      titleHoverVisual: "hold",
      titleHoverRetainLease: "timed",
    };
  }

  if (areTitleShareEndpointsEqual(args.endpoint, args.arrow.target)) {
    return {
      titleHoverVisual: "retain",
      titleHoverRetainLease: args.arrow.targetRetainLease,
    };
  }

  return NO_TITLE_SHARE_INSTRUCTION;
}

export function resolveTitleShareRoleInstruction(args: {
  layoutId?: string | null;
  sourceLayoutId?: string | null;
  targetLayoutId?: string | null;
  targetRetainLease?: TitleShareRetainLease;
  sourceEnabled?: boolean;
}): TitleShareInstruction {
  const endpoint = createTitleShareEndpoint("list", args.layoutId);
  const source = createTitleShareEndpoint("list", args.sourceLayoutId);
  const target = createTitleShareEndpoint("list", args.targetLayoutId);

  return resolveTitleShareEndpointInstruction({
    endpoint,
    sourceEnabled: args.sourceEnabled,
    arrow: createTitleShareArrow({
      kind: "identity",
      source,
      target,
      targetRetainLease: args.targetRetainLease,
    }),
  });
}

function isTitleShareIdentityArrow(arrow: TitleShareArrow) {
  return arrow.kind === "identity" && areTitleShareEndpointsEqual(arrow.source, arrow.target);
}

export function composeTitleShareArrows(
  first: TitleShareArrow,
  second: TitleShareArrow,
): TitleShareCompositionResult {
  if (isTitleShareIdentityArrow(first)) {
    return {
      kind: "composed",
      arrow: second,
    };
  }

  if (isTitleShareIdentityArrow(second)) {
    return {
      kind: "composed",
      arrow: first,
    };
  }

  if (!first.target || !second.source) {
    return {
      kind: "rejected",
      reason: "missing-endpoint",
    };
  }

  if (!areTitleShareEndpointsEqual(first.target, second.source)) {
    return {
      kind: "rejected",
      reason: "endpoint-mismatch",
    };
  }

  if (!first.source || !second.target) {
    return {
      kind: "rejected",
      reason: "missing-endpoint",
    };
  }

  const kind = resolveTitleShareArrowKind({
    sourceKind: first.source.kind,
    targetKind: second.target.kind,
  });

  if (!kind || kind === "identity") {
    return {
      kind: "rejected",
      reason: "undeclared-composition",
    };
  }

  return {
    kind: "composed",
    arrow: createTitleShareArrow({
      kind,
      source: first.source,
      target: second.target,
      targetRetainLease: second.targetRetainLease,
    }),
  };
}

function compareConfigDraftItemUrl(
  left: Pick<ConfigDraftCollectionRef, "url">,
  right: Pick<ConfigDraftCollectionRef, "url">,
) {
  return left.url.localeCompare(right.url);
}

function createConfigDraftComparableCollections(collections: readonly ConfigDraftCollectionRef[]) {
  return collections
    .map((collection) => ({
      name: collection.name,
      url: collection.url,
      folder: collection.folder,
      last_updated: collection.last_updated,
      enable_updates: collection.enable_updates,
    }))
    .sort(compareConfigDraftItemUrl);
}

function createConfigDraftComparableGroups(groups: ConfigDraft["groups"]) {
  return groups
    .map((group) => ({
      name: group.name,
      url: group.url,
      folder: group.folder,
    }))
    .sort(compareConfigDraftItemUrl);
}

function compareConfigDraftMusic(
  left: Pick<Music, "canonical_music_id">,
  right: Pick<Music, "canonical_music_id">,
) {
  return left.canonical_music_id.localeCompare(right.canonical_music_id);
}

function createConfigDraftComparableExtra(extra: ConfigDraft["extra"]) {
  return extra
    .map((music) => ({
      alias: music.alias,
      canonical_music_id: music.canonical_music_id,
      end_ms: music.end_ms,
      liked: music.liked,
      name: music.name,
      path: music.path,
      start_ms: music.start_ms,
      url: music.url,
    }))
    .sort(compareConfigDraftMusic);
}

export function createConfigDraftComparableKey(draft: ConfigDraft | null) {
  if (!draft) {
    return "null";
  }

  return JSON.stringify({
    mode: draft.mode,
    name: draft.name,
    collections: createConfigDraftComparableCollections(draft.collections),
    groups: createConfigDraftComparableGroups(draft.groups),
    extra: createConfigDraftComparableExtra(draft.extra),
  });
}

export function hasConfigDraftChanges(
  draft: ConfigDraft | null,
  draftBaseline: ConfigDraft | null,
): boolean {
  if (!draft || !draftBaseline) {
    return false;
  }

  return createConfigDraftComparableKey(draft) !== createConfigDraftComparableKey(draftBaseline);
}

export function resolveTitleShareToneFromDraft(draft: ConfigDraft | null): CollectionTitleTone {
  if (!draft) {
    return "solid";
  }

  return draft.name.length === 0 ? "muted" : "solid";
}

export function resolveConfigBackTitleSharePlan(args: {
  activeLayoutId: string | null;
  draft: ConfigDraft | null;
  draftBaseline: ConfigDraft | null;
}) {
  const hasDraftChanges = hasConfigDraftChanges(args.draft, args.draftBaseline);
  let sourceLayoutId = args.activeLayoutId;
  let returnLayoutId = args.activeLayoutId;

  if (args.activeLayoutId && args.draft && args.draftBaseline && hasDraftChanges) {
    const normalizedName = normalizeDraftName(args.draft.name);

    if (normalizedName.length > 0) {
      sourceLayoutId = playlistTitleLayoutId(normalizedName);
      returnLayoutId = playlistTitleLayoutId(normalizedName);
    }
  }

  return {
    hasDraftChanges,
    returnLayoutId,
    sourceLayoutId,
    titleToneHandoff: returnLayoutId
      ? createCollectionTitleHandoff(returnLayoutId, resolveTitleShareToneFromDraft(args.draft))
      : null,
  };
}

export function resolveTitleSharePageTransition(args: {
  activeLayoutId: string | null;
  titleToneHandoff: CollectionTitleHandoff | null;
  pressedLayoutId: string | null;
}): TitleSharePageTransition {
  const outgoingSourceLayoutId = args.activeLayoutId;
  const returnTargetLayoutId =
    args.activeLayoutId || args.pressedLayoutId ? null : (args.titleToneHandoff?.layoutId ?? null);

  return {
    outgoingSourceLayoutId,
    returnTargetLayoutId,
    committedLayoutId: args.pressedLayoutId ?? outgoingSourceLayoutId,
  };
}

export function shouldSuppressTitleShareFade(
  layoutId: string,
  transition: Pick<TitleSharePageTransition, "outgoingSourceLayoutId" | "returnTargetLayoutId">,
) {
  return (
    layoutId === transition.outgoingSourceLayoutId || layoutId === transition.returnTargetLayoutId
  );
}

export function resolveTitleShareHoverVisual(args: {
  layoutId?: string | null;
  sourceLayoutId?: string | null;
  targetLayoutId?: string | null;
}): TitleShareHoverVisual {
  return resolveTitleShareRoleInstruction(args).titleHoverVisual;
}
