import { Signal } from "./types";

export function createSignal<K extends string>(k: K): Signal<K> {
  return {
    type: k,
    evt: k,
  };
}
