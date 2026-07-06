import { cn } from "@/lib/utils";
import { icons } from "@/src/assets/icons";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "motion/react";
import type React from "react";
import { type PropsWithChildren, type ReactNode, memo, useEffect, useRef, useState } from "react";
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

type RemoteShareStatus = {
  enabled: boolean;
  code: string;
};

const REMOTE_SHARE_CODE_MAX_LENGTH = 8;
const remoteShareIconTransition = {
  duration: 0.22,
  ease: [0.22, 1, 0.36, 1],
} as const;

function normalizeRemoteShareCodeInput(value: string) {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, REMOTE_SHARE_CODE_MAX_LENGTH);
}

const remoteShareCodeInputProps = {
  inputMode: "email" as const,
  autoCapitalize: "characters" as const,
  autoCorrect: "off" as const,
  autoComplete: "off" as const,
  spellCheck: false,
  enterKeyHint: "done" as const,
  lang: "en",
  pattern: "[A-Za-z0-9]*",
};

async function invokeRemoteShareStatus() {
  return invoke<RemoteShareStatus>("get_remote_share_status");
}

async function invokeRemoteShareEnabled(enabled: boolean) {
  return invoke<RemoteShareStatus>("set_remote_share_enabled", { enabled });
}

async function invokeRemoteShareCode(code: string) {
  return invoke<RemoteShareStatus>("set_remote_share_code", { code });
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

function RemoteShareSignalIcon({ enabled }: { enabled: boolean }) {
  const toneClassName = enabled
    ? undefined
    : "text-neutral-500 dark:text-neutral-500";
  const RemoteShareIcon = enabled ? icons.wifi : icons.wifiOff;
  const pathMotion = {
    initial: { pathLength: 0, opacity: 0 },
    animate: { pathLength: 1, opacity: 1 },
    exit: { pathLength: 0, opacity: 0 },
    transition: remoteShareIconTransition,
  };

  return (
    <span className="relative block size-4.5">
      <AnimatePresence initial={false} mode="wait">
        <RemoteShareIcon
          key={enabled ? "remote-share-enabled" : "remote-share-disabled"}
          size={18}
          className={cn("absolute inset-0 block", toneClassName)}
          pathMotion={pathMotion}
        />
      </AnimatePresence>
    </span>
  );
}

const RemoteShareControl = memo(function RemoteShareControlComponent() {
  const isVisible = useIsBarVisible();
  const [status, setStatus] = useState<RemoteShareStatus>({
    enabled: false,
    code: "",
  });
  const [draftCode, setDraftCode] = useState("");
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const committingRef = useRef(false);
  const codeComposingRef = useRef(false);

  useEffect(() => {
    let active = true;
    void invokeRemoteShareStatus()
      .then((nextStatus) => {
        if (!active) return;
        setStatus(nextStatus);
        setDraftCode(nextStatus.code);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  async function toggleEnabled() {
    const nextEnabled = !status.enabled;
    setStatus((current) => ({ ...current, enabled: nextEnabled }));
    try {
      const nextStatus = await invokeRemoteShareEnabled(nextEnabled);
      setStatus(nextStatus);
      setDraftCode(nextStatus.code);
    } catch {
      setStatus((current) => ({ ...current, enabled: !nextEnabled }));
    }
  }

  async function commitCode() {
    const normalized = normalizeRemoteShareCodeInput(draftCode);
    setFocused(false);
    if (!normalized) {
      setDraftCode(status.code);
      return;
    }
    if (normalized === status.code || committingRef.current) {
      setDraftCode(normalized);
      return;
    }
    committingRef.current = true;
    setDraftCode(normalized);
    try {
      const nextStatus = await invokeRemoteShareCode(normalized);
      setStatus(nextStatus);
      setDraftCode(nextStatus.code);
    } catch {
      setDraftCode(status.code);
    } finally {
      committingRef.current = false;
    }
  }

  return (
    <div data-tauri-drag-region={!isVisible}>
      <motion.div
        className={cn([
          "group/remote-share rounded-md cursor-default h-8 flex items-center justify-center overflow-hidden",
          "opacity-70 hover:bg-black/5 dark:hover:bg-white/5 hover:opacity-100",
          "transition duration-300 ease-in-out",
          !isVisible && "opacity-0 pointer-events-none",
        ])}
        aria-label="Remote share"
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        <button
          type="button"
          className="flex size-8 shrink-0 items-center justify-center rounded-md"
          aria-label={status.enabled ? "Disable remote share" : "Enable remote share"}
          onClick={() => void toggleEnabled()}
        >
          <RemoteShareSignalIcon enabled={status.enabled} />
        </button>
        <motion.div
          className="overflow-hidden"
          initial={false}
          animate={{
            width: hovered || focused ? "auto" : 0,
          }}
          transition={{
            duration: 0.24,
            ease: [0.22, 1, 0.36, 1],
          }}
        >
          <input
            className={cn([
              "h-8 w-18 bg-transparent pr-2 text-[11px] font-semibold tracking-normal outline-none",
              "placeholder:text-neutral-400 dark:placeholder:text-neutral-600",
            ])}
            value={draftCode}
            {...remoteShareCodeInputProps}
            maxLength={REMOTE_SHARE_CODE_MAX_LENGTH}
            aria-label="Remote share code"
            onFocus={() => setFocused(true)}
            onBlur={() => void commitCode()}
            onCompositionStart={() => {
              codeComposingRef.current = true;
            }}
            onCompositionEnd={(event) => {
              codeComposingRef.current = false;
              setDraftCode(normalizeRemoteShareCodeInput(event.currentTarget.value));
            }}
            onChange={(event) => {
              if (codeComposingRef.current) {
                setDraftCode(event.currentTarget.value);
                return;
              }
              setDraftCode(normalizeRemoteShareCodeInput(event.currentTarget.value));
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
              if (event.key === "Escape") {
                setDraftCode(status.code);
                event.currentTarget.blur();
              }
            }}
          />
        </motion.div>
      </motion.div>
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
          <RemoteShareControl />
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

const TopBar = memo(function TopBarComponent({ surface = "support" }: { surface?: TopBarSurface }) {
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
