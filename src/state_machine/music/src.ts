import { setup, assign, enqueueActions } from "xstate";
import { eventHandler } from "../kit";
import {
  Context,
  into_slot,
  new_frame,
  new_slot,
  createHowlerTap,
  Frame,
} from "./core";
import { payloads, ss, sub_machine, invoker, Events } from "./events";
import { I, K } from "@/lib/comb";
import { udf, vec } from "@/lib/e";
import { hideCenterTool, viewCenterTool } from "../centertool";
import { station } from "@/src/subpub/buses";
import { Music } from "@/src/cmd/commands";
import crab from "@/src/cmd";
import { ss as muss } from "../muinfo";
import { Howl, Howler } from "howler";
import { convertFileSrc } from "@tauri-apps/api/core";

let installed = false;
let postGain: GainNode | null = null;
let switching = false;

function db2lin(db: number) {
  return Math.pow(10, db / 20);
}

function computeSafeBoost(curLufs: number, targetLufs: number, maxBoostDb = 4) {
  const rawBoostDb = targetLufs - curLufs; // 可能很大
  const appliedBoostDb = Math.min(rawBoostDb, maxBoostDb);
  const effectiveTarget = curLufs + appliedBoostDb; // 把目标自适应下调
  return { s: db2lin(appliedBoostDb), effectiveTarget };
}

export function ensureHowlerPostGain() {
  if (installed) return postGain!;
  if (!Howler.usingWebAudio)
    throw new Error("HTML5 Audio 回退，无法插入增益节点。");

  const ctx = Howler.ctx as AudioContext;
  const master = Howler.masterGain as GainNode;

  // ===== 1) HPF：切超低（25~35Hz）
  const hpf = ctx.createBiquadFilter();
  hpf.type = "highpass";
  hpf.frequency.value = 30; // 25~35 之间按口味调
  hpf.Q.value = 0.707;

  // ===== 2) LowShelf：轻削 60~120Hz
  const lowShelf = ctx.createBiquadFilter();
  lowShelf.type = "lowshelf";
  lowShelf.frequency.value = 90; // 60~120
  lowShelf.gain.value = -4; // -3~-6dB

  // ===== 3) GentleComp：预压，减轻硬限负担
  const gentle = ctx.createDynamicsCompressor();
  gentle.threshold.value = -18; // -24~-12 之间
  gentle.knee.value = 6; // 软一点
  gentle.ratio.value = 3; // 2~4:1
  gentle.attack.value = 0.006; // 5~10ms
  gentle.release.value = 0.25; // 200~300ms

  // ===== 4) Limiter：硬限（仍是压缩器近似）
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1; // ceiling（模拟）
  limiter.knee.value = 1;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003; // 快速抓峰
  limiter.release.value = 0.18; // 稍长，减“喘息/泵感”

  // ===== 5) SoftClip：软削波（tanh 曲线）
  const softClip = ctx.createWaveShaper();
  softClip.curve = buildSoftClipCurve(4096, 0.9); // 0.8~0.95 强度
  softClip.oversample = "4x"; // 减少高频折叠

  function buildSoftClipCurve(len: number, drive: number) {
    const curve = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const x = (i / (len - 1)) * 2 - 1; // [-1,1]
      const y = Math.tanh(x * (1 / (1 - 1e-3)) * drive);
      curve[i] = y;
    }
    return curve;
  }

  // ===== 6) postGain：最后补一点点（默认 1.0）
  postGain = ctx.createGain();
  postGain.gain.value = 1;

  // 重新布线
  try {
    master.disconnect();
  } catch {}
  master.connect(hpf);
  hpf.connect(lowShelf);
  lowShelf.connect(gentle);
  gentle.connect(limiter);
  limiter.connect(softClip);
  softClip.connect(postGain);
  postGain.connect(ctx.destination);

  installed = true;
  return postGain!;
}

export function setPostGainLinear(g: number) {
  if (!installed) return;
  if (!postGain) return;
  postGain.gain.value = Math.max(0, g); // 可以 >1
}

export function setPostGainLinearSmooth(g: number, t = 0.04) {
  if (!installed || !postGain) return;
  const ctx = Howler.ctx as AudioContext;
  const now = ctx.currentTime;
  const p = postGain.gain;
  p.setTargetAtTime(Math.max(0, g), now, t); // ~40ms 平滑
}

export function resetPostGain() {
  setPostGainLinear(1);
}

// 可选：如果你的 analyser 想看“增益之后”的信号：
export function tapAfterBoost(analyser: AnalyserNode) {
  if (!postGain) return;
  try {
    postGain.connect(analyser);
  } catch {}
}

let activeFrameDecay: { cancel: () => void } | null = null;

function hardStop(h?: Howl, opts?: { keepTap?: boolean }) {
  if (!h) return;
  try {
    h.stop();
  } catch {}
  try {
    h.off();
  } catch {} // 移除所有监听器，防多次 next
  // 重要：真正释放缓冲与全局缓存
  try {
    h.unload();
  } catch {}
  if (!opts?.keepTap) {
    try {
      station && decayAudioFrame();
    } catch {}
  }
  // 这里不操作 postGain，让 onend/onstop 统一 reset
}

export function decayAudioFrame(duration = 300) {
  // 取消上一次的衰减，避免并发
  activeFrameDecay?.cancel?.();

  const startFrame = station.audioFrame.get(); // 读取当前帧
  const t0 = performance.now();

  // s(t) = (1 - p)^3, p ∈ [0,1]，从 1 平滑到 0（ease-out cubic 的反函数）
  const scaleAt = (p: number) => {
    const clamped = Math.min(1, Math.max(0, p));
    const s = Math.pow(1 - clamped, 3);
    return s;
  };

  let raf = 0;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    if (raf) cancelAnimationFrame(raf);
  };
  activeFrameDecay = { cancel };

  const tick = () => {
    if (cancelled) return;

    const now = performance.now();
    const p = (now - t0) / duration;

    if (p >= 1) {
      // 结束：重置为全 0 的结构体
      station.audioFrame.set(new_frame());
      activeFrameDecay = null;
      return;
    }

    const s = scaleAt(p);

    // 逐字段缩放
    const next: Frame = {
      ...startFrame,
      frequencyNorm: startFrame.frequencyNorm.map((v) => v * s),
      volume: startFrame.volume * s,
      bass: startFrame.bass * s,
      mid: startFrame.mid * s,
      treble: startFrame.treble * s,
      bassPeak: startFrame.bassPeak * s,
      volumePeak: startFrame.volumePeak * s,
      intensityBurst: startFrame.intensityBurst * s,
    };

    station.audioFrame.set(next);
    raf = requestAnimationFrame(tick);
  };

  raf = requestAnimationFrame(tick);
  return cancel; // 需要时可手动取消
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
      processMsg: EH.whenDone(payloads.processMsg.evt())(I),
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
          .filter((m) => !i?.exclude.map((e) => e.title).includes(m.title))
      ),
      selected: EH.whenDone(payloads.toggle_audio.evt())((i) => i || undefined),
    }),
    ensure_play: enqueueActions(async ({ context, enqueue, self }) => {
      if (switching) return; // 防重入
      switching = true;
      const all: Music[] = context.flatList;
      if (all.length === 0) return;

      const last = context.lastPlay;
      const pool = last ? all.filter((m) => !sameTrack(m, last)) : all;
      const base = pool.length > 0 ? pool : all;
      const idx = softminSample(base, 0.8);
      const choose = base[idx];

      hardStop(context.audio);
      // LUFS → 线性倍率 s
      const target = context.selected?.avg_db ?? -14;
      const cur = choose.avg_db ?? target;
      const { s } = computeSafeBoost(cur, target, 4);

      // 拆分：Howler 的 volume ≤ 1；剩余用 postGain 扛
      const howlerVol = Math.min(1, s);
      const extra = s / howlerVol; // >=1

      const sound = new Howl({
        src: convertFileSrc(choose.path),
        volume: howlerVol, // 0..1
        onplay: async () => {
          // 1) 确保 AudioContext 恢复（某些浏览器策略需要）
          try {
            await (Howler.ctx as AudioContext | null)?.resume?.();
          } catch {}

          // 2) 安装后级增益链（此时 ctx 一定存在）
          try {
            ensureHowlerPostGain();
            setPostGainLinearSmooth(extra); // 设置 >1 的增益
          } catch (e) {
            console.warn("[postGain] install failed:", e);
          }

          // 3) 懒创建 tap，并启动采样
          if (!context.tap && Howler.usingWebAudio) {
            try {
              (context as any).tap = createHowlerTap(2048, 0.8);
            } catch (e) {
              console.warn("[tap] create failed:", e);
            }
          }
          context.tap?.start(station.audioFrame.set);

          // 如果你希望频谱看“增益之后”的信号：
          // tapAfterBoost(context.tap!.analyser);
        },
        onend: () => {
          resetPostGain();
          try {
            sound.off();
          } catch {}
          try {
            sound.unload();
          } catch {}
          self.send(ss.playx.Signal.next);
        },
        onstop: () => {
          resetPostGain();
          try {
            sound.off();
          } catch {}
          try {
            sound.unload();
          } catch {}
          context.tap?.stop();
          decayAudioFrame();
        },
      });

      enqueue.assign({ nowPlaying: choose, audio: sound });
      setTimeout(() => {
        switching = false;
      }, 0);
    }),

    stop_audio: ({ context }) => context.audio?.stop(),
    clean_judge: assign({
      nowJudge: udf,
    }),
    play_audio: ({ context }) => context.audio?.play(),
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
      const excludeTitle = new Set(slot.exclude.map((l) => l.path));
      const hasDifference = selected.exclude.some(
        (l) => !excludeTitle.has(l.path)
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
