import type { TorphStage } from "@grahlnn/comps";

export function resolvePlayListPageItemSlotPositionAnimationEnabled(args: {
  requested: boolean;
  torphStage: TorphStage;
  textChanged: boolean;
}) {
  return args.requested && !args.textChanged && args.torphStage === "idle";
}

export function resolvePlayListPageItemTitleProjectionLayoutId(args: {
  layoutId?: string;
  torphStage: TorphStage;
  textChanged: boolean;
}) {
  if (args.textChanged || args.torphStage !== "idle") {
    return undefined;
  }

  return args.layoutId;
}
