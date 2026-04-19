import type { CollectionTitleHandoff } from "@/src/flow/appLogic/core";

export interface PlayListPageTransitionViewModel {
  outgoingSourceLayoutId: string | null;
  returnTargetLayoutId: string | null;
}

export function resolvePlayListPageTransitionViewModel(args: {
  activeLayoutId: string | null;
  titleToneHandoff: CollectionTitleHandoff | null;
}): PlayListPageTransitionViewModel {
  if (args.activeLayoutId) {
    return {
      outgoingSourceLayoutId: args.activeLayoutId,
      returnTargetLayoutId: null,
    };
  }

  return {
    outgoingSourceLayoutId: null,
    returnTargetLayoutId: args.titleToneHandoff?.layoutId ?? null,
  };
}

export function shouldSuppressPlayListPageItemFade(
  layoutId: string,
  transition: PlayListPageTransitionViewModel,
) {
  return (
    layoutId === transition.outgoingSourceLayoutId ||
    layoutId === transition.returnTargetLayoutId
  );
}

export function resolvePlayListPageCommittedLayoutId(args: {
  pressedLayoutId: string | null;
  transition: PlayListPageTransitionViewModel;
}) {
  return args.pressedLayoutId ?? args.transition.outgoingSourceLayoutId;
}
