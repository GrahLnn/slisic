import { describe, expect, test } from "bun:test";
import {
  defaultMemberInput,
  defaultTaskInput,
  type Context,
} from "../src/flow/template_board/core";
import {
  selectTemplateBoardState,
  selectTemplateBoardViewModel,
} from "../src/flow/template_board/selectors";

function createContext(): Context {
  return {
    dashboard: null,
    memberInput: { ...defaultMemberInput },
    taskInput: { ...defaultTaskInput },
    bulkStatus: "done",
    selectedTaskIds: [],
    mouseInfo: null,
    pending: null,
  };
}

describe("selectTemplateBoardState", () => {
  test("keeps primitive state stable with strict equality", () => {
    expect(selectTemplateBoardState.compare("idle", "idle")).toBe(true);
    expect(selectTemplateBoardState.compare("idle", "loading")).toBe(false);
  });
});

describe("selectTemplateBoardViewModel", () => {
  test("treats recreated shallow-equal inputs as unchanged", () => {
    const dashboard = {
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
    };
    const prev = {
      dashboard,
      memberInput: { id: "liam", name: "Liam", role: "PM" },
      taskInput: {
        id: "audit",
        title: "Audit",
        notes: "Check flows",
        status: "todo" as const,
        priority: 1,
      },
      bulkStatus: "done" as const,
      selectedTaskIds: ["audit"],
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
    };
    const next = {
      dashboard,
      memberInput: { ...prev.memberInput },
      taskInput: { ...prev.taskInput },
      bulkStatus: prev.bulkStatus,
      selectedTaskIds: [...prev.selectedTaskIds],
      mouseInfo: { ...prev.mouseInfo },
    };

    expect(selectTemplateBoardViewModel.compare(prev, next)).toBe(true);
  });

  test("detects changes in selected fields", () => {
    const base = selectTemplateBoardViewModel.project({
      value: "idle",
      context: createContext(),
    });
    const changed = {
      ...base,
      selectedTaskIds: ["task-1"],
    };

    expect(selectTemplateBoardViewModel.compare(base, changed)).toBe(false);
  });
});
