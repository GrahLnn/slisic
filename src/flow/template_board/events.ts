import { me, type Result } from "@grahlnn/fn";
import { crab } from "../../cmd";
import type { TemplateDashboard } from "../../cmd/commands";
import {
  collect,
  createActors,
  defineSS,
  event,
  type InvokeEvt,
  ns,
  type PayloadEvt,
  type SignalEvt,
  sst,
  type UniqueEvts,
  allSignal,
  allState,
  allTransfer,
  type ActorInput,
} from "../kit";
import type {
  AssignTaskInput,
  BulkStatusInput,
  OperationResult,
  PendingOperation,
  TaskStatus,
  UnassignTaskInput,
} from "./core";

async function expectDashboard(
  promise: Promise<Result<TemplateDashboard, string>>,
): Promise<TemplateDashboard> {
  return (await promise).match({
    Ok: (dashboard) => dashboard,
    Err: (error) => {
      throw new Error(error);
    },
  });
}

export const ss = defineSS(
  ns(
    "mainx",
    sst(
      ["idle", "loading"],
      [
        "run",
        "load_snapshot",
        "bootstrap",
        "reset",
        "create_member",
        "create_task",
        "open_window",
        "capture_mouse",
      ],
    ),
  ),
);

export const state = allState(ss);
export const sig = allSignal(ss);
export const transfer = allTransfer(ss);

export const invoker = createActors({
  async executePending({
    input,
  }: ActorInput<PendingOperation>): Promise<OperationResult> {
    return me(input).match("kind", {
      snapshot: async () => ({
        kind: "dashboard",
        dashboard: await expectDashboard(crab.templateSnapshot()),
      }),
      bootstrap: async () => ({
        kind: "dashboard",
        dashboard: await expectDashboard(crab.templateBootstrap()),
        clearSelection: true,
        success: {
          title: "Demo data loaded",
        },
      }),
      reset: async () => ({
        kind: "dashboard",
        dashboard: await expectDashboard(crab.templateReset()),
        clearSelection: true,
        success: {
          title: "Template data reset",
        },
      }),
      create_member: async ({ input }) => ({
        kind: "dashboard",
        dashboard: await expectDashboard(crab.templateCreateMember(input)),
        resetMemberInput: true,
        success: {
          title: "Member added",
        },
      }),
      create_task: async ({ input }) => ({
        kind: "dashboard",
        dashboard: await expectDashboard(crab.templateCreateTask(input)),
        resetTaskInput: true,
        success: {
          title: "Task added",
        },
      }),
      assign_task: async ({ input }) => ({
        kind: "dashboard",
        dashboard: await expectDashboard(crab.templateAssignTask(input)),
      }),
      unassign_task: async ({ input }) => ({
        kind: "dashboard",
        dashboard: await expectDashboard(crab.templateUnassignTask(input)),
      }),
      bulk_status: async ({ input }) => {
        if (input.task_ids.length === 0) {
          return {
            kind: "noop",
          };
        }

        return {
          kind: "dashboard",
          dashboard: await expectDashboard(crab.templateBulkSetStatus(input)),
          clearSelection: true,
        };
      },
      open_window: async () => {
        await crab.createWindow("Main", {
          width: 1000,
          height: 720,
        });
        return {
          kind: "window",
          success: {
            title: "New window opened",
          },
        };
      },
      capture_mouse: async () => ({
        kind: "mouse",
        mouseInfo: (await crab.getMouseAndWindowPosition()).match({
          Ok: (mouseInfo) => mouseInfo,
          Err: (error) => {
            throw new Error(error);
          },
        }),
      }),
    });
  },
});

export const payloads = collect(
  ...event<string>()(
    "set_member_id",
    "set_member_name",
    "set_member_role",
    "set_task_id",
    "set_task_title",
    "set_task_notes",
    "toggle_task_selection",
  ),
  ...event<TaskStatus>()("set_task_status", "set_bulk_status"),
  ...event<number>()("set_task_priority"),
  ...event<AssignTaskInput>()("assign_task"),
  ...event<UnassignTaskInput>()("unassign_task"),
  ...event<BulkStatusInput>()("set_status"),
);

export type MainStateT = keyof typeof ss.mainx.State;
export type Events = UniqueEvts<
  | SignalEvt<typeof ss>
  | InvokeEvt<typeof invoker>
  | PayloadEvt<typeof payloads.infer>
>;
