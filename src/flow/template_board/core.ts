import type { MouseWindowInfo } from "@/src/cmd";
import type {
  AssignTaskInput,
  BulkStatusInput,
  NewMemberInput,
  NewTaskInput,
  TaskStatus,
  TemplateDashboard,
  UnassignTaskInput,
} from "@/src/cmd/templateApp";

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
