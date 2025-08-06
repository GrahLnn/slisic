import { Atom, atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import { matchable, Matchable } from "@/lib/matchable";

export function createAtom<T>(initialValue: T) {
  const atomm = atom<T>(initialValue);

  function useSee() {
    return useAtomValue(atomm);
  }

  function useSet() {
    return useSetAtom(atomm);
  }

  function get() {
    return atomm;
  }

  function useAll() {
    return useAtom(atomm);
  }

  return {
    atom: atomm,
    useSee,
    useSet,
    useAll,
    get,
  };
}

export function createMatchAtom<T extends string | number>(initialValue: T) {
  const inner = createAtom<Matchable<T>>(matchable(initialValue));

  return {
    atom: inner.atom,
    useAll: () => {
      const [raw, setRaw] = inner.useAll();
      return [
        raw,
        (v: T) =>
          setRaw((prev) => {
            if (prev.value === v) return prev; // 避免不必要更新
            return matchable(v);
          }),
      ] as const;
    },
    useSee: () => inner.useSee(),
    useSet: () => {
      const set = inner.useSet();
      return (value: T) =>
        set((prev) => {
          if (prev.value === value) return prev;
          return matchable(value);
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
