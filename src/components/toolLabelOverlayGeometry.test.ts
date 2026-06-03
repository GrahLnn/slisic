import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  collectHoverSyncScrollTargets,
  collectScrollContainers,
  isScrollableContainer,
  sameRect,
  toOverlayStyle,
} from "./toolLabelOverlayGeometry";

function rect(args: {
  top: number;
  left: number;
  right: number;
  bottom?: number;
  width: number;
  height: number;
}) {
  return args as DOMRectReadOnly;
}

function createElement(args: { parentElement?: HTMLElement | null; ownerDocument?: Document }) {
  return args as HTMLElement;
}

describe("ToolLabel overlay geometry", () => {
  const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  let getComputedStyle: (element: Element) => CSSStyleDeclaration;

  beforeEach(() => {
    getComputedStyle = () =>
      ({
        overflow: "visible",
        overflowX: "visible",
        overflowY: "visible",
      }) as CSSStyleDeclaration;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        getComputedStyle: (element: Element) => getComputedStyle(element),
      },
    });
  });

  afterEach(() => {
    if (originalWindowDescriptor) {
      Object.defineProperty(globalThis, "window", originalWindowDescriptor);
      return;
    }

    Reflect.deleteProperty(globalThis, "window");
  });

  test("projects portal overlay style from viewport rect for each anchor", () => {
    const anchorRect = rect({
      top: 12,
      left: 24,
      right: 124,
      width: 100,
      height: 18,
    });

    assert.deepEqual(toOverlayStyle(anchorRect, "left", 320), {
      top: 12,
      left: 24,
      height: 18,
      minWidth: 100,
    });
    assert.deepEqual(toOverlayStyle(anchorRect, "right", 320), {
      top: 12,
      right: 196,
      height: 18,
      minWidth: 100,
    });
  });

  test("compares stable rect coordinates without object identity", () => {
    const first = rect({
      top: 1,
      left: 2,
      right: 12,
      width: 10,
      height: 4,
    });

    assert.equal(
      sameRect(
        first,
        rect({
          top: 1,
          left: 2,
          right: 12,
          width: 10,
          height: 4,
        }),
      ),
      true,
    );
    assert.equal(
      sameRect(
        first,
        rect({
          top: 1,
          left: 3,
          right: 13,
          width: 10,
          height: 4,
        }),
      ),
      false,
    );
    assert.equal(sameRect(null, first), false);
  });

  test("classifies any scrollable overflow axis as a scroll container", () => {
    const element = createElement({});

    getComputedStyle = () =>
      ({
        overflow: "visible",
        overflowX: "clip",
        overflowY: "auto",
      }) as CSSStyleDeclaration;

    assert.equal(isScrollableContainer(element), true);

    getComputedStyle = () =>
      ({
        overflow: "visible",
        overflowX: "clip",
        overflowY: "hidden",
      }) as CSSStyleDeclaration;

    assert.equal(isScrollableContainer(element), false);
  });

  test("collects scroll containers from nearest parent to farthest ancestor", () => {
    const root = createElement({});
    const farScroll = createElement({
      parentElement: root,
    });
    const staticParent = createElement({
      parentElement: farScroll,
    });
    const nearScroll = createElement({
      parentElement: staticParent,
    });
    const anchor = createElement({
      parentElement: nearScroll,
    });

    getComputedStyle = (element) =>
      ({
        overflow: element === nearScroll || element === farScroll ? "auto" : "visible",
        overflowX: "visible",
        overflowY: "visible",
      }) as CSSStyleDeclaration;

    assert.deepEqual(collectScrollContainers(anchor), [nearScroll, farScroll]);
  });

  test("returns hover sync scroll containers with the anchor owner window", () => {
    const ownerWindow = {} as Window;
    const ownerDocument = {
      defaultView: ownerWindow,
    } as Document;
    const scrollParent = createElement({
      ownerDocument,
    });
    const anchor = createElement({
      ownerDocument,
      parentElement: scrollParent,
    });

    getComputedStyle = () =>
      ({
        overflow: "scroll",
        overflowX: "visible",
        overflowY: "visible",
      }) as CSSStyleDeclaration;

    assert.deepEqual(collectHoverSyncScrollTargets(anchor), {
      containers: [scrollParent],
      ownerWindow,
    });
  });
});
