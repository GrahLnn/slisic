import type {
  AssignTaskInput,
  BulkStatusInput,
  TaskStatus,
  UnassignTaskInput,
} from "@/src/cmd/templateApp";
import { useSelector } from "@xstate/react";
import { createActor } from "xstate";
import { createSender } from "../kit";
import { machine } from "./machine";
import { type MainStateT, payloads, sig } from "./events";

export const actor = createActor(machine);
const send = createSender(actor);

export const hook = {
  useState: () => useSelector(actor, (shot) => shot.value as MainStateT),
  useContext: () => useSelector(actor, (shot) => shot.context),
};

export const action = {
  run: () => send(sig.mainx.run),
  loadSnapshot: () => send(sig.mainx.load_snapshot),
  bootstrap: () => send(sig.mainx.bootstrap),
  reset: () => send(sig.mainx.reset),
  createMember: () => send(sig.mainx.create_member),
  createTask: () => send(sig.mainx.create_task),
  openWindow: () => send(sig.mainx.open_window),
  captureMouse: () => send(sig.mainx.capture_mouse),
  setMemberId: (value: string) => send(payloads.set_member_id.load(value)),
  setMemberName: (value: string) => send(payloads.set_member_name.load(value)),
  setMemberRole: (value: string) => send(payloads.set_member_role.load(value)),
  setTaskId: (value: string) => send(payloads.set_task_id.load(value)),
  setTaskTitle: (value: string) => send(payloads.set_task_title.load(value)),
  setTaskNotes: (value: string) => send(payloads.set_task_notes.load(value)),
  setTaskStatus: (value: TaskStatus) =>
    send(payloads.set_task_status.load(value)),
  setTaskPriority: (value: number) =>
    send(payloads.set_task_priority.load(value)),
  setBulkStatus: (value: TaskStatus) =>
    send(payloads.set_bulk_status.load(value)),
  toggleTaskSelection: (taskId: string) =>
    send(payloads.toggle_task_selection.load(taskId)),
  assignTask: (input: AssignTaskInput) => send(payloads.assign_task.load(input)),
  unassignTask: (input: UnassignTaskInput) =>
    send(payloads.unassign_task.load(input)),
  setStatus: (input: BulkStatusInput) => send(payloads.set_status.load(input)),
};
