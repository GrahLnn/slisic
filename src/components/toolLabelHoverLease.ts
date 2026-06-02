export type ToolLabelPointerPosition = {
  clientX: number;
  clientY: number;
};

export type ToolLabelHoverLease =
  | {
      kind: "open";
      source: "target" | "overlay" | "geometry";
    }
  | {
      kind: "closed";
      reason:
        | "disabled"
        | "layout"
        | "missing-tool"
        | "missing-pointer"
        | "missing-target"
        | "dismissed"
        | "outside";
    };

export type ToolLabelHoverProbeElement = {
  ownerDocument: {
    elementsFromPoint: (clientX: number, clientY: number) => Element[];
  };
  contains: (target: Element) => boolean;
  getBoundingClientRect: () => DOMRect | DOMRectReadOnly;
};

export const closedToolLabelHoverLease = {
  kind: "closed",
  reason: "outside",
} satisfies ToolLabelHoverLease;

export function resolveToolLabelOverlayVisibility(args: {
  lease: ToolLabelHoverLease;
  hasTool: boolean;
  interactionDisabled: boolean;
}) {
  return args.lease.kind === "open" && args.hasTool && !args.interactionDisabled;
}

function isElementInside(container: ToolLabelHoverProbeElement, element: Element) {
  return element === container || container.contains(element);
}

function isPointInsideRect(point: ToolLabelPointerPosition, rect: DOMRect | DOMRectReadOnly) {
  return (
    point.clientX >= rect.left &&
    point.clientX <= rect.right &&
    point.clientY >= rect.top &&
    point.clientY <= rect.bottom
  );
}

export function resolveToolLabelHoverLeaseFromPointerProbe(args: {
  interactionDisabled: boolean;
  hasTool: boolean;
  pointerPosition: ToolLabelPointerPosition | null;
  hoverTarget: ToolLabelHoverProbeElement | null;
  overlay: ToolLabelHoverProbeElement | null;
}): ToolLabelHoverLease {
  if (args.interactionDisabled) {
    return {
      kind: "closed",
      reason: "disabled",
    };
  }

  if (!args.hasTool) {
    return {
      kind: "closed",
      reason: "missing-tool",
    };
  }

  if (!args.pointerPosition) {
    return {
      kind: "closed",
      reason: "missing-pointer",
    };
  }

  if (!args.hoverTarget) {
    return {
      kind: "closed",
      reason: "missing-target",
    };
  }

  const hoverTarget = args.hoverTarget;
  const overlay = args.overlay;
  const { clientX, clientY } = args.pointerPosition;
  const hitElements = hoverTarget.ownerDocument.elementsFromPoint(clientX, clientY);

  if (overlay && hitElements.some((element) => isElementInside(overlay, element))) {
    return {
      kind: "open",
      source: "overlay",
    };
  }

  if (hitElements.some((element) => isElementInside(hoverTarget, element))) {
    return {
      kind: "open",
      source: "target",
    };
  }

  if (isPointInsideRect(args.pointerPosition, hoverTarget.getBoundingClientRect())) {
    return {
      kind: "open",
      source: "geometry",
    };
  }

  return {
    kind: "closed",
    reason: "outside",
  };
}
