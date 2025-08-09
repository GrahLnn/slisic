import {
  StateMap,
  SignalMap,
  ToSignal,
  TransferBase,
  TransferMap,
  StateSignalResult,
} from "./types";
import { createSignal } from "./signal";

/* ---------- 手动版（transfer 为空壳，但带 pick 方法） ---------- */
export function ss<
  const TState extends readonly string[],
  TSignal extends string
>(cfg: {
  states: TState;
  signals: readonly TSignal[];
}): StateSignalResult<TState, TSignal> {
  const State = {} as StateMap<TState>;
  for (const s of cfg.states) (State as any)[s] = s;

  const Signal = {} as SignalMap<TSignal>;
  for (const sig of cfg.signals)
    Signal[sig.toLowerCase() as Lowercase<TSignal>] = createSignal(sig);

  const transfer = {
    pick: () => ({}),
  } as unknown as TransferMap<TState>;

  return { State, Signal, transfer };
}

/* ---------- sst：自动生成 State / Signal / transfer ---------- */
export function sst<
  const TState extends readonly string[],
  const TExtra extends readonly string[] = []
>(
  states: TState,
  extra_signals?: TExtra
): StateSignalResult<TState, ToSignal<TState> | TExtra[number]> {
  const State = {} as StateMap<TState>;
  for (const s of states) (State as any)[s] = s;

  const Signal = {} as SignalMap<ToSignal<TState> | TExtra[number]>;

  const transferBase = {} as TransferBase<TState>;

  // 1) 根据状态生成 to_xxx
  for (const s of states) {
    const type = `to_${s}` as ToSignal<TState>;
    const key = type.toLowerCase() as Lowercase<ToSignal<TState>>;
    Signal[key] = createSignal(type);
    (transferBase as any)[key] = { target: s };
  }

  // 2) 额外信号（运行时扩展 transfer；类型保持保守的 TransferBase）
  if (extra_signals) {
    for (const s of extra_signals) {
      const type = s as TExtra[number];
      const key = type.toLowerCase() as Lowercase<typeof type>;
      Signal[key] = createSignal(type);
      (transferBase as any)[key] = { target: s };
    }
  }

  // 3) pick（带完备的键名约束）
  function pick<K extends keyof typeof transferBase>(
    ...keys: K[]
  ): Pick<typeof transferBase, K> {
    return Object.fromEntries(keys.map((k) => [k, transferBase[k]])) as Pick<
      typeof transferBase,
      K
    >;
  }

  const transfer = Object.assign(transferBase, { pick }) as TransferMap<TState>;

  return { State, Signal, transfer };
}
