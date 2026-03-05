import { useSelector } from "@xstate/react";
import { createActor } from "xstate";
import { createSender } from "../kit";
import { machine } from "./machine";
import type {
  AssignTaskInput,
  BulkStatusInput,
  TaskStatus,
  UnassignTaskInput,
} from "./core";
import { type MainStateT, payloads, sig } from "./events";

export const actor = createActor(machine);
const send = createSender(actor);

let started = false;

export function ensureStarted() {
  if (started) {
    return;
  }
  actor.start();
  started = true;
}

function sendSafe(evt: unknown) {
  ensureStarted();
  send(evt as any);
}

export const hook = {
  useState: () => useSelector(actor, (shot) => shot.value as MainStateT),
  useContext: () => useSelector(actor, (shot) => shot.context),
};

export const action = {
  run: () => sendSafe(sig.mainx.run),
  loadSnapshot: () => sendSafe(sig.mainx.load_snapshot),
  bootstrap: () => sendSafe(sig.mainx.bootstrap),
  reset: () => sendSafe(sig.mainx.reset),
  createMember: () => sendSafe(sig.mainx.create_member),
  createTask: () => sendSafe(sig.mainx.create_task),
  openWindow: () => sendSafe(sig.mainx.open_window),
  captureMouse: () => sendSafe(sig.mainx.capture_mouse),
  setMemberId: (value: string) => sendSafe(payloads.set_member_id.load(value)),
  setMemberName: (value: string) =>
    sendSafe(payloads.set_member_name.load(value)),
  setMemberRole: (value: string) =>
    sendSafe(payloads.set_member_role.load(value)),
  setTaskId: (value: string) => sendSafe(payloads.set_task_id.load(value)),
  setTaskTitle: (value: string) =>
    sendSafe(payloads.set_task_title.load(value)),
  setTaskNotes: (value: string) =>
    sendSafe(payloads.set_task_notes.load(value)),
  setTaskStatus: (value: TaskStatus) =>
    sendSafe(payloads.set_task_status.load(value)),
  setTaskPriority: (value: number) =>
    sendSafe(payloads.set_task_priority.load(value)),
  setBulkStatus: (value: TaskStatus) =>
    sendSafe(payloads.set_bulk_status.load(value)),
  toggleTaskSelection: (taskId: string) =>
    sendSafe(payloads.toggle_task_selection.load(taskId)),
  assignTask: (input: AssignTaskInput) =>
    sendSafe(payloads.assign_task.load(input)),
  unassignTask: (input: UnassignTaskInput) =>
    sendSafe(payloads.unassign_task.load(input)),
  setStatus: (input: BulkStatusInput) =>
    sendSafe(payloads.set_status.load(input)),
};
