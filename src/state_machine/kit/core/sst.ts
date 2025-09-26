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
    (Signal as any)[key] = createSignal(sig);
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

  // 1) 生成 to_* 信号与 transferBase
  for (const s of states) {
    const type = `to_${s}` as ToSignal<TState>;
    const key = type.toLowerCase() as Lowercase<typeof type>;
    (Signal as any)[key] = createSignal(type);
    (transferBase as any)[key] = { target: s };
  }

  // 2) 额外信号仅进 Signal（不写入 transferBase）
  if (extra_signals) {
    for (const s of extra_signals) {
      const type = s as TExtra[number];
      const key = type.toLowerCase() as Lowercase<typeof type>;
      (Signal as any)[key] = createSignal(type);
    }
  }

  // 3) pick / one
  function pick<K extends keyof typeof transferBase>(...keys: K[]) {
    return Object.fromEntries(keys.map((k) => [k, transferBase[k]])) as Pick<
      typeof transferBase,
      K
    >;
  }
  function one<K extends keyof typeof transferBase>(key: K) {
    return { [key]: transferBase[key] } as Pick<typeof transferBase, K>;
  }

  // 4) Proxy：属性访问返回映射对象；__raw 返回裸表；其余透传
  const transfer = new Proxy({} as any, {
    get(_t, p: PropertyKey) {
      if (p === "pick") return pick;
      if (p === "one") return one;
      if (p === "__raw") return transferBase;
      if (typeof p === "string" && p in transferBase) {
        const k = p as keyof typeof transferBase;
        return { [k]: transferBase[k] }; // 关键：返回 Pick 形状
      }
      return (transferBase as any)[p];
    },
  }) as TransferMap<TState>;

  return { State, Signal, transfer };
}
