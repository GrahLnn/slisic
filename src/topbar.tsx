import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { icons, logos } from "@/src/assets/icons";
import { platform } from "@tauri-apps/plugin-os";
import React, { memo, useEffect, type PropsWithChildren } from "react";
import { shouldBarVisible } from "./state_machine/barVisible";
import { isWindowFocus } from "./state_machine/windowFocus";

const os = platform();

interface CtrlButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
  o?: string;
  p?: string;
}

function CtrlButton({
  children,
  onClick = () => {},
  className,
  o,
  p,
}: CtrlButtonProps) {
  const shouldVisible = shouldBarVisible();
  return (
    <div data-tauri-drag-region={!shouldVisible}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: <explanation> */}
      <div
        className={cn([
          "rounded-md cursor-default h-8 flex items-center justify-center",
          p || "p-2",
          o || "opacity-60",
          "hover:bg-black/5 dark:hover:bg-white/5 hover:opacity-100",
          "transition-all duration-300 ease-in-out",
          !shouldVisible && "opacity-0 pointer-events-none",
          className,
        ])}
        onClick={onClick}
      >
        {children}
      </div>
    </div>
  );
}

interface DropdownMenuItemProps {
  name: string;
  shortcut?: string;
  fn?: () => void;
  data?: React.ReactNode;
}

interface DropdownButtonProps extends PropsWithChildren {
  p?: string;
  o?: string;
  className?: string;
  label?: string | React.ReactNode;
  items?: Array<DropdownMenuItemProps>;
}

function DropdownButton({
  children,
  label,
  items,
  p,
  o,
  className,
}: DropdownButtonProps) {
  const shouldVisible = shouldBarVisible();
  return (
    <div data-tauri-drag-region={!shouldVisible}>
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn([
            "focus:outline-none focus:ring-0 focus:border-0",
            "rounded-md cursor-default",
            p || "p-2",
            o || "opacity-60",
            "hover:bg-black/5 dark:hover:bg-white/5 hover:opacity-100",
            "data-[state=open]:bg-black/5 dark:data-[state=open]:bg-white/5 data-[state=open]:opacity-100",
            "transition-all duration-300 ease-in-out",
            !shouldVisible && "opacity-0 pointer-events-none",
            className,
          ])}
        >
          {children}
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56 bg-popover/80 backdrop-filter backdrop-blur-[16px]">
          {label && (
            <DropdownMenuLabel className="cursor-default select-none">
              {label}
            </DropdownMenuLabel>
          )}
          {label && <DropdownMenuSeparator />}
          {items?.map((item) => (
            <React.Fragment key={item.name}>
              <DropdownMenuItem
                className="focus:bg-accent/60"
                key={item.name}
                onClick={item.fn}
              >
                {item.name}
                {item.shortcut && (
                  <DropdownMenuShortcut>{item.shortcut}</DropdownMenuShortcut>
                )}
              </DropdownMenuItem>
              {item.data}
            </React.Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

const LeftControls = memo(() => {
  return (
    <div className="flex items-center px-2 text-[var(--content)]">
      <logos.tauri className="h-4 w-4 opacity-60" />
    </div>
  );
});

const RightControls = memo(() => {
  return (
    <div className={cn(["flex items-center"])}>
      <CtrlButton>
        <icons.magnifler3 size={14} />
      </CtrlButton>
      <CtrlButton>
        <icons.globe3 size={14} />
      </CtrlButton>

      <CtrlButton>
        <icons.arrowDown size={14} />
      </CtrlButton>

      <div className="w-[138px]" />
    </div>
  );
});

const settingsItems = [
  { name: "Preferences", fn: () => {} },
  { name: "Help", fn: () => {} },
  { name: "Upgrade to pro", fn: () => {} },
];

const MiddleControls = memo(() => {
  return (
    <div className={cn(["flex items-center h-full"])}>
      <DropdownButton label="Page Nav" items={settingsItems}>
        <icons.gridCircle size={14} />
      </DropdownButton>

      <DropdownButton
        label="User Preferences"
        items={settingsItems}
        className="text-xs font-light h-8"
        o="opacity-80"
        p="px-5"
      >
        <div className="text-trim-cap">tauri app</div>
      </DropdownButton>
      <DropdownButton label="Settings" items={settingsItems}>
        <icons.sliders size={14} />
      </DropdownButton>
    </div>
  );
});

const TopBar = memo(() => {
  const windowFocused = isWindowFocus();

  useEffect(() => {
    if (!windowFocused) {
      document.body.setAttribute("window-blur", "");

      // 创建遮罩层
      const overlay = document.createElement("div");
      overlay.id = "window-blur-overlay";
      overlay.className = "window-blur-overlay";

      // 添加事件监听器以捕获所有事件
      const blockEvent = (e: Event) => {
        e.stopPropagation();
        e.preventDefault();
      };

      overlay.addEventListener("mousedown", blockEvent, true);
      overlay.addEventListener("mouseup", blockEvent, true);
      overlay.addEventListener("click", blockEvent, true);
      overlay.addEventListener("dblclick", blockEvent, true);
      overlay.addEventListener("contextmenu", blockEvent, true);
      overlay.addEventListener("wheel", blockEvent, true);
      overlay.addEventListener("touchstart", blockEvent, true);
      overlay.addEventListener("touchend", blockEvent, true);
      overlay.addEventListener("touchmove", blockEvent, true);
      overlay.addEventListener("keydown", blockEvent, true);
      overlay.addEventListener("keyup", blockEvent, true);

      document.body.appendChild(overlay);
    } else {
      document.body.removeAttribute("window-blur");

      // 移除遮罩层
      const overlay = document.getElementById("window-blur-overlay");
      if (overlay) {
        document.body.removeChild(overlay);
      }
    }

    // 清理函数
    return () => {
      const overlay = document.getElementById("window-blur-overlay");
      if (overlay) {
        document.body.removeChild(overlay);
      }
    };
  }, [windowFocused]);

  return (
    <>
      {os === "windows" && (
        <div
          className={cn([
            "fixed top-0 left-0 flex",
            "w-screen h-8 z-[9999] select-none",
            "before:absolute before:inset-0 before:-z-10",
            "before:bg-gradient-to-b before:from-[var(--app-bg)] before:to-[var(--app-bg)]/60",
            "before:transition before:duration-500 ease-in-out",
            "after:absolute after:inset-0 after:-z-10",
            "after:backdrop-blur-[16px] after:opacity-100 after:origin-top",
            "after:bg-gradient-to-b after:from-transparent after:via-transparent after:to-white/0",
            "after:mask-image-[linear-gradient(to_bottom,rgba(0,0,0,1)_0%,rgba(0,0,0,0)_100%)]",
            "after:transition after:duration-500 ease-in-out",
          ])}
        >
          <div
            className={cn([
              "grid grid-cols-[1fr_auto_1fr] w-full h-full",
              !windowFocused && "opacity-30",
              "transition duration-300 ease-in-out",
            ])}
          >
            <div
              data-tauri-drag-region
              className={cn(["flex justify-start pl-1"])}
            >
              <LeftControls />
            </div>
            <div data-tauri-drag-region className={cn(["flex justify-center"])}>
              <MiddleControls />
            </div>
            <div data-tauri-drag-region className={cn(["flex justify-end"])}>
              <RightControls />
            </div>
          </div>
        </div>
      )}
    </>
  );
});

export default TopBar;
