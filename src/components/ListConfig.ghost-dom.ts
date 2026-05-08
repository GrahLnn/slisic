import {
  type GhostFrame,
  type GhostPoint,
  resolveGhostAngleFromTransform,
  resolveGhostCloneFrame,
  resolveGhostOriginFromTransformOrigin,
} from "./ListConfig.ghost-geometry";
import { type GhostMotionState } from "./ListConfig.ghost-motion";

export type GhostClone = {
  cloneContentNode: HTMLDivElement;
  cloneNode: HTMLDivElement;
  sourceAngle: number;
  sourceClipInsets: GhostClipInsets;
  sourceFrame: GhostFrame;
  sourceTransformOrigin: GhostPoint;
};

export type GhostClipInsets = {
  bottom: number;
  left: number;
  right: number;
  top: number;
};

export type GhostNodePose = {
  angle: number;
  frame: GhostFrame;
  transformOrigin: GhostPoint;
};

export type GhostSurfaceTransitionState = {
  hasTargetSurface: boolean;
  liveTargetOpacity: string | null;
  progress: number;
  sourceOpacity: string | null;
  targetOpacity: string | null;
};

export type GhostSurfaceTransitionController = {
  releaseTarget: () => void;
  sample: () => GhostSurfaceTransitionState;
  setProgress: (progress: number) => void;
};

const LIST_CONFIG_GHOST_Z_INDEX = 180;
const GHOST_MIN_CLIP_PADDING = 1;
const TORPH_ROOT_DEBUG_ROLE = "root";
const TORPH_FLOW_SHELL_DEBUG_ROLE = "flow-shell";
const TORPH_OVERLAY_DEBUG_ROLE = "overlay";
const TOOL_LABEL_TEXT_CONTAINER_DEBUG_ROLE = "text-container";
const GHOST_SURFACE_HOST_DEBUG_ROLE = "true";
const GHOST_SURFACE_SOURCE_HANDOFF_START_PROGRESS = 0.76;
const GHOST_SURFACE_SOURCE_HANDOFF_END_PROGRESS = 0.9;
const GHOST_SURFACE_LIVE_HANDOFF_START_PROGRESS = 0.94;
const GHOST_SURFACE_LIVE_HANDOFF_END_PROGRESS = 1;
const GHOST_TORPH_TEXT_METRIC_STYLE_PROPERTIES = [
  "font",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "font-stretch",
  "font-kerning",
  "font-variant-ligatures",
  "font-feature-settings",
  "font-variation-settings",
  "letter-spacing",
  "word-spacing",
  "line-height",
  "white-space",
  "text-transform",
  "text-indent",
  "text-rendering",
  "writing-mode",
  "text-orientation",
  "direction",
  "unicode-bidi",
] as const;

function resolveGhostComputedStyle(node: HTMLElement) {
  return node.ownerDocument.defaultView?.getComputedStyle(node) ?? window.getComputedStyle(node);
}

function formatGhostTransformOrigin(origin: GhostPoint) {
  return `${origin.x}px ${origin.y}px`;
}

function isGhostHtmlElement(node: unknown): node is HTMLElement {
  return typeof node === "object" && node !== null && "dataset" in node && "style" in node;
}

function resolveGhostTorphFlowShell(node: Element) {
  return Array.from(node.children).find(
    (child): child is HTMLElement =>
      isGhostHtmlElement(child) && child.dataset.torphDebugRole === TORPH_FLOW_SHELL_DEBUG_ROLE,
  );
}

function resolveGhostTorphOverlay(node: Element) {
  return Array.from(node.children).find(
    (child): child is HTMLElement =>
      isGhostHtmlElement(child) && child.dataset.torphDebugRole === TORPH_OVERLAY_DEBUG_ROLE,
  );
}

function resolveGhostTorphRoots(node: ParentNode) {
  return Array.from(
    node.querySelectorAll<HTMLElement>(`[data-torph-debug-role='${TORPH_ROOT_DEBUG_ROLE}']`),
  );
}

function resolveGhostToolLabelTextContainer(node: ParentNode) {
  if (
    isGhostHtmlElement(node) &&
    node.dataset.toolLabelDebugRole === TOOL_LABEL_TEXT_CONTAINER_DEBUG_ROLE
  ) {
    return node as HTMLDivElement;
  }

  return (node.querySelectorAll<HTMLElement>(
    `[data-tool-label-debug-role='${TOOL_LABEL_TEXT_CONTAINER_DEBUG_ROLE}']`,
  )[0] ?? null) as HTMLDivElement | null;
}

function resolveGhostSurfaceHost(node: ParentNode) {
  if (
    isGhostHtmlElement(node) &&
    node.dataset.listConfigGhostSurfaceHost === GHOST_SURFACE_HOST_DEBUG_ROLE
  ) {
    return node as HTMLDivElement;
  }

  return (node.querySelectorAll<HTMLElement>(`[data-list-config-ghost-surface-host='true']`)[0] ??
    null) as HTMLDivElement | null;
}

type GhostSurfaceLayerRole = "source" | "target";

function resolveGhostSurfaceLayer(node: ParentNode, role: GhostSurfaceLayerRole) {
  if (isGhostHtmlElement(node) && node.dataset.listConfigGhostSurfaceRole === role) {
    return node as HTMLDivElement;
  }

  return (node.querySelectorAll<HTMLElement>(
    `[data-list-config-ghost-surface-role='${role}']`,
  )[0] ?? null) as HTMLDivElement | null;
}

export function resolveGhostTorphTextMetricStylePatch(
  sourceStyle: Pick<CSSStyleDeclaration, "getPropertyValue">,
) {
  return Object.fromEntries(
    GHOST_TORPH_TEXT_METRIC_STYLE_PROPERTIES.map((property) => [
      property,
      sourceStyle.getPropertyValue(property),
    ]).filter(([, value]) => value.length > 0),
  );
}

function applyGhostInlineStylePatch(node: HTMLElement, stylePatch: Record<string, string>) {
  Object.entries(stylePatch).forEach(([property, value]) => {
    node.style.setProperty(property, value);
  });
}

type GhostSurfaceHostStyle = {
  display: string;
  height: string;
  minHeight: string;
  minWidth: string;
  overflow: string;
  pointerEvents: string;
  position: string;
  width: string;
};

function resolveGhostSurfaceHostStyle(frame: GhostFrame): GhostSurfaceHostStyle {
  const width = `${frame.width}px`;
  const height = `${frame.height}px`;

  return {
    display: "block",
    position: "relative",
    width,
    height,
    minWidth: width,
    minHeight: height,
    overflow: "visible",
    pointerEvents: "none",
  };
}

function applyGhostSurfaceHostStyle(node: HTMLElement, shellStyle: GhostSurfaceHostStyle) {
  node.style.display = shellStyle.display;
  node.style.position = shellStyle.position;
  node.style.width = shellStyle.width;
  node.style.height = shellStyle.height;
  node.style.minWidth = shellStyle.minWidth;
  node.style.minHeight = shellStyle.minHeight;
  node.style.overflow = shellStyle.overflow;
  node.style.pointerEvents = shellStyle.pointerEvents;
}

type GhostBoxShellStyle = {
  display: string;
  height: string;
  minHeight: string;
  minWidth: string;
  position: string;
  width: string;
};

function resolveGhostFixedDimension(value: string, fallback: number) {
  const parsedValue = Number.parseFloat(value);

  if (Number.isFinite(parsedValue) && parsedValue > 0) {
    return `${parsedValue}px`;
  }

  return `${fallback}px`;
}

function resolveGhostBoxShellStyle(node: HTMLElement): GhostBoxShellStyle {
  const style = resolveGhostComputedStyle(node);
  const rect = node.getBoundingClientRect();
  const width = resolveGhostFixedDimension(style.width, rect.width || node.offsetWidth);
  const height = resolveGhostFixedDimension(style.height, rect.height || node.offsetHeight);

  return {
    display: style.display,
    position: style.position,
    width,
    height,
    minWidth: width,
    minHeight: height,
  };
}

function applyGhostBoxShellStyle(node: HTMLElement, shellStyle: GhostBoxShellStyle) {
  node.style.display = shellStyle.display;
  node.style.position = shellStyle.position;
  node.style.width = shellStyle.width;
  node.style.height = shellStyle.height;
  node.style.minWidth = shellStyle.minWidth;
  node.style.minHeight = shellStyle.minHeight;
}

function normalizeGhostTorphFlowShell(
  node: HTMLElement,
  sourceNode: HTMLElement,
  textMetricStylePatch: Record<string, string>,
) {
  node.style.visibility = "visible";
  node.style.pointerEvents = "none";
  applyGhostBoxShellStyle(node, resolveGhostBoxShellStyle(sourceNode));
  applyGhostInlineStylePatch(node, textMetricStylePatch);
}

function normalizeGhostTorphOverlay(
  sourceRootNode: HTMLElement,
  rootNode: HTMLElement,
  node: HTMLElement,
  textMetricStylePatch: Record<string, string>,
) {
  applyGhostBoxShellStyle(rootNode, resolveGhostBoxShellStyle(sourceRootNode));
  rootNode.style.pointerEvents = "none";
  applyGhostInlineStylePatch(rootNode, textMetricStylePatch);
  node.style.position = "absolute";
  node.style.left = "0";
  node.style.top = "0";
  node.style.width = "100%";
  node.style.height = "100%";
  node.style.visibility = "visible";
  node.style.pointerEvents = "none";
}

export function simplifyGhostCloneContentTree(args: {
  cloneNode: HTMLDivElement;
  sourceNode: HTMLDivElement;
}) {
  const sourceRoots = resolveGhostTorphRoots(args.sourceNode);
  const cloneRoots = resolveGhostTorphRoots(args.cloneNode);

  cloneRoots.forEach((cloneRoot, index) => {
    const sourceRoot = sourceRoots[index];
    const sourceFlowShell = sourceRoot ? resolveGhostTorphFlowShell(sourceRoot) : null;
    const cloneFlowShell = resolveGhostTorphFlowShell(cloneRoot);
    const sourceOverlay = sourceRoot ? resolveGhostTorphOverlay(sourceRoot) : null;
    const cloneOverlay = resolveGhostTorphOverlay(cloneRoot);

    if (!sourceFlowShell) {
      return;
    }

    const sourceFlowShellStyle = resolveGhostComputedStyle(sourceFlowShell);
    const flowShellTextMetricStylePatch =
      resolveGhostTorphTextMetricStylePatch(sourceFlowShellStyle);

    if (sourceOverlay && cloneOverlay) {
      normalizeGhostTorphOverlay(
        sourceRoot,
        cloneRoot,
        cloneOverlay,
        flowShellTextMetricStylePatch,
      );
      cloneRoot.replaceChildren(cloneOverlay);
      cloneRoot.dataset.listConfigGhostTorphSanitized = "true";
      cloneRoot.dataset.listConfigGhostTorphVisibleLayer = TORPH_OVERLAY_DEBUG_ROLE;
      return;
    }

    if (!cloneFlowShell) {
      return;
    }

    const sanitizedFlowShell = cloneFlowShell.cloneNode(true) as HTMLElement;
    normalizeGhostTorphFlowShell(
      sanitizedFlowShell,
      sourceFlowShell,
      flowShellTextMetricStylePatch,
    );
    cloneRoot.replaceChildren(sanitizedFlowShell);
    cloneRoot.dataset.listConfigGhostTorphSanitized = "true";
    cloneRoot.dataset.listConfigGhostTorphVisibleLayer = TORPH_FLOW_SHELL_DEBUG_ROLE;
  });
}

export function resolveGhostCloneContentDisplay(display: string) {
  switch (display.trim()) {
    case "inline":
      return "block";
    case "inline-block":
      return "block";
    case "inline-flex":
      return "flex";
    case "inline-grid":
      return "grid";
    case "inline-table":
      return "table";
    default:
      return display;
  }
}

export function mergeGhostClipInsets(...clipInsetsList: GhostClipInsets[]) {
  return clipInsetsList.reduce<GhostClipInsets>(
    (mergedInsets, insets) => ({
      top: Math.max(mergedInsets.top, insets.top),
      right: Math.max(mergedInsets.right, insets.right),
      bottom: Math.max(mergedInsets.bottom, insets.bottom),
      left: Math.max(mergedInsets.left, insets.left),
    }),
    {
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    },
  );
}

function clampGhostInset(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(value, 0);
}

export function resolveGhostClipInsets(args: {
  frame: GhostFrame;
  lineHeight: string;
  visualRect: Pick<DOMRectReadOnly, "height" | "left" | "top" | "width">;
}) {
  const frameRight = args.frame.left + args.frame.width;
  const frameBottom = args.frame.top + args.frame.height;
  const visualRight = args.visualRect.left + args.visualRect.width;
  const visualBottom = args.visualRect.top + args.visualRect.height;
  const parsedLineHeight = Number.parseFloat(args.lineHeight);
  const lineHeightBleed =
    Number.isFinite(parsedLineHeight) && parsedLineHeight > args.frame.height
      ? (parsedLineHeight - args.frame.height) / 2
      : 0;

  return {
    top: Math.max(
      clampGhostInset(args.frame.top - args.visualRect.top),
      lineHeightBleed,
      GHOST_MIN_CLIP_PADDING,
    ),
    right: Math.max(clampGhostInset(visualRight - frameRight), GHOST_MIN_CLIP_PADDING),
    bottom: Math.max(
      clampGhostInset(visualBottom - frameBottom),
      lineHeightBleed,
      GHOST_MIN_CLIP_PADDING,
    ),
    left: Math.max(clampGhostInset(args.frame.left - args.visualRect.left), GHOST_MIN_CLIP_PADDING),
  } satisfies GhostClipInsets;
}

export function resolveGhostPaintFrame(args: { frame: GhostFrame; insets: GhostClipInsets }) {
  return {
    left: args.frame.left - args.insets.left,
    top: args.frame.top - args.insets.top,
    width: args.frame.width + args.insets.left + args.insets.right,
    height: args.frame.height + args.insets.top + args.insets.bottom,
  } satisfies GhostFrame;
}

export function applyGhostPaintBox(args: {
  cloneContentNode: HTMLDivElement;
  cloneNode: HTMLDivElement;
  frame: GhostFrame;
  insets: GhostClipInsets;
}) {
  const paintFrame = resolveGhostPaintFrame({
    frame: args.frame,
    insets: args.insets,
  });

  args.cloneNode.style.left = `${paintFrame.left}px`;
  args.cloneNode.style.top = `${paintFrame.top}px`;
  args.cloneNode.style.width = `${paintFrame.width}px`;
  args.cloneNode.style.height = `${paintFrame.height}px`;
  args.cloneNode.style.overflow = "visible";
  args.cloneNode.style.transformOrigin = formatGhostTransformOrigin({
    x: args.insets.left,
    y: args.insets.top,
  });
  args.cloneNode.style.clipPath = "";

  args.cloneContentNode.style.position = "absolute";
  args.cloneContentNode.style.left = `${args.insets.left}px`;
  args.cloneContentNode.style.top = `${args.insets.top}px`;
  args.cloneContentNode.style.width = `${args.frame.width}px`;
  args.cloneContentNode.style.height = `${args.frame.height}px`;
}

export function hideGhostTarget(node: HTMLDivElement | null) {
  if (!node) {
    return;
  }

  node.style.opacity = "0";
}

export function showGhostTarget(node: HTMLDivElement | null) {
  if (!node) {
    return;
  }

  node.style.opacity = "";
}

export function resolveGhostNodePose(node: HTMLDivElement): GhostNodePose {
  const sourceRect = node.getBoundingClientRect();
  const sourceStyle = resolveGhostComputedStyle(node);
  const resolvedWidth =
    Number.parseFloat(sourceStyle.width) || node.offsetWidth || sourceRect.width;
  const resolvedHeight =
    Number.parseFloat(sourceStyle.height) || node.offsetHeight || sourceRect.height;
  const transformOrigin = resolveGhostOriginFromTransformOrigin(sourceStyle.transformOrigin);

  return {
    angle: resolveGhostAngleFromTransform(sourceStyle.transform),
    frame: resolveGhostCloneFrame({
      sourceRect: {
        left: sourceRect.left,
        top: sourceRect.top,
        width: sourceRect.width,
        height: sourceRect.height,
      },
      width: resolvedWidth,
      height: resolvedHeight,
      transform: sourceStyle.transform,
      transformOrigin: sourceStyle.transformOrigin,
    }),
    transformOrigin,
  };
}

export function resolveGhostNodeClipInsets(node: HTMLDivElement, pose?: GhostNodePose) {
  const visualRect = node.getBoundingClientRect();
  const sourceStyle = resolveGhostComputedStyle(node);

  return resolveGhostClipInsets({
    frame: (pose ?? resolveGhostNodePose(node)).frame,
    lineHeight: sourceStyle.lineHeight,
    visualRect: {
      left: visualRect.left,
      top: visualRect.top,
      width: visualRect.width,
      height: visualRect.height,
    },
  });
}

export function createGhostClone(sourceNode: HTMLDivElement): GhostClone {
  const {
    angle: sourceAngle,
    frame: sourceFrame,
    transformOrigin: sourceTransformOrigin,
  } = resolveGhostNodePose(sourceNode);
  const { cloneContentNode, sourceStyle } = createGhostCloneContentNode({
    angle: sourceAngle,
    sourceNode,
    sourceFrame,
    transformOrigin: sourceTransformOrigin,
  });
  const cloneNode = sourceNode.ownerDocument.createElement("div");
  const sourceClipInsets = resolveGhostNodeClipInsets(sourceNode, {
    angle: sourceAngle,
    frame: sourceFrame,
    transformOrigin: sourceTransformOrigin,
  });

  cloneNode.style.position = "fixed";
  cloneNode.style.margin = "0";
  cloneNode.style.pointerEvents = "none";
  cloneNode.style.zIndex = `${LIST_CONFIG_GHOST_Z_INDEX}`;
  cloneNode.style.willChange = "transform";
  cloneNode.style.opacity = sourceStyle.opacity;
  cloneNode.dataset.listConfigGhostClone = "true";
  cloneNode.style.boxSizing = "border-box";

  applyGhostPaintBox({
    cloneContentNode,
    cloneNode,
    frame: sourceFrame,
    insets: sourceClipInsets,
  });

  cloneNode.appendChild(cloneContentNode);
  sourceNode.ownerDocument.body.appendChild(cloneNode);

  return {
    cloneContentNode,
    cloneNode,
    sourceAngle,
    sourceClipInsets,
    sourceFrame,
    sourceTransformOrigin,
  };
}

function createGhostCloneContentNode(args: {
  angle: number;
  sourceNode: HTMLDivElement;
  sourceFrame: GhostFrame;
  transformOrigin: GhostPoint;
}) {
  const cloneContentNode = args.sourceNode.cloneNode(true) as HTMLDivElement;
  const sourceStyle = resolveGhostComputedStyle(args.sourceNode);

  cloneContentNode
    .querySelectorAll<HTMLElement>("[data-tool-label-overlay='true']")
    .forEach((node) => {
      node.remove();
    });
  simplifyGhostCloneContentTree({
    cloneNode: cloneContentNode,
    sourceNode: args.sourceNode,
  });
  stabilizeGhostCloneSourceSurface({
    cloneNode: cloneContentNode,
    frame: args.sourceFrame,
  });

  cloneContentNode.style.margin = "0";
  cloneContentNode.style.boxSizing = sourceStyle.boxSizing;
  // The ghost clone no longer lives in inline text flow, so keeping an
  // inline display would reintroduce baseline layout and make the final
  // handoff jump even when the outer frame is already correct.
  cloneContentNode.style.display = resolveGhostCloneContentDisplay(sourceStyle.display);
  cloneContentNode.style.whiteSpace = sourceStyle.whiteSpace;
  cloneContentNode.style.overflowWrap = sourceStyle.overflowWrap;
  cloneContentNode.style.wordBreak = sourceStyle.wordBreak;
  cloneContentNode.style.lineHeight = sourceStyle.lineHeight;
  cloneContentNode.style.transformOrigin = formatGhostTransformOrigin(args.transformOrigin);
  cloneContentNode.style.transform = `rotate(${args.angle}deg)`;
  cloneContentNode.style.willChange = "transform";
  cloneContentNode.dataset.listConfigGhostCloneContent = "true";

  return {
    cloneContentNode,
    sourceStyle,
  };
}

type GhostCloneTextContainerShellStyle = {
  display: string;
  height: string;
  left: string;
  minHeight: string;
  minWidth: string;
  position: string;
  top: string;
  transform: string;
  transformOrigin: string;
  willChange: string;
  width: string;
};

function resolveGhostCloneTextSurfaceLayerStyle(
  node: HTMLDivElement,
): GhostCloneTextContainerShellStyle {
  return {
    display: resolveGhostComputedStyle(node).display,
    position: "absolute",
    left: "0",
    top: "0",
    width: "100%",
    height: "100%",
    minWidth: "100%",
    minHeight: "100%",
    transform: "",
    transformOrigin: "",
    willChange: "",
  };
}

function applyGhostCloneTextSurfaceLayerStyle(
  node: HTMLDivElement,
  shellStyle: GhostCloneTextContainerShellStyle,
) {
  node.style.display = shellStyle.display;
  node.style.position = shellStyle.position;
  node.style.left = shellStyle.left;
  node.style.top = shellStyle.top;
  node.style.width = shellStyle.width;
  node.style.height = shellStyle.height;
  node.style.minWidth = shellStyle.minWidth;
  node.style.minHeight = shellStyle.minHeight;
  node.style.transform = shellStyle.transform;
  node.style.transformOrigin = shellStyle.transformOrigin;
  node.style.willChange = shellStyle.willChange;
}

function stabilizeGhostCloneSourceSurface(args: { cloneNode: ParentNode; frame: GhostFrame }) {
  const cloneTextContainer = resolveGhostToolLabelTextContainer(args.cloneNode);

  if (!cloneTextContainer) {
    return false;
  }

  const cloneTextContainerParent = cloneTextContainer.parentNode;

  if (!isGhostHtmlElement(cloneTextContainerParent)) {
    return false;
  }

  const surfaceHost = cloneTextContainer.ownerDocument.createElement("div");

  surfaceHost.dataset.listConfigGhostSurfaceHost = GHOST_SURFACE_HOST_DEBUG_ROLE;
  applyGhostSurfaceHostStyle(surfaceHost, resolveGhostSurfaceHostStyle(args.frame));
  cloneTextContainer.dataset.listConfigGhostSurfaceRole = "source";
  cloneTextContainer.style.opacity = "1";
  applyGhostCloneTextSurfaceLayerStyle(
    cloneTextContainer,
    resolveGhostCloneTextSurfaceLayerStyle(cloneTextContainer),
  );
  cloneTextContainerParent.replaceChild(surfaceHost, cloneTextContainer);
  surfaceHost.replaceChildren(cloneTextContainer);

  return true;
}

function createGhostSurfaceLayer(args: {
  initialOpacity: string;
  role: GhostSurfaceLayerRole;
  sourceNode: HTMLDivElement;
}) {
  const sourceTextContainer = resolveGhostToolLabelTextContainer(args.sourceNode);

  if (!sourceTextContainer) {
    return null;
  }

  const surfaceLayer = sourceTextContainer.cloneNode(true) as HTMLDivElement;
  simplifyGhostCloneContentTree({
    cloneNode: surfaceLayer,
    sourceNode: sourceTextContainer,
  });
  surfaceLayer.dataset.listConfigGhostSurfaceRole = args.role;
  surfaceLayer.style.opacity = args.initialOpacity;
  applyGhostCloneTextSurfaceLayerStyle(
    surfaceLayer,
    resolveGhostCloneTextSurfaceLayerStyle(sourceTextContainer),
  );

  return surfaceLayer;
}

function clampGhostSurfaceTransitionProgress(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function smoothstepGhostSurfaceTransition(progress: number) {
  const clampedProgress = clampGhostSurfaceTransitionProgress(progress, 0, 1);

  return clampedProgress * clampedProgress * (3 - 2 * clampedProgress);
}

function resolveGhostSurfaceTransitionPhaseProgress(args: {
  end: number;
  progress: number;
  start: number;
}) {
  if (args.end <= args.start) {
    return args.progress >= args.end ? 1 : 0;
  }

  return smoothstepGhostSurfaceTransition((args.progress - args.start) / (args.end - args.start));
}

export function resolveGhostSurfaceTransitionOpacities(args: {
  progress: number;
  targetOpacityScale?: number;
}) {
  const progress = clampGhostSurfaceTransitionProgress(args.progress, 0, 1);
  const targetOpacityScale = Number.isFinite(args.targetOpacityScale)
    ? clampGhostSurfaceTransitionProgress(args.targetOpacityScale!, 0, 1)
    : 1;
  const cloneTargetRevealProgress = resolveGhostSurfaceTransitionPhaseProgress({
    progress,
    start: GHOST_SURFACE_SOURCE_HANDOFF_START_PROGRESS,
    end: GHOST_SURFACE_SOURCE_HANDOFF_END_PROGRESS,
  });
  const liveTargetRevealProgress = resolveGhostSurfaceTransitionPhaseProgress({
    progress,
    start: GHOST_SURFACE_LIVE_HANDOFF_START_PROGRESS,
    end: GHOST_SURFACE_LIVE_HANDOFF_END_PROGRESS,
  });

  return {
    progress,
    sourceOpacity: 1 - cloneTargetRevealProgress,
    targetOpacity: cloneTargetRevealProgress * (1 - liveTargetRevealProgress),
    liveTargetOpacity: targetOpacityScale * liveTargetRevealProgress,
  };
}

function applyGhostSurfaceTransitionProgress(args: {
  hostNode: HTMLDivElement;
  targetNode: HTMLDivElement;
  targetOpacityScale: number;
  progress: number;
}) {
  const sourceSurface = resolveGhostSurfaceLayer(args.hostNode, "source");
  const targetSurface = resolveGhostSurfaceLayer(args.hostNode, "target");
  const transitionState = resolveGhostSurfaceTransitionOpacities({
    progress: args.progress,
    targetOpacityScale: args.targetOpacityScale,
  });

  if (sourceSurface) {
    sourceSurface.style.opacity = `${transitionState.sourceOpacity}`;
  }

  if (targetSurface) {
    targetSurface.style.opacity = `${transitionState.targetOpacity}`;
  }

  args.targetNode.style.opacity = `${transitionState.liveTargetOpacity}`;
}

export function createGhostSurfaceTransition(args: {
  cloneContentNode: HTMLDivElement;
  targetNode: HTMLDivElement;
}): GhostSurfaceTransitionController | null {
  const surfaceHost = resolveGhostSurfaceHost(args.cloneContentNode);

  if (!surfaceHost) {
    return null;
  }

  const sourceSurface = resolveGhostSurfaceLayer(surfaceHost, "source");

  if (!sourceSurface) {
    return null;
  }

  const existingTargetSurface = resolveGhostSurfaceLayer(surfaceHost, "target");
  const targetSurface =
    existingTargetSurface ??
    createGhostSurfaceLayer({
      initialOpacity: "0",
      role: "target",
      sourceNode: args.targetNode,
    });

  if (!targetSurface) {
    return null;
  }

  if (!existingTargetSurface) {
    surfaceHost.replaceChildren(sourceSurface, targetSurface);
  }

  let currentProgress = 0;
  const targetInlineOpacity = args.targetNode.style.opacity;
  const targetComputedOpacity = Number.parseFloat(
    resolveGhostComputedStyle(args.targetNode).opacity,
  );
  const targetOpacityScale =
    Number.isFinite(targetComputedOpacity) && targetComputedOpacity >= 0
      ? targetComputedOpacity
      : 1;

  applyGhostSurfaceTransitionProgress({
    hostNode: surfaceHost,
    targetNode: args.targetNode,
    targetOpacityScale,
    progress: currentProgress,
  });

  return {
    releaseTarget() {
      args.targetNode.style.opacity = targetInlineOpacity;
    },
    sample() {
      return {
        hasTargetSurface: true,
        liveTargetOpacity: args.targetNode.style.opacity || null,
        progress: currentProgress,
        sourceOpacity: sourceSurface.style.opacity || null,
        targetOpacity: targetSurface.style.opacity || null,
      };
    },
    setProgress(progress: number) {
      currentProgress = Number.isFinite(progress)
        ? clampGhostSurfaceTransitionProgress(progress, 0, 1)
        : 0;
      applyGhostSurfaceTransitionProgress({
        hostNode: surfaceHost,
        targetNode: args.targetNode,
        targetOpacityScale,
        progress: currentProgress,
      });
    },
  };
}

export function applyGhostMotionState(args: {
  cloneContentNode: HTMLDivElement;
  cloneNode: HTMLDivElement;
  sourceFrame: GhostFrame;
  state: GhostMotionState;
}) {
  const translateX = args.state.left - args.sourceFrame.left;
  const translateY = args.state.top - args.sourceFrame.top;

  args.cloneNode.style.transform = `translate3d(${translateX}px, ${translateY}px, 0) scale(${args.state.scaleX}, ${args.state.scaleY})`;
  args.cloneContentNode.style.transformOrigin = formatGhostTransformOrigin(
    args.state.transformOrigin,
  );
  args.cloneContentNode.style.transform = `rotate(${args.state.angle}deg)`;
}
