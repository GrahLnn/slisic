export function resolvePlayItemFrameProjection(args: { layoutId?: string }) {
  const normalizedLayoutId = args.layoutId?.trim();

  if (!normalizedLayoutId) {
    return {
      layout: false,
      layoutId: undefined,
    } as const;
  }

  return {
    layout: "position",
    layoutId: normalizedLayoutId,
  } as const;
}
