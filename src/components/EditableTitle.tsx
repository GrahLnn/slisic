import { cn } from "@/lib/utils";
import { useRef, type ComponentProps } from "react";
import { motion } from "motion/react";

type EditableTitleProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  layoutId?: string;
} & Omit<ComponentProps<"div">, "onChange">;

/**
 * The visible title layer keeps the exact display typography, while the
 * overlaid textarea preserves native text editing semantics. Keeping both
 * layers separate avoids fighting textarea rendering quirks just to reproduce
 * the title's visual treatment.
 */
export function EditableTitle({
  value,
  onChange,
  placeholder = "Untitled List",
  autoFocus = false,
  layoutId,
  className,
  style,
  ...props
}: EditableTitleProps) {
  const displayValue = value.length > 0 ? value : placeholder;
  const inputRef = useRef<HTMLTextAreaElement>(null);

  return (
    <div {...props}>
      <motion.div
        layoutId={layoutId}
        className={cn("relative w-fit max-w-full", className)}
        style={style}
      >
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none whitespace-pre-wrap break-words",
            value.length === 0 && "opacity-40",
          )}
        >
          {displayValue}
        </div>
        <textarea
          ref={(node) => {
            inputRef.current = node;

            if (!node || !autoFocus || node.dataset.autofocusReady === "true") {
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
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={(event) => onChange(event.target.value.trim())}
          className={cn(
            "pointer-events-auto absolute inset-0 block h-full w-full resize-none overflow-hidden bg-transparent",
            "whitespace-pre-wrap break-words text-transparent outline-none",
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
