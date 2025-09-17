import { and, fromCallback, raise } from "xstate";
import { goto, godown, invokeState } from "../kit";
import { src } from "./src";
import { payloads, ss, sub_machine, invoker } from "./events";
import { resultx } from "../state";
import { B, call0 } from "@/lib/comb";
import crab from "@/src/cmd";
import { tap } from "@/lib/result";
import { lievt } from "@/src/cmd/commandAdapter";

export const machine = src.createMachine({
  initial: ss.mainx.State.idle,
  context: {
    collections: [],
    flatList: [],
    reviews: [],
    folderReviews: [],
    updateWeblistReviews: [],
  },
  on: {
    unmount: {
      target: godown(ss.mainx.State.idle),
      actions: "clean_ctx",
      reenter: true,
    },
    add_review_actor: {
      actions: ["add_review_actor", raise(ss.mainx.Signal.review_check)],
    },
    [sub_machine.review.evt()]: {
      actions: ["over_review", raise(ss.mainx.Signal.review_check)],
    },
    add_folder_check: {
      actions: ["add_folder_check", raise(ss.mainx.Signal.review_check)],
    },
    [sub_machine.check_folder.evt()]: {
      actions: [
        "over_folder_check",
        "update_coll",
        raise(ss.mainx.Signal.review_check),
      ],
    },
    update_web_entry: {
      actions: ["add_weblist_update", raise(ss.mainx.Signal.review_check)],
    },
    [sub_machine.update_weblist.evt()]: {
      actions: [
        "over_weblist_update",
        "update_coll",
        raise(ss.mainx.Signal.review_check),
      ],
    },
    update_single: {
      actions: "update_single",
    },
    processMsg: {
      actions: "set_msg",
    },
  },
  invoke: {
    src: fromCallback(({ sendBack }) => {
      const pr = lievt("processResult")(() =>
        crab.readAll().then(tap(B(payloads.update_single.load)(sendBack)))
      );
      const pcmsg = lievt("processMsg")(B(payloads.processMsg.load)(sendBack));
      return () => {
        pr.then(call0);
        pcmsg.then(call0);
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
      id: ss.mainx.State.loading,
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
        delete: {
          actions: ["delete", raise(ss.mainx.Signal.after_delete)],
        },
        AFTER_DELETE: [{ guard: "noData", target: ss.mainx.State.new_guide }],
      },
      states: {
        [ss.playx.State.playing]: {
          entry: ["play_audio"],
          on: {
            toggle_audio: {
              actions: [
                "reset_frame",
                "stop_audio",
                "clean_judge",
                "clean_audio",
              ],
              target: ss.playx.State.stop,
            },
            next: {
              actions: [
                "reset_frame",
                "stop_audio",
                "clean_judge",
                "fatigue_parm",
                "update_last",
                "update_list",
                "update_selected",
                "update_coll",
              ],
              target: ss.playx.State.next,
            },
            not_exist: {
              actions: [
                "not_exist",
                "update_coll",
                "clean_not_exist",
                raise(ss.playx.Signal.next),
              ],
            },
            unstar: {
              actions: ["unstar", "update_coll"],
              target: ss.playx.State.next,
            },
            up: {
              actions: ["up", "boost_parm", "update_coll"],
            },
            down: {
              actions: [
                "down",
                "fatigue_parm",
                "cancle_boost_parm",
                "update_coll",
              ],
            },
            cancle_up: {
              actions: ["cancle_up", "cancle_boost_parm", "update_coll"],
            },
            cancle_down: {
              actions: ["cancle_down", "cancle_fatigue_parm", "update_coll"],
            },
          },
        },
        [ss.playx.State.next]: {
          entry: ["ensure_play", raise(ss.playx.Signal.to_playing)],
          on: ss.playx.transfer.pick("to_playing"),
        },
        [ss.playx.State.stop]: {
          on: {
            toggle_audio: {
              actions: ["ensure_list", "ensure_play"],
              target: ss.playx.State.playing,
            },
            edit_playlist: {
              actions: "into_slot",
              target: goto(ss.mainx.State.edit),
            },
          },
        },
      },
    },
    [ss.mainx.State.edit]: {
      id: ss.mainx.State.edit,
      on: {
        back: {
          actions: "clean_slot",
          target: ss.mainx.State.play,
        },
        set_slot: {
          actions: "edit_slot",
          target: godown(resultx.State.err),
        },
      },
      initial: resultx.State.err,
      states: {
        [resultx.State.err]: {
          always: [
            {
              guard: and(["is_list_complete", "is_data_diff"]),
              target: resultx.State.ok,
            },
          ],
          on: {
            review_check: [
              {
                guard: and(["is_list_complete", "is_data_diff"]),
                target: resultx.State.ok,
              },
            ],
          },
        },
        [resultx.State.ok]: {
          entry: raise(ss.mainx.Signal.review_check),
          on: {
            done: goto(ss.mainx.State.updating),
            review_check: {
              target: resultx.State.err,
              guard: "is_review",
            },
          },
        },
      },
    },
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
          always: {
            target: resultx.State.ok,
            guard: "is_list_complete",
          },
          on: {
            review_check: {
              target: resultx.State.ok,
              guard: "is_review",
            },
          },
        },
        [resultx.State.ok]: {
          entry: raise(ss.mainx.Signal.review_check),
          on: {
            done: goto(ss.mainx.State.saving),
            review_check: {
              target: resultx.State.err,
              guard: "is_review",
            },
          },
        },
      },
    },
    [ss.mainx.State.updating]: {
      id: ss.mainx.State.updating,
      invoke: {
        id: invoker.update_collection.name,
        src: invoker.update_collection.name,
        input: ({ context: { slot, selected } }) => ({
          slot,
          selected,
        }),
        onDone: {
          target: ss.mainx.State.loading,
          actions: "clean_ctx",
        },
      },
    },
    [ss.mainx.State.saving]: {
      id: ss.mainx.State.saving,
      invoke: {
        id: invoker.save_collection.name,
        src: invoker.save_collection.name,
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
