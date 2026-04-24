import type { TorphStage } from "@grahlnn/comps";

export function resolvePlayListPageItemSlotPositionAnimationEnabled(args: {
  requested: boolean;
  torphStage: TorphStage;
  textChanged: boolean;
}) {
  return args.requested && !args.textChanged && args.torphStage === "idle";
}
