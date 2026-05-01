export function normalizeMediaPathKey(path: string | null | undefined) {
  return path?.trim().replace(/\\/g, "/").toLowerCase() ?? "";
}
