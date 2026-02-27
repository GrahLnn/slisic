import { sileo } from "sileo";
import { assign } from "xstate";
import type {
  AssignTaskInput,
  BulkStatusInput,
  UnassignTaskInput,
} from "@/src/cmd/templateApp";
import { to_string } from "../kit";
import {
  defaultMemberInput,
  defaultTaskInput,
  initialContext,
  type Context,
  type OperationResult,
  type PendingOperation,
} from "./core";
import { invoker, payloads, sig, ss } from "./events";
import { src } from "./src";

function setPending(pending: PendingOperation) {
  return assign<Context, any>({
    pending: () => pending,
  });
}

function handleSuccess(output: OperationResult) {
  if (output.kind === "dashboard" && output.success) {
    sileo.success(output.success);
    return;
  }

  if (output.kind === "window") {
    sileo.success(output.success);
  }
}

function applyResult(context: Context, output: OperationResult): Context {
  const next = { ...context, pending: null };

  switch (output.kind) {
    case "dashboard":
      return {
        ...next,
        dashboard: output.dashboard,
        selectedTaskIds: output.clearSelection ? [] : context.selectedTaskIds,
        memberInput: output.resetMemberInput
          ? { ...defaultMemberInput }
          : context.memberInput,
        taskInput: output.resetTaskInput
          ? { ...defaultTaskInput }
          : context.taskInput,
      };
    case "mouse":
      return {
        ...next,
        mouseInfo: output.mouseInfo,
      };
    case "window":
    case "noop":
      return next;
  }
}

export const machine = src.createMachine({
  context: initialContext,
  initial: ss.mainx.State.idle,
  on: {
    [payloads.set_member_id.evt]: {
      actions: assign({
        memberInput: ({ context, event }) => ({
          ...context.memberInput,
          id: (event as { output: string }).output,
        }),
      }),
    },
    [payloads.set_member_name.evt]: {
      actions: assign({
        memberInput: ({ context, event }) => ({
          ...context.memberInput,
          name: (event as { output: string }).output,
        }),
      }),
    },
    [payloads.set_member_role.evt]: {
      actions: assign({
        memberInput: ({ context, event }) => ({
          ...context.memberInput,
          role: (event as { output: string }).output,
        }),
      }),
    },
    [payloads.set_task_id.evt]: {
      actions: assign({
        taskInput: ({ context, event }) => ({
          ...context.taskInput,
          id: (event as { output: string }).output,
        }),
      }),
    },
    [payloads.set_task_title.evt]: {
      actions: assign({
        taskInput: ({ context, event }) => ({
          ...context.taskInput,
          title: (event as { output: string }).output,
        }),
      }),
    },
    [payloads.set_task_notes.evt]: {
      actions: assign({
        taskInput: ({ context, event }) => ({
          ...context.taskInput,
          notes: (event as { output: string }).output,
        }),
      }),
    },
    [payloads.set_task_status.evt]: {
      actions: assign({
        taskInput: ({ context, event }) => ({
          ...context.taskInput,
          status: (event as { output: Context["taskInput"]["status"] }).output,
        }),
      }),
    },
    [payloads.set_task_priority.evt]: {
      actions: assign({
        taskInput: ({ context, event }) => {
          const value = Math.max(
            1,
            Math.trunc((event as { output: number }).output || 1),
          );
          return {
            ...context.taskInput,
            priority: value,
          };
        },
      }),
    },
    [payloads.set_bulk_status.evt]: {
      actions: assign({
        bulkStatus: ({ event }) =>
          (event as { output: Context["bulkStatus"] }).output,
      }),
    },
    [payloads.toggle_task_selection.evt]: {
      actions: assign({
        selectedTaskIds: ({ context, event }) => {
          const taskId = (event as { output: string }).output;
          return context.selectedTaskIds.includes(taskId)
            ? context.selectedTaskIds.filter((id) => id !== taskId)
            : [...context.selectedTaskIds, taskId];
        },
      }),
    },
  },
  states: {
    [ss.mainx.State.idle]: {
      on: {
        [sig.mainx.run.type]: {
          target: ss.mainx.State.loading,
          actions: setPending({ kind: "snapshot" }),
        },
        [sig.mainx.load_snapshot.type]: {
          target: ss.mainx.State.loading,
          actions: setPending({ kind: "snapshot" }),
        },
        [sig.mainx.bootstrap.type]: {
          target: ss.mainx.State.loading,
          actions: setPending({ kind: "bootstrap" }),
        },
        [sig.mainx.reset.type]: {
          target: ss.mainx.State.loading,
          actions: setPending({ kind: "reset" }),
        },
        [sig.mainx.create_member.type]: {
          target: ss.mainx.State.loading,
          actions: assign({
            pending: ({ context }) => ({
              kind: "create_member",
              input: context.memberInput,
            }),
          }),
        },
        [sig.mainx.create_task.type]: {
          target: ss.mainx.State.loading,
          actions: assign({
            pending: ({ context }) => ({
              kind: "create_task",
              input: context.taskInput,
            }),
          }),
        },
        [payloads.assign_task.evt]: {
          target: ss.mainx.State.loading,
          actions: assign({
            pending: ({ event }) => ({
              kind: "assign_task",
              input: (event as { output: AssignTaskInput }).output,
            }),
          }),
        },
        [payloads.unassign_task.evt]: {
          target: ss.mainx.State.loading,
          actions: assign({
            pending: ({ event }) => ({
              kind: "unassign_task",
              input: (event as { output: UnassignTaskInput }).output,
            }),
          }),
        },
        [payloads.set_status.evt]: [
          {
            guard: ({ event }) =>
              (event as { output: { task_ids: string[] } }).output.task_ids
                .length > 0,
            target: ss.mainx.State.loading,
            actions: assign({
              pending: ({ event }) => ({
                kind: "bulk_status",
                input: (event as { output: BulkStatusInput }).output,
              }),
            }),
          },
        ],
        [sig.mainx.open_window.type]: {
          target: ss.mainx.State.loading,
          actions: setPending({ kind: "open_window" }),
        },
        [sig.mainx.capture_mouse.type]: {
          target: ss.mainx.State.loading,
          actions: setPending({ kind: "capture_mouse" }),
        },
      },
    },
    [ss.mainx.State.loading]: {
      invoke: {
        id: invoker.executePending.name,
        src: invoker.executePending.name,
        input: ({ context }) => context.pending as PendingOperation,
        onDone: {
          target: ss.mainx.State.idle,
          actions: [
            assign(({ context, event }) =>
              applyResult(
                context as Context,
                (event as unknown as { output: OperationResult }).output,
              ),
            ),
            ({ event }) =>
              handleSuccess((event as { output: OperationResult }).output),
          ],
        },
        onError: {
          target: ss.mainx.State.idle,
          actions: [
            assign({ pending: () => null }),
            ({ event }) => {
              sileo.error({
                title: "Request failed",
                description: to_string((event as { error: unknown }).error),
              });
            },
          ],
        },
      },
    },
  },
});
