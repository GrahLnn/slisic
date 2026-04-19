import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

type ListConfigGhostTransition = {
  layoutId: string;
  cloneNode: HTMLDivElement;
};

const LIST_CONFIG_GHOST_Z_INDEX = 180;

function hideGhostTarget(node: HTMLDivElement | null) {
  if (!node) {
    return;
  }

  node.style.opacity = "0";
}

function showGhostTarget(node: HTMLDivElement | null) {
  if (!node) {
    return;
  }

  node.style.opacity = "";
}

function createGhostClone(sourceNode: HTMLDivElement) {
  const sourceRect = sourceNode.getBoundingClientRect();
  const cloneNode = sourceNode.cloneNode(true) as HTMLDivElement;
  const sourceStyle = window.getComputedStyle(sourceNode);

  cloneNode
    .querySelectorAll<HTMLElement>("[data-tool-label-overlay='true']")
    .forEach((node) => {
      node.remove();
    });

  cloneNode.style.position = "fixed";
  cloneNode.style.left = `${sourceRect.left}px`;
  cloneNode.style.top = `${sourceRect.top}px`;
  cloneNode.style.width = `${sourceRect.width}px`;
  cloneNode.style.height = `${sourceRect.height}px`;
  cloneNode.style.margin = "0";
  cloneNode.style.pointerEvents = "none";
  cloneNode.style.zIndex = `${LIST_CONFIG_GHOST_Z_INDEX}`;
  cloneNode.style.transform = sourceStyle.transform;
  cloneNode.style.transformOrigin = sourceStyle.transformOrigin;
  cloneNode.style.opacity = sourceStyle.opacity;

  sourceNode.ownerDocument.body.appendChild(cloneNode);

  return cloneNode;
}

export function useListConfigGhostTransition(targetIdsKey: string) {
  const [activeLayoutId, setActiveLayoutId] = useState<string | null>(null);
  const [dismissHoverSignal, setDismissHoverSignal] = useState(0);
  const ghostTransitionRef = useRef<ListConfigGhostTransition | null>(null);
  const targetRegistryRef = useRef<Map<string, HTMLDivElement>>(new Map());

  useLayoutEffect(() => {
    const ghostTransition = ghostTransitionRef.current;

    if (!activeLayoutId || !ghostTransition) {
      return;
    }

    const targetNode = targetRegistryRef.current.get(activeLayoutId);

    if (!targetNode) {
      return;
    }

    const targetRect = targetNode.getBoundingClientRect();
    hideGhostTarget(targetNode);

    const animation = ghostTransition.cloneNode.animate(
      [
        {
          left: ghostTransition.cloneNode.style.left,
          top: ghostTransition.cloneNode.style.top,
          width: ghostTransition.cloneNode.style.width,
          height: ghostTransition.cloneNode.style.height,
          transform: ghostTransition.cloneNode.style.transform || "none",
        },
        {
          left: `${targetRect.left}px`,
          top: `${targetRect.top}px`,
          width: `${targetRect.width}px`,
          height: `${targetRect.height}px`,
          transform: "none",
        },
      ],
      {
        duration: 360,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "forwards",
      },
    );

    animation.finished
      .catch(() => {})
      .finally(() => {
        showGhostTarget(targetNode);
        ghostTransition.cloneNode.remove();

        if (ghostTransitionRef.current?.layoutId === ghostTransition.layoutId) {
          ghostTransitionRef.current = null;
        }

        setActiveLayoutId((current) =>
          current === ghostTransition.layoutId ? null : current,
        );
      });

    return () => {
      animation.cancel();
      showGhostTarget(targetNode);
    };
  }, [activeLayoutId, targetIdsKey]);

  const registerTargetNode = useCallback(
    (layoutId: string, node: HTMLDivElement | null) => {
      const registry = targetRegistryRef.current;

      if (!node) {
        registry.delete(layoutId);
        return;
      }

      registry.set(layoutId, node);
    },
    [],
  );

  const startGhostTransition = useCallback(
    (args: { layoutId: string; sourceNode: HTMLDivElement | null }) => {
      ghostTransitionRef.current?.cloneNode.remove();
      ghostTransitionRef.current = null;

      if (!args.sourceNode) {
        return;
      }

      ghostTransitionRef.current = {
        layoutId: args.layoutId,
        cloneNode: createGhostClone(args.sourceNode),
      };

      flushSync(() => {
        setDismissHoverSignal((current) => current + 1);
        setActiveLayoutId(args.layoutId);
      });
    },
    [],
  );

  return {
    activeLayoutId,
    dismissHoverSignal,
    isAnimating: activeLayoutId !== null,
    registerTargetNode,
    startGhostTransition,
  };
}
