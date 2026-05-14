export interface PlayListTitleReturnSurfaceState {
  consumedLayoutId: string | null;
}

export interface PlayListTitleReturnSurfaceSnapshot {
  layoutId: string;
}

export const INACTIVE_TITLE_RETURN_SURFACE: PlayListTitleReturnSurfaceState = {
  consumedLayoutId: null,
};

export function resolvePlayListTitleReturnSurfaceState(args: {
  targetLayoutId: string | null;
  consumedLayoutId: string | null;
}) {
  if (args.targetLayoutId === null) {
    return INACTIVE_TITLE_RETURN_SURFACE;
  }

  if (args.consumedLayoutId === args.targetLayoutId) {
    return {
      consumedLayoutId: args.consumedLayoutId,
    } satisfies PlayListTitleReturnSurfaceState;
  }

  return {
    consumedLayoutId: args.consumedLayoutId,
  } satisfies PlayListTitleReturnSurfaceState;
}

export function resolvePlayListTitleReturnSurfaceAfterLayoutComplete(args: {
  current: PlayListTitleReturnSurfaceState;
  targetLayoutId: string | null;
  layoutId: string;
}) {
  if (args.targetLayoutId === null || args.targetLayoutId !== args.layoutId) {
    return args.current;
  }

  return {
    consumedLayoutId: args.layoutId,
  } satisfies PlayListTitleReturnSurfaceState;
}

export function resolvePlayListTitleReturnSurfaceSnapshot(args: {
  targetLayoutId: string | null;
  state: PlayListTitleReturnSurfaceState;
}) {
  if (args.targetLayoutId === null || args.state.consumedLayoutId === args.targetLayoutId) {
    return null;
  }

  return {
    layoutId: args.targetLayoutId,
  } satisfies PlayListTitleReturnSurfaceSnapshot;
}
