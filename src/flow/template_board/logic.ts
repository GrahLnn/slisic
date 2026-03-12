import { me } from "@grahlnn/fn";
import {
  defaultMemberInput,
  defaultTaskInput,
  type Context,
  type OperationResult,
  type ToastMessage,
} from "./core";

export function getSuccessToast(output: OperationResult): ToastMessage | null {
  return me(output).match("kind", {
    dashboard: ({ success }) => success ?? null,
    mouse: () => null,
    noop: () => null,
    window: ({ success }) => success,
  });
}

export function applyOperationResult(
  context: Context,
  output: OperationResult,
): Context {
  const next = { ...context, pending: null };

  return me(output).match("kind", {
    dashboard: ({
      dashboard,
      clearSelection,
      resetMemberInput,
      resetTaskInput,
    }) => ({
      ...next,
      dashboard,
      selectedTaskIds: clearSelection ? [] : context.selectedTaskIds,
      memberInput: resetMemberInput
        ? { ...defaultMemberInput }
        : context.memberInput,
      taskInput: resetTaskInput ? { ...defaultTaskInput } : context.taskInput,
    }),
    mouse: ({ mouseInfo }) => ({
      ...next,
      mouseInfo,
    }),
    noop: () => next,
    window: () => next,
  });
}
