import { type GhostFrame, resolveGhostAngleFromTransform, resolveGhostCloneFrame } from "./ListConfig.ghost-geometry";
import { type GhostMotionState } from "./ListConfig.ghost-motion";

export type GhostClone = {
  cloneContentNode: HTMLDivElement;
  cloneNode: HTMLDivElement;
  sourceAngle: number;
  sourceFrame: GhostFrame;
};

const LIST_CONFIG_GHOST_Z_INDEX = 180;

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

export function createGhostClone(sourceNode: HTMLDivElement): GhostClone {
  const sourceRect = sourceNode.getBoundingClientRect();
  const cloneContentNode = sourceNode.cloneNode(true) as HTMLDivElement;
  const cloneNode = sourceNode.ownerDocument.createElement("div");
  const sourceStyle = window.getComputedStyle(sourceNode);
  const resolvedWidth = Number.parseFloat(sourceStyle.width) || sourceNode.offsetWidth;
  const resolvedHeight = Number.parseFloat(sourceStyle.height) || sourceNode.offsetHeight;
  const sourceFrame = resolveGhostCloneFrame({
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
  });
  const sourceAngle = resolveGhostAngleFromTransform(sourceStyle.transform);

  cloneContentNode
    .querySelectorAll<HTMLElement>("[data-tool-label-overlay='true']")
    .forEach((node) => {
      node.remove();
    });

  cloneNode.style.position = "fixed";
  cloneNode.style.left = `${sourceFrame.left}px`;
  cloneNode.style.top = `${sourceFrame.top}px`;
  cloneNode.style.width = `${sourceFrame.width}px`;
  cloneNode.style.height = `${sourceFrame.height}px`;
  cloneNode.style.margin = "0";
  cloneNode.style.pointerEvents = "none";
  cloneNode.style.zIndex = `${LIST_CONFIG_GHOST_Z_INDEX}`;
  cloneNode.style.transformOrigin = "top left";
  cloneNode.style.willChange = "transform";
  cloneNode.style.opacity = sourceStyle.opacity;
  cloneNode.dataset.listConfigGhostClone = "true";

  cloneContentNode.style.width = "100%";
  cloneContentNode.style.height = "100%";
  cloneContentNode.style.margin = "0";
  cloneContentNode.style.boxSizing = sourceStyle.boxSizing;
  cloneContentNode.style.whiteSpace = sourceStyle.whiteSpace;
  cloneContentNode.style.overflowWrap = sourceStyle.overflowWrap;
  cloneContentNode.style.wordBreak = sourceStyle.wordBreak;
  cloneContentNode.style.lineHeight = sourceStyle.lineHeight;
  cloneContentNode.style.transformOrigin = sourceStyle.transformOrigin;
  cloneContentNode.style.transform = `rotate(${sourceAngle}deg)`;
  cloneContentNode.style.willChange = "transform";
  cloneContentNode.dataset.listConfigGhostCloneContent = "true";

  cloneNode.appendChild(cloneContentNode);
  sourceNode.ownerDocument.body.appendChild(cloneNode);

  return {
    cloneContentNode,
    cloneNode,
    sourceAngle,
    sourceFrame,
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
  args.cloneContentNode.style.transform = `rotate(${args.state.angle}deg)`;
}
