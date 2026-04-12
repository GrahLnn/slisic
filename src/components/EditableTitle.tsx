import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";

type EditableTitleProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
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
  className,
  style,
  ...props
}: EditableTitleProps) {
  const displayValue = value.length > 0 ? value : placeholder;

  return (
    <div
      className={cn("relative inline-grid max-w-full align-top", className)}
      style={style}
      {...props}
    >
      <div
        aria-hidden="true"
        className={cn(
          "col-start-1 row-start-1 whitespace-pre-wrap break-words",
          value.length === 0 && "opacity-40",
        )}
      >
        {displayValue}
      </div>
      <textarea
        aria-label="List title"
        rows={1}
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={(event) => onChange(event.target.value.trim())}
        className={cn(
          "col-start-1 row-start-1 block h-full w-full resize-none overflow-hidden bg-transparent",
          "whitespace-pre-wrap break-words text-transparent outline-none",
          "caret-[#090909] dark:caret-[#f6f6f6]",
        )}
        style={{
          font: "inherit",
          lineHeight: "inherit",
          letterSpacing: "inherit",
        }}
      />
    </div>
  );
}
