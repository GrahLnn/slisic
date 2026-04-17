import { assign } from "xstate";
import { createInitialContext, parseClipboardDownloadUrl, toErrorMessage } from "./core";
import { invoker, ss } from "./events";
import { src } from "./src";

function resolveClipboardUrl(text: string | null) {
  return parseClipboardDownloadUrl(text ?? "");
}

export const machine = src.createMachine({
  initial: ss.mainx.State.idle,
  context: createInitialContext(),
  on: {
    paste: {
      target: `.${ss.mainx.State.readingClipboard}`,
      actions: assign(() => createInitialContext()),
    },
    reset: {
      target: `.${ss.mainx.State.idle}`,
      actions: assign(() => createInitialContext()),
    },
  },
  states: {
    [ss.mainx.State.idle]: {},
    [ss.mainx.State.readingClipboard]: {
      invoke: {
        id: invoker.readClipboardText.id,
        src: invoker.readClipboardText.src,
        onDone: {
          target: ss.mainx.State.validating,
          actions: assign(({ event }) => ({
            ...createInitialContext(),
            clipboardText: event.output,
          })),
        },
        onError: {
          target: ss.mainx.State.error,
          actions: assign(({ event }) => ({
            ...createInitialContext(),
            error: toErrorMessage(event.error),
          })),
        },
      },
    },
    [ss.mainx.State.validating]: {
      always: [
        {
          guard: ({ context }) => resolveClipboardUrl(context.clipboardText).ok,
          target: ss.mainx.State.probing,
          actions: assign(({ context }) => {
            const parsed = resolveClipboardUrl(context.clipboardText);
            if (!parsed.ok) {
              return {};
            }

            return {
              url: parsed.url,
            };
          }),
        },
        {
          target: ss.mainx.State.error,
          actions: assign(({ context }) => {
            const parsed = resolveClipboardUrl(context.clipboardText);
            if (parsed.ok) {
              return {};
            }

            return {
              error: parsed.error,
            };
          }),
        },
      ],
    },
    [ss.mainx.State.probing]: {
      invoke: {
        id: invoker.probeDownloadResource.id,
        src: invoker.probeDownloadResource.src,
        input: ({ context }) => {
          if (!context.url) {
            throw new Error("missing validated URL for probe");
          }

          return context.url;
        },
        onDone: {
          target: ss.mainx.State.enqueueing,
          actions: assign({
            probe: ({ event }) => event.output,
            url: ({ event }) => event.output.url,
            error: () => null,
          }),
        },
        onError: {
          target: ss.mainx.State.error,
          actions: assign({
            error: ({ event }) => toErrorMessage(event.error),
          }),
        },
      },
    },
    [ss.mainx.State.enqueueing]: {
      invoke: {
        id: invoker.enqueueCollectionDownload.id,
        src: invoker.enqueueCollectionDownload.src,
        input: ({ context }) => {
          if (!context.url) {
            throw new Error("missing download URL for enqueue");
          }

          return context.url;
        },
        onDone: {
          target: ss.mainx.State.done,
          actions: assign({
            task: ({ event }) => event.output,
            url: ({ event }) => event.output.url,
            error: () => null,
          }),
        },
        onError: {
          target: ss.mainx.State.error,
          actions: assign({
            error: ({ event }) => toErrorMessage(event.error),
          }),
        },
      },
    },
    [ss.mainx.State.done]: {},
    [ss.mainx.State.error]: {},
  },
});
