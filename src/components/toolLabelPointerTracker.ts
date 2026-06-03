import type { ToolLabelPointerPosition } from "./toolLabelHoverLease";

export type ToolLabelPointerTracker = {
  position: ToolLabelPointerPosition | null;
  refCount: number;
  syncSubscribers: Set<() => void>;
  updatePosition: (event: PointerEvent) => void;
  updatePositionFromWheel: (event: WheelEvent) => void;
  clearPosition: () => void;
  requestSync: () => void;
};

const toolLabelPointerTrackers = new WeakMap<Document, ToolLabelPointerTracker>();

export const TOOL_LABEL_POINTER_WHEEL_CAPTURE = true;

export function retainToolLabelPointerTracker(ownerDocument: Document) {
  let tracker = toolLabelPointerTrackers.get(ownerDocument);

  if (!tracker) {
    tracker = {
      position: null,
      refCount: 0,
      syncSubscribers: new Set(),
      updatePosition: (event) => {
        tracker!.position = {
          clientX: event.clientX,
          clientY: event.clientY,
        };
      },
      updatePositionFromWheel: (event) => {
        tracker!.position = {
          clientX: event.clientX,
          clientY: event.clientY,
        };
        tracker!.requestSync();
      },
      clearPosition: () => {
        tracker!.position = null;
      },
      requestSync: () => {
        tracker!.syncSubscribers.forEach((subscriber) => {
          subscriber();
        });
      },
    };
    toolLabelPointerTrackers.set(ownerDocument, tracker);
    ownerDocument.addEventListener("pointerdown", tracker.updatePosition, {
      passive: true,
    });
    ownerDocument.addEventListener("pointermove", tracker.updatePosition, {
      passive: true,
    });
    ownerDocument.addEventListener("wheel", tracker.updatePositionFromWheel, {
      passive: true,
      capture: TOOL_LABEL_POINTER_WHEEL_CAPTURE,
    });
    ownerDocument.addEventListener("pointerleave", tracker.clearPosition, {
      passive: true,
    });
    ownerDocument.defaultView?.addEventListener("blur", tracker.clearPosition);
  }

  tracker.refCount += 1;

  return () => {
    const currentTracker = toolLabelPointerTrackers.get(ownerDocument);

    if (!currentTracker) {
      return;
    }

    currentTracker.refCount -= 1;

    if (currentTracker.refCount > 0) {
      return;
    }

    ownerDocument.removeEventListener("pointerdown", currentTracker.updatePosition);
    ownerDocument.removeEventListener("pointermove", currentTracker.updatePosition);
    ownerDocument.removeEventListener(
      "wheel",
      currentTracker.updatePositionFromWheel,
      TOOL_LABEL_POINTER_WHEEL_CAPTURE,
    );
    ownerDocument.removeEventListener("pointerleave", currentTracker.clearPosition);
    ownerDocument.defaultView?.removeEventListener("blur", currentTracker.clearPosition);
    toolLabelPointerTrackers.delete(ownerDocument);
  };
}

export function readToolLabelPointerPosition(ownerDocument: Document | null) {
  return ownerDocument ? (toolLabelPointerTrackers.get(ownerDocument)?.position ?? null) : null;
}

export function subscribeToolLabelPointerSync(
  ownerDocument: Document | null,
  subscriber: () => void,
) {
  const tracker = ownerDocument ? toolLabelPointerTrackers.get(ownerDocument) : null;

  if (!tracker) {
    return () => {};
  }

  tracker.syncSubscribers.add(subscriber);

  return () => {
    tracker.syncSubscribers.delete(subscriber);
  };
}
