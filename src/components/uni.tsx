import { cn } from "@/lib/utils";
import { useState, useRef, useEffect, memo } from "react";
import {
  IconProps,
  icons,
  motionIcons,
  type MotionIconProps,
} from "@/src/assets/icons";
import {
  motion,
  AnimatePresence,
  useAnimation,
  AnimationProps,
} from "motion/react";
import { me } from "@/lib/matchable";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import * as React from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Result } from "@/lib/result";

interface DataListProps {
  children: React.ReactNode;
  className?: string;
}

export function DataList({ children, className }: DataListProps) {
  return (
    <div
      className={cn([
        "flex flex-col gap-2 p-3 w-full",
        "overflow-hidden  transition duration-300",
        "border-[#e5e5e5] dark:border-[#171717]",
        "bg-[#f7fafc] dark:bg-[#0c0c0c]",
        ,
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

interface MultiFolderChooserProps {
  label: string;
  value: Array<{ k: string; v: string }>;
  explain?: string;
  warning?: string;
  check?: string[];
  onChoose?: (val: string | null) => void;
  ondelete?: (val: string) => void;
}

export function MultiFolderChooser({
  label,
  value,
  explain,
  onChoose,
  ondelete,
}: MultiFolderChooserProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-between items-center">
        <div className="flex flex-col gap-1">
          <div className="text-sm font-semibold text-[#262626] dark:text-[#d4d4d4] transition">
            {label}
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
        <EntryToolButton
          label="Select"
          onClick={() => {
            onChoose &&
              open({ directory: true }).then((path) => {
                onChoose(path);
              });
          }}
        />
      </div>
      {value.map((v) => (
        <Pair
          key={v.k}
          label={v.k}
          value={v.v}
          bantoggle
          on
          banTip="Delete"
          banfn={() => ondelete?.(v.k)}
          // action={motionIcons.duplicate2}
          // actionfn={async () => {
          //   return crab.copyToClipboard(note.value);
          // }}
        />
      ))}
    </div>
  );
}

interface PairProps {
  label: string | React.ReactNode;
  value: string;
  bantoggle?: boolean;
  banTip?: string;
  on?: boolean;
  actionfn?: () => Promise<Result<any, string>>;
  banfn?: () => void;
  action?: (props: MotionIconProps | IconProps) => React.ReactNode;
  hide?: boolean;
  className?: string;
  verified?: boolean;
  anime?: boolean;
}

export function Pair({
  label,
  value,
  bantoggle,
  banTip = "Disable",
  on,
  actionfn,
  banfn,
  action,
  hide = false,
  className,
  verified = true,
  anime = false,
}: PairProps) {
  const [labelIsHover, setLabelIsHover] = useState(false);
  const [valueIsHover, setValueIsHover] = useState(false);
  const [valueIsCopied, setValueIsCopied] = useState(false);

  return (
    <div className={cn(["flex items-center justify-between gap-8", className])}>
      <div
        className="relative"
        onMouseEnter={() => setLabelIsHover(true)}
        onMouseLeave={() => setLabelIsHover(false)}
      >
        <div
          className={cn([
            "text-xs text-[#525252] dark:text-[#a3a3a3] transition",
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
                  <div className="text-xs opacity-0">D</div>
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
              r.tap(() => {
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
                ? "text-[#404040] dark:text-[#a3a3a3]"
                : "text-[#525252] dark:text-[#8a8a8a]",
              !verified && "text-[#ef0202] dark:text-[#a92626]",
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
                          anime && "animate-pulse",
                        ])}
                      >
                        {value}
                      </motion.div>
                    ),
                  }),
                false: () => <icons.minus size={12} />,
              })}
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
                        transition: { duration: 0.3 },
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
  value?: string; // 选中值（受控）
  list: string[]; // 选项列表
  explain?: string;
  onChoose: (val: string) => void;
  canAddNew?: boolean;
  onAddNew?: () => void;
  width?: string; // 可选：触发器宽度
  height?: string; // 可选：下拉高度
};

type Option = { value: string; label: string };

function useOptions(list: string[]): Option[] {
  return React.useMemo(() => list.map((v) => ({ value: v, label: v })), [list]);
}

export function PairCombobox({
  label,
  value = "",
  list,
  explain,
  onChoose,
  canAddNew = false,
  onAddNew,
  width = "240px",
  height = "320px",
}: PairComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const options = useOptions(list);

  // ---- 内部虚拟化命令框（抽出来便于复用/测试） ----
  const VirtualizedCommand: React.FC<{
    height: string;
    options: Option[];
    placeholder: string;
    selectedOption: string;
    onSelectOption: (option: string) => void;
    canAddNew?: boolean;
    onAddNew?: () => void;
  }> = ({
    height,
    options,
    placeholder,
    selectedOption,
    onSelectOption,
    canAddNew,
    onAddNew,
  }) => {
    const [filteredOptions, setFilteredOptions] =
      React.useState<Option[]>(options);
    const [focusedIndex, setFocusedIndex] = React.useState(0);
    const [isKeyboardNavActive, setIsKeyboardNavActive] = React.useState(false);
    const parentRef = React.useRef<HTMLDivElement | null>(null);

    // 选项变化时同步过滤结果
    React.useEffect(() => setFilteredOptions(options), [options]);

    const virtualizer = useVirtualizer({
      count: filteredOptions.length,
      getScrollElement: () => parentRef.current,
      estimateSize: () => 36, // 单项高度，确保与样式一致
      overscan: 8,
    });

    const virtualOptions = virtualizer.getVirtualItems();

    const scrollToIndex = (index: number) => {
      virtualizer.scrollToIndex(index, { align: "center" });
    };

    const handleSearch = (search: string) => {
      setIsKeyboardNavActive(false);
      const key = (search ?? "").toLowerCase(); // 修复：避免 ?? []
      // 同时匹配 value 和 label
      setFilteredOptions(
        options.filter((opt) =>
          (opt.value + " " + opt.label).toLowerCase().includes(key)
        )
      );
      // 搜索后把焦点回到第一项
      setFocusedIndex(0);
      scrollToIndex(0);
    };

    const handleKeyDown = (event: React.KeyboardEvent) => {
      switch (event.key) {
        case "ArrowDown": {
          event.preventDefault();
          setIsKeyboardNavActive(true);
          setFocusedIndex((prev) => {
            const newIndex =
              prev === -1 ? 0 : Math.min(prev + 1, filteredOptions.length - 1);
            scrollToIndex(newIndex);
            return newIndex;
          });
          break;
        }
        case "ArrowUp": {
          event.preventDefault();
          setIsKeyboardNavActive(true);
          setFocusedIndex((prev) => {
            const newIndex =
              prev === -1 ? filteredOptions.length - 1 : Math.max(prev - 1, 0);
            scrollToIndex(newIndex);
            return newIndex;
          });
          break;
        }
        case "Enter": {
          event.preventDefault();
          if (filteredOptions[focusedIndex]) {
            onSelectOption(filteredOptions[focusedIndex].value);
          }
          break;
        }
        default:
          break;
      }
    };

    // 初选滚到可见
    React.useEffect(() => {
      if (!selectedOption) return;
      const idx = filteredOptions.findIndex((o) => o.value === selectedOption);
      if (idx >= 0) {
        setFocusedIndex(idx);
        virtualizer.scrollToIndex(idx, { align: "center" });
      }
    }, [selectedOption, filteredOptions, virtualizer]);

    return (
      <Command shouldFilter={false} onKeyDown={handleKeyDown}>
        <CommandInput onValueChange={handleSearch} placeholder={placeholder} />
        <CommandList
          ref={parentRef}
          className="hide-scrollbar"
          style={{ height, width: "100%", overflow: "auto" }}
          onMouseDown={() => setIsKeyboardNavActive(false)}
          onMouseMove={() => setIsKeyboardNavActive(false)}
        >
          <CommandEmpty>No item found.</CommandEmpty>
          <CommandGroup>
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: "100%",
                position: "relative",
              }}
            >
              {virtualOptions.map((v) => {
                const opt = filteredOptions[v.index];
                return (
                  <CommandItem
                    key={opt.value}
                    disabled={isKeyboardNavActive}
                    className={cn(
                      "absolute left-0 top-0 w-full bg-transparent",
                      focusedIndex === v.index &&
                        "bg-accent text-accent-foreground",
                      isKeyboardNavActive &&
                        focusedIndex !== v.index &&
                        "aria-selected:bg-transparent aria-selected:text-primary"
                    )}
                    style={{
                      height: `${v.size}px`,
                      transform: `translateY(${v.start}px)`,
                    }}
                    value={opt.value}
                    onMouseEnter={() =>
                      !isKeyboardNavActive && setFocusedIndex(v.index)
                    }
                    onMouseLeave={() =>
                      !isKeyboardNavActive && setFocusedIndex(-1)
                    }
                    onSelect={onSelectOption}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        selectedOption === opt.value
                          ? "opacity-100"
                          : "opacity-0"
                      )}
                    />
                    {opt.label}
                  </CommandItem>
                );
              })}
            </div>

            {canAddNew && (
              <div className="sticky bottom-0 mt-1 border-t bg-background">
                <CommandItem
                  value="__add_new__"
                  onSelect={() => onAddNew?.()}
                  className="flex items-center gap-2"
                >
                  <Plus className="h-4 w-4" />
                  Add New
                </CommandItem>
              </div>
            )}
          </CommandGroup>
        </CommandList>
      </Command>
    );
  };

  return (
    <div className="flex gap-8 items-center justify-between">
      <div className="flex flex-col gap-1">
        <div className="text-sm font-semibold text-[#262626] dark:text-[#d4d4d4] transition">
          {label}
        </div>
        {explain && (
          <div className="text-xs text-[#525252] dark:text-[#a3a3a3] transition">
            {explain}
          </div>
        )}
      </div>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            role="combobox"
            aria-expanded={open}
            ignorecn
            className={cn([
              "data-[placeholder]:text-muted-foreground [&_svg:not([class*='text-'])]:text-muted-foreground aria-invalid:border-destructive dark:hover:bg-input/50 flex w-fit items-center justify-between gap-2 whitespace-nowrap shadow-xs outline-none disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-9 data-[size=sm]:h-8 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 text-sm text-[#262626]/70 dark:text-[#d4d4d4]/70 transition px-2 py-1 bg-[#f1f5f9] dark:bg-[#171717] rounded-md border border-[#e5e5e5] dark:border-[#262626] data-[state=open]:bg-[#f1f5f9] dark:data-[state=open]:bg-[#1a1a1b]",
            ])}
          >
            {value || "Select..."}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>

        <PopoverContent className="p-0" style={{ width }}>
          <VirtualizedCommand
            height={height}
            options={options}
            placeholder="Search..."
            selectedOption={value}
            canAddNew={canAddNew}
            onAddNew={onAddNew}
            onSelectOption={(currentValue) => {
              onChoose(currentValue);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
interface PairChooseProps {
  label: string;
  value: string;
  list: string[];
  explain?: string;
  onChoose?: (val: string) => void;
  canAddNew?: boolean;
  onAddNew?: (val: string) => void;
}

export function PairChoose({
  label,
  value,
  list,
  explain,
  onChoose,
  canAddNew = false,
  onAddNew,
}: PairChooseProps) {
  return (
    <div className="flex gap-8 items-center justify-between">
      <div className="flex flex-col gap-1">
        <div className="text-sm font-semibold text-[#262626] dark:text-[#d4d4d4] transition ">
          {label}
        </div>
        <div className="text-xs text-[#525252] dark:text-[#a3a3a3] transition">
          {explain}
        </div>
      </div>

      <Select onValueChange={onChoose}>
        <SelectTrigger
          className={cn([
            "text-sm text-[#262626] dark:text-[#d4d4d4] transition px-2 py-1",
            "bg-[#f1f5f9] dark:bg-[#171717] rounded-md border border-[#e5e5e5] dark:border-[#262626]",
            "data-[state=open]:bg-[#f1f5f9] dark:data-[state=open]:bg-[#1a1a1b]",
          ])}
        >
          <SelectValue placeholder={value} />
        </SelectTrigger>
        <SelectContent className="max-h-64">
          {list.map((l) => (
            <SelectItem key={l} value={l}>
              {l}
            </SelectItem>
          ))}
          {canAddNew && <InputItem label="Add New" onCheck={onAddNew} />}
        </SelectContent>
      </Select>
    </div>
  );
}
interface PairEditLRProps {
  label: string;
  value: string;
  onChange?: (val: string) => void;
  explain?: string;
  warning?: string;
  allowSpace?: boolean;
  upper?: boolean;
}

export function PairEditLR({
  label,
  value,
  onChange,
  explain,
  warning,
  allowSpace = false,
  upper = false,
}: PairEditLRProps) {
  return (
    <div className="flex gap-8 items-center justify-between">
      <div className="flex flex-col gap-1">
        <div className="text-sm font-semibold text-[#262626] dark:text-[#d4d4d4] transition ">
          {label}
        </div>
        <div className="text-xs text-[#525252] dark:text-[#a3a3a3] transition">
          {explain}
        </div>
      </div>
      <input
        type="text"
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          if (upper) v.toUpperCase();
          if (v.trim() !== "" || value.trim() !== "" || allowSpace) {
            onChange?.(v);
          }
        }}
        // onBlur={() => {
        //   const v = value.trim();
        //   onChange?.(v);
        // }}
        className={cn([
          "text-sm text-[#262626] dark:text-[#d4d4d4] transition px-2 py-1",
          "bg-[#f1f5f9] dark:bg-[#171717] rounded-md border border-[#e5e5e5] dark:border-[#262626]",
          "focus:outline-none focus:ring-0",
          warning ? "border-[#df2837] dark:border-[#df2837]" : "",
        ])}
      />
    </div>
  );
}
interface EntryToolButtonProps {
  icon?: React.ReactNode;
  label: string;
  onClick?: () => void;
}

export function EntryToolButton({
  icon,
  label,
  onClick,
}: EntryToolButtonProps) {
  const [hover, setHover] = useState(false);
  return (
    <div
      className="flex items-center gap-1 cursor-pointer transition duration-300 ease-in-out hover:bg-[#e7eced] dark:hover:bg-[#383838] rounded-md pl-2 pr-2.5 py-1"
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
            : "text-[#525252] dark:text-[#a3a3a3]",
        ])}
      >
        {label}
      </div>
    </div>
  );
}

interface EntryToolButtonSwitchProps extends EntryToolButtonProps {
  option?: string[];
}

export function EntryToolButtonSwitch({
  icon,
  label,
  onClick,
}: EntryToolButtonSwitchProps) {
  const [turn, setTurn] = useState(0);

  const handleClick = () => {
    setTurn(turn + 1);
    onClick?.();
  };

  return (
    <div
      className="flex items-center gap-1 cursor-pointer transition duration-300 ease-in-out group hover:bg-[#e7eced] dark:hover:bg-[#383838] rounded-md pl-2 pr-2.5 py-1"
      onClick={handleClick}
    >
      {icon && (
        <motion.div
          animate={{ rotate: turn * 360, transition: { duration: 0.5 } }}
        >
          {icon}
        </motion.div>
      )}
      <div className="text-xs text-[#525252] group-hover:text-[#262626] dark:text-[#a3a3a3] group-hover:dark:text-[#d4d4d4] transition">
        {label}
      </div>
    </div>
  );
}

export function ItemEditTitle({ title }: { title: string }) {
  return (
    <div className="text-sm font-semibold text-[#404040] dark:text-[#d4d4d4] transition">
      {title}
    </div>
  );
}

interface ItemEditContentProps {
  content: string;
  onChange?: (val: string) => void;
  className?: string;
  holder?: string;
  onBlur?: () => void;
}

export function ItemEditContent({
  content,
  onChange,
  className,
  holder,
  onBlur,
}: ItemEditContentProps) {
  const [value, setValue] = useState(content);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  // 每次 value 变化都 resize
  useEffect(() => {
    resizeTextArea();
  }, [value]);

  // 父组件 content 变化同步本地
  useEffect(() => {
    setValue(content);
  }, [content]);

  // 挂载和窗口 resize 时也要 resize
  useEffect(() => {
    resizeTextArea();
    window.addEventListener("resize", resizeTextArea);
    return () => window.removeEventListener("resize", resizeTextArea);
    // eslint-disable-next-line
  }, []);

  function resizeTextArea() {
    const el = textAreaRef.current;
    if (!el) return;

    // 1) 先自动高度
    el.style.height = "auto";

    // 2) 读取计算样式里的 border 宽度，避免硬编码 2
    const style = window.getComputedStyle(el);
    const borderTop = parseFloat(style.borderTopWidth);
    const borderBottom = parseFloat(style.borderBottomWidth);

    // 3) 用 Math.ceil 消除 scrollHeight 的截断误差
    const newHeight = Math.ceil(el.scrollHeight) + borderTop + borderBottom;

    el.style.height = `${newHeight}px`;
  }

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

interface EditKVProps {
  k: string;
  v: string;
  holderK: string;
  holderV: string;
  canDelete?: boolean;
  onChangeK?: (val: string) => void;
  onChangeV?: (val: string) => void;
  onDelete?: () => void;
  onBlur?: () => void;
}

export function EditKV({
  k,
  v,
  holderK,
  holderV,
  onChangeK,
  onChangeV,
  onDelete,
  onBlur,
  canDelete = true,
}: EditKVProps) {
  return (
    <>
      <div className="flex items-start gap-1">
        <div className="flex items-center gap-1 w-full">
          {canDelete && (
            <div
              className={cn([
                "p-1 rounded-full transition duration-300 cursor-pointer",
                "hover:bg-[#e7eced] dark:hover:bg-[#383838]",
                "text-[#525252] dark:text-[#a3a3a3]",
                "hover:text-[#262626] dark:hover:text-[#d4d4d4]",
              ])}
              onClick={onDelete}
            >
              <icons.xmark size={12} />
            </div>
          )}
          <ItemEditContent
            content={k}
            className="w-full"
            holder={holderK}
            onChange={onChangeK}
            onBlur={onBlur}
          />
        </div>
      </div>
      <ItemEditContent
        content={v}
        holder={holderV}
        onChange={onChangeV}
        onBlur={onBlur}
      />
    </>
  );
}

interface CardToolItemProps {
  icon?: React.ReactNode;
  label: string;
  onClick?: () => void;
}

export const ToolItem = memo(function CardToolItemComp({
  icon,
  label,
  onClick,
}: CardToolItemProps) {
  return (
    <DropdownMenuItem
      onClick={onClick}
      className="opacity-70 hover:opacity-100 transition"
    >
      <IconsItem icon={icon} text={label} />
    </DropdownMenuItem>
  );
});

interface IconsItemProps {
  icon?: React.ReactNode;
  text: string;
}
function IconsItem({ icon, text }: IconsItemProps) {
  return (
    <div className="flex items-center gap-2">
      {icon}
      <span>{text}</span>
    </div>
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
      <div className="text-[#404040] dark:text-[#d4d4d4] transition font-semibold text-lg">
        {title}
      </div>
      <div className="text-xs text-[#525252] dark:text-[#a3a3a3] transition">
        {explain}
      </div>
    </div>
  );
}

interface InputItemProps {
  label: string;
  className?: string;
  onCheck?: (t: string) => void;
  placeholder?: string;
}

export function InputItem({
  label,
  className,
  onCheck,
  placeholder,
}: InputItemProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");

  const ref = useRef<HTMLInputElement>(null);

  return (
    <motion.div
      className={cn([
        "group relative flex h-8 w-full items-center overflow-hidden rounded text-sm",
        "dark:text-[#e5e5e5] opacity-70 dark:opacity-60 hover:opacity-90 transition",
        "hover:bg-accent transition-colors",
        editing && "cursor-text opacity-100 bg-accent",
      ])}
      onClick={() => {
        if (!editing) {
          setEditing(true);
          setTimeout(() => ref.current?.focus(), 100);
        } else {
          ref.current?.focus();
        }
      }}
      layout
    >
      <AnimatePresence initial={false}>
        {editing ? (
          <motion.div
            initial={{ y: -10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 10, opacity: 0 }}
            transition={{ staggerChildren: 0.1 }}
            key={0}
            className="absolute left-0 flex w-full items-center justify-between"
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="ml-2 w-4/6 cursor-text bg-transparent outline-none"
              ref={ref}
              placeholder={placeholder}
              onKeyDown={(e) => {
                e.stopPropagation();
              }}
            />
            <div className="absolute right-0 mr-2 flex items-center gap-x-1 cursor-default">
              <button
                className="rounded bg-neutral-300 p-[3px] text-neutral-700 hover:bg-neutral-400/50 dark:bg-neutral-600 dark:text-neutral-100 dark:hover:bg-neutral-500 cursor-pointer"
                onClick={() => {
                  setEditing(false);
                  setText("");
                  onCheck?.(text.trim());
                }}
              >
                <icons.check3 size={12} />
              </button>
              <button
                className="rounded bg-neutral-300 p-[3px] text-neutral-700 hover:bg-neutral-400/50 dark:bg-neutral-600 dark:text-neutral-100 dark:hover:bg-neutral-500 cursor-pointer"
                onClick={() => {
                  setEditing(false);
                  setText("");
                }}
              >
                <icons.xmark size={12} />
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.button
            initial={{ y: -10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 10, opacity: 0 }}
            key={1}
            className="absolute right-0 flex w-full items-center"
            onClick={() => {
              setEditing(true);
              setTimeout(() => ref.current?.focus(), 100);
            }}
          >
            <span className="ml-2">{label}</span>
            {/* < className="absolute right-0 mr-2 text-base" /> */}
          </motion.button>
        )}
      </AnimatePresence>
      <div
        className={cn(
          "pointer-events-none absolute left-0 h-full w-full",
          editing ? "block" : "hidden group-hover:block"
        )}
      />
    </motion.div>
  );
}

export function ListSeparator() {
  return (
    <motion.div
      className="h-4 ml-5 w-px bg-[#e5e5e5] dark:bg-[#171717] transition"
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
