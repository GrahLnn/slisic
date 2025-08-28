import { assign, fromCallback, setup, type SnapshotFrom } from "xstate";
import { useActorRef, useSelector } from "@xstate/react";

const mediaQueryLogic = fromCallback<
  { type: "MEDIA_CHANGED"; dark: boolean },
  { query: string }
>(({ sendBack, input }) => {
  if (typeof window === "undefined") return () => {};

  const mql = window.matchMedia(input.query);

  sendBack({ type: "MEDIA_CHANGED", dark: mql.matches });

  const handler = (e: MediaQueryListEvent) =>
    sendBack({ type: "MEDIA_CHANGED", dark: e.matches });

  mql.addEventListener("change", handler);

  return () => {
    mql.removeEventListener("change", handler);
  };
});

export const themeMachine = setup({
  types: {
    context: {} as { isDark: boolean },
    events: {} as { type: "MEDIA_CHANGED"; dark: boolean },
  },

  actors: { mediaQueryLogic },
}).createMachine({
  context: { isDark: false },
  invoke: {
    id: "media",
    src: "mediaQueryLogic",
    input: { query: "(prefers-color-scheme: dark)" },
  },
  on: {
    MEDIA_CHANGED: {
      actions: assign({
        isDark: ({ event }) => event.dark,
      }),
    },
  },
});

export type ThemeSnapshot = SnapshotFrom<typeof themeMachine>;

export const selectIsDark = (s: ThemeSnapshot) => s.context.isDark;

export function useIsDark(): boolean {
  const actor = useActorRef(themeMachine);
  return useSelector(actor, selectIsDark);
}
