import {
  createCollectionTitleHandoff,
  normalizeDraftName,
  playlistTitleLayoutId,
  type CollectionTitleHandoff,
  type CollectionTitleTone,
  type ConfigDraft,
} from "./core";

export interface TitleSharePageTransition {
  outgoingSourceLayoutId: string | null;
  returnTargetLayoutId: string | null;
  committedLayoutId: string | null;
}

function serializeConfigDraftComparable(draft: ConfigDraft) {
  return JSON.stringify({
    mode: draft.mode,
    name: draft.name,
    collections: draft.collections,
    groups: draft.groups,
  });
}

export function hasConfigDraftChanges(
  draft: ConfigDraft | null,
  draftBaseline: ConfigDraft | null,
): boolean {
  if (!draft || !draftBaseline) {
    return false;
  }

  return serializeConfigDraftComparable(draft) !== serializeConfigDraftComparable(draftBaseline);
}

export function resolveTitleShareToneFromDraft(
  draft: ConfigDraft | null,
): CollectionTitleTone {
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
  const hasDraftChanges = hasConfigDraftChanges(
    args.draft,
    args.draftBaseline,
  );
  let returnLayoutId = args.activeLayoutId;

  if (args.activeLayoutId && args.draft && args.draftBaseline && hasDraftChanges) {
    const normalizedName = normalizeDraftName(args.draft.name);

    if (normalizedName.length > 0) {
      returnLayoutId = playlistTitleLayoutId(normalizedName);
    }
  }

  return {
    hasDraftChanges,
    returnLayoutId,
    titleToneHandoff: returnLayoutId
      ? createCollectionTitleHandoff(
          returnLayoutId,
          resolveTitleShareToneFromDraft(args.draft),
        )
      : null,
  };
}

export function resolveTitleSharePageTransition(args: {
  activeLayoutId: string | null;
  titleToneHandoff: CollectionTitleHandoff | null;
  pressedLayoutId: string | null;
}): TitleSharePageTransition {
  const outgoingSourceLayoutId = args.activeLayoutId;
  const returnTargetLayoutId = args.activeLayoutId || args.pressedLayoutId
    ? null
    : args.titleToneHandoff?.layoutId ?? null;

  return {
    outgoingSourceLayoutId,
    returnTargetLayoutId,
    committedLayoutId: args.pressedLayoutId ?? outgoingSourceLayoutId,
  };
}

export function shouldSuppressTitleShareFade(
  layoutId: string,
  transition: Pick<
    TitleSharePageTransition,
    "outgoingSourceLayoutId" | "returnTargetLayoutId"
  >,
) {
  return (
    layoutId === transition.outgoingSourceLayoutId ||
    layoutId === transition.returnTargetLayoutId
  );
}
