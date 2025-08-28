import { setup, assign, assertEvent, fromCallback } from "xstate";
import {
  InvokeEvt,
  eventHandler,
  UniqueEvts,
  PayloadEvt,
  SignalEvt,
  MachineEvt,
} from "../kit";
import { Context, Frame, new_frame, new_slot } from "./core";
import { payloads, ss, sub_machine } from "./state";
import { invoker } from "./utils";
import { I, K, B } from "@/lib/comb";
import { udf, vec } from "@/lib/e";
import { hideCenterTool, viewCenterTool } from "../centertool";
import { fileToBlobUrl, pickRandom } from "@/lib/utils";
import { convertFileSrc } from "@tauri-apps/api/core";
import { AudioAnalyzer } from "@/src/components/audio/Analyzer";

export const analyzeAudio = fromCallback<
  // 让 receive 的事件随便 any，避免类型约束阻塞
  any,
  { audio: HTMLAudioElement; analyzer?: AudioAnalyzer }
>(({ input, sendBack, receive }) => {
  const analyzer = input.analyzer ?? new AudioAnalyzer(2048, 0.8);
  let stop: null | (() => void) = null;
  let closed = false;
  console.log(input);
  analyzer.connect(input.audio).then(() => {
    if (closed) return;
    stop = analyzer.onFrame(B(payloads.update_audio_frame.load)(sendBack));
  });

  // 可选：支持外部发来的“停止采样”消息
  receive((evt) => {
    if (evt?.type === "analyzer.stop") {
      closed = true;
      stop?.();
      analyzer.disconnect();
    }
  });

  // Cleanup：离开被 invoke 的状态时自动调用
  return () => {
    closed = true;
    stop?.();
    analyzer.disconnect();
  };
});

type Events = UniqueEvts<
  | SignalEvt<typeof ss>
  | InvokeEvt<typeof invoker>
  | PayloadEvt<typeof payloads.infer>
  | MachineEvt<typeof sub_machine.infer>
>;
export const EH = eventHandler<Context, Events>();
export const src = setup({
  actors: { ...invoker.send_all(), analyzeAudio },
  types: {
    context: {} as Context,
    events: {} as Events,
  },
  actions: {
    hide_center_tool: hideCenterTool,
    view_center_tool: viewCenterTool,
    clean_ctx: assign({
      collections: vec,
      slot: udf,
    }),
    clean_slot: assign({
      slot: udf,
    }),
    update_colls: assign({
      collections: EH.whenDone(invoker.load_collections.evt())(I),
    }),
    new_slot: assign({
      slot: new_slot,
    }),
    edit_slot: assign({
      slot: EH.whenDone(payloads.set_slot.evt())(I),
    }),
    add_review_actor: assign({
      reviews: EH.whenDone(payloads.add_review_actor.evt())(
        (url, c, _evt, sp) =>
          c.reviews.concat({
            url,
            actor: sp(sub_machine.review)({ url }),
          })
      ),
    }),
    over_review: assign({
      reviews: EH.whenDone(sub_machine.review.evt())((i, c) =>
        c.reviews.filter((r) => r.url !== i.url)
      ),
      slot: EH.whenDone(sub_machine.review.evt())((i, c) => {
        if (!c.slot) return;
        return {
          ...c.slot,
          links: c.slot.links.map((link) =>
            link.url === i.url
              ? {
                  ...link,
                  title_or_msg: i.r.answer(),
                  status: i.r.name(),
                }
              : link
          ),
        };
      }),
    }),
    update_single: assign({
      collections: EH.whenDone(payloads.update_single.evt())(I),
    }),
    play_audio: EH.take(payloads.toggle_audio.evt())(async (ctx, event) => {
      const all = event.output.folders.flatMap((f) => f.musics);
      if (all.length === 0) return;

      let last = -1;
      let lastUrl: string | null = null;

      const playNext = async () => {
        if (all.length === 0) return;

        let idx = Math.floor(Math.random() * all.length);
        if (all.length > 1 && idx === last) {
          idx =
            (idx + 1 + Math.floor(Math.random() * (all.length - 1))) %
            all.length;
        }
        last = idx;

        const path = all[idx].path;
        const url = await fileToBlobUrl(path);

        if (lastUrl) URL.revokeObjectURL(lastUrl);
        lastUrl = url;

        ctx.audio.crossOrigin = "anonymous";
        ctx.audio.src = url;
        void ctx.audio.play();
      };

      ctx.audio.onended = () => {
        void playNext();
      };
      await playNext();
    }),
    stop_audio: EH.take(payloads.toggle_audio.evt())((ctx) => {
      ctx.audio.onended = null;
      ctx.audio.pause();
      ctx.audio.currentTime = 0;
    }),
    reset_frame: assign({
      audioFrame: new_frame,
    }),
    update_audio_frame: assign({
      audioFrame: EH.whenDone(payloads.update_audio_frame.evt())(I),
    }),
    ensure_analyzer: assign({
      analyzer: ({ context }) =>
        context.analyzer ?? new AudioAnalyzer(2048, 0.8),
    }),
  },
  guards: {
    hasData: ({ context }) => context.collections.length > 0,
    noData: ({ context }) => context.collections.length === 0,
    is_list_complete: ({ context }) =>
      (context.slot?.name.trim().length ?? 0) > 0,
  },
});
