import { cn } from "@/lib/utils";
import { icons } from "@/src/assets/icons";
import { AnimatePresence, motion } from "motion/react";
import type React from "react";
import { type PropsWithChildren, type ReactNode, memo } from "react";
import { app as bootstrapApp } from "./flow/bootstrap";
import { action as pasteDownloadAction } from "./flow/pasteDownload";
import { useIsBarVisible } from "./flow/barVisible";
import { useIsWindowFocus } from "./flow/windowFocus";
import { os } from "@/lib/utils";
import { GlassSurface } from "./components/glass/GlassSurface";

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
        aria-label={label}
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

type TopBarSurface = "config" | "playlist" | "spectrum" | "support";

export const LeftControls = memo(function LeftControlsComponent({
  surface,
}: {
  surface: TopBarSurface;
}) {
  const handleResetDevDatabase = () => {
    bootstrapApp.resetDevDatabaseAndExit();
  };

  const handleBatchPaste = () => {
    void pasteDownloadAction.pasteBatchFromClipboard();
  };

  return (
    <div className="flex items-center px-2 text-(--content)">
      {os.match({
        macos: () => <div className="w-21" />,
        _: () => null,
      })}
      {import.meta.env.DEV && (
        <>
          <CtrlButton
            label="Reset DB"
            icon={<icons.trashXmark size={14} />}
            onClick={handleResetDevDatabase}
            className="cursor-pointer hover:text-red-600"
            o="opacity-30"
          />
          {surface === "config" && (
            <CtrlButton
              label="Batch paste"
              icon={<icons.clipboardLines size={14} />}
              onClick={handleBatchPaste}
              className="cursor-pointer hover:text-sky-600"
              o="opacity-30"
            />
          )}
        </>
      )}
    </div>
  );
});

const RightControls = memo(function RightControlsComponent() {
  return (
    <div className={cn(["flex items-center"])}>
      {/*<CtrlButton label="Search" icon={<icons.magnifier3 size={14} />} />
      <CtrlButton label="Language" icon={<icons.globe3 size={14} />} />
      <CtrlButton label="Update" icon={<icons.arrowDown size={14} />} />*/}

      {os.match({
        windows: () => <div className="w-34.5" />,
        macos: () => <div className="w-2" />,
        _: () => null,
      })}
    </div>
  );
});

const MiddleControls = memo(function MiddleControlsComponent() {
  const middleTools: Array<{ key: string; node: ReactNode }> = [];
  const middleTool = middleTools[0];
  return (
    <AnimatePresence>
      {middleTool && (
        <motion.div
          key={middleTool.key}
          initial={{ opacity: 0, y: 2 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -2 }}
          transition={{ duration: 0.2 }}
        >
          {middleTool.node}
        </motion.div>
      )}
    </AnimatePresence>
  );
});

const TopBar = memo(function TopBarComponent({
  surface = "support",
}: {
  surface?: TopBarSurface;
}) {
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
            "flex flex-none relative overflow-hidden",
            "w-full h-8 z-100 select-none",
            "app-titlebar-glass",
          ])}
        >
          <GlassSurface variant="titlebar" className="inset-0 z-0" />
          <div
            className={cn([
              "relative z-10 grid grid-cols-[1fr_auto_1fr] w-full h-full",
              !windowFocused && "opacity-30",
              "transition duration-300 ease-in-out",
            ])}
            data-tauri-drag-region={!allowBarInteraction}
          >
            {allowBarInteraction && (
              <>
                <div data-tauri-drag-region className={cn(["flex justify-start pl-1"])}>
                  <LeftControls surface={surface} />
                </div>
                <div data-tauri-drag-region className={cn(["flex justify-center"])}>
                  <MiddleControls />
                </div>
                <div data-tauri-drag-region className={cn(["flex justify-end"])}>
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
