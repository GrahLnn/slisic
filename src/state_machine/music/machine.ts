import {
  and,
  createMachine,
  enqueueActions,
  fromCallback,
  raise,
  spawnChild,
} from "xstate";
import { goto, godown, invokeState } from "../kit";
import { src } from "./src";
import { payloads, ss, sub_machine, invoker } from "./events";
import { resultx } from "../state";
import { ActorDone } from "../muinfo";
import { B, call0, I, K } from "@/lib/comb";
import { events } from "@/src/cmd/commands";
import crab from "@/src/cmd";
import { tap } from "@/lib/result";
import { lievt } from "@/src/cmd/commandAdapter";
import { Frame, new_frame } from "./core";

export const machine = src.createMachine({
  initial: ss.mainx.State.idle,
  context: {
    collections: [],
    flatList: [],
    reviews: [],
    audio: new Audio(),
    audioFrame: new_frame(),
  },
  on: {
    unmount: {
      target: godown(ss.mainx.State.idle),
      actions: "clean_ctx",
      reenter: true,
    },
    add_review_actor: {
      actions: "add_review_actor",
    },
    [sub_machine.review.evt()]: {
      actions: "over_review",
    },
    update_single: {
      actions: "update_single",
    },
  },
  invoke: {
    src: fromCallback(({ sendBack }) => {
      const pr = lievt("processResult")(() =>
        crab.readAll().then(tap(B(payloads.update_single.load)(sendBack)))
      );
      return () => {
        pr.then(call0);
      };
    }),
  },
  states: {
    [ss.mainx.State.idle]: {
      on: {
        run: ss.mainx.State.loading,
      },
    },
    [ss.mainx.State.loading]: {
      type: "parallel",
      states: invokeState(invoker.load_collections.name, "update_colls"),

      onDone: [
        {
          target: ss.mainx.State.play,
          guard: "hasData",
        },
        {
          target: ss.mainx.State.new_guide,
          guard: "noData",
        },
      ],
    },
    [ss.mainx.State.play]: {
      initial: ss.playx.State.stop,
      on: {
        to_create: {
          target: ss.mainx.State.create,
          actions: "new_slot",
        },
      },
      states: {
        [ss.playx.State.playing]: {
          invoke: {
            id: "analyzeAudio",
            src: "analyzeAudio",
            input: ({ context }) => ({
              audio: context.audio,
              analyzer: context.analyzer,
            }),
          },
          entry: "play_audio",
          on: {
            [payloads.update_audio_frame.evt()]: {
              actions: "update_audio_frame",
            },
            toggle_audio: {
              actions: ["reset_frame", "stop_audio", "clean_audio"],
              target: ss.playx.State.stop,
            },
            next: {
              actions: ["reset_frame", "stop_audio"],
              target: ss.playx.State.next,
            },
          },
        },
        [ss.playx.State.next]: {
          entry: [
            "ensure_analyzer",
            "ensure_play",
            raise(ss.playx.Signal.to_playing),
          ],
          on: ss.playx.transfer.pick("to_playing"),
        },
        [ss.playx.State.stop]: {
          on: {
            toggle_audio: {
              actions: ["ensure_analyzer", "ensure_list", "ensure_play"],
              target: ss.playx.State.playing,
            },
          },
        },
      },
    },
    [ss.mainx.State.fast_edit]: {},
    [ss.mainx.State.new_guide]: {
      id: ss.mainx.State.new_guide,
      entry: "hide_center_tool",
      on: {
        to_create: {
          target: ss.mainx.State.create,
          actions: "new_slot",
        },
      },
    },
    [ss.mainx.State.create]: {
      on: {
        to_loading: ss.mainx.State.loading,
        set_slot: {
          actions: "edit_slot",
          target: godown(resultx.State.err),
        },
        back: [
          {
            target: ss.mainx.State.play,
            guard: "hasData",
            actions: "clean_slot",
          },
          {
            target: ss.mainx.State.new_guide,
            guard: "noData",
            actions: "clean_slot",
          },
        ],
      },
      initial: resultx.State.err,
      states: {
        [resultx.State.err]: {
          entry: raise(resultx.Signal.go),
          on: {
            go: {
              target: resultx.State.ok,
              guard: "is_list_complete",
            },
          },
        },
        [resultx.State.ok]: {
          on: {
            done: goto(ss.mainx.State.save),
          },
        },
      },
    },
    [ss.mainx.State.save]: {
      id: ss.mainx.State.save,
      invoke: {
        id: invoker.save_collections.name,
        src: invoker.save_collections.name,
        input: ({ context: { slot } }) => ({
          slot,
        }),
        onDone: {
          target: ss.mainx.State.loading,
          actions: "clean_ctx",
        },
      },
    },
  },
});
