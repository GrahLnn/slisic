import { describe, expect, test } from "bun:test";
import {
  defaultMemberInput,
  defaultTaskInput,
  type Context,
  type OperationResult,
} from "../src/flow/template_board/core";
import {
  applyOperationResult,
  getSuccessToast,
} from "../src/flow/template_board/logic";

function createContext(): Context {
  return {
    dashboard: null,
    memberInput: {
      id: "liam",
      name: "Liam",
      role: "PM",
    },
    taskInput: {
      id: "audit",
      title: "Audit",
      notes: "Check flows",
      status: "doing",
      priority: 3,
    },
    bulkStatus: "done",
    selectedTaskIds: ["task-1"],
    mouseInfo: null,
    pending: { kind: "snapshot" },
  };
}

describe("getSuccessToast", () => {
  test("returns only supported success payloads", () => {
    expect(
      getSuccessToast({
        kind: "dashboard",
        dashboard: {
          members: [],
          tasks: [],
          assignments: [],
          stats: {
            total_members: 0,
            total_tasks: 0,
            todo_tasks: 0,
            doing_tasks: 0,
            done_tasks: 0,
          },
        },
        success: { title: "Loaded" },
      }),
    ).toEqual({ title: "Loaded" });

    expect(
      getSuccessToast({
        kind: "mouse",
        mouseInfo: {
          mouse_x: 1,
          mouse_y: 2,
          window_x: 3,
          window_y: 4,
          window_width: 5,
          window_height: 6,
          rel_x: 7,
          rel_y: 8,
          pixel_ratio: 1,
        },
      }),
    ).toBeNull();
  });
});

describe("applyOperationResult", () => {
  test("resets transient state only when dashboard flags request it", () => {
    const context = createContext();
    const output: OperationResult = {
      kind: "dashboard",
      dashboard: {
        members: [],
        tasks: [],
        assignments: [],
        stats: {
          total_members: 1,
          total_tasks: 2,
          todo_tasks: 1,
          doing_tasks: 1,
          done_tasks: 0,
        },
      },
      clearSelection: true,
      resetMemberInput: true,
      resetTaskInput: true,
    };

    expect(applyOperationResult(context, output)).toEqual({
      ...context,
      dashboard: output.dashboard,
      memberInput: defaultMemberInput,
      taskInput: defaultTaskInput,
      selectedTaskIds: [],
      pending: null,
    });
  });

  test("updates mouse info without disturbing existing form state", () => {
    const context = createContext();

    expect(
      applyOperationResult(context, {
        kind: "mouse",
        mouseInfo: {
          mouse_x: 10,
          mouse_y: 20,
          window_x: 30,
          window_y: 40,
          window_width: 50,
          window_height: 60,
          rel_x: 70,
          rel_y: 80,
          pixel_ratio: 2,
        },
      }),
    ).toEqual({
      ...context,
      mouseInfo: {
        mouse_x: 10,
        mouse_y: 20,
        window_x: 30,
        window_y: 40,
        window_width: 50,
        window_height: 60,
        rel_x: 70,
        rel_y: 80,
        pixel_ratio: 2,
      },
      pending: null,
    });
  });
});
