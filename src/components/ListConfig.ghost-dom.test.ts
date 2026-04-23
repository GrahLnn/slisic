import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  applyGhostPaintBox,
  applyGhostMotionState,
  createGhostSurfaceTransition,
  mergeGhostClipInsets,
  resolveGhostTorphTextMetricStylePatch,
  resolveGhostClipInsets,
  resolveGhostCloneContentDisplay,
  resolveGhostNodePose,
  resolveGhostPaintFrame,
  resolveGhostSurfaceTransitionOpacities,
  simplifyGhostCloneContentTree,
} from "./ListConfig.ghost-dom";

type MockGhostNode = {
  children: MockGhostNode[];
  className: string;
  computedStyle: CSSStyleDeclaration;
  dataset: Record<string, string>;
  getBoundingClientRect: () => {
    height: number;
    left: number;
    top: number;
    width: number;
  };
  ownerDocument: {
    defaultView: {
      getComputedStyle: (node: MockGhostNode) => CSSStyleDeclaration;
    };
  };
  offsetHeight: number;
  offsetWidth: number;
  parentNode: MockGhostNode | null;
  querySelectorAll: (selector: string) => MockGhostNode[];
  replaceChild: (nextChild: MockGhostNode, previousChild: MockGhostNode) => void;
  replaceChildren: (...nextChildren: MockGhostNode[]) => void;
  style: CSSStyleDeclaration;
  textContent: string;
  cloneNode: (deep?: boolean) => MockGhostNode;
};

const mockDefaultView = {
  getComputedStyle(node: MockGhostNode) {
    return node.computedStyle;
  },
};

function createMockStyle(initial: Record<string, string> = {}) {
  const values: Record<string, string> = { ...initial };

  return {
    ...values,
    getPropertyValue(property: string) {
      return values[property] ?? "";
    },
    setProperty(property: string, value: string) {
      values[property] = value;
      (this as Record<string, string>)[property] = value;
    },
  } as unknown as CSSStyleDeclaration;
}

function serializeMockStyle(style: CSSStyleDeclaration) {
  return Object.fromEntries(
    Object.entries(style as unknown as Record<string, string>).filter(
      ([key, value]) => typeof value === "string" && key !== "setProperty" && key !== "getPropertyValue",
    ),
  );
}

function matchesMockSelector(node: MockGhostNode, selector: string) {
  const dataMatch = selector.match(/^\[([^=]+)=['"]([^'"]+)['"]\]$/);

  if (!dataMatch) {
    return false;
  }

  const [, rawAttribute, value] = dataMatch;
  const attribute = rawAttribute.replace(/^data-/, "");
  const datasetKey = attribute.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());

  return node.dataset[datasetKey] === value;
}

function collectMockDescendants(node: MockGhostNode, selector: string): MockGhostNode[] {
  return node.children.flatMap((child) => [
    ...(matchesMockSelector(child, selector) ? [child] : []),
    ...collectMockDescendants(child, selector),
  ]);
}

function createMockGhostNode(args: {
  children?: MockGhostNode[];
  className?: string;
  computedStyle?: Record<string, string>;
  dataset?: Record<string, string>;
  rect?: {
    height: number;
    left: number;
    top: number;
    width: number;
  };
  textContent?: string;
}) {
  const rect = args.rect ?? {
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  };
  let node: MockGhostNode;

  node = {
    children: [] as MockGhostNode[],
    className: args.className ?? "",
    computedStyle: createMockStyle(args.computedStyle),
    dataset: { ...args.dataset },
    getBoundingClientRect: () => rect,
    ownerDocument: {
      defaultView: mockDefaultView,
    },
    offsetHeight: rect.height,
    offsetWidth: rect.width,
    parentNode: null,
    querySelectorAll(selector: string): MockGhostNode[] {
      return collectMockDescendants(node, selector);
    },
    replaceChild(nextChild: MockGhostNode, previousChild: MockGhostNode) {
      const index = node.children.indexOf(previousChild);

      assert.notEqual(index, -1);
      nextChild.parentNode = node;
      previousChild.parentNode = null;
      node.children[index] = nextChild;
    },
    replaceChildren(...nextChildren: MockGhostNode[]) {
      node.children.forEach((child) => {
        child.parentNode = null;
      });
      nextChildren.forEach((child) => {
        child.parentNode = node;
      });
      node.children = nextChildren;
    },
    style: createMockStyle(),
    textContent: args.textContent ?? "",
    cloneNode(deep = false) {
      return createMockGhostNode({
        children: deep ? node.children.map((child: MockGhostNode) => child.cloneNode(true)) : [],
        className: node.className,
        computedStyle: serializeMockStyle(node.computedStyle),
        dataset: { ...node.dataset },
        rect,
        textContent: node.textContent,
      });
    },
  } satisfies MockGhostNode;

  node.children = args.children ?? [];
  node.children.forEach((child) => {
    child.parentNode = node;
  });

  return node;
}

describe("ListConfig ghost DOM", () => {
  test("blockifies inline displays once the clone leaves text flow", () => {
    assert.equal(resolveGhostCloneContentDisplay("inline"), "block");
    assert.equal(resolveGhostCloneContentDisplay("inline-block"), "block");
    assert.equal(resolveGhostCloneContentDisplay("inline-flex"), "flex");
    assert.equal(resolveGhostCloneContentDisplay("inline-grid"), "grid");
    assert.equal(resolveGhostCloneContentDisplay("inline-table"), "table");
  });

  test("keeps already block-level displays unchanged", () => {
    assert.equal(resolveGhostCloneContentDisplay("block"), "block");
    assert.equal(resolveGhostCloneContentDisplay("flex"), "flex");
    assert.equal(resolveGhostCloneContentDisplay("grid"), "grid");
  });

  test("preserves Torph text metrics when the flow shell is detached from its source tree", () => {
    const patch = resolveGhostTorphTextMetricStylePatch({
      getPropertyValue(property: string) {
        const values: Record<string, string> = {
          "font-family": '"Geist"',
          "font-size": "14px",
          "line-height": "18px",
          "letter-spacing": "0.2px",
          "white-space": "nowrap",
        };

        return values[property] ?? "";
      },
    });

    assert.deepEqual(patch, {
      "font-family": '"Geist"',
      "font-size": "14px",
      "line-height": "18px",
      "letter-spacing": "0.2px",
      "white-space": "nowrap",
    });
  });

  test("keeps the Torph overlay as the ghost-visible layer when it already exists", () => {
    const sourceFlowShell = createMockGhostNode({
      computedStyle: {
        "font-family": '"Geist"',
        "font-size": "14px",
        "line-height": "18px",
        "white-space": "nowrap",
      },
      rect: {
        left: 0,
        top: 0,
        width: 89,
        height: 18,
      },
      dataset: {
        torphDebugRole: "flow-shell",
      },
    });
    const sourceOverlay = createMockGhostNode({
      rect: {
        left: 0,
        top: 0,
        width: 89,
        height: 18,
      },
      dataset: {
        torphDebugRole: "overlay",
      },
    });
    const sourceRoot = createMockGhostNode({
      children: [sourceFlowShell, sourceOverlay],
      computedStyle: {
        display: "grid",
        position: "relative",
        width: "89px",
        height: "18px",
      },
      rect: {
        left: 0,
        top: 0,
        width: 89,
        height: 18,
      },
      dataset: {
        torphDebugRole: "root",
      },
    });
    const sourceNode = createMockGhostNode({
      children: [sourceRoot],
    });
    const cloneNode = sourceNode.cloneNode(true);
    const [cloneRoot] = cloneNode.querySelectorAll("[data-torph-debug-role='root']");

    simplifyGhostCloneContentTree({
      cloneNode: cloneNode as unknown as HTMLDivElement,
      sourceNode: sourceNode as unknown as HTMLDivElement,
    });

    assert.equal(cloneRoot.dataset.listConfigGhostTorphSanitized, "true");
    assert.equal(cloneRoot.dataset.listConfigGhostTorphVisibleLayer, "overlay");
    assert.equal(cloneRoot.children.length, 1);
    assert.equal(cloneRoot.children[0]?.dataset.torphDebugRole, "overlay");
    assert.equal(cloneRoot.style.getPropertyValue("font-family"), '"Geist"');
    assert.equal(cloneRoot.style.getPropertyValue("font-size"), "14px");
    assert.equal(cloneRoot.style.width, "89px");
    assert.equal(cloneRoot.style.height, "18px");
    assert.equal(cloneRoot.children[0]?.style.position, "absolute");
    assert.equal(cloneRoot.children[0]?.style.width, "100%");
    assert.equal(cloneRoot.children[0]?.style.height, "100%");
  });

  test("resolves the unclamped frame and angle from a rotated host node", () => {
    const node = {
      getBoundingClientRect: () => ({
        left: 1201.7822265625,
        top: 211.1537322998047,
        width: 90.88460540771484,
        height: 34.08927536010742,
      }),
      offsetWidth: 89,
      offsetHeight: 18,
      ownerDocument: {
        defaultView: {
          getComputedStyle: () =>
            ({
              width: "89.0938px",
              height: "18px",
              transform: "matrix(0.982919, -0.184039, 0.184039, 0.982919, 0, 0)",
              transformOrigin: "89.0938px 9px",
            }) as CSSStyleDeclaration,
        },
      },
    } as unknown as HTMLDivElement;

    const pose = resolveGhostNodePose(node);

    assert.ok(Math.abs(pose.frame.left - 1201.9167663647) < 0.001);
    assert.ok(Math.abs(pose.frame.top - 211.0000032998047) < 0.001);
    assert.ok(Math.abs(pose.frame.width - 89.0938) < 0.001);
    assert.ok(Math.abs(pose.frame.height - 18) < 0.001);
    assert.ok(Math.abs(pose.angle + 10.605108556116875) < 0.001);
    assert.ok(Math.abs(pose.transformOrigin.x - 89.0938) < 0.001);
    assert.ok(Math.abs(pose.transformOrigin.y - 9) < 0.001);
  });

  test("derives clip insets from rotated overflow and line-height bleed", () => {
    const insets = resolveGhostClipInsets({
      frame: {
        left: 1201.9167663647,
        top: 211.0000032998047,
        width: 89.0938,
        height: 18,
      },
      lineHeight: "24px",
      visualRect: {
        left: 1201.7822265625,
        top: 211.1537322998047,
        width: 90.88460540771484,
        height: 34.08927536010742,
      },
    });

    assert.ok(Math.abs(insets.top - 3) < 0.001);
    assert.ok(Math.abs(insets.right - 1.6562656055146963) < 0.001);
    assert.ok(Math.abs(insets.bottom - 16.2430043601074) < 0.001);
    assert.ok(Math.abs(insets.left - 1) < 0.001);
  });

  test("keeps baseline-safe padding even without rotated overflow", () => {
    assert.deepEqual(
      resolveGhostClipInsets({
        frame: {
          left: 380,
          top: 371.3333435058594,
          width: 89.0938,
          height: 18,
        },
        lineHeight: "24px",
        visualRect: {
          left: 380,
          top: 371.3333435058594,
          width: 89.0938,
          height: 18,
        },
      }),
      {
        top: 3,
        right: 1,
        bottom: 3,
        left: 1,
      },
    );
  });

  test("merges source and target clip insets with the widest paint envelope", () => {
    assert.deepEqual(
      mergeGhostClipInsets(
        {
          top: 3,
          right: 1.5,
          bottom: 16.2,
          left: 1,
        },
        {
          top: 4,
          right: 2,
          bottom: 3,
          left: 1.25,
        },
      ),
      {
        top: 4,
        right: 2,
        bottom: 16.2,
        left: 1.25,
      },
    );
  });

  test("expands the paint shell around the content frame", () => {
    assert.deepEqual(
      resolveGhostPaintFrame({
        frame: {
          left: 380,
          top: 371.3333435058594,
          width: 89.0938,
          height: 18,
        },
        insets: {
          top: 3,
          right: 2,
          bottom: 16.2,
          left: 1.25,
        },
      }),
      {
        left: 378.75,
        top: 368.3333435058594,
        width: 92.3438,
        height: 37.2,
      },
    );
  });

  test("positions the content box inside the expanded paint shell", () => {
    const cloneNode = {
      style: {},
    } as unknown as HTMLDivElement;
    const cloneContentNode = {
      style: {},
    } as unknown as HTMLDivElement;

    applyGhostPaintBox({
      cloneContentNode,
      cloneNode,
      frame: {
        left: 380,
        top: 371.3333435058594,
        width: 89.0938,
        height: 18,
      },
      insets: {
        top: 3,
        right: 2,
        bottom: 16.2,
        left: 1.25,
      },
    });

    assert.equal((cloneNode as unknown as { style: Record<string, string> }).style.left, "378.75px");
    assert.equal((cloneNode as unknown as { style: Record<string, string> }).style.top, "368.3333435058594px");
    assert.equal((cloneNode as unknown as { style: Record<string, string> }).style.width, "92.3438px");
    assert.equal((cloneNode as unknown as { style: Record<string, string> }).style.height, "37.2px");
    assert.equal(
      (cloneNode as unknown as { style: Record<string, string> }).style.transformOrigin,
      "1.25px 3px",
    );
    assert.equal(
      (cloneContentNode as unknown as { style: Record<string, string> }).style.left,
      "1.25px",
    );
    assert.equal(
      (cloneContentNode as unknown as { style: Record<string, string> }).style.top,
      "3px",
    );
    assert.equal(
      (cloneContentNode as unknown as { style: Record<string, string> }).style.width,
      "89.0938px",
    );
    assert.equal(
      (cloneContentNode as unknown as { style: Record<string, string> }).style.height,
      "18px",
    );
  });

  test("applies the animated transform origin alongside the angle", () => {
    const cloneNode = {
      style: {},
    } as unknown as HTMLDivElement;
    const cloneContentNode = {
      style: {},
    } as unknown as HTMLDivElement;

    applyGhostMotionState({
      cloneContentNode,
      cloneNode,
      sourceFrame: {
        left: 380,
        top: 371.3333435058594,
        width: 89.0938,
        height: 18,
      },
      state: {
        angle: -10.605108556116875,
        center: { x: 1246.4636663647, y: 220.0000032998047 },
        followProgress: 1,
        height: 18,
        left: 1201.9167663647,
        pathAngle: -11.785183214297717,
        progress: 1,
        rawPathAngle: -11.785183214297717,
        scaleX: 1,
        scaleY: 1,
        settleProgress: 1,
        settleTargetAngle: -10.605108556116875,
        top: 211.0000032998047,
        trackedAngle: -11.785183214297717,
        transformOrigin: { x: 89.0938, y: 9 },
        width: 89.0938,
      },
    });

    assert.match(
      (cloneNode as unknown as { style: Record<string, string> }).style.transform,
      /^translate3d\(821\.9167.*px, -160\.3333.*px, 0\) scale\(1, 1\)$/,
    );
    assert.equal(
      (cloneContentNode as unknown as { style: Record<string, string> }).style.transformOrigin,
      "89.0938px 9px",
    );
    assert.equal(
      (cloneContentNode as unknown as { style: Record<string, string> }).style.transform,
      "rotate(-10.605108556116875deg)",
    );
  });

  test("surface transition keeps the outer shell and crossfades source/target layers", () => {
    const sourceSurface = createMockGhostNode({
      className: "clone-text-container",
      computedStyle: {
        display: "flex",
      },
      dataset: {
        listConfigGhostSurfaceRole: "source",
        toolLabelDebugRole: "text-container",
      },
      children: [
        createMockGhostNode({
          className: "plain-surface",
          textContent: "Minus Sixty One",
        }),
      ],
    });
    sourceSurface.style.position = "absolute";
    sourceSurface.style.left = "0";
    sourceSurface.style.top = "0";
    sourceSurface.style.width = "100%";
    sourceSurface.style.height = "100%";
    sourceSurface.style.minWidth = "100%";
    sourceSurface.style.minHeight = "100%";
    sourceSurface.style.opacity = "1";

    const surfaceHost = createMockGhostNode({
      className: "ghost-surface-host",
      dataset: {
        listConfigGhostSurfaceHost: "true",
      },
      children: [sourceSurface],
    });
    const cloneContentNode = createMockGhostNode({
      className: "ghost-shell",
      children: [surfaceHost],
    });
    const targetTextContainer = createMockGhostNode({
      className: "target-text-container",
      computedStyle: {
        display: "flex",
      },
      dataset: {
        toolLabelDebugRole: "text-container",
      },
      children: [
        createMockGhostNode({
          className: "torph-surface",
          textContent: "Minus Sixty One",
        }),
      ],
    });
    const targetNode = createMockGhostNode({
      className: "target-shell",
      children: [targetTextContainer],
    });
    targetNode.style.opacity = "";

    const surfaceTransition = createGhostSurfaceTransition({
      cloneContentNode: cloneContentNode as unknown as HTMLDivElement,
      targetNode: targetNode as unknown as HTMLDivElement,
    });

    const [nextSourceSurface, nextTargetSurface] = surfaceHost.children;

    assert.ok(surfaceTransition);
    assert.equal(cloneContentNode.className, "ghost-shell");
    assert.equal(cloneContentNode.children.length, 1);
    assert.equal(surfaceHost.children.length, 2);
    assert.equal(nextSourceSurface, sourceSurface);
    assert.equal(nextTargetSurface?.className, "target-text-container");
    assert.equal(nextTargetSurface?.dataset.listConfigGhostSurfaceRole, "target");
    assert.equal(nextTargetSurface?.style.position, "absolute");
    assert.equal(nextTargetSurface?.style.left, "0");
    assert.equal(nextTargetSurface?.style.top, "0");
    assert.equal(nextTargetSurface?.style.width, "100%");
    assert.equal(nextTargetSurface?.style.height, "100%");
    assert.equal(nextTargetSurface?.style.minWidth, "100%");
    assert.equal(nextTargetSurface?.style.minHeight, "100%");
    assert.equal(nextTargetSurface?.style.opacity, "0");
    assert.equal(targetNode.style.opacity, "0");
    assert.deepEqual(surfaceTransition?.sample(), {
      hasTargetSurface: true,
      liveTargetOpacity: "0",
      progress: 0,
      sourceOpacity: "1",
      targetOpacity: "0",
    });

    const midProgress = 0.82;
    const midTransition = resolveGhostSurfaceTransitionOpacities({
      progress: midProgress,
    });

    surfaceTransition?.setProgress(midProgress);

    assert.equal(sourceSurface.style.opacity, `${midTransition.sourceOpacity}`);
    assert.equal(nextTargetSurface?.style.opacity, `${midTransition.targetOpacity}`);
    assert.equal(targetNode.style.opacity, `${midTransition.liveTargetOpacity}`);

    const terminalProgress = 1;
    const terminalTransition = resolveGhostSurfaceTransitionOpacities({
      progress: terminalProgress,
    });

    surfaceTransition?.setProgress(terminalProgress);

    assert.equal(sourceSurface.style.opacity, `${terminalTransition.sourceOpacity}`);
    assert.equal(nextTargetSurface?.style.opacity, `${terminalTransition.targetOpacity}`);
    assert.equal(targetNode.style.opacity, `${terminalTransition.liveTargetOpacity}`);

    surfaceTransition?.releaseTarget();

    assert.equal(targetNode.style.opacity, "");
  });

  test("surface transition normalizes the target layer instead of preserving live flow metrics", () => {
    const sourceSurface = createMockGhostNode({
      computedStyle: {
        display: "flex",
        position: "absolute",
        width: "100%",
        height: "100%",
        minWidth: "100%",
        minHeight: "100%",
      },
      dataset: {
        listConfigGhostSurfaceRole: "source",
        toolLabelDebugRole: "text-container",
      },
      rect: {
        left: 0,
        top: 0,
        width: 89,
        height: 18,
      },
      children: [
        createMockGhostNode({
          className: "plain-surface",
          textContent: "Minus Sixty One",
        }),
      ],
    });
    sourceSurface.style.opacity = "1";
    const surfaceHost = createMockGhostNode({
      dataset: {
        listConfigGhostSurfaceHost: "true",
      },
      children: [sourceSurface],
    });
    const cloneContentNode = createMockGhostNode({
      className: "ghost-shell",
      children: [surfaceHost],
    });
    const targetFlowShell = createMockGhostNode({
      computedStyle: {
        display: "block",
        position: "static",
        width: "89px",
        height: "18px",
        "font-family": '"Geist"',
        "font-size": "14px",
        "line-height": "18px",
        "white-space": "nowrap",
      },
      dataset: {
        torphDebugRole: "flow-shell",
      },
      rect: {
        left: 0,
        top: 0,
        width: 89,
        height: 18,
      },
    });
    const targetOverlay = createMockGhostNode({
      dataset: {
        torphDebugRole: "overlay",
      },
      rect: {
        left: 0,
        top: 0,
        width: 89,
        height: 18,
      },
    });
    const targetTorphRoot = createMockGhostNode({
      children: [targetFlowShell, targetOverlay],
      computedStyle: {
        display: "grid",
        position: "relative",
        width: "89px",
        height: "18px",
      },
      dataset: {
        torphDebugRole: "root",
      },
      rect: {
        left: 0,
        top: 0,
        width: 89,
        height: 18,
      },
    });
    const targetTextContainer = createMockGhostNode({
      className: "target-text-container",
      computedStyle: {
        display: "flex",
        position: "static",
        width: "89px",
        height: "18px",
      },
      dataset: {
        toolLabelDebugRole: "text-container",
      },
      rect: {
        left: 0,
        top: 0,
        width: 89,
        height: 18,
      },
      children: [targetTorphRoot],
    });
    const targetNode = createMockGhostNode({
      className: "target-shell",
      children: [targetTextContainer],
    });
    targetNode.style.opacity = "";

    const surfaceTransition = createGhostSurfaceTransition({
      cloneContentNode: cloneContentNode as unknown as HTMLDivElement,
      targetNode: targetNode as unknown as HTMLDivElement,
    });

    const nextTargetSurface = surfaceHost.children[1];
    const [nextTargetTorphRoot] = nextTargetSurface?.children ?? [];

    assert.ok(surfaceTransition);
    assert.equal(nextTargetSurface?.style.display, "flex");
    assert.equal(nextTargetSurface?.style.position, "absolute");
    assert.equal(nextTargetSurface?.style.left, "0");
    assert.equal(nextTargetSurface?.style.top, "0");
    assert.equal(nextTargetSurface?.style.width, "100%");
    assert.equal(nextTargetSurface?.style.height, "100%");
    assert.equal(nextTargetSurface?.style.minWidth, "100%");
    assert.equal(nextTargetSurface?.style.minHeight, "100%");
    assert.equal(nextTargetTorphRoot?.style.width, "89px");
    assert.equal(nextTargetTorphRoot?.style.height, "18px");
    assert.equal(nextTargetTorphRoot?.children[0]?.dataset.torphDebugRole, "overlay");
    assert.equal(nextTargetTorphRoot?.children[0]?.style.width, "100%");
    assert.equal(nextTargetTorphRoot?.children[0]?.style.height, "100%");

    const lateProgress = 0.98;
    const lateTransition = resolveGhostSurfaceTransitionOpacities({
      progress: lateProgress,
    });

    surfaceTransition?.setProgress(lateProgress);

    assert.equal(nextTargetSurface?.style.opacity, `${lateTransition.targetOpacity}`);
    assert.equal(targetNode.style.opacity, `${lateTransition.liveTargetOpacity}`);

    surfaceTransition?.releaseTarget();

    assert.equal(targetNode.style.opacity, "");
  });
});
