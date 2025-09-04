import { AnimatePresence, motion, LayoutGroup } from "motion/react";
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
import { AudioVisualizerCanvas } from "../components/audio/canvas";
import { useAudioAnalyzer } from "../components/audio/useAudioAnalyzer";
import { station } from "@/src/subpub/buses";
import { Playlist } from "../cmd/commands";

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

function SnapList({
  lists,
  action,
}: {
  lists: Playlist[];
  action: { play: (i: Playlist) => void };
}) {
  const [expanded, setExpanded] = useState(false);

  // 第一个元素（收起时唯一可见）
  const first = lists[0];
  const rest = useMemo(() => lists.slice(1), [lists]);

  return (
    <LayoutGroup id="snap-list">
      <motion.div
        className="h-screen overflow-y-scroll snap-y snap-mandatory flex flex-col items-center justify-center relative"
        onHoverStart={() => setExpanded(true)}
        onHoverEnd={() => setExpanded(false)}
      >
        {/* —— 收起状态：居中“唯一真实项”+ 透明 ghost —— */}
        <motion.div
          layoutId={`item-${first.name}`}
          layout // 参与布局动画
          className="snap-center text-2xl font-cinzel text-[#0a0a0a] dark:text-[#fafafa] cursor-pointer absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
          onClick={() => action.play(first)}
          // 两种状态：收起=中心；展开=占据它在列表中的最终位置（由下面列表中的同 layoutId 接管）
          style={{ pointerEvents: expanded ? "none" : "auto" }}
          initial={false}
          animate={{ opacity: expanded ? 0 : 1, scale: expanded ? 0.98 : 1 }}
          transition={{ type: "spring", stiffness: 500, damping: 40 }}
        >
          {first.name}
        </motion.div>

        {/* 收起时的 ghost 层（仅视觉堆叠，不参与 layoutId） */}
        {!expanded && (
          <div className="pointer-events-none">
            {rest.map((i) => (
              <motion.div
                key={`ghost-${i.name}`}
                className="snap-center text-2xl font-cinzel text-[#0a0a0a] dark:text-[#fafafa] absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
                initial={{ opacity: 0 }}
                animate={{ opacity: 0 }}
              >
                {i.name}
              </motion.div>
            ))}
          </div>
        )}

        {/* —— 展开状态：真正的列表（带 layoutId）—— */}
        <AnimatePresence initial={false} mode="sync">
          {expanded && (
            <motion.div
              key="expanded-list"
              className="w-full flex flex-col gap-8 items-center justify-center py-24"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ type: "tween", duration: 0.18 }}
            >
              {/* 把“第一个元素”在这里以同一个 layoutId 渲染，形成共享布局过渡 */}
              <motion.div
                layoutId={`item-${first.name}`}
                layout
                className="snap-center text-2xl font-cinzel text-[#0a0a0a] dark:text-[#fafafa] cursor-pointer"
                onClick={() => action.play(first)}
                transition={{
                  layout: { type: "spring", stiffness: 600, damping: 45 },
                }}
              >
                {first.name}
              </motion.div>

              {rest.map((i) => (
                <motion.div
                  key={i.name}
                  layoutId={`item-${i.name}`}
                  layout
                  className="snap-center text-2xl font-cinzel text-[#0a0a0a] dark:text-[#fafafa] cursor-pointer"
                  onClick={() => action.play(i)}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 6 }}
                  transition={{
                    type: "tween",
                    duration: 0.16,
                  }}
                >
                  {i.name}
                </motion.div>
              ))}

              <motion.div
                layoutId="add-list"
                layout
                className="snap-center text-2xl font-cinzel text-[#0a0a0a] dark:text-[#fafafa] cursor-pointer"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                transition={{ type: "tween", duration: 0.16 }}
              >
                Add List
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </LayoutGroup>
  );
}

function Play() {
  const lists = hook.useList();
  const isPlaying = hook.ussIsPlaying();
  const curPlay = hook.useCurPlay();
  const curList = hook.useCurList();
  const isCursorInApp = station.cursorinapp.useSee();
  const [hoveredKey, setHoveredKey] = useState<string | null>(null); // 记录当前悬停的 item
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});

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
      <div className="fixed top-0 left-0 w-full h-full">
        <AudioVisualizerCanvas />
      </div>
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
                  onClick={() => {
                    if (disabled) return;
                    action.play(i);
                  }}
                  // 无障碍/键盘：禁用态不可聚焦
                  tabIndex={disabled ? -1 : 0}
                  aria-disabled={disabled || undefined}
                >
                  {/* 文字切换区：仅在 shouldSwap 时做有进有出的切换，否则直接显示 name */}
                  <div
                    className="cursor-pointer"
                    onMouseEnter={() => setHoveredKey(i.name)}
                    onMouseLeave={() =>
                      setHoveredKey((k) => (k === i.name ? null : k))
                    }
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
                                transition={{ duration: 0.25, ease: "easeOut" }}
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
                                transition={{ duration: 0.25, ease: "easeOut" }}
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
                  </div>
                  <AnimatePresence>
                    {isPlaying && isCursorInApp && isCurrent && (
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
                          >
                            <motionIcons.thumbsUp />
                          </div>
                          <div
                            className={cn([
                              "p-1 mt-1",
                              "hover:opacity-60 opacity-40",
                              "transition duration-300",
                            ])}
                          >
                            <motionIcons.thumbsDown />
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
                          >
                            <motionIcons.starSlash size={14} />
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

export default function Home() {
  const state = hook.useState();

  return state.match({
    play: () => <Play />,
    new_guide: () => (
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
    ),
    create: () => (
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
    ),
    _: K(null),
  });
}
