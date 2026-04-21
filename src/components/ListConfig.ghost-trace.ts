import {
  captureListConfigGhostFrames,
  recordListConfigGhostTrace,
  snapshotListConfigGhostElement,
} from "@/src/debug/listConfigGhostTrace";

export type GhostTransitionTraceNodes = {
  layoutId: string;
  cloneContentNode: HTMLDivElement;
  cloneNode: HTMLDivElement;
  sourceNode: HTMLDivElement;
  targetNode: HTMLDivElement | null;
};

function createGhostTransitionTracePayload(
  nodes: GhostTransitionTraceNodes,
): Record<string, unknown> {
  return {
    layoutId: nodes.layoutId,
    sourceNode: snapshotListConfigGhostElement(nodes.sourceNode),
    cloneNode: snapshotListConfigGhostElement(nodes.cloneNode),
    cloneContentNode: snapshotListConfigGhostElement(nodes.cloneContentNode),
    targetNode: snapshotListConfigGhostElement(nodes.targetNode),
  };
}

export function recordGhostTransitionTrace(
  event: string,
  nodes: GhostTransitionTraceNodes,
  payload: Record<string, unknown> = {},
) {
  recordListConfigGhostTrace(event, {
    ...createGhostTransitionTracePayload(nodes),
    ...payload,
  });
}

export function captureGhostTransitionFrames(args: {
  label: string;
  frames?: number;
  layoutId: string;
  cloneContentNode: HTMLDivElement;
  cloneNode: HTMLDivElement;
  sourceNode: HTMLDivElement;
  resolveTargetNode: () => HTMLDivElement | null;
  sampleMotion?: () => Record<string, unknown>;
}) {
  captureListConfigGhostFrames(args.label, {
    frames: args.frames,
    sample: () => ({
      ...createGhostTransitionTracePayload({
        layoutId: args.layoutId,
        sourceNode: args.sourceNode,
        cloneNode: args.cloneNode,
        cloneContentNode: args.cloneContentNode,
        targetNode: args.resolveTargetNode(),
      }),
      ...args.sampleMotion?.(),
    }),
  });
}
