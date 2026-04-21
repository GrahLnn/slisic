export type GhostFrame = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type GhostPoint = {
  x: number;
  y: number;
};

type GhostMatrix = {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
};

function parseGhostMatrix(transform: string): GhostMatrix {
  if (transform === "none") {
    return {
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      e: 0,
      f: 0,
    };
  }

  const match = transform.match(/matrix\(([^)]+)\)/);
  if (!match) {
    return {
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      e: 0,
      f: 0,
    };
  }

  const values = match[1].split(",").map((value) => Number.parseFloat(value.trim()));

  return {
    a: values[0] ?? 1,
    b: values[1] ?? 0,
    c: values[2] ?? 0,
    d: values[3] ?? 1,
    e: values[4] ?? 0,
    f: values[5] ?? 0,
  };
}

function parseGhostOrigin(transformOrigin: string): GhostPoint {
  const [originX = "0", originY = "0"] = transformOrigin.split(" ");

  return {
    x: Number.parseFloat(originX) || 0,
    y: Number.parseFloat(originY) || 0,
  };
}

function transformGhostPoint(
  point: GhostPoint,
  origin: GhostPoint,
  matrix: GhostMatrix,
): GhostPoint {
  const localX = point.x - origin.x;
  const localY = point.y - origin.y;

  return {
    x: matrix.a * localX + matrix.c * localY + matrix.e + origin.x,
    y: matrix.b * localX + matrix.d * localY + matrix.f + origin.y,
  };
}

export function normalizeGhostAngle(angle: number) {
  const normalizedAngle = ((((angle + 180) % 360) + 360) % 360) - 180;

  return normalizedAngle === -180 ? 180 : normalizedAngle;
}

export function resolveGhostAngleFromPoint(point: GhostPoint) {
  return normalizeGhostAngle((Math.atan2(point.y, point.x) * 180) / Math.PI);
}

export function resolveGhostFrameCenter(frame: GhostFrame): GhostPoint {
  return {
    x: frame.left + frame.width / 2,
    y: frame.top + frame.height / 2,
  };
}

export function resolveGhostFrame(
  rect: Pick<GhostFrame, "left" | "top" | "width" | "height">,
): GhostFrame {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

export function resolveGhostAngleFromTransform(transform: string) {
  const matrix = parseGhostMatrix(transform);

  return resolveGhostAngleFromPoint({ x: matrix.a, y: matrix.b });
}

export function resolveGhostCloneFrame(args: {
  sourceRect: GhostFrame;
  width: number;
  height: number;
  transform: string;
  transformOrigin: string;
}) {
  const matrix = parseGhostMatrix(args.transform);
  const origin = parseGhostOrigin(args.transformOrigin);
  const corners = [
    transformGhostPoint({ x: 0, y: 0 }, origin, matrix),
    transformGhostPoint({ x: args.width, y: 0 }, origin, matrix),
    transformGhostPoint({ x: args.width, y: args.height }, origin, matrix),
    transformGhostPoint({ x: 0, y: args.height }, origin, matrix),
  ];
  const minX = Math.min(...corners.map((corner) => corner.x));
  const minY = Math.min(...corners.map((corner) => corner.y));

  return {
    left: args.sourceRect.left - minX,
    top: args.sourceRect.top - minY,
    width: args.width,
    height: args.height,
  } as const;
}
