import {
  setup,
  assign,
  enqueueActions,
  fromCallback,
  raise,
  assertEvent,
} from "xstate";
import {
  InvokeEvt,
  eventHandler,
  UniqueEvts,
  PayloadEvt,
  SignalEvt,
  MachineEvt,
} from "../kit";
import { Context, Frame, new_frame, new_slot } from "./core";
import { payloads, ss, sub_machine, invoker } from "./events";
import { I, K, B } from "@/lib/comb";
import { udf, vec } from "@/lib/e";
import { hideCenterTool, viewCenterTool } from "../centertool";
import { fileToBlobUrl, pickRandom } from "@/lib/utils";
import { convertFileSrc } from "@tauri-apps/api/core";
import { AudioAnalyzer } from "@/src/components/audio/analyzer";
import { station } from "@/src/subpub/buses";

export interface PlayerCtx {
  audio: HTMLAudioElement;
  analyzer?: AudioAnalyzer;
  audioFrame: Frame;
}

const analyzeAudio = fromCallback<
  any,
  { audio: HTMLAudioElement; analyzer?: AudioAnalyzer }
>(({ input, sendBack, receive }) => {
  const analyzer = input.analyzer ?? new AudioAnalyzer(2048, 0.8);
  let stop: null | (() => void) = null;
  let closed = false;

  analyzer.connect(input.audio).then(() => {
    if (closed) return;
    stop = analyzer.onFrame((frame) => {
      if (closed) return;
      //   sendBack(payloads.update_audio_frame.load(frame));
      station.audioFrame.set(frame);
    });
  });

  receive((evt) => {
    if (evt?.type === "analyzer.stop") {
      closed = true;
      stop?.();
      analyzer.disconnect();
    }
  });

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
    ensure_list: assign({
      flatList: EH.whenDone(payloads.toggle_audio.evt())((i) =>
        i!.folders.flatMap((f) => f.musics)
      ),
      selected: EH.whenDone(payloads.toggle_audio.evt())((i) => i || undefined),
    }),
    ensure_play: assign({
      nowPlaying: ({ context }) => {
        const all = context.flatList;
        if (all.length === 0) return;

        let idx = Math.floor(Math.random() * all.length);
        if (all.length > 1) {
          idx =
            (idx + 1 + Math.floor(Math.random() * (all.length - 1))) %
            all.length;
        }
        const mu = all[idx];
        return mu;
      },
    }),
    play_audio: async ({ context, self }) => {
      const cur_mu = context.nowPlaying;
      if (!cur_mu) return;
      const url = await fileToBlobUrl(cur_mu.path);
      context.audio.crossOrigin = "anonymous";
      context.audio.src = url;
      context.audio.play();
      context.audio.onended = () => self.send(ss.playx.Signal.next);
    },
    stop_audio: ({ context }) => {
      context.audio.onended = null;
      context.audio.pause();
      context.audio.currentTime = 0;
    },
    clean_audio: assign({
      nowPlaying: udf,
      selected: udf,
    }),
    reset_frame: () => station.audioFrame.set(new_frame()),
    update_audio_frame: ({ event }) => {
      assertEvent(event, payloads.update_audio_frame.evt());
      station.audioFrame.set(event.output);
    },
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
