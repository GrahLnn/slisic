import { commands, events, makeLievt } from "./commands";
import { Err, Ok, type Result } from "@grahlnn/fn";

type AwaitedRet<F extends (...args: any[]) => any> = Awaited<ReturnType<F>>;
type SpectaResult<T, E> =
  | { status: "ok"; data: T }
  | { status: "error"; error: E };

type SpectaData<R> = R extends { status: "ok"; data: infer D } ? D : never;
type SpectaError<R> = R extends { status: "error"; error: infer E } ? E : never;

type CommandsType = typeof commands;
type CommandKey = keyof CommandsType;

type CmdRawResult<K extends CommandKey> =
  AwaitedRet<CommandsType[K]> extends {
    status: "ok" | "error";
  }
    ? Result<
        SpectaData<AwaitedRet<CommandsType[K]>>,
        SpectaError<AwaitedRet<CommandsType[K]>>
      >
    : AwaitedRet<CommandsType[K]>;

function toResult<T, E>(value: SpectaResult<T, E>): Result<T, E> {
  switch (value.status) {
    case "ok":
      return Ok<T, E>(value.data);
    case "error":
      return Err<E, T>(value.error);
    default:
      throw new Error("unexpected specta result");
  }
}

function isSpectaResult<T, E>(value: unknown): value is SpectaResult<T, E> {
  if (!value || typeof value !== "object") return false;
  const status = (value as { status?: string }).status;
  return status === "ok" || status === "error";
}

const crabProxy = new Proxy(
  {} as {
    [K in CommandKey]: (
      ...args: Parameters<CommandsType[K]>
    ) => Promise<CmdRawResult<K>>;
  },
  {
    get(target, prop: PropertyKey, receiver) {
      // Keep explicitly assigned properties (e.g. evt) working.
      if (Reflect.has(target, prop)) {
        return Reflect.get(target, prop, receiver);
      }

      const cmd = (commands as Record<PropertyKey, unknown>)[prop];
      if (typeof cmd !== "function") {
        return undefined;
      }

      return async (...args: unknown[]) => {
        type Raw = AwaitedRet<CommandsType[Extract<typeof prop, CommandKey>]>;
        type T = SpectaData<Raw>;
        type E = SpectaError<Raw>;

        const value: Raw = await (cmd as (...a: unknown[]) => Promise<Raw>)(
          ...args,
        );
        return isSpectaResult<T, E>(value) ? toResult<T, E>(value) : value;
      };
    },
  },
);

const evt = makeLievt(events);

export const crab = Object.assign(crabProxy, { evt });
