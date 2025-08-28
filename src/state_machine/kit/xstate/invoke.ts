import { WithPrefix } from "../core/types";

export function invokeEvt<S extends string>(id: S): WithPrefix<S> {
  return `xstate.done.actor.${id}`;
}

export function godown(state: string) {
  return `.${state}`;
}

export function goto(state: string) {
  return `#${state}`;
}

/* xstate 子状态机快速包裹器 */
export function invokeState<
  S extends string,
  A extends string | readonly string[] | undefined = undefined
>(src: S, actions?: A) {
  return {
    [src]: {
      initial: "do",
      states: {
        do: {
          invoke: {
            id: src,
            src,
            onDone: {
              target: "done",
              actions,
            },
          },
        },
        done: { type: "final" },
      },
    },
  } as const;
}

export interface ActorInput<T> {
  input: T;
}
