import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { icons } from "@/src/assets/icons";
import {
  action as appLogicAction,
  hook as appLogicHook,
} from "@/src/flow/appLogic";
import type {
  CollectionTitleHandoff,
  CollectionTitleTone,
  ConfigDraft,
} from "@/src/flow/appLogic/core";
import { ArcTrackList } from "./ArcTrackList";
import { HoloButton } from "./HoloButton";
import { ToolLabel, MaskL, MaskMiddle, MaskR } from "./toollabel";
import { motion } from "motion/react";
import { Torph } from "@grahlnn/comps";
import { CoverTool } from "./coverTool";
import {
  collectionTitleLayoutTransition,
  collectionTitleClassName,
  CREATE_COLLECTION_TITLE,
} from "./collectionTitle";
import { EditableTitle } from "./EditableTitle";
import {
  CREATE_COLLECTION_LAYOUT_ID,
  collectionTitleLayoutId,
} from "@/src/flow/appLogic/core";

const HASH_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const HASH_FONT_FAMILIES = [
  "var(--font-geist-pixel-square)",
  "var(--font-geist-pixel-grid)",
  "var(--font-geist-pixel-circle)",
  "var(--font-geist-pixel-triangle)",
  "var(--font-geist-pixel-line)",
] as const;
const TOOL_LABEL_ITEMS = [
  "【原神】「ジュニャーナとヴィディヤーの森」Disc 3 - 死生流転真如",
  "【原神】「ジュニャーナとヴィディヤーの森」Disc 4 - スメール戦闘編",
  "[Official] TUNIC (Original Soundtrack) - Full Album _ Lifeformed × Janice Kwan",
  "【青春猪头少年不会梦到兔女郎学姐】ED六人合唱.樱岛麻衣&梓川枫&古贺朋绘&双叶理央&丰浜和花&牧之原翔子",
] as const;
const ARC_LIST_ITEMS = [
  "[Official] TUNIC (Original Soundtrack) - Full Album _ Lifeformed × Janice Kwan",
  "【原神】「白露澄明の泉」Disc 1 - 律令の頌歌",
  "【原神】「白露澄明の泉」Disc 2 - 栄光のアリオーソ",
  "【原神】「白露澄明の泉」Disc 3 - 幽泉淙々の歌",
  "【原神】「白露澄明の泉」Disc 4 - フォンテーヌ戦記",
  "【原神】「風と牧歌の城 City of Winds and Idylls」Disc 1 - 風と牧歌の城 City of Winds and Idylls",
  "【原神】「風と牧歌の城 City of Winds and Idylls」Disc 2 - 蒲公英の国 The Horizon of Dandelion",
  "【原神】「風と牧歌の城 City of Winds and Idylls」Disc 3 - モンド戦記 Saga of the West Wind",
  "【原神】「輝く星々Vol. 3」",
  "【原神】「輝く星々Vol. 4」",
  "【原神】「輝く星々Vol. 5」",
  "【原神】「輝く星々Vol.2 The Stellar Moments Vol.2」",
  "【原神】「寂々たる無妄の国」Disc 1 - 稲光と雷櫻の大地",
  "【原神】「寂々たる無妄の国」Disc 2 - 浮世の栄枯",
  "【原神】「寂々たる無妄の国」Disc 3 - 稲妻征戦記",
  "【原神】「皎月雲間の夢」Disc 1 - 海を照す琉璃明月",
  "【原神】「皎月雲間の夢」Disc 2 - 山頂の清心、雲間の月",
  "【原神】「皎月雲間の夢」Disc 3 - 璃月鏖戦録",
  "【原神】「流変の砂、さやさやと」Disc 1 - 風砂の追懐",
  "【原神】「流変の砂、さやさやと」Disc 2 - 砂海に離散する民",
  "【原神】「流変の砂、さやさやと」Disc 3 - スメール戦闘編2",
  "【原神】「流星の軌跡」",
  "【原神】「流星の軌跡Vol. 2」",
  "【原神】「千岩の眺望」Disc 1 - 山岳重畳",
  "【原神】「千岩の眺望」Disc 2 - 淵に沈みゆく日没",
  "【原神】「千岩の眺望」Disc 3 - 戦いの響音",
  "【原神】「万水の源なる海」Disc 1 - かの者、衆の水を見守りぬ",
  "【原神】「万水の源なる海」Disc 2 - 真鍮と鉄のガイヤルド",
  "【原神】「万水の源なる海」Disc 3 - 万水の終焉に辿り着くその日まで",
  "【原神】「渦巻、落星と雪山 Vortex of Legends」",
  "【原神】「夜を照らす焔」Disc 1 - 聖山に守られし豊穣の地",
  "【原神】「夜を照らす焔」Disc 2 - 音なき戦場に集う旗",
  "【原神】「夜を照らす焔」Disc 3 - 輝く炎を掲げて",
  "【原神】「遺失と忘却の島」Disc 1 - 忘失と瞑想の島",
  "【原神】「遺失と忘却の島」Disc 2 - 海淵の下",
  "【原神】「遺失と忘却の島」Disc 3 - 稲妻征戦記2",
  "【原神】「永遠のシンフォニー」Disc 1 - ペトリコールの詩",
  "【原神】「永遠のシンフォニー」Disc 2 - 古海の大楽章",
  "【原神】「永遠のシンフォニー」Disc 3 - 昇りゆく赤月",
  "【原神】「真珠の歌」Disc 1 - 海島の童話",
  "【原神】「真珠の歌」Disc 2 - 眩い星々",
  "【原神】「真珠の歌」Disc 3 - 激流と山岳",
  "【原神】「真珠の歌」Disc 4 - 異邦人の旅路",
  "【原神】「真珠の歌2」Disc 1 - 幻世の浮生",
  "【原神】「真珠の歌2」Disc 2 - 群島奇想曲",
  "【原神】「真珠の歌2」Disc 3 - 波瀾曲折",
  "【原神】「真珠の歌3」Disc 1 - 歓喜、あるいは流れる夢の蜃気楼",
  "【原神】「真珠の歌3」Disc 2 - 俗世諸相",
  "【原神】「真珠の歌3」Disc 3 - 夢想の逸話",
  "【原神】「真珠の歌4」Disc 1 - 真夏の歌",
  "【原神】「真珠の歌4」Disc 2 - 言葉なき歌",
  "【原神】「真珠の歌4」Disc 3 - 集う光彩",
  "【原神】「ジュニャーナとヴィディヤーの森」Disc 1 - 緑に囲まれた住処",
  "【原神】「ジュニャーナとヴィディヤーの森」Disc 2 - 深林、せせらぎと秘めごと",
  "【原神】「ジュニャーナとヴィディヤーの森」Disc 3 - 死生流転真如",
  "【原神】「ジュニャーナとヴィディヤーの森」Disc 4 - スメール戦闘編",
  "【原神】風と異邦人 Le Vent et les Enfants des étoiles",
  "【原神】流星の軌跡Vol.3",
  "【ユメの喫茶店】 - ミツキヨ (Mitsukiyo) 【FULL ALBUM】",
  "24_7 -works. for stream vol.2-",
  "A Party To My Death",
  "AD_Drum'n Bass 5",
  "AD_EDM 3",
  "AD_Garage",
  "AD_HOUSE 10",
  "AD_HOUSE 11",
  "AD_HOUSE 12",
  "AD_HOUSE Winter 3",
  "AD_PIANO IX -Alt-",
  "ADvantage",
  "Blue Archive OST",
  "C418 - Releases",
  "Chainsaw Man OP_ED's Full",
  "Colors 2 _ AD_HOUSE VOCAL REMIXES",
  "Cube",
  "Cyberpunk 2077 Soundtrack",
  "Death Stranding (Original Soundtrack)",
  "DEEMO 4.0 - xi collection",
  "End of my life",
  "Epic Mountain - Playlists",
  "Freedom EP",
  "FUTURE CHALLENGE",
  "GRANBLUE FANTASY_ Relink ORIGINAL SOUNDTRACK",
  "Harry Potter - Complete Soundtrack",
  "Harry Potter and the Deathly Hallows Part 1 (soundtrack)",
  "Melatonin (OST + Licensed Music)",
  "Ori and the Will of the Wisps_ Original Soundtrack (Full Album) - Gareth Coker",
  "Phant",
  "RAVEL拉威尔 库普兰之墓 海上孤舟 小丑的晨歌 鹅妈妈组曲",
  "Requiem - Tomoki Hirata",
  "Self Expression",
  "Stardew Valley OST",
  "Stream Palette",
  "Stream Palette 4",
  "Stream Palette 5 -RANKED-",
  "TENET Official Soundtrack _ WaterTower Music",
  "TERRARIA 1.4.3 FULL SOUNDTRACK IN ORDER",
  "Uploads from John Williams - Topic",
  "Uploads from kensuke ushio - Topic",
  "works.11",
  "works.12",
  "works.13",
  "works.14",
  "Yo Kaze (All uploads)",
  "Zwei!! Original Soundtrack",
  "ZWEI2 Original Soundtrack [De-Limited]",
  "「Engage Kiss」ED中日歌词完整版／ナナヲアカリ「恋愛脳」",
  "【初音ミク】第一次H【もう石田】",
  "【刀剑终章「ANIMA」无损原声】“不也挺好吗？”",
  "【翻唱】神っぽいな (像神一样呐)【NIJISANJI EN⧸Maria Marionette】",
  "【翻唱】Let's Get It Started【Maria Marionette Ver.】",
  "【钢琴】拉威尔 镜子组曲 丑角的晨歌",
  "【拉威尔⧸卡萨多】丑角的晨歌｜法国广播爱乐乐团",
  "【青春猪头少年不会梦到兔女郎学姐】ED六人合唱.樱岛麻衣&梓川枫&古贺朋绘&双叶理央&丰浜和花&牧之原翔子",
  "【世界顶尖的暗杀者转生为异世界贵族】ED完整版",
  "【杨·霍班】Yann Robin -  Quatuor à Cordes n°2, Crescent scratches（新月刮痕）",
  "【原创音乐】「Escape」Feat.LinLin【bassy官方】",
  "【朱一清】【Yiqing Zhu】深灰，为室内管弦乐团 Deep Grey, for Chamber Orchestra",
  "【自制】拉威尔—海上孤舟 Ravel - Une barque sur l'océan - 总谱版 Score edition",
  "【总谱】拉威尔 丑角的晨歌｜4K",
  "【Enna⧸重混音】《踊》✝️来到狂欢的舞厅吧",
  "【Glass Doll ‛｜ 硝子ドール 】Aikatsu!  Cover by Maria Marionette ♡ NIJISANJI EN ♡",
  "【Isabella's Lullaby ACAPPELLA の唄】Full Acappella Cover by  Maria Marionette",
  "【Maria⧸重混音】《アイドル》💖你便是那完美的偶像",
  "【Say】 - 【打击乐协奏曲】∙ Martin Grubinger ∙ Daníel Bja",
  "【Want You Bad｜ うぉんちゅーばっど】Cover by Maria Marionette ♡NIJISANJI EN ♡",
  "【Yann Robin】 - 【提取】",
  "【オリジナルMV】可愛くなりたい 歌ってみた 【七海うらら＊】.webm",
  "鼓手高能还原｜稲葉曇 - lost umbrella(yuigot Remix)",
  "井口裕香「一番星ソノリティ」Music Video（TVアニメ「異世界おじさん」EDテーマ）.webm",
  "我早已对你心动不已啦！♡ｼｭｷ(⁎＞ᴗ＜⁎)ｼｭｷ【翻唱：ときどきどき】",
  "A Doll's Dream ♡ Maria Marionette 【ORIGINAL SONG】.webm",
  "AZALI × Crow - MECHANICAL GOD.webm",
  "C△NDY - Maria Marionette【OFFICIAL MV】Original Song オリジナル曲.webm",
  "cadode 「回夏」MV（夏日重现 ED）",
  "Maria Marionette - Marionette's Stage【OFFICIAL MV】Original Song オリジナル曲.webm",
  "Maurice Ravel - Piano Concerto for the Left Hand.webm",
  "Maurice Ravel： «Daphnis et Chloé». 2ème Suite, Simon Rattle.webm",
  "On That April Morning She Rose From Her Bed And Called",
  "Pendant Of Light 光のペンダント 原创曲",
  "Puppet Cafe - ぱぺっとかふぇ♡ Maria Marionette 【OFFICIAL MV】 Original Song",
  "Puppet Cafe ♡ Maria Marionette 【OFFICIAL MV】 Original Song.webm",
  "Rebecca Saunders - vermilion - 2003.webm",
  "Streichquartett Nr. 3 [w⧸score] 2004 ｜ Beat Furrer.webm",
  "キラキラDaydream ♡ Maria Marionette 【OFFICIAL MV】 原创歌曲",
] as const;

export interface ListConfigTitleSnapshot {
  layoutId: string;
  value: string;
  placeholder?: string;
}

export function createListConfigTitleSnapshot(
  activeLayoutId: string | null,
  draft: ConfigDraft | null,
): ListConfigTitleSnapshot | null {
  if (!activeLayoutId || !draft) {
    return null;
  }

  return {
    layoutId: activeLayoutId,
    value: draft.name,
    placeholder: draft.mode === "create" ? CREATE_COLLECTION_TITLE : undefined,
  };
}

export function resolveListConfigTitleViewModel(args: {
  activeLayoutId: string | null;
  draft: ConfigDraft | null;
  titleToneHandoff: CollectionTitleHandoff | null;
  previousSnapshot: ListConfigTitleSnapshot | null;
}) {
  const snapshot =
    createListConfigTitleSnapshot(args.activeLayoutId, args.draft) ??
    args.previousSnapshot;
  const layoutId = snapshot?.layoutId;

  return {
    snapshot,
    autoFocus: Boolean(args.activeLayoutId && args.draft?.mode === "create"),
    handoffTone:
      layoutId && args.titleToneHandoff?.layoutId === layoutId
        ? args.titleToneHandoff.tone
        : null,
    layoutId,
    placeholder: snapshot?.placeholder,
    value: snapshot?.value ?? "",
  } as {
    snapshot: ListConfigTitleSnapshot | null;
    autoFocus: boolean;
    handoffTone: CollectionTitleTone | null;
    layoutId: string | undefined;
    placeholder?: string;
    value: string;
  };
}

function createDisplayHash(length = 5) {
  const values = new Uint32Array(length);

  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(values);
  } else {
    for (let index = 0; index < length; index += 1) {
      values[index] = Math.floor(Math.random() * HASH_ALPHABET.length);
    }
  }

  return Array.from(
    values,
    (value) => HASH_ALPHABET[value % HASH_ALPHABET.length],
  ).join("");
}

function FnButton({ text }: { text: string }) {
  return (
    <div
      className={cn(
        "w-fit h-fit",
        // "flex items-center justify-between",
        // "flex items-center justify-between w-fit gap-2 whitespace-nowrap",
        "[corner-shape:squircle_squircle_squircle_squircle] rounded-[25px] outline-none",
        "cursor-pointer transition duration-300 ease-in-out",
        // "data-[size=default]:h-9 data-[size=sm]:h-8",
        "px-2 py-1 text-sm",
        "text-xs text-[#525252] dark:text-[#e5e5e5] hover:text-[#262626] hover:dark:text-[#d4d4d4]",
        "hover:bg-[#e7eced] dark:hover:bg-[#383838]",
        // open && "bg-[#f1f5f9] dark:bg-[#1a1a1b]",
      )}
      // onClick={() => setOpen((v) => !v)}
    >
      {text}
    </div>
  );
}

export function ListConfig() {
  const { activeLayoutId, draft, titleToneHandoff } = appLogicHook.useContext();
  const titleSnapshotRef = useRef<ListConfigTitleSnapshot | null>(null);
  const [displayHash] = useState(() => createDisplayHash());
  const titleViewModel = resolveListConfigTitleViewModel({
    activeLayoutId,
    draft,
    titleToneHandoff,
    previousSnapshot: titleSnapshotRef.current,
  });

  if (titleViewModel.snapshot) {
    titleSnapshotRef.current = titleViewModel.snapshot;
  }

  const contentFadeProps = {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: collectionTitleLayoutTransition,
  } as const;

  return (
    <div className={cn("relative flex flex-col w-160 mx-auto mt-24")}>
      <div className={cn("relative z-20 flex flex-col")}>
        <motion.div {...contentFadeProps}>
          <button
            type="button"
            onClick={appLogicAction.back}
            className={cn(
              "group relative isolate inline-flex w-fit cursor-pointer select-none py-2 pr-2",
              "before:absolute before:inset-y-0 before:-left-2 before:right-0 before:-z-10",
              "before:rounded-[25px] before:bg-transparent before:transition before:duration-300",
              "before:[corner-shape:squircle_squircle_squircle_squircle]",
              "hover:before:bg-[#e5e5e5] dark:hover:before:bg-[#262626]",
            )}
          >
            <icons.arrowDown className="rotate-90 text-[#737373] dark:text-[#8a8a8a] group-hover:text-[#262626] dark:group-hover:text-[#d4d4d4] transition duration-300" />
          </button>
        </motion.div>
        <EditableTitle
          autoFocus={titleViewModel.autoFocus}
          className={cn("text-4xl font-bold", "w-fit")}
          handoffTone={titleViewModel.handoffTone}
          layoutId={titleViewModel.layoutId}
          placeholder={titleViewModel.placeholder}
          style={{ fontFamily: "var(--font-noto-sans)" }}
          value={titleViewModel.value}
          onChange={appLogicAction.changeDraftName}
        />
        <motion.div {...contentFadeProps}>
          <ToolLabel
            className="mt-2"
            textClassName="text-sm trim-cap text-[#404040] dark:text-[#a3a3a3]"
            text="C:\\download"
            tool={
              <>
                <CoverTool text="Change" />
                <MaskR />
              </>
            }
          />
          <div className="h-24" />
          <div className="flex justify-between">
            <div className="flex gap-2">
              <FnButton text="Paste" />
              <FnButton text="Imoprt" />
            </div>

            <div>{/*<FnButton text="Save" />*/}</div>
          </div>
          <div className="h-2" />
        </motion.div>
      </div>

      <motion.div {...contentFadeProps} className="relative z-10 flex flex-col">
        {TOOL_LABEL_ITEMS.map((item, index) => (
          <div key={`${item}-${index}`} className="py-2 group">
            <div
              className={cn(
                "flex items-center backdrop-blur-md w-fit gap-2 pr-1",
                "rounded-full",
              )}
            >
              <ToolLabel
                className={cn("")}
                hoverMode="group"
                toolLayer="portal"
                text={item}
                textClassName="text-[12px] text-[#404040] dark:text-[#a3a3a3]"
                tool={
                  <div className="flex justify-between w-full items-center">
                    <div className="flex h-fit">
                      <CoverTool text="Enable Update" />
                      <MaskR />
                    </div>
                    <div className="flex h-fit">
                      <MaskL />
                      <CoverTool text="Pop" />
                    </div>
                  </div>
                }
              />
              <icons.autoDownload size={12} />
            </div>
          </div>
        ))}
      </motion.div>

      <motion.div {...contentFadeProps}>
        <ArcTrackList items={ARC_LIST_ITEMS} />
      </motion.div>
    </div>
  );
}
