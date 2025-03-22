type SignalMap<T extends string> = Record<Lowercase<T>, { type: T; into(): T }>;
type StateMap<T extends readonly string[]> = { [K in T[number]]: K };

interface StateSignalConfig<
  TState extends readonly string[],
  TSignal extends readonly string[]
> {
  states: TState;
  signals: TSignal;
}

type StateSignalResult<
  TState extends readonly string[],
  TSignal extends readonly string[]
> = {
  State: StateMap<TState>;
  Signal: SignalMap<TSignal[number]>;
};

function createSignal<T extends string>(name: T) {
  const type = name.toUpperCase() as T;
  return {
    type,
    into(): T {
      return type;
    },
  };
}

export function createStateAndSignals<
  const TState extends readonly string[],
  const TSignal extends readonly string[]
>({
  states,
  signals,
}: StateSignalConfig<TState, TSignal>): StateSignalResult<TState, TSignal> {
  const State = {} as StateMap<TState>;
  for (const s of states) {
    State[s as TState[number]] = s as TState[number];
  }

  const Signal = {} as SignalMap<TSignal[number]>;
  for (const sig of signals) {
    Signal[sig.toLowerCase() as Lowercase<TSignal[number]>] = createSignal(sig);
  }

  return { State, Signal };
}
