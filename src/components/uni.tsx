import { cn } from "@/lib/utils";
import { me } from "@grahlnn/fn";
import {
  icons,
  motionIcons,
  type IconProps,
  type MotionIconProps,
} from "@/src/assets/icons";
import { open } from "@tauri-apps/plugin-dialog";
import { AnimatePresence, motion, type AnimationProps } from "motion/react";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";

export function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <div
      className={cn([
        "flex items-center gap-2 cursor-pointer py-2 h-8",
        "text-[#525252] dark:text-[#d4d4d4] dark:hover:text-[#e5e5e5] hover:text-[#262626] transition duration-300",
      ])}
      onClick={onClick}
    >
      <icons.arrowLeft size={16} thick={2} />
      <div className=" whitespace-nowrap ">Back</div>
    </div>
  );
}

interface DataListProps {
  children: React.ReactNode;
  className?: string;
}

export function DataList({ children, className }: DataListProps) {
  return (
    <div
      className={cn([
        "flex flex-col gap-2 p-3 w-full",
        "overflow-hidden transition duration-300",
        "border-[#e5e5e5] dark:border-[#373737]",
        "bg-[#f7fafc] dark:bg-[#262626] opacity-80",
        className,
      ])}
    >
      {children}
    </div>
  );
}

interface PairEditProps {
  label: string;
  value: string;
  onChange?: (val: string) => void;
  explain?: string;
  multiLine?: boolean;
  warning?: string;
  check?: string[];
}

export function PairEdit({
  label,
  value,
  onChange,
  explain,
  multiLine = false,
  warning,
  check,
}: PairEditProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <div className="text-sm font-semibold text-[#262626] dark:text-[#d4d4d4] transition">
          {label}
        </div>
        <div
          className={cn([
            "text-xs transition",
            check?.map((c) => c.toLowerCase()).includes(value.toLowerCase())
              ? "text-[#df2837]"
              : "text-[#525252] dark:text-[#a3a3a3]",
          ])}
        >
          {check?.map((c) => c.toLowerCase()).includes(value.toLowerCase())
            ? warning
            : explain}
        </div>
      </div>
      {multiLine ? (
        <ItemEditContent content={value} onChange={onChange} />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            if (v.trim() !== "" || value.trim() !== "") {
              onChange?.(v);
            }
          }}
          onBlur={() => {
            const v = value.trim();
            onChange?.(v);
          }}
          className={cn([
            "text-sm text-[#262626] dark:text-[#d4d4d4] transition px-2 py-1",
            "bg-[#f1f5f9] dark:bg-[#171717] rounded-md border border-[#e5e5e5] dark:border-[#262626]",
            "focus:outline-none focus:ring-0",
            check?.map((c) => c.toLowerCase()).includes(value.toLowerCase()) &&
              "border-[#df2837] dark:border-[#df2837]",
          ])}
        />
      )}
    </div>
  );
}

export function Head({ title, explain }: { title: string; explain?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-sm font-semibold text-[#262626] dark:text-[#e5e5e5] transition">
        {title}
      </div>
      <div
        className={cn([
          "text-xs transition",
          "text-[#525252] dark:text-[#a3a3a3]",
        ])}
      >
        {explain}
      </div>
    </div>
  );
}

interface MultiFolderChooserProps {
  value: Array<{ k: string; v: string }>;
  warning?: string;
  check?: string[];
  onChoose?: (val: string | null) => void;
  ondelete?: (val: string) => void;
  enabled?: boolean;
}

export function MultiFolderChooser({
  value,
  check,
  onChoose,
  ondelete,
  enabled = true,
}: MultiFolderChooserProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-between items-center">
        {enabled ? (
          <>
            <Head
              title="Local Folder"
              explain="Select the folder that contains your music files."
            />
            <EntryToolButton
              label="Select"
              onClick={() => {
                onChoose &&
                  open({ directory: true }).then((path) => {
                    onChoose(typeof path === "string" ? path : null);
                  });
              }}
            />
          </>
        ) : (
          <Head
            title="Local Folder"
            explain="Audio analysis needs ffmpeg installed."
          />
        )}
      </div>
      {[...value].reverse().map((v) => {
        const verified = !check?.includes(v.k);
        return (
          <Pair
            key={v.k}
            label={v.k}
            value={verified ? v.v : "Already exists"}
            bantoggle
            on
            banTip="Delete"
            banfn={() => ondelete?.(v.k)}
            verified={verified}
          />
        );
      })}
    </div>
  );
}

type RightTool = { name: string; onClick?: () => void; inProgress?: boolean };

interface PairProps {
  label: string | React.ReactNode;
  value: string;
  bantoggle?: boolean;
  banTip?: string;
  on?: boolean;
  actionfn?: () => Promise<{ tap?: (fn: () => void) => unknown }>;
  banfn?: () => void;
  action?: (props: MotionIconProps | IconProps) => React.ReactNode;
  hide?: boolean;
  className?: string;
  verified?: boolean;
  anime?: boolean;
  rightButton?: Array<RightTool> | RightTool;
  allowEmptyValue?: boolean;
}

export function Pair({
  label,
  value,
  bantoggle,
  allowEmptyValue = false,
  banTip = "Disable",
  on,
  actionfn,
  banfn,
  action,
  hide = false,
  className,
  verified = true,
  anime = false,
  rightButton,
}: PairProps) {
  const [labelIsHover, setLabelIsHover] = useState(false);
  const [valueIsHover, setValueIsHover] = useState(false);
  const [valueIsCopied, setValueIsCopied] = useState(false);

  const colRight: RightTool[] = rightButton
    ? Array.isArray(rightButton)
      ? rightButton
      : [rightButton]
    : [];
  const anyBusy = colRight.some((v) => v.inProgress);

  return (
    <div className={cn(["flex items-center justify-between gap-8", className])}>
      <div
        className="relative"
        onMouseEnter={() => setLabelIsHover(true)}
        onMouseLeave={() => setLabelIsHover(false)}
      >
        <div
          className={cn([
            "text-xs text-[#525252] dark:text-[#d4d4d4] transition",
            on === false && "line-through",
          ])}
        >
          {label}
        </div>
        <AnimatePresence>
          {labelIsHover && bantoggle && (
            <div className="absolute -top-0.5 left-0 z-50">
              <div className="flex items-center">
                <motion.div
                  className="bg-[#f9f9f9] dark:bg-[#383838] rounded-md shadow px-1 py-0.5 border border-[#d4d4d4] dark:border-[#4a4a4a] cursor-pointer"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  onClick={banfn}
                >
                  <div className="flex items-center gap-0.5 whitespace-nowrap">
                    {on ? (
                      <icons.ban
                        size={12}
                        className="text-[#262626] dark:text-[#a3a3a3]"
                      />
                    ) : (
                      <icons.circleCheck3
                        size={12}
                        className="text-[#262626] dark:text-[#a3a3a3]"
                      />
                    )}
                    <div className="text-xs text-[#404040] dark:text-[#a3a3a3] transition">
                      {on ? banTip : "Enable"}
                    </div>
                  </div>
                </motion.div>
                <motion.div
                  className="w-6 py-0.5 mask-lor"
                  initial={{ backdropFilter: "blur(0px)" }}
                  animate={{
                    backdropFilter: "blur(1px)",
                  }}
                  exit={{
                    backdropFilter: "blur(0px)",
                  }}
                  transition={{ duration: 0.2 }}
                >
                  <div className="text-xs opacity-0">_</div>
                </motion.div>
              </div>
            </div>
          )}
        </AnimatePresence>
      </div>

      <div
        className="relative"
        onMouseEnter={() => setValueIsHover(true)}
        onMouseLeave={() => setValueIsHover(false)}
      >
        <motion.div
          className={cn(["flex items-center", action && "cursor-pointer"])}
          onClick={() => {
            actionfn?.().then((r) => {
              r.tap?.(() => {
                setValueIsCopied(true);
                setTimeout(() => setValueIsCopied(false), 1000);
              });
            });
          }}
        >
          <motion.div
            className={cn([
              "text-xs text-nowrap whitespace-nowrap max-w-md",
              (on || !bantoggle) && verified
                ? "text-[#404040] dark:text-[#d4d4d4]"
                : "text-[#525252] dark:text-[#8a8a8a]",
              !verified && "text-[#ef0202] dark:text-[#ff0000]",
            ])}
          >
            <AnimatePresence mode="wait" initial={false}>
              {me(!!value).match({
                true: () =>
                  me(hide && !valueIsHover).match({
                    true: () => (
                      <motion.div
                        key="hide"
                        initial={{ opacity: 0, filter: "blur(6px)" }}
                        animate={{ opacity: 1, filter: "blur(0px)" }}
                        exit={{ opacity: 0, filter: "blur(6px)" }}
                        transition={{ duration: 0.2 }}
                      >
                        {"•".repeat(value.length)}
                      </motion.div>
                    ),
                    false: () => (
                      <motion.div
                        key="show"
                        initial={{ opacity: 0, filter: "blur(10px)" }}
                        animate={{ opacity: 1, filter: "blur(0px)" }}
                        exit={{ opacity: 0, filter: "blur(6px)" }}
                        transition={{ duration: 0.2 }}
                        className={cn([
                          !hide && "truncate",
                          anime && verified && "animate-pulse",
                        ])}
                      >
                        {value}
                      </motion.div>
                    ),
                  }),
                false: () => !allowEmptyValue && <icons.minus size={12} />,
              })}
            </AnimatePresence>
            <AnimatePresence>
              {rightButton && verified && (
                <div className="absolute -top-0.5 right-0 z-50">
                  <div className="flex items-center">
                    {(valueIsHover || anyBusy) && (
                      <motion.div
                        className="w-6 py-0.5 mask-rol"
                        initial={{ backdropFilter: "blur(0px)" }}
                        animate={{
                          backdropFilter: "blur(1px)",
                        }}
                        exit={{
                          backdropFilter: "blur(0px)",
                        }}
                        transition={{ duration: 0.2 }}
                      >
                        <div className="text-xs opacity-0">_</div>
                      </motion.div>
                    )}
                    {colRight
                      .filter((v) => (anyBusy ? v.inProgress : valueIsHover))
                      .map((v, i) => (
                        <div key={v.name} className="contents">
                          {i > 0 && (
                            <div className="w-1 py-0.5 backdrop-blur-[1px]">
                              <div className="text-xs opacity-0">_</div>
                            </div>
                          )}
                          <motion.div
                            className={cn([
                              "bg-[#f9f9f9] dark:bg-[#383838] rounded-md shadow px-1 py-0.5 border border-[#d4d4d4] dark:border-[#4a4a4a]",
                              v.inProgress ? "cursor-wait" : "cursor-pointer",
                            ])}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            onClick={v.onClick}
                          >
                            <div className="flex items-center gap-0.5 whitespace-nowrap relative">
                              {v.inProgress && (
                                <div className="absolute left-0 top-0 flex items-center h-full">
                                  <div className="backdrop-blur-[1px] text-[#dbab0a] dark:text-[#dbab0a]">
                                    <motionIcons.live
                                      size={12}
                                      className="animate-spin [animation-duration:5s]"
                                      fillOpacity={0.9}
                                    />
                                  </div>
                                  <div className="w-6 h-full backdrop-blur-[1px] mask-lor" />
                                </div>
                              )}
                              <div className="text-xs text-[#404040] dark:text-[#a3a3a3] transition">
                                {v.name}
                              </div>
                            </div>
                          </motion.div>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </AnimatePresence>
          </motion.div>
          {action && (
            <AnimatePresence mode="wait" initial={false}>
              {(valueIsHover || valueIsCopied) && (
                <motion.div
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: "auto", opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <AnimatePresence mode="wait" initial={false}>
                    {valueIsCopied ? (
                      <motionIcons.check3
                        size={12}
                        initial={{ pathLength: 0 }}
                        animate={{ pathLength: 1 }}
                        exit={{ pathLength: 0 }}
                        transition={{ duration: 0.3 }}
                        className="ml-1 dark:text-[#22c55e] text-[#1c9c4b] transition"
                      />
                    ) : (
                      action({
                        size: 12,
                        initial: { pathLength: 0 },
                        animate: { pathLength: 1 },
                        exit: { pathLength: 0 },
                        transition: { duration: 0.3 } as AnimationProps["transition"],
                        className:
                          "text-[#262626] dark:text-[#a3a3a3] transition ml-1",
                      })
                    )}
                  </AnimatePresence>
                </motion.div>
              )}
            </AnimatePresence>
          )}
        </motion.div>
      </div>
    </div>
  );
}

type PairComboboxProps = {
  label: string;
  list: string[];
  onChoose: (val: string) => void;
  canAddNew?: boolean;
  onAddNew?: () => void;
  width?: string;
  height?: string;
};

type Option = { value: string; label: string };

function useOptions(list: string[]): Option[] {
  return useMemo(() => list.map((v) => ({ value: v, label: v })), [list]);
}

export function PairCombobox({
  label,
  list,
  onChoose,
  canAddNew = false,
  onAddNew,
  width = "240px",
  height = "320px",
}: PairComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(0);
  const options = useOptions(list);
  const rootRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const key = query.trim().toLowerCase();
    if (!key) return options;
    return options.filter((opt) =>
      `${opt.value} ${opt.label}`.toLowerCase().includes(key),
    );
  }, [options, query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setFocusedIndex(0);
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      const node = rootRef.current;
      if (!node) return;
      if (!(event.target instanceof Node)) return;
      if (!node.contains(event.target)) {
        setOpen(false);
      }
    };

    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (focusedIndex >= filtered.length) {
      setFocusedIndex(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, focusedIndex]);

  const selectOption = (value: string) => {
    onChoose(value);
    setOpen(false);
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        className={cn(
          "flex items-center justify-between w-fit gap-2 whitespace-nowrap",
          "rounded-md outline-none",
          "cursor-pointer transition duration-300 ease-in-out",
          "data-[size=default]:h-9 data-[size=sm]:h-8",
          "pl-2 pr-2.5 py-1",
          "text-xs text-[#525252] dark:text-[#e5e5e5] hover:text-[#262626] hover:dark:text-[#d4d4d4]",
          "hover:bg-[#e7eced] dark:hover:bg-[#383838]",
          open && "bg-[#f1f5f9] dark:bg-[#1a1a1b]",
        )}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className={cn([
              "absolute right-0 top-full z-[120] p-0 mx-2 mt-1",
              "shadow-lg rounded-md",
              "bg-popover/70 backdrop-filter backdrop-blur-[16px]",
            ])}
            style={{ width }}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
          >
            <div className="border-b border-[#d4d4d4]/60 dark:border-[#4a4a4a]/60 px-2 py-1">
              <input
                className="w-full bg-transparent text-xs text-[#404040] dark:text-[#d4d4d4] outline-none"
                placeholder="Search..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setFocusedIndex((i) =>
                      Math.min(i + 1, Math.max(filtered.length - 1, 0)),
                    );
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setFocusedIndex((i) => Math.max(i - 1, 0));
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();
                    const next = filtered[focusedIndex];
                    if (next) selectOption(next.value);
                  }
                }}
              />
            </div>
            <div
              className={cn(["hide-scrollbar overflow-auto"])}
              style={{ height, width: "100%" }}
            >
              {filtered.length === 0 ? (
                <div className="py-6 text-center text-sm select-none text-[#404040] dark:text-[#a3a3a3] transition">
                  No item found.
                </div>
              ) : (
                filtered.map((opt, index) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={cn([
                      "w-full truncate bg-transparent px-2 py-1.5 text-left text-sm transition",
                      index === focusedIndex
                        ? "bg-accent text-accent-foreground"
                        : "text-[#404040] hover:bg-accent/60 dark:text-[#d4d4d4]",
                    ])}
                    onMouseEnter={() => setFocusedIndex(index)}
                    onClick={() => selectOption(opt.value)}
                  >
                    <span className="flex-1 min-w-0 truncate">{opt.label}</span>
                  </button>
                ))
              )}
              {canAddNew && (
                <div className="sticky bottom-0 mt-1 border-t border-[#d4d4d4]/60 bg-[#f5f5f580] dark:border-[#4a4a4a]/60 dark:bg-[#171717cc]">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-2 py-1.5 text-sm text-[#404040] dark:text-[#d4d4d4]"
                    onClick={() => {
                      onAddNew?.();
                      setOpen(false);
                    }}
                  >
                    + Add New
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface EntryToolButtonProps {
  icon?: React.ReactNode;
  label: string;
  onClick?: () => void;
  className?: string;
}

export function EntryToolButton({
  icon,
  label,
  onClick,
  className,
}: EntryToolButtonProps) {
  const [hover, setHover] = useState(false);
  return (
    <div
      className={cn([
        "flex items-center gap-1 cursor-pointer transition duration-300 ease-in-out hover:bg-[#e7eced] dark:hover:bg-[#383838] rounded-md pl-2 pr-2.5 py-1",
        className,
      ])}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {icon}
      <div
        className={cn([
          "text-xs transition duration-300",
          hover
            ? "text-[#262626] dark:text-[#d4d4d4]"
            : "text-[#525252] dark:text-[#e5e5e5]",
        ])}
      >
        {label}
      </div>
    </div>
  );
}

export function ItemEditContent({
  content,
  onChange,
  className,
  holder,
  onBlur,
}: {
  content: string;
  onChange?: (val: string) => void;
  className?: string;
  holder?: string;
  onBlur?: () => void;
}) {
  const [value, setValue] = useState(content);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textAreaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const style = window.getComputedStyle(el);
    const borderTop = parseFloat(style.borderTopWidth);
    const borderBottom = parseFloat(style.borderBottomWidth);
    const newHeight = Math.ceil(el.scrollHeight) + borderTop + borderBottom;
    el.style.height = `${newHeight}px`;
  }, [value]);

  useEffect(() => {
    setValue(content);
  }, [content]);

  useEffect(() => {
    const resize = () => {
      const el = textAreaRef.current;
      if (!el) return;
      el.style.height = "auto";
      const style = window.getComputedStyle(el);
      const borderTop = parseFloat(style.borderTopWidth);
      const borderBottom = parseFloat(style.borderBottomWidth);
      const newHeight = Math.ceil(el.scrollHeight) + borderTop + borderBottom;
      el.style.height = `${newHeight}px`;
    };

    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  return (
    <textarea
      ref={textAreaRef}
      className={cn([
        "text-sm transition break-all resize-none",
        "bg-[#f1f5f9] dark:bg-[#171717] text-[#262626] dark:text-[#d4d4d4]",
        "px-2 py-1 rounded ",
        "border border-[#e5e5e5] dark:border-[#262626]",
        "outline-none transition duration-300 hide-scrollbar focus:outline-none focus:ring-0",
        className,
      ])}
      placeholder={holder}
      value={value}
      rows={1}
      onChange={(e) => {
        const v = e.target.value;
        if (v.trim() !== "" || value.trim() !== "") {
          setValue(v);
          onChange?.(v);
        }
      }}
      onBlur={onBlur}
    />
  );
}

export function EditHead({
  title,
  explain,
}: {
  title: string;
  explain: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[#171717] dark:text-[#f5f5f5] transition font-semibold text-lg">
        {title}
      </div>
      <div className="text-xs text-[#525252] dark:text-[#a3a3a3] transition">
        {explain}
      </div>
    </div>
  );
}

export function ListSeparator() {
  return (
    <motion.div
      className="h-4 ml-5 w-px bg-[#a3a3a3] dark:bg-[#373737] transition opacity-60 dark:opacity-100"
      initial={{
        height: 0,
      }}
      animate={{
        height: 16,
      }}
      transition={{
        duration: 0.3,
      }}
      exit={{
        height: 0,
      }}
    />
  );
}
