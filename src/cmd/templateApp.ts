import { invoke } from "@tauri-apps/api/core";
import { Err, Ok, type Result } from "@grahlnn/fn";

export type TaskStatus = "todo" | "doing" | "done";

export interface NewMemberInput {
  id: string;
  name: string;
  role: string;
}

export interface NewTaskInput {
  id: string;
  title: string;
  notes: string;
  status: TaskStatus;
  priority: number;
}

export interface AssignTaskInput {
  task_id: string;
  member_id: string;
}

export interface UnassignTaskInput {
  task_id: string;
}

export interface BulkStatusInput {
  task_ids: string[];
  status: TaskStatus;
}

export interface Member {
  id: string;
  name: string;
  role: string;
  created_at: number;
}

export interface Task {
  id: string;
  title: string;
  notes: string;
  status: TaskStatus;
  priority: number;
  owner_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface TaskAssignmentView {
  task_id: string;
  member_id: string;
}

export interface DemoStats {
  total_members: number;
  total_tasks: number;
  todo_tasks: number;
  doing_tasks: number;
  done_tasks: number;
}

export interface TemplateDashboard {
  members: Member[];
  tasks: Task[];
  assignments: TaskAssignmentView[];
  stats: DemoStats;
}

async function invokeResult<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<Result<T, string>> {
  try {
    const payload = await invoke<T>(command, args);
    return Ok<T, string>(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Err<string, T>(message);
  }
}

export const templateApi = {
  bootstrap: () =>
    invokeResult<TemplateDashboard>("template_bootstrap"),
  snapshot: () => invokeResult<TemplateDashboard>("template_snapshot"),
  createMember: (input: NewMemberInput) =>
    invokeResult<TemplateDashboard>("template_create_member", { input }),
  createTask: (input: NewTaskInput) =>
    invokeResult<TemplateDashboard>("template_create_task", { input }),
  assignTask: (input: AssignTaskInput) =>
    invokeResult<TemplateDashboard>("template_assign_task", { input }),
  unassignTask: (input: UnassignTaskInput) =>
    invokeResult<TemplateDashboard>("template_unassign_task", { input }),
  bulkSetStatus: (input: BulkStatusInput) =>
    invokeResult<TemplateDashboard>("template_bulk_set_status", { input }),
  reset: () => invokeResult<TemplateDashboard>("template_reset"),
};
