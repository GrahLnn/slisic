import type {
  AssignTaskInput,
  BulkStatusInput as CmdBulkStatusInput,
  MouseWindowInfo,
  NewMemberInput,
  NewTaskInput as CmdNewTaskInput,
  TemplateDashboard,
  UnassignTaskInput,
} from "@/src/cmd/commands";

export type TaskStatus = "todo" | "doing" | "done";
export type {
  AssignTaskInput,
  MouseWindowInfo,
  NewMemberInput,
  TemplateDashboard,
  UnassignTaskInput,
};
export type NewTaskInput = Omit<CmdNewTaskInput, "status"> & {
  status: TaskStatus;
};
export type BulkStatusInput = Omit<CmdBulkStatusInput, "status"> & {
  status: TaskStatus;
};

export interface ToastMessage {
  title: string;
  description?: string;
}

export type PendingOperation =
  | { kind: "snapshot" }
  | { kind: "bootstrap" }
  | { kind: "reset" }
  | { kind: "create_member"; input: NewMemberInput }
  | { kind: "create_task"; input: NewTaskInput }
  | { kind: "assign_task"; input: AssignTaskInput }
  | { kind: "unassign_task"; input: UnassignTaskInput }
  | { kind: "bulk_status"; input: BulkStatusInput }
  | { kind: "open_window" }
  | { kind: "capture_mouse" };

export type OperationResult =
  | {
      kind: "dashboard";
      dashboard: TemplateDashboard;
      success?: ToastMessage;
      clearSelection?: boolean;
      resetMemberInput?: boolean;
      resetTaskInput?: boolean;
    }
  | { kind: "mouse"; mouseInfo: MouseWindowInfo }
  | { kind: "window"; success: ToastMessage }
  | { kind: "noop" };

export interface Context {
  dashboard: TemplateDashboard | null;
  memberInput: NewMemberInput;
  taskInput: NewTaskInput;
  bulkStatus: TaskStatus;
  selectedTaskIds: string[];
  mouseInfo: MouseWindowInfo | null;
  pending: PendingOperation | null;
}

export const defaultMemberInput: NewMemberInput = {
  id: "",
  name: "",
  role: "",
};

export const defaultTaskInput: NewTaskInput = {
  id: "",
  title: "",
  notes: "",
  status: "todo",
  priority: 1,
};

export const initialContext: Context = {
  dashboard: null,
  memberInput: { ...defaultMemberInput },
  taskInput: { ...defaultTaskInput },
  bulkStatus: "done",
  selectedTaskIds: [],
  mouseInfo: null,
  pending: null,
};
