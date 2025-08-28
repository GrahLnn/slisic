import { AnimatePresence, motion } from "motion/react";
import { SpotlightSection } from "../components/arc_scroll";
import { useMemo } from "react";
import { labels } from "../components/labels";
import { cn } from "@/lib/utils";
import { motionIcons } from "../assets/icons";
import { action, hook } from "../state_machine/music";
import { K } from "@/lib/comb";
import { EmptyPage } from "../components/empty";
import { New } from "../components/music/new";
import { ListSeparator } from "../components/uni";
import { AudioVisualizerCanvas } from "../components/audio/canvas";
import { useAudioAnalyzer } from "../components/audio/useAudioAnalyzer";

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

export default function Home() {
  const lists = hook.useList();
  const state = hook.useState();
  const frame = hook.useAudioFrame();
  const GUIDE_ITEMS: GuideItem[] = lists
    .map((l) => ({
      title: l.name,
      content: l.folders.every((i) => i.downloaded_ok) ? (
        <labels.musicPlay />
      ) : (
        <labels.working />
      ),
      fn: () => action.play(l),
    }))
    .concat({
      title: "Add",
      content: <labels.musicPlus />,
      fn: () => {},
    });

  return state.match({
    play: () => (
      <>
        <div className="fixed top-0 left-0 w-full h-full">
          <AudioVisualizerCanvas audioData={frame} />
        </div>
        <Face>
          {/* <SpotlightSection
            items={GUIDE_ITEMS}
            render={(item, index) => (
              <Card
                key={item.title}
                content={item.content}
                title={item.title}
                idx={index + 1}
                zIndex={index}
                onClick={item.fn}
              />
            )}
            gap={0.08}
            speed={0.3}
            arcRadius={500}
            pinVhMultiplier={10}
          /> */}
          <div
            className={cn([
              "flex flex-col justify-center items-center z-10 w-full h-full",
              "text-2xl font-cinzel",
            ])}
          >
            †countdown to death†
          </div>
        </Face>
      </>
    ),
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
        <div className="flex w-full h-full overflow-hidden">
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
