/* 轻量 Signal 构造器（给 sst/createStateAndSignals 用） */
export function createSignal<T extends string>(name: T) {
  return { type: name, into: () => name };
}
