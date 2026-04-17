import { cn } from "@/lib/utils";
import { useLayoutEffect, useRef, type ComponentProps } from "react";
import { motion, useAnimate } from "motion/react";
import type { CollectionTitleTone } from "@/src/flow/appLogic/core";
import {
  collectionTitleColorTransition,
  useCollectionTitleColor,
} from "./collectionTitle";

type EditableTitleProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  interactionDisabled?: boolean;
  layoutId?: string;
  handoffTone?: CollectionTitleTone | null;
} & Omit<ComponentProps<"div">, "onChange">;

export function resolveEditableTitleDisplayValue(
  value: string,
  placeholder?: string,
) {
  if (value.length > 0) {
    return value;
  }

  return placeholder ?? "";
}

/**
 * The visible title layer keeps the exact display typography, while the
 * overlaid textarea preserves native text editing semantics. Keeping both
 * layers separate avoids fighting textarea rendering quirks just to reproduce
 * the title's visual treatment.
 */
export function EditableTitle({
  value,
  onChange,
  placeholder,
  autoFocus = false,
  interactionDisabled = false,
  layoutId,
  handoffTone = null,
  className,
  style,
  ...props
}: EditableTitleProps) {
  const displayValue = resolveEditableTitleDisplayValue(value, placeholder);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const targetTone: CollectionTitleTone =
    value.length === 0 ? "muted" : "solid";
  const targetColor = useCollectionTitleColor(targetTone);
  const handoffColor = useCollectionTitleColor(handoffTone ?? targetTone);
  const [scope, animate] = useAnimate<HTMLDivElement>();

  useLayoutEffect(() => {
    const node = scope.current;
    if (!node) {
      return;
    }

    if (!handoffTone || handoffColor === targetColor) {
      node.style.color = targetColor;
      return;
    }

    node.style.color = handoffColor;

    let stopAnimation: (() => void) | undefined;
    const frame = requestAnimationFrame(() => {
      const controls = animate(
        node,
        { color: targetColor },
        collectionTitleColorTransition,
      );
      stopAnimation = () => {
        controls.stop();
      };
    });

    return () => {
      cancelAnimationFrame(frame);
      stopAnimation?.();
    };
  }, [animate, handoffColor, handoffTone, scope, targetColor]);

  useLayoutEffect(() => {
    if (!interactionDisabled) {
      return;
    }

    inputRef.current?.blur();
  }, [interactionDisabled]);

  return (
    <div {...props}>
      <motion.div
        layoutId={layoutId}
        className={cn("relative w-fit max-w-full", className)}
        style={style}
      >
        <div
          aria-hidden="true"
          ref={scope}
          className="pointer-events-none whitespace-pre-wrap wrap-break-word"
        >
          {displayValue}
        </div>
        <textarea
          ref={(node) => {
            inputRef.current = node;

            if (
              !node ||
              !autoFocus ||
              interactionDisabled ||
              node.dataset.autofocusReady === "true"
            ) {
              return;
            }

            node.dataset.autofocusReady = "true";
            queueMicrotask(() => {
              node.focus();
              const cursor = node.value.length;
              node.setSelectionRange(cursor, cursor);
            });
          }}
          aria-label="List title"
          rows={1}
          spellCheck={false}
          readOnly={interactionDisabled}
          tabIndex={interactionDisabled ? -1 : undefined}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={(event) => onChange(event.target.value.trim())}
          className={cn(
            "absolute inset-0 block h-full w-full resize-none overflow-hidden bg-transparent",
            interactionDisabled ? "pointer-events-none" : "pointer-events-auto",
            "whitespace-pre-wrap wrap-break-word text-transparent outline-none",
            "caret-[#090909] dark:caret-[#f6f6f6]",
          )}
          style={{
            font: "inherit",
            lineHeight: "inherit",
            letterSpacing: "inherit",
          }}
        />
      </motion.div>
    </div>
  );
}
