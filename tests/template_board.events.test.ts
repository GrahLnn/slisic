import { describe, expect, test } from "bun:test";
import { Err, Ok } from "@grahlnn/fn";
import type { MouseWindowInfo, NewMemberInput, TemplateDashboard } from "../src/cmd/commands";
import {
  createExecutePending,
  expectDashboard,
  type TemplateBoardGateway,
} from "../src/flow/template_board/events";
import type {
  AssignTaskInput,
  BulkStatusInput,
  NewTaskInput,
  PendingOperation,
  UnassignTaskInput,
} from "../src/flow/template_board/core";

function createDashboard(): TemplateDashboard {
  return {
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
}

function createMouseInfo(): MouseWindowInfo {
  return {
    mouse_x: 1,
    mouse_y: 2,
    window_x: 3,
    window_y: 4,
    window_width: 5,
    window_height: 6,
    rel_x: 7,
    rel_y: 8,
    pixel_ratio: 1,
  };
}

function createGateway(overrides: Partial<TemplateBoardGateway> = {}): TemplateBoardGateway {
  const dashboard = createDashboard();
  return {
    templateSnapshot: async () => Ok(dashboard),
    templateBootstrap: async () => Ok(dashboard),
    templateReset: async () => Ok(dashboard),
    templateCreateMember: async (_input: NewMemberInput) => Ok(dashboard),
    templateCreateTask: async (_input: NewTaskInput) => Ok(dashboard),
    templateAssignTask: async (_input: AssignTaskInput) => Ok(dashboard),
    templateUnassignTask: async (_input: UnassignTaskInput) => Ok(dashboard),
    templateBulkSetStatus: async (_input: BulkStatusInput) => Ok(dashboard),
    createWindow: async (_name, _options) => undefined,
    getMouseAndWindowPosition: async () => Ok(createMouseInfo()),
    ...overrides,
  };
}

async function execute(input: PendingOperation, gateway?: TemplateBoardGateway) {
  return createExecutePending(gateway)({ input });
}

describe("template_board executePending TP/FP/TN/FN", () => {
  test("TP: bulk status with task ids calls backend and returns dashboard", async () => {
    let called = false;
    const dashboard = createDashboard();
    const result = await execute(
      {
        kind: "bulk_status",
        input: {
          task_ids: ["task-1"],
          status: "done",
        },
      },
      createGateway({
        templateBulkSetStatus: async (_input) => {
          called = true;
          return Ok(dashboard);
        },
      }),
    );

    expect(called).toBe(true);
    expect(result).toEqual({
      kind: "dashboard",
      dashboard,
      clearSelection: true,
    });
  });

  test("TN: bulk status with empty task ids is a noop and does not call backend", async () => {
    let called = false;
    const result = await execute(
      {
        kind: "bulk_status",
        input: {
          task_ids: [],
          status: "done",
        },
      },
      createGateway({
        templateBulkSetStatus: async (_input) => {
          called = true;
          return Ok(createDashboard());
        },
      }),
    );

    expect(called).toBe(false);
    expect(result).toEqual({ kind: "noop" });
  });

  test("FP: backend Err is surfaced as a thrown failure instead of false success", async () => {
    await expect(expectDashboard(Promise.resolve(Err("backend failed")))).rejects.toThrow(
      "backend failed",
    );
  });

  test("FN: backend Ok is accepted as success instead of false failure", async () => {
    const dashboard = createDashboard();

    await expect(expectDashboard(Promise.resolve(Ok(dashboard)))).resolves.toEqual(dashboard);
  });

  test("capture_mouse delegates to the caller-owned window command path", async () => {
    let calls = 0;
    const mouseInfo = createMouseInfo();

    const result = await execute(
      {
        kind: "capture_mouse",
      },
      createGateway({
        getMouseAndWindowPosition: async () => {
          calls += 1;
          return Ok(mouseInfo);
        },
      }),
    );

    expect(calls).toBe(1);
    expect(result).toEqual({
      kind: "mouse",
      mouseInfo,
    });
  });

  test("capture_mouse surfaces command failures instead of fabricating mouse info", async () => {
    await expect(
      execute(
        {
          kind: "capture_mouse",
        },
        createGateway({
          getMouseAndWindowPosition: async () => Err("wrong window binding"),
        }),
      ),
    ).rejects.toThrow("wrong window binding");
  });
});
