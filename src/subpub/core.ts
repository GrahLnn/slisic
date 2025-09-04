import { Atom, atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import { me, Matchable } from "@/lib/matchable";
import { createStore } from "jotai/vanilla";
export const appStore = createStore();

export function createAtom<T>(initialValue: T) {
  const a = atom<T>(initialValue);

  // —— 非 Hook API（可以在任何地方用）
  const set = (next: T | ((prev: T) => T)) => {
    if (typeof next === "function") {
      const updater = next as (p: T) => T;
      appStore.set(a, updater(appStore.get(a)));
    } else {
      appStore.set(a, next);
    }
  };
  const get = () => appStore.get(a);

  // —— Hook 版（仅组件/自定义 Hook 内使用）
  const useSee = () => useAtomValue(a);
  const useSet = () => useSetAtom(a);
  const useAll = () => useAtom(a);

  return { atom: a, set, get, useSee, useSet, useAll };
}

export function createMatchAtom<T extends string | number>(initialValue: T) {
  const inner = createAtom<Matchable<T>>(me(initialValue));

  return {
    atom: inner.atom,
    useAll: () => {
      const [raw, setRaw] = inner.useAll();
      return [
        raw,
        (v: T) =>
          setRaw((prev) => {
            if (prev.value === v) return prev; // 避免不必要更新
            return me(v);
          }),
      ] as const;
    },
    useSee: () => inner.useSee(),
    useSet: () => {
      const set = inner.useSet();
      return (value: T) =>
        set((prev) => {
          if (prev.value === value) return prev;
          return me(value);
        });
    },
    get: inner.get,
  };
}

export function createDerivedAtom<T>(derive: (get: <V>(a: Atom<V>) => V) => T) {
  const derivedAtom = atom<T>((get) => derive(get));
  function useSee() {
    return useAtomValue(derivedAtom);
  }
  function get() {
    return derivedAtom;
  }
  return {
    atom: derivedAtom,
    useSee,
    get,
  };
}
