import {
  AnimatePresence,
  motion,
  LayoutGroup,
  useAnimationControls,
} from "motion/react";
import { SpotlightSection } from "../components/arc_scroll";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { labels } from "../components/labels";
import { cn } from "@/lib/utils";
import { motionIcons } from "../assets/icons";
import { action, hook } from "../state_machine/music";
import { K } from "@/lib/comb";
import { EmptyPage } from "../components/empty";
import { New } from "../components/music/new";
import { BackButton, ListSeparator } from "../components/uni";
import { station } from "@/src/subpub/buses";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuTrigger,
  LongPressContextMenuItem,
} from "@/components/ui/context-menu";

interface GuideCardProps {
  content: React.ReactNode;
  title: string;
  idx: number;
  rotation?: number;
  zIndex: number;
  onClick?: () => void;
}

interface GuideItem {
  title: string;
  content: React.ReactNode;
  fn?: () => void;
}

export function Face({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-start select-none overflow-hidden">
      {children}
    </div>
  );
}

const Card: React.FC<GuideCardProps> = ({ content, title, idx, onClick }) => {
  const formattedIdx = String(idx).padStart(2, "0");

  return (
    <motion.div
      className={"group relative hover:z-50 select-none"}
      whileHover={{ scale: 1.2, rotate: 0, y: 0 }}
      whileTap={{ scale: 0.95 }}
      onClick={onClick}
    >
      <div
        className={cn([
          "duration-250 flex h-[240px] w-[200px] flex-col items-center justify-between rounded-xl  transition-all group-hover:shadow-xl dark:border dark:border-white/5 dark:bg-[#1A1A1A]",
          "bg-white p-1 shadow-lg ring ring-[#DEDEDE]/50 dark:ring-[#333333]/50",
        ])}
      >
        <div className="h-4" />
        {content}
        <div className="w-full self-end p-2">
          <div className="text-xs text-[#DEDEDE] dark:text-[#828282]">
            {formattedIdx}
          </div>
          <div className="text-md font-medium text-[#262626] dark:text-[#D9D9D9] dark:group-hover:text-white">
            {title}
          </div>
        </div>
        <div className="absolute top-24 h-10 w-full bg-transparent md:top-36" />
      </div>
    </motion.div>
  );
};

function Play() {
  const lists = hook.useList();
  const isPlaying = hook.ussIsPlaying();
  const curPlay = hook.useCurPlay();
  const curList = hook.useCurList();
  const isCursorInApp = station.cursorinapp.useSee();
  const [hoveredKey, setHoveredKey] = useState<string | null>(null); // 记录当前悬停的 item
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const upCtrl = useAnimationControls();
  const downCtrl = useAnimationControls();
  const starCtrl = useAnimationControls();

  const oneShot = async (ctrl: ReturnType<typeof useAnimationControls>) => {
    // 立刻重置到 0（无动画）
    ctrl.set({ pathLength: 0 });
    // 播放 0 → 1
    await ctrl.start({
      pathLength: 1,
      transition: { duration: 0.3, ease: "easeInOut" },
    });
    // 结束后保持在 1（静态）
  };

  const setItemRef = useCallback(
    (key: string): React.RefCallback<HTMLDivElement> =>
      (el) => {
        if (el) itemRefs.current[key] = el;
        else delete itemRefs.current[key];
      },
    []
  );

  useLayoutEffect(() => {
    if (!curList) return;
    const key = curList.name;
    const el = itemRefs.current[key];
    const wrap = containerRef.current;
    if (!el || !wrap) return;

    requestAnimationFrame(() =>
      el.scrollIntoView({ block: "center", behavior: "smooth" })
    );
  }, [curList]);

  return (
    <>
      <Face>
        <div className={cn(["flex flex-col z-10 w-full h-full"])}>
          <div
            ref={containerRef}
            className={cn([
              "h-screen w-screen snap-y snap-mandatory flex flex-col items-center gap-8",
              isPlaying ? "overflow-hidden" : "overflow-y-scroll",
            ])}
          >
            <div aria-hidden className="shrink-0 h-[100vh] snap-none" />
            {lists.map((i) => {
              const isCurrent = i.name === curList?.name;
              const disabled = isPlaying && !isCurrent;

              // 当前且正在播放时，未 hover 显示 curPlay.title；hover 显示自己的 name
              const shouldSwap = isPlaying && isCurrent;
              const showName = shouldSwap ? hoveredKey === i.name : true;
              const isOk = i.entries.every((f) => f.downloaded_ok);

              return (
                <motion.div
                  key={i.name}
                  ref={setItemRef(i.name)} // 这里和 useLayoutEffect 里取的 key 对应
                  className={cn([
                    "snap-center text-2xl font-cinzel text-[#0a0a0a] dark:text-[#fafafa] transition focus:outline-none flex flex-col items-center",
                    disabled && "pointer-events-none select-none", // 不可交互+不可选中
                  ])}
                  initial={false} // 避免每次 re-render 都回到 initial
                  animate={
                    disabled
                      ? { filter: "blur(6px)", opacity: 0 }
                      : { filter: "blur(0px)", opacity: 1 }
                  }
                  transition={{ duration: 0.3, ease: "easeOut" }}
                  // 无障碍/键盘：禁用态不可聚焦
                  tabIndex={disabled ? -1 : 0}
                  aria-disabled={disabled || undefined}
                >
                  {/* 文字切换区：仅在 shouldSwap 时做有进有出的切换，否则直接显示 name */}
                  <ContextMenu>
                    <ContextMenuTrigger
                      className={cn([
                        isOk
                          ? "cursor-pointer"
                          : "select-none text-[#404040] dark:text-[#a3a3a3] animate-pulse",
                      ])}
                      onMouseEnter={() => setHoveredKey(i.name)}
                      onMouseLeave={() =>
                        setHoveredKey((k) => (k === i.name ? null : k))
                      }
                      onClick={() => {
                        if (disabled || !isOk) return;
                        action.play(i);
                      }}
                    >
                      {(() => {
                        const alt = curPlay?.title ?? i.name;
                        const longer =
                          (alt?.length ?? 0) >= i.name.length ? alt : i.name;

                        return shouldSwap ? (
                          <span className="relative inline-block">
                            {/* 幽灵占位：撑开成两者里最长的宽度，保持命中区域稳定 */}
                            <span
                              aria-hidden
                              className="invisible block whitespace-pre"
                            >
                              {longer}
                            </span>

                            <AnimatePresence mode="wait" initial={false}>
                              {showName ? (
                                <motion.span
                                  key="name"
                                  className="absolute inset-0 flex items-center justify-center pointer-events-none"
                                  initial={{ filter: "blur(6px)", opacity: 0 }}
                                  animate={{ filter: "blur(0px)", opacity: 1 }}
                                  exit={{ filter: "blur(6px)", opacity: 0 }}
                                  transition={{
                                    duration: 0.25,
                                    ease: "easeOut",
                                  }}
                                >
                                  {i.name}
                                </motion.span>
                              ) : (
                                <motion.span
                                  key="title"
                                  className="absolute inset-0 flex items-center justify-center pointer-events-none"
                                  initial={{ filter: "blur(6px)", opacity: 0 }}
                                  animate={{ filter: "blur(0px)", opacity: 1 }}
                                  exit={{ filter: "blur(6px)", opacity: 0 }}
                                  transition={{
                                    duration: 0.25,
                                    ease: "easeOut",
                                  }}
                                >
                                  {alt}
                                </motion.span>
                              )}
                            </AnimatePresence>
                          </span>
                        ) : (
                          <span>{i.name}</span>
                        );
                      })()}
                    </ContextMenuTrigger>
                    {!isPlaying && (
                      <ContextMenuContent className="opacity-70">
                        <ContextMenuItem onClick={() => action.edit(i)}>
                          Edit
                        </ContextMenuItem>
                        <LongPressContextMenuItem
                          durationMs={2000}
                          onConfirm={() => action.delete(i)}
                          className="text-[#e81123] focus:text-[#e81123] data-[highlighted]:text-[#e81123]"
                        >
                          Delete
                        </LongPressContextMenuItem>
                      </ContextMenuContent>
                    )}
                  </ContextMenu>
                  <AnimatePresence>
                    {curPlay && isPlaying && isCursorInApp && isCurrent && (
                      <motion.div
                        className={cn([
                          "flex justify-between w-full gap-4 min-w-24",
                        ])}
                        initial={{
                          filter: "blur(6px)",
                          opacity: 0,
                          height: 0,
                        }}
                        animate={{
                          filter: "blur(0px)",
                          opacity: 1,
                          height: "auto",
                        }}
                        exit={{
                          filter: "blur(6px)",
                          opacity: 0,
                          height: 0,
                        }}
                      >
                        <div className="flex items-center gap-4">
                          <div
                            className={cn([
                              "p-1",
                              "hover:opacity-100 opacity-40",
                              "hover:text-[#468be6]",
                              "transition duration-300",
                            ])}
                            onClick={() => oneShot(upCtrl)}
                          >
                            <motionIcons.thumbsUp
                              initial={{ pathLength: 1 }}
                              animate={upCtrl}
                            />
                          </div>
                          <div
                            className={cn([
                              "p-1 mt-1",
                              "hover:opacity-60 opacity-40",
                              "transition duration-300",
                            ])}
                            onClick={() => oneShot(downCtrl)}
                          >
                            <motionIcons.thumbsDown
                              initial={{ pathLength: 1 }}
                              animate={downCtrl}
                            />
                          </div>
                        </div>
                        <div className={cn(["flex items-center"])}>
                          <div
                            className={cn([
                              "p-1 mt-[2px]",
                              "hover:opacity-60 opacity-40",
                              "hover:text-[#e81123] dark:hover:text-[#e3303f]",
                              "transition duration-300",
                            ])}
                            onClick={() => {
                              action.unstar(curPlay);
                              oneShot(starCtrl);
                            }}
                          >
                            <motionIcons.starSlash
                              size={14}
                              initial={{ pathLength: 1 }}
                              animate={starCtrl}
                            />
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
            <motion.div
              className={cn([
                "text-2xl font-cinzel text-[#0a0a0a] dark:text-[#fafafa] transition cursor-pointer snap-center",
                "whitespace-nowrap",
                isPlaying && "opacity-0 pointer-events-none select-none",
              ])}
              onClick={() => {
                if (isPlaying) return;
                action.add_new();
              }}
              tabIndex={isPlaying ? -1 : 0}
              aria-disabled={isPlaying || undefined}
            >
              Add List
            </motion.div>
            <div aria-hidden className="shrink-0 h-[50vh] snap-none" />
          </div>
        </div>
      </Face>
    </>
  );
}

function Create() {
  return (
    <Face>
      <div className="relative flex w-full h-full overflow-hidden">
        <div className="absolute left-6 top-0 flex items-center gap-2">
          <BackButton onClick={action.back} />
        </div>
        <div className="flex flex-col justify-center items-center w-1/2">
          <motion.div layoutId="musicPlus">
            <labels.musicPlus />
          </motion.div>
        </div>

        <div className="w-1/2 py-4 px-6 overflow-y-auto">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <New />
          </motion.div>
        </div>
      </div>
    </Face>
  );
}

function Edit() {
  return (
    <Face>
      <div className="relative flex w-full h-full overflow-hidden">
        <div className="absolute left-6 top-0 flex items-center gap-2">
          <BackButton onClick={action.back} />
        </div>
        <div className="flex flex-col justify-center items-center w-1/2">
          <motion.div layoutId="musicPlus">
            <labels.musicPlus />
          </motion.div>
        </div>

        <div className="w-1/2 py-4 px-6 overflow-y-auto">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <New />
          </motion.div>
        </div>
      </div>
    </Face>
  );
}

function Guide() {
  return (
    <EmptyPage
      symbol={
        <motion.div layoutId="musicPlus">
          <labels.musicPlus />
        </motion.div>
      }
      explain="You don’t have any play list yet. Let’s add your first one!"
      cta="Add First List"
      onClick={action.add_new}
    />
  );
}

export default function Home() {
  const state = hook.useState();

  return state.match({
    play: () => <Play />,
    new_guide: () => <Guide />,
    create: () => <Create />,
    saving: () => <Create />,
    updating: () => <Create />,
    edit: () => <Edit />,
    _: K(null),
  });
}
