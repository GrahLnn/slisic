import {
  commands,
  events,
  makeLievt,
  type Result as SpectaResult,
} from "./commands";
import { Ok, Err, type Result } from "@grahlnn/fn";

type AwaitedRet<F extends (...args: any) => any> = Awaited<ReturnType<F>>;

type SpectaData<R> = R extends { status: "ok"; data: infer D } ? D : never;
type SpectaError<R> = R extends { status: "error"; error: infer E } ? E : never;

type CmdRawResult<K extends CommandKey> =
  AwaitedRet<CommandsType[K]> extends {
    status: "ok" | "error";
  }
    ? Result<
        SpectaData<AwaitedRet<CommandsType[K]>>,
        SpectaError<AwaitedRet<CommandsType[K]>>
      >
    : AwaitedRet<CommandsType[K]>;

type CommandsType = typeof commands;
type CommandKey = keyof CommandsType;

function toResult<T, E>(r: SpectaResult<T, E>): Result<T, E> {
  switch (r.status) {
    case "ok":
      return Ok<T, E>(r.data);
    case "error":
      return Err<E, T>(r.error);
  }
}

function isSpectaResult<T, E>(x: any): x is SpectaResult<T, E> {
  return (
    x != null &&
    typeof x === "object" &&
    (x.status === "ok" || x.status === "error")
  );
}

const crabProxy = new Proxy(
  {} as {
    [K in CommandKey]: (
      ...a: Parameters<CommandsType[K]>
    ) => Promise<CmdRawResult<K>>;
  },
  {
    get(_, prop: CommandKey) {
      return async (...args: any[]) => {
        type Raw = AwaitedRet<CommandsType[typeof prop]>;
        type T = SpectaData<Raw>;
        type E = SpectaError<Raw>;

        const r: Raw = await (commands as any)[prop](...args);
        return isSpectaResult(r) ? toResult<T, E>(r) : r;
      };
    },
  },
);

const evt = makeLievt(events);

export const crab = Object.assign(crabProxy, { evt });
