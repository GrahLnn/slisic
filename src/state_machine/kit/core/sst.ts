import {
  StateMap,
  SignalMap,
  ToSignal,
  TransferBase,
  TransferMap,
  StateSignalResult,
  ElemNoSpaceTuple,
} from "./types";
import { createSignal } from "./signal";

export function ss<
  const TState extends readonly string[],
  const TSignal extends readonly string[] = []
>(cfg: {
  states: TState & ElemNoSpaceTuple<TState>;
  signals: TSignal & ElemNoSpaceTuple<TSignal>;
}): StateSignalResult<TState, TSignal[number]> {
  const State = {} as StateMap<TState>;
  for (const s of cfg.states) (State as any)[s] = s;

  const Signal = {} as SignalMap<TSignal[number]>;
  for (const sig of cfg.signals) {
    const key = sig.toLowerCase() as Lowercase<TSignal[number]>;
    // 这里的 sig 仍是 TSignal[number] 的字面量联合，不会被报错信息污染
    Signal[key] = createSignal(sig);
  }

  const transfer = { pick: () => ({}) } as unknown as TransferMap<TState>;
  return { State, Signal, transfer };
}

export function sst<
  const TState extends readonly string[],
  const TExtra extends readonly string[] = []
>(
  states: ElemNoSpaceTuple<TState>,
  extra_signals?: ElemNoSpaceTuple<TExtra>
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

  // 2) 额外信号
  if (extra_signals) {
    for (const s of extra_signals) {
      const type = s as TExtra[number];
      const key = type.toLowerCase() as Lowercase<typeof type>;
      Signal[key] = createSignal(type);
      (transferBase as any)[key] = { target: s };
    }
  }

  // 3) pick
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
