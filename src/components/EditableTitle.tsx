import { cn } from "@/lib/utils";
import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { motion } from "motion/react";
import type { CollectionTitleTone } from "@/src/flow/appLogic/core";
import {
  collectionTitleLayoutTransition,
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

export function resolveEditableTitleLayoutId(args: {
  layoutId?: string;
  interactionDisabled: boolean;
  isFocused: boolean;
  isAutoWriting: boolean;
}) {
  if (
    args.isFocused ||
    args.isAutoWriting ||
    !args.layoutId
  ) {
    return undefined;
  }

  return args.layoutId;
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function waitForNextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

const EDITABLE_TITLE_AUTOFOCUS_DELAY_MS =
  Math.round(collectionTitleLayoutTransition.duration * 1000) + 16;

export interface EditableTitleHandle {
  commitResolvedValue(args: { value: string; animateTyping: boolean }): Promise<void>;
  blur(): Promise<void>;
}

/**
 * The visible title layer keeps the exact display typography, while the
 * overlaid textarea preserves native text editing semantics. Keeping both
 * layers separate avoids fighting textarea rendering quirks just to reproduce
 * the title's visual treatment.
 */
export const EditableTitle = forwardRef<EditableTitleHandle, EditableTitleProps>(function EditableTitle({
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
}: EditableTitleProps, ref) {
  const displayValue = resolveEditableTitleDisplayValue(value, placeholder);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const titleRootRef = useRef<HTMLDivElement>(null);
  const autoWriteRunRef = useRef(0);
  const [isFocused, setIsFocused] = useState(false);
  const [isAutoWriting, setIsAutoWriting] = useState(false);
  const targetTone: CollectionTitleTone =
    value.length === 0 ? "muted" : "solid";
  const targetColor = useCollectionTitleColor(targetTone);
  const handoffColor = useCollectionTitleColor(handoffTone ?? targetTone);
  const resolvedLayoutId = resolveEditableTitleLayoutId({
    layoutId,
    interactionDisabled,
    isFocused,
    isAutoWriting,
  });
  const hasColorHandoff = Boolean(handoffTone && handoffColor !== targetColor);
  const layoutHostKey = layoutId ?? "__editable-title";

  useLayoutEffect(() => {
    if (!interactionDisabled) {
      return;
    }

    inputRef.current?.blur();
  }, [interactionDisabled]);

  useImperativeHandle(ref, () => ({
    async commitResolvedValue(args) {
      const node = inputRef.current;
      const runId = autoWriteRunRef.current + 1;
      autoWriteRunRef.current = runId;

      if (!node) {
        onChange(args.value);
        return;
      }

      if (!args.animateTyping) {
        onChange(args.value);
        node.focus();
        await waitForNextFrame();
        node.blur();
        await waitForNextFrame();
        return;
      }

      setIsAutoWriting(true);
      node.focus();
      node.setSelectionRange(0, 0);
      onChange("");
      await waitForNextFrame();

      for (let index = 0; index < args.value.length; index += 1) {
        if (autoWriteRunRef.current !== runId) {
          break;
        }

        onChange(args.value.slice(0, index + 1));
        await wait(22);
      }

      node.blur();
      await waitForNextFrame();
      if (autoWriteRunRef.current === runId) {
        setIsAutoWriting(false);
      }
    },
    async blur() {
      inputRef.current?.blur();
      await waitForNextFrame();
    },
  }), [onChange]);

  return (
    <div {...props}>
      <motion.div
        key={layoutHostKey}
        ref={titleRootRef}
        layoutId={resolvedLayoutId}
        className={cn("relative w-fit max-w-full", className)}
        style={style}
      >
        <motion.div
          aria-hidden="true"
          className="pointer-events-none whitespace-pre-wrap wrap-break-word"
          initial={false}
          animate={{ color: targetColor }}
          transition={hasColorHandoff ? collectionTitleColorTransition : { duration: 0 }}
          style={{ color: hasColorHandoff ? handoffColor : targetColor }}
        >
          {displayValue}
        </motion.div>
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
            window.setTimeout(() => {
              if (!node.isConnected || interactionDisabled) {
                return;
              }

              node.focus();
              const cursor = node.value.length;
              node.setSelectionRange(cursor, cursor);
            }, EDITABLE_TITLE_AUTOFOCUS_DELAY_MS);
          }}
          aria-label="List title"
          rows={1}
          spellCheck={false}
          readOnly={interactionDisabled || isAutoWriting}
          tabIndex={interactionDisabled || isAutoWriting ? -1 : undefined}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={(event) => onChange(event.target.value.trim())}
          onFocus={() => setIsFocused(true)}
          onBlurCapture={() => setIsFocused(false)}
          className={cn(
            "absolute inset-0 block h-full w-full resize-none overflow-hidden bg-transparent",
            interactionDisabled || isAutoWriting
              ? "pointer-events-none"
              : "pointer-events-auto",
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
});
