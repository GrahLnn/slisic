import { setup, assign, assertEvent } from "xstate";
import { eventHandler } from "../kit";
import { Context, Frame, into_slot, new_frame, new_slot } from "./core";
import { payloads, ss, sub_machine, invoker, Events } from "./events";
import { I, K } from "@/lib/comb";
import { udf, vec } from "@/lib/e";
import { hideCenterTool, viewCenterTool } from "../centertool";
import { fileToBlobUrl } from "@/lib/utils";
import { AudioAnalyzer } from "@/src/components/audio/analyzer";
import { station } from "@/src/subpub/buses";
import { Music } from "@/src/cmd/commands";
import crab from "@/src/cmd";
import { AudioEngine } from "@/src/components/audio/engine";
import { ss as muss } from "../muinfo";

export interface PlayerCtx {
  audio: HTMLAudioElement;
  analyzer?: AudioAnalyzer;
  audioFrame: Frame;
}

function computeLogit(m: Music) {
  // 你的规则：logit 越高 = 越不想选，entry 也有疲劳惩罚
  return (m.base_bias + m.fatigue) * (1 - m.user_boost);
}
const incBoost = (v?: number, step = 0.1, max = 0.9) => {
  const x = Number.isFinite(v) ? (v as number) : 0; // 未定义/NaN 当 0
  // 加一步并四舍五入到 1 位小数，规避二进制小数误差
  const y = Math.round((x + step) * 10) / 10;
  return y > max ? max : y;
};
function softminSample(all: Music[], T = 0.8, rng = Math.random): number {
  const logits = all.map(computeLogit);
  // softmin = softmax(-logit/T)
  const invT = 1 / Math.max(T, 1e-6);
  const scaled = logits.map((v) => -v * invT);
  const m = Math.max(...scaled);
  const exps = scaled.map((v) => Math.exp(v - m));
  const sum = exps.reduce((a, b) => a + b, 0);
  let r = rng() * sum;
  for (let i = 0; i < exps.length; i++) {
    r -= exps[i];
    if (r <= 0) return i;
  }
  return exps.length - 1;
}

const sameTrack = (a?: Music, b?: Music) => !!a && !!b && a.path === b.path;

export const EH = eventHandler<Context, Events>();
export const src = setup({
  actors: { ...invoker.as_act(), ...sub_machine.as_act() },
  types: {
    context: {} as Context,
    events: {} as Events,
  },
  actions: {
    hide_center_tool: hideCenterTool,
    view_center_tool: viewCenterTool,
    set_msg: assign({
      processMsg: EH.whenDone(payloads.processMsg.evt())((r) => {
        console.log(r);
        return r;
      }),
    }),
    clean_ctx: assign({
      collections: vec,
      slot: udf,
    }),
    clean_slot: assign({
      slot: udf,
      selected: udf,
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
    add_folder_check: assign({
      folderReviews: EH.whenDone(payloads.add_folder_check.evt())(
        (entry, c, _evt, sp) =>
          c.folderReviews.concat({
            path: entry.path!,
            actor: sp(sub_machine.check_folder)({ entry }),
          })
      ),
    }),
    add_weblist_update: assign({
      updateWeblistReviews: EH.whenDone(payloads.update_web_entry.evt())(
        (entry, c, _evt, sp) =>
          c.updateWeblistReviews.concat({
            url: entry.url!,
            actor: sp(sub_machine.update_weblist)({
              entry,
              playlist: c.selected?.name!,
            }),
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
                  title_or_msg: i.r.match({
                    Ok: (r) => r.title,
                    Err: I,
                  }),
                  entry_type: i.r.match({
                    Ok: (r) => {
                      switch (r.item_type) {
                        case "playlist":
                          return "WebList";
                        default:
                          return "WebVideo";
                      }
                    },
                    Err: K("Unknown"),
                  }),
                  count: i.r.match({
                    Ok: (r) => r.entries_count,
                    Err: K(null),
                  }),
                  status: i.r.name(),
                }
              : link
          ),
        };
      }),
    }),
    over_folder_check: assign({
      folderReviews: EH.whenDone(sub_machine.check_folder.evt())(({ r }, c) =>
        r.match({
          Ok: (g) => c.folderReviews.filter((r) => r.path !== g.path),
          Err: K(c.folderReviews),
        })
      ),
      slot: EH.whenDone(sub_machine.check_folder.evt())(({ r }, c) => {
        if (!c.slot || r.isErr()) return c.slot;
        const entry = r.unwrap();
        return {
          ...c.slot,
          entries: c.slot.entries.map((e) =>
            e.path === entry.path ? entry : e
          ),
        };
      }),
      selected: EH.whenDone(sub_machine.check_folder.evt())(({ r }, c) => {
        if (!c.selected || r.isErr()) return c.selected;
        const entry = r.unwrap();
        return {
          ...c.selected,
          entries: c.selected.entries.map((e) =>
            e.path === entry.path ? entry : e
          ),
        };
      }),
    }),
    over_weblist_update: assign({
      updateWeblistReviews: EH.whenDone(sub_machine.update_weblist.evt())(
        ({ r }, c) =>
          r.match({
            Ok: (entry) => {
              return c.updateWeblistReviews.filter((r) => r.url !== entry.url);
            },
            Err: K(c.updateWeblistReviews),
          })
      ),
      slot: EH.whenDone(sub_machine.update_weblist.evt())(({ r }, c) => {
        if (!c.slot || r.isErr()) return c.slot;
        const entry = r.unwrap();
        return {
          ...c.slot,
          entries: c.slot.entries.map((e) =>
            e.path === entry.path ? entry : e
          ),
        };
      }),
      selected: EH.whenDone(sub_machine.update_weblist.evt())(({ r }, c) => {
        if (!c.selected || r.isErr()) return c.selected;
        const entry = r.unwrap();
        return {
          ...c.selected,
          entries: c.selected.entries.map((e) =>
            e.path === entry.path ? entry : e
          ),
        };
      }),
    }),
    update_single: assign({
      collections: EH.whenDone(payloads.update_single.evt())(I),
      processMsg: udf,
    }),
    ensure_list: assign({
      flatList: EH.whenDone(payloads.toggle_audio.evt())((i) =>
        i!.entries
          .flatMap((f) => f.musics)
          .filter((m) => !i?.exclude.map((e) => e.path).includes(m.path))
      ),
      selected: EH.whenDone(payloads.toggle_audio.evt())((i) => i || undefined),
    }),
    ensure_play: assign({
      nowPlaying: ({ context }) => {
        const all: Music[] = context.flatList;
        if (all.length === 0) return;

        const last = context.lastPlay;

        // 1) 从概率计算中排除 lastPlaying
        const pool = last ? all.filter((m) => !sameTrack(m, last)) : all;

        // 2) 候选集空了（只有一首且正好是 last）：回退到原列表
        const base = pool.length > 0 ? pool : all;

        // 3) softmin 抽样
        const idx = softminSample(base, 0.8);

        // 4) 返回抽中的歌
        return base[idx];
      },
    }),
    stop_audio: async ({ context, self }) => {
      const { engine, audio, analyzer } = context;
      self.send(ss.playx.Signal.analyzerstop);
      // 先停采样
      context.playToken = (context.playToken ?? 0) + 1;
      context.__stopSampling?.();
      context.__stopSampling = undefined;
      analyzer?.stopSampling();

      // 再淡出并停播，防爆音
      engine?.fadeOut(25);
      await new Promise((r) => setTimeout(r, 35));
      audio.onended = null;
      audio.pause();
      audio.currentTime = 0;
    },
    clean_judge: assign({
      nowJudge: udf,
    }),
    resume_ctx: ({ context }) =>
      context.engine?.resume?.() || context.engine?.ctx.resume?.(),
    play_audio: async ({ context, self }) => {
      const { engine, analyzer, audio, nowPlaying: cur, selected } = context;
      if (!engine || !analyzer || !cur) return;

      const token = (context.playToken = (context.playToken ?? 0) + 1);
      const liveToken = () => self.getSnapshot().context.playToken!;

      // 统一接线
      analyzer.attachTo(engine.ctx);
      engine.ensureSource(audio);
      analyzer.setTapFrom(engine.lufs);

      // 停旧采样
      try {
        context.__stopSampling?.();
      } catch {}
      context.__stopSampling = undefined;
      analyzer.stopSampling?.();

      const exists = await crab.exists(cur.path);
      exists.tap((ok) => {
        if (!ok) {
          console.warn("[play_audio] file missing", cur.path);
          self.send(payloads.not_exist.load(cur));
          return;
        }
      });

      // 准备音源
      const url = await fileToBlobUrl(cur.path);
      if (liveToken() !== token) return;
      audio.crossOrigin = "anonymous";
      audio.src = url;

      // 确保可听
      audio.muted = false;
      audio.volume = 1;

      // 先淡出，再设响度（以 playlist 的 avg_db 做目标；无则 -14）
      engine.fadeOut(1);
      const targetLufs = selected?.avg_db ?? -14;
      engine.setLoudnessFromAvgDb(cur.avg_db, targetLufs, 12);

      // 等 canplay（带 3s 探针日志）
      await new Promise<void>((resolve) => {
        const oncp = () => {
          audio.removeEventListener("canplay", oncp);
          resolve();
        };
        audio.addEventListener("canplay", oncp, { once: true });
        if (audio.readyState >= 2) resolve();
        setTimeout(() => {
          if (audio.readyState < 2) {
            console.warn("[play_audio] canplay timeout", {
              rs: audio.readyState,
              src: audio.src,
            });
          }
        }, 3000);
      });

      // 先确保 AudioContext 不是 suspended
      try {
        await (engine.resume?.() || engine.ctx.resume?.());
      } catch {}
      if (liveToken() !== token) return;
      // 播放
      try {
        await audio.play();
      } catch (err) {
        console.error("[play_audio] play() rejected", err, audio.error);
        return;
      }
      if (liveToken() !== token) return;
      // ------- 关键：等待“时钟真的动起来” -------
      const waitTimebase = (kick = false) =>
        new Promise<boolean>((resolve) => {
          let fired = false;
          const T_DEADLINE = 1600; // 最多等 1.6s
          const T_POLL = 100; // 100ms 轮询 currentTime
          const MIN_T = 0.02; // 认为“动起来”的最小时间

          const onPlaying = () => {
            fired = true;
            cleanup(true);
          };
          const timer = setInterval(() => {
            if (audio.currentTime > MIN_T) {
              fired = true;
              cleanup(true);
            }
          }, T_POLL);
          const to = setTimeout(() => {
            if (!fired) cleanup(false);
          }, T_DEADLINE);

          const cleanup = (ok: boolean) => {
            audio.removeEventListener("playing", onPlaying);
            clearInterval(timer);
            clearTimeout(to);
            resolve(ok);
          };
          audio.addEventListener("playing", onPlaying, { once: true });

          // 可选：kick 前先做一次极小 seek，有些浏览器会因此点火时钟
          if (kick) {
            try {
              const t0 = audio.currentTime;
              audio.currentTime = Math.max(0, t0 + 0.001);
            } catch {}
          }
        });

      // 第一次等待（不 kick）
      let ok = await waitTimebase(false);
      if (liveToken() !== token) return;
      if (!ok) {
        console.warn("[play_audio] timebase stuck, kicking…");
        // “踢一下”：暂停→微 seek→play
        try {
          audio.pause();
        } catch {}
        try {
          audio.currentTime = 0.001;
        } catch {}
        try {
          await audio.play();
          if (liveToken() !== token) return;
        } catch (e) {
          console.error("[play_audio] kick play() rejected", e, audio.error);
          return;
        }
        ok = await waitTimebase(true);
        if (liveToken() !== token) return;
        if (!ok) {
          console.error(
            "[play_audio] timebase failed after kick; abort sampling"
          );
          return;
        }
      }

      // 时钟已走，淡入 & 启动采样
      engine.fadeIn(25);
      context.__stopSampling = analyzer.startSampling?.((frame) => {
        station.audioFrame.set(frame);
      });

      // 结束回调
      audio.onended = () => {
        self.send(ss.playx.Signal.next);
      };
    },

    delete: assign({
      collections: EH.whenDone(payloads.delete.evt())((p, c) => {
        crab.delete(p.name);
        return c.collections.filter((f) => f.name !== p.name);
      }),
    }),
    clean_audio: assign({
      nowPlaying: udf,
      lastPlay: udf,
      selected: udf,
    }),
    fatigue_parm: ({ context }) => crab.fatigue(context.nowPlaying!),
    boost_parm: ({ context }) => crab.boost(context.nowPlaying!),
    cancle_boost_parm: ({ context }) => crab.cancleBoost(context.nowPlaying!),
    cancle_fatigue_parm: ({ context }) =>
      crab.cancleFatigue(context.nowPlaying!),
    update_last: assign({
      lastPlay: ({ context }) => context.nowPlaying,
    }),
    update_list: assign({
      flatList: ({ context }) =>
        context.flatList.map((i) =>
          i.path === context.selected?.name
            ? { ...i, fatigue: i.fatigue + 0.1 }
            : i
        ),
    }),
    update_selected: assign({
      selected: ({ context }) => {
        const sel = context.selected;
        const cur = context.nowPlaying;
        if (!sel || !cur) return sel;

        const targetPath = cur.path;

        return {
          ...sel,
          folders: sel.entries.map((fd) => ({
            ...fd,
            musics: fd.musics.map((m) =>
              m.path === targetPath
                ? { ...m, fatigue: (m.fatigue ?? 0) + 0.1 }
                : m
            ),
          })),
        };
      },
    }),
    update_coll: assign({
      collections: ({ context }) =>
        context.collections.map((c) =>
          c.name === context.selected?.name ? context.selected : c
        ),
    }),
    not_exist: assign({
      flatList: EH.whenDone(payloads.not_exist.evt())((i, c) => {
        return c.flatList.map((f) =>
          f.path === i.path ? { ...f, downloaded_ok: false } : f
        );
      }),
      selected: EH.whenDone(payloads.not_exist.evt())((i, c) => {
        const s = c.selected;
        if (!s) return;
        return {
          ...s,
          entries: s.entries.map((fd) => ({
            ...fd,
            musics: fd.musics.map((m) =>
              m.path === i.path ? { ...m, downloaded_ok: false } : m
            ),
          })),
        };
      }),
    }),
    clean_not_exist: EH.take(payloads.not_exist.evt())(crab.deleteMusic),
    unstar: assign({
      flatList: EH.whenDone(payloads.unstar.evt())((i, c) => {
        crab.unstar(c.selected!, i);
        return c.flatList.filter((f) => f.path !== i.path);
      }),
      selected: EH.whenDone(payloads.unstar.evt())((i, c) => {
        const s = c.selected;
        if (!s) return;
        return {
          ...s,
          exclude: [...s.exclude, i],
        };
      }),
    }),
    up: assign({
      flatList: EH.whenDone(payloads.up.evt())((p, c) =>
        c.flatList.map((i) =>
          i.path === p.path
            ? { ...i, user_boost: incBoost(i.user_boost, 0.1, 0.9) }
            : i
        )
      ),
      selected: EH.whenDone(payloads.up.evt())((i, c) => {
        const s = c.selected;
        if (!s) return;
        return {
          ...s,
          entries: s.entries.map((fd) => ({
            ...fd,
            musics: fd.musics.map((m) =>
              m.path === i.path
                ? { ...m, user_boost: incBoost(i.user_boost, 0.1, 0.9) }
                : m
            ),
          })),
        };
      }),
      nowJudge: K("Up"),
    }),
    down: assign({
      flatList: EH.whenDone(payloads.down.evt())((p, c) =>
        c.flatList.map((i) =>
          i.path === p.path
            ? {
                ...i,
                fatigue: i.fatigue + 0.1,
                user_boost: i.user_boost > 0 ? i.user_boost - 0.1 : 0.0,
              }
            : i
        )
      ),
      selected: EH.whenDone(payloads.down.evt())((i, c) => {
        const s = c.selected;
        if (!s) return;
        return {
          ...s,
          entries: s.entries.map((fd) => ({
            ...fd,
            musics: fd.musics.map((m) =>
              m.path === i.path
                ? {
                    ...m,
                    fatigue: m.fatigue + 0.1,
                    user_boost: i.user_boost > 0 ? i.user_boost - 0.1 : 0.0,
                  }
                : m
            ),
          })),
        };
      }),
      nowJudge: K("Down"),
    }),
    cancle_up: assign({
      flatList: EH.whenDone(payloads.cancle_up.evt())((p, c) =>
        c.flatList.map((i) =>
          i.path === p.path
            ? { ...i, user_boost: i.user_boost > 0 ? i.user_boost - 0.1 : 0.0 }
            : i
        )
      ),
      selected: EH.whenDone(payloads.cancle_up.evt())((i, c) => {
        const s = c.selected;
        if (!s) return;
        return {
          ...s,
          entries: s.entries.map((fd) => ({
            ...fd,
            musics: fd.musics.map((m) =>
              m.path === i.path
                ? {
                    ...m,
                    user_boost: i.user_boost > 0 ? i.user_boost - 0.1 : 0.0,
                  }
                : m
            ),
          })),
        };
      }),
      nowJudge: udf,
    }),
    cancle_down: assign({
      flatList: EH.whenDone(payloads.cancle_down.evt())((p, c) =>
        c.flatList.map((i) =>
          i.path === p.path ? { ...i, fatigue: i.fatigue - 0.1 } : i
        )
      ),
      selected: EH.whenDone(payloads.cancle_down.evt())((i, c) => {
        const s = c.selected;
        if (!s) return;
        return {
          ...s,
          entries: s.entries.map((fd) => ({
            ...fd,
            musics: fd.musics.map((m) =>
              m.path === i.path ? { ...m, fatigue: m.fatigue - 0.1 } : m
            ),
          })),
        };
      }),
      nowJudge: udf,
    }),
    reset_frame: () => station.audioFrame.set(new_frame()),
    update_audio_frame: ({ event }) => {
      assertEvent(event, payloads.update_audio_frame.evt());
      station.audioFrame.set(event.output);
    },
    ensure_engine: assign({
      engine: ({ context }) => context.engine ?? new AudioEngine(),
    }),
    ensure_analyzer: assign({
      analyzer: ({ context }) =>
        context.analyzer ?? new AudioAnalyzer(2048, 0.8),
    }),
    ensure_graph: ({ context }) => {
      const { engine, analyzer, audio } = context;
      if (!engine || !analyzer) {
        console.warn("[ensure_graph] missing engine/analyzer");
        return;
      }
      if (!audio.src || audio.readyState < 2) {
        console.warn("[ensure_graph] skip: media not ready", {
          src: audio.src,
          rs: audio.readyState,
        });
        return;
      }

      analyzer.attachTo(engine.ctx);
      engine.ensureSource(audio);
      analyzer.setTapFrom(engine.lufs);

      console.log("[ensure_graph] ok", {
        rs: audio.readyState,
        ctx: engine.ctx.state,
        lufsGain: engine.lufs.gain.value,
        fadeGain: engine.fade.gain.value,
      });
    },

    into_slot: assign({
      slot: EH.whenDone(payloads.edit_playlist.evt())(into_slot),
      selected: EH.whenDone(payloads.edit_playlist.evt())(I),
    }),
    cancel_review: assign({
      reviews: EH.whenDone(payloads.cancel_review.evt())((url, c) => {
        const r = c.reviews.find((r) => r.url === url);
        r?.actor.send?.(muss.mainx.Signal.cancle); // 子机里处理 CANCEL，自己退出
        return c.reviews; // 交给 over_review 在 done 时移除
      }),
    }),
  },
  guards: {
    hasData: ({ context }) => context.collections.length > 0,
    noData: ({ context }) => context.collections.length === 0,
    is_review: ({ context }) =>
      context.reviews.length > 0 ||
      context.folderReviews.length > 0 ||
      context.updateWeblistReviews.length > 0,
    is_list_complete: ({ context }) => {
      const slot = context.slot;
      if (!slot) return false;
      return (
        context.reviews.length === 0 &&
        (slot.name.trim().length ?? 0) > 0 &&
        slot.entries.length + slot.folders.length + slot.links.length > 0
      );
    },
    is_data_diff: ({ context }) => {
      const slot = context.slot;
      const selected = context.selected;

      if (!slot || !selected) return false;
      const entryPaths = new Set(slot.entries.map((e) => e.path));
      const hasIntersection = slot.folders.some((f) => entryPaths.has(f.path));
      const entryLink = new Set(slot.entries.map((l) => l.url));
      const linkHasIntersection = slot.links.some((l) => entryLink.has(l.url));
      const entryName = new Set(slot.entries.map((l) => l.name));
      const entryHasDifference = selected.entries.some(
        (l) => !entryName.has(l.name)
      );
      const excludeTitle = new Set(slot.exclude.map((l) => l.title));
      const hasDifference = selected.exclude.some(
        (l) => !excludeTitle.has(l.title)
      );
      return (
        !hasIntersection &&
        !linkHasIntersection &&
        (slot.name.trim() !== selected.name ||
          slot.links.length + slot.folders.length > 0 ||
          slot.entries.length !== selected.entries.length ||
          entryHasDifference ||
          hasDifference)
      );
    },
  },
});
