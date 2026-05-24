export type BackActionVisualKind = "back" | "check" | "processing";

export interface BackActionVisualState {
  kind: BackActionVisualKind;
  key: string;
}

/**
 * Back button visuals replay only when the semantic state changes.
 * Draft content changes inside the same semantic state must not retrigger
 * the path animation.
 */
export function resolveBackActionVisualState(args: {
  hasDraftChanges: boolean;
  isImporting: boolean;
  isParsing: boolean;
}): BackActionVisualState {
  if (args.isParsing || args.isImporting) {
    return {
      kind: "processing",
      key: "processing",
    };
  }

  const kind = args.hasDraftChanges ? "check" : "back";
  return {
    kind,
    key: kind,
  };
}
