import { cn } from "@/lib/utils";
import { icons } from "@/src/assets/icons";
import { AnimatePresence, motion } from "motion/react";
import type React from "react";
import { type PropsWithChildren, ReactNode, memo, useEffect } from "react";
import { useIsBarVisible } from "./state_machine/barVisible";
import { useIsWindowFocus } from "./state_machine/windowFocus";
import { os } from "@/lib/utils";

interface CtrlButtonProps extends PropsWithChildren {
  icon?: React.ReactNode;
  label?: string;
  onClick?: () => void;
  className?: string;
  o?: string;
  p?: string;
}

const CtrlButton = memo(function CtrlButtonComp({
  icon,
  label,
  onClick = () => {},
  className,
  o,
  p,
}: CtrlButtonProps) {
  const isVisible = useIsBarVisible();
  return (
    <div data-tauri-drag-region={!isVisible}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: <explanation> */}
      <div
        className={cn([
          "rounded-md cursor-default h-8 flex items-center justify-center",
          p || "p-2",
          o || "opacity-60",
          "hover:bg-black/5 dark:hover:bg-white/5 hover:opacity-100 ",
          "transition duration-300 ease-in-out",
          !isVisible && "opacity-0 pointer-events-none",
          className,
        ])}
        onClick={onClick}
      >
        <div className={cn(["flex items-center gap-1"])}>
          <span style={{ transform: "translateZ(0)" }}>{icon}</span>
          {/* <motion.span
            className={cn(["text-xs trim-cap overflow-hidden", !isHovered && "w-0"])}
            layout
          >
            {label}
          </motion.span> */}
        </div>
      </div>
    </div>
  );
});

export const LeftControls = memo(function LeftControlsComponent() {
  return (
    <div className="flex items-center px-2 text-[var(--content)]">
      {os.match({
        macos: () => <div className="w-[84px]" />,
        _: () => null,
      })}
    </div>
  );
});

const RightControls = memo(function RightControlsComponent() {
  const isVisible = useIsBarVisible();

  const checkcn =
    "dark:hover:bg-[#373737] hover:bg-[#d4d4d4] opacity-70 hover:opacity-100 rounded-full transition cursor-pointer";
  return (
    <div className={cn(["flex items-center"])}>
      <CtrlButton label="Search" icon={<icons.magnifler3 size={14} />} />
      <CtrlButton label="Language" icon={<icons.globe3 size={14} />} />
      <CtrlButton label="Update" icon={<icons.arrowDown size={14} />} />

      {os.match({
        windows: () => <div className="w-[138px]" />,
        macos: () => <div className="w-[8px]" />,
        _: () => null,
      })}
    </div>
  );
});

const MiddleControls = memo(function MiddleControlsComponent() {
  const middleTools: ReactNode[] = [];
  return (
    <AnimatePresence>
      {middleTools && (
        <motion.div
          key={middleTools?.key || "tool"}
          initial={{ opacity: 0, y: 2 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -2 }}
          transition={{ duration: 0.2 }}
        >
          {middleTools?.node}
        </motion.div>
      )}
    </AnimatePresence>
  );
});

const TopBar = memo(function TopBarComponent() {
  const windowFocused = useIsWindowFocus();
  const allowBarInteraction = true;

  // useEffect(() => {
  //   if (!windowFocused) {
  //     document.body.setAttribute("window-blur", "");

  //     // 创建遮罩层
  //     const overlay = document.createElement("div");
  //     overlay.id = "window-blur-overlay";
  //     overlay.className = "window-blur-overlay";

  //     // 添加事件监听器以捕获所有事件
  //     const blockEvent = (e: Event) => {
  //       e.stopPropagation();
  //       e.preventDefault();
  //     };

  //     overlay.addEventListener("mousedown", blockEvent, true);
  //     overlay.addEventListener("mouseup", blockEvent, true);
  //     overlay.addEventListener("click", blockEvent, true);
  //     overlay.addEventListener("dblclick", blockEvent, true);
  //     overlay.addEventListener("contextmenu", blockEvent, true);
  //     overlay.addEventListener("wheel", blockEvent, true);
  //     overlay.addEventListener("touchstart", blockEvent, true);
  //     overlay.addEventListener("touchend", blockEvent, true);
  //     overlay.addEventListener("touchmove", blockEvent, true);
  //     overlay.addEventListener("keydown", blockEvent, true);
  //     overlay.addEventListener("keyup", blockEvent, true);

  //     document.body.appendChild(overlay);
  //   } else {
  //     document.body.removeAttribute("window-blur");

  //     // 移除遮罩层
  //     const overlay = document.getElementById("window-blur-overlay");
  //     if (overlay) {
  //       document.body.removeChild(overlay);
  //     }
  //   }

  //   // 清理函数
  //   return () => {
  //     const overlay = document.getElementById("window-blur-overlay");
  //     if (overlay) {
  //       document.body.removeChild(overlay);
  //     }
  //   };
  // }, [windowFocused]);

  return (
    <>
      {
        <div
          className={cn([
            "flex flex-none relative",
            "w-full h-8 z-[100] select-none",
            "before:content-[''] before:absolute before:inset-0 before:-z-10",
            "before:bg-gradient-to-b before:from-[var(--app-bg)] before:to-[var(--app-bg)]/60",
            "before:transition-colors before:duration-500 before:ease-in-out",
            "after:content-[''] after:absolute after:inset-0 after:-z-10",
            "after:backdrop-blur-[16px] after:opacity-100 after:origin-top",
            "after:bg-gradient-to-b after:from-transparent after:via-transparent after:to-white/0",
            "after:mask-image-[linear-gradient(to_bottom,rgba(0,0,0,1)_0%,rgba(0,0,0,0)_100%)]",
            "after:transition-colors after:duration-500 after:ease-in-out",
          ])}
        >
          <div
            className={cn([
              "grid grid-cols-[1fr_auto_1fr] w-full h-full",
              !windowFocused && "opacity-30",
              "transition duration-300 ease-in-out",
            ])}
            data-tauri-drag-region={!allowBarInteraction}
          >
            {allowBarInteraction && (
              <>
                <div
                  data-tauri-drag-region
                  className={cn(["flex justify-start pl-1"])}
                >
                  <LeftControls />
                </div>
                <div
                  data-tauri-drag-region
                  className={cn(["flex justify-center"])}
                >
                  <MiddleControls />
                </div>
                <div
                  data-tauri-drag-region
                  className={cn(["flex justify-end"])}
                >
                  <RightControls />
                </div>
              </>
            )}
          </div>
        </div>
      }
    </>
  );
});

export default TopBar;
