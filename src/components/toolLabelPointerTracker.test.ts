import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  TOOL_LABEL_POINTER_WHEEL_CAPTURE,
  readToolLabelPointerPosition,
  retainToolLabelPointerTracker,
  subscribeToolLabelPointerSync,
} from "./toolLabelPointerTracker";

type Listener = (event: never) => void;
type ListenerRecord = {
  type: string;
  listener: Listener;
  capture: boolean;
};

function resolveCapture(options?: boolean | AddEventListenerOptions) {
  return typeof options === "boolean" ? options : Boolean(options?.capture);
}

class FakeEventTarget {
  addCalls: ListenerRecord[] = [];
  removeCalls: ListenerRecord[] = [];
  private listeners: ListenerRecord[] = [];

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) {
    assert.equal(typeof listener, "function");

    const record = {
      type,
      listener: listener as Listener,
      capture: resolveCapture(options),
    };

    this.addCalls.push(record);
    this.listeners.push(record);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) {
    assert.equal(typeof listener, "function");

    const record = {
      type,
      listener: listener as Listener,
      capture: resolveCapture(options),
    };

    this.removeCalls.push(record);
    this.listeners = this.listeners.filter(
      (current) =>
        current.type !== record.type ||
        current.listener !== record.listener ||
        current.capture !== record.capture,
    );
  }

  dispatch(type: string, event: object = {}) {
    this.listeners
      .filter((record) => record.type === type)
      .forEach((record) => {
        record.listener(event as never);
      });
  }

  countListeners(type: string) {
    return this.listeners.filter((record) => record.type === type).length;
  }
}

class FakeDocument extends FakeEventTarget {
  defaultView = new FakeEventTarget();
}

function createDocument() {
  return new FakeDocument() as unknown as Document & {
    defaultView: FakeEventTarget;
    addCalls: ListenerRecord[];
    removeCalls: ListenerRecord[];
    dispatch: (type: string, event?: object) => void;
    countListeners: (type: string) => number;
  };
}

describe("ToolLabel pointer tracker", () => {
  test("registers document and window listeners only once per retained document", () => {
    const ownerDocument = createDocument();
    const firstRelease = retainToolLabelPointerTracker(ownerDocument);
    const secondRelease = retainToolLabelPointerTracker(ownerDocument);

    assert.deepEqual(
      ownerDocument.addCalls.map((call) => [call.type, call.capture]),
      [
        ["pointerdown", false],
        ["pointermove", false],
        ["wheel", TOOL_LABEL_POINTER_WHEEL_CAPTURE],
        ["pointerleave", false],
      ],
    );
    assert.deepEqual(
      ownerDocument.defaultView.addCalls.map((call) => [call.type, call.capture]),
      [["blur", false]],
    );

    secondRelease();

    assert.equal(ownerDocument.removeCalls.length, 0);
    assert.equal(ownerDocument.defaultView.removeCalls.length, 0);

    firstRelease();

    assert.deepEqual(
      ownerDocument.removeCalls.map((call) => [call.type, call.capture]),
      [
        ["pointerdown", false],
        ["pointermove", false],
        ["wheel", TOOL_LABEL_POINTER_WHEEL_CAPTURE],
        ["pointerleave", false],
      ],
    );
    assert.deepEqual(
      ownerDocument.defaultView.removeCalls.map((call) => [call.type, call.capture]),
      [["blur", false]],
    );
  });

  test("records pointer evidence and clears it on document leave or window blur", () => {
    const ownerDocument = createDocument();
    const release = retainToolLabelPointerTracker(ownerDocument);

    ownerDocument.dispatch("pointermove", {
      clientX: 24,
      clientY: 48,
    });

    assert.deepEqual(readToolLabelPointerPosition(ownerDocument), {
      clientX: 24,
      clientY: 48,
    });

    ownerDocument.dispatch("pointerleave");

    assert.equal(readToolLabelPointerPosition(ownerDocument), null);

    ownerDocument.dispatch("pointerdown", {
      clientX: 12,
      clientY: 16,
    });
    ownerDocument.defaultView.dispatch("blur");

    assert.equal(readToolLabelPointerPosition(ownerDocument), null);

    release();
  });

  test("wheel evidence requests hover sync without keeping removed subscribers", () => {
    const ownerDocument = createDocument();
    const release = retainToolLabelPointerTracker(ownerDocument);
    let syncCount = 0;
    const unsubscribe = subscribeToolLabelPointerSync(ownerDocument, () => {
      syncCount += 1;
    });

    ownerDocument.dispatch("wheel", {
      clientX: 88,
      clientY: 144,
    });

    assert.deepEqual(readToolLabelPointerPosition(ownerDocument), {
      clientX: 88,
      clientY: 144,
    });
    assert.equal(syncCount, 1);

    unsubscribe();
    ownerDocument.dispatch("wheel", {
      clientX: 96,
      clientY: 160,
    });

    assert.deepEqual(readToolLabelPointerPosition(ownerDocument), {
      clientX: 96,
      clientY: 160,
    });
    assert.equal(syncCount, 1);

    release();
  });
});
