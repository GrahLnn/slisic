import { me } from "@grahlnn/fn";
import type { Context } from "./core";
import type { MainStateT } from "./events";

type SelectorShot = {
  value: unknown;
  context: Context;
};

export type TemplateBoardViewModel = Pick<
  Context,
  "dashboard" | "memberInput" | "taskInput" | "bulkStatus" | "selectedTaskIds" | "mouseInfo"
>;

export const selectTemplateBoardState = me.select(
  (shot: SelectorShot) => shot.value as MainStateT,
  me.eq.strict<MainStateT>(),
);

export const selectTemplateBoardViewModel = me.select(
  (shot: SelectorShot): TemplateBoardViewModel => ({
    dashboard: shot.context.dashboard,
    memberInput: shot.context.memberInput,
    taskInput: shot.context.taskInput,
    bulkStatus: shot.context.bulkStatus,
    selectedTaskIds: shot.context.selectedTaskIds,
    mouseInfo: shot.context.mouseInfo,
  }),
  me.eq.struct({
    dashboard: me.eq.optional(me.eq.strict()),
    memberInput: me.eq.shallow(),
    taskInput: me.eq.shallow(),
    bulkStatus: me.eq.strict(),
    selectedTaskIds: me.eq.arrayShallow<string>(),
    mouseInfo: me.eq.optional(me.eq.shallow()),
  }),
);
