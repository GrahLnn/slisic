import { crab } from "@/src/cmd";
import {
  templateApi,
  type AssignTaskInput,
  type BulkStatusInput,
  type TaskStatus,
  type TemplateDashboard,
  type UnassignTaskInput,
} from "@/src/cmd/templateApp";
import type { Result } from "@grahlnn/fn";
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
import type { OperationResult, PendingOperation } from "./core";

async function expectDashboard(
  promise: Promise<Result<TemplateDashboard, string>>,
): Promise<TemplateDashboard> {
  const result = await promise;
  if (result.isErr()) {
    throw new Error(result.unwrap_err());
  }
  return result.unwrap();
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
    switch (input.kind) {
      case "snapshot":
        return {
          kind: "dashboard",
          dashboard: await expectDashboard(templateApi.snapshot()),
        };
      case "bootstrap":
        return {
          kind: "dashboard",
          dashboard: await expectDashboard(templateApi.bootstrap()),
          clearSelection: true,
          success: {
            title: "Demo data loaded",
          },
        };
      case "reset":
        return {
          kind: "dashboard",
          dashboard: await expectDashboard(templateApi.reset()),
          clearSelection: true,
          success: {
            title: "Template data reset",
          },
        };
      case "create_member":
        return {
          kind: "dashboard",
          dashboard: await expectDashboard(templateApi.createMember(input.input)),
          resetMemberInput: true,
          success: {
            title: "Member added",
          },
        };
      case "create_task":
        return {
          kind: "dashboard",
          dashboard: await expectDashboard(templateApi.createTask(input.input)),
          resetTaskInput: true,
          success: {
            title: "Task added",
          },
        };
      case "assign_task":
        return {
          kind: "dashboard",
          dashboard: await expectDashboard(templateApi.assignTask(input.input)),
        };
      case "unassign_task":
        return {
          kind: "dashboard",
          dashboard: await expectDashboard(templateApi.unassignTask(input.input)),
        };
      case "bulk_status":
        if (input.input.task_ids.length === 0) {
          return {
            kind: "noop",
          };
        }
        return {
          kind: "dashboard",
          dashboard: await expectDashboard(templateApi.bulkSetStatus(input.input)),
          clearSelection: true,
        };
      case "open_window":
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
      case "capture_mouse": {
        const result = await crab.getMouseAndWindowPosition();
        if (result.isErr()) {
          throw new Error(result.unwrap_err());
        }
        return {
          kind: "mouse",
          mouseInfo: result.unwrap(),
        };
      }
    }

    throw new Error("Unknown pending operation");
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
