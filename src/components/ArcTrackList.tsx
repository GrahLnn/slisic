import { useEffect, useRef, useState } from "react";
import { ToolLabel, MaskL } from "./toollabel";
import { CoverTool } from "./coverTool";

const ARC_VIEWBOX_WIDTH = 288;
const ARC_LEADING_PADDING = 220;
const ARC_TRAILING_PADDING = 112;
const ARC_ITEM_GAP = 78;
const ARC_VIEWPORT_FALLBACK_HEIGHT = 640;
const ARC_LOOKUP_STEPS = 240;
const ARC_VISIBLE_MARGIN = 72;
const ARC_PATH_STEPS = 96;

type ArcTrackListProps = {
  items: readonly string[];
};

type ArcSample = {
  distance: number;
  x: number;
  y: number;
};

function getArcGeometry(viewportHeight: number) {
  const topInset = 0;
  const bottomInset = 0;
  const drawableHeight = Math.max(1, viewportHeight - topInset - bottomInset);

  return {
    topInset,
    bottomInset,
    drawableHeight,
    topX: 244,
    bottomX: 150,
    circleRadius: Math.max(drawableHeight * 2.1, 2600),
  };
}

function getArcPath(viewportHeight: number) {
  const { topInset, drawableHeight, topX, bottomX, circleRadius } =
    getArcGeometry(viewportHeight);
  const start = { x: topX, y: topInset };
  const end = { x: bottomX, y: topInset + drawableHeight };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const chord = Math.hypot(dx, dy);
  const safeRadius = Math.max(circleRadius, chord / 2 + 1);
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  const perpX = dy / chord;
  const perpY = -dx / chord;
  const offset = Math.sqrt(
    Math.max(0, safeRadius * safeRadius - (chord * chord) / 4),
  );
  const centerX = midX + perpX * offset;
  const centerY = midY + perpY * offset;
  const startAngle = Math.atan2(start.y - centerY, start.x - centerX);
  const endAngle = Math.atan2(end.y - centerY, end.x - centerX);
  const deltaAngle = Math.atan2(
    Math.sin(endAngle - startAngle),
    Math.cos(endAngle - startAngle),
  );

  return Array.from({ length: ARC_PATH_STEPS + 1 }, (_, index) => {
    const progress = index / ARC_PATH_STEPS;
    const angle = startAngle + deltaAngle * progress;
    const x = centerX + safeRadius * Math.cos(angle);
    const y = centerY + safeRadius * Math.sin(angle);

    return `${index === 0 ? "M" : "L"}${x} ${y}`;
  }).join("");
}

function buildArcLookup(path: SVGPathElement) {
  const totalLength = path.getTotalLength();

  return Array.from({ length: ARC_LOOKUP_STEPS + 1 }, (_, index) => {
    const distance = (totalLength * index) / ARC_LOOKUP_STEPS;
    const point = path.getPointAtLength(distance);

    return {
      distance,
      x: point.x,
      y: point.y,
    };
  });
}

function getArcSampleAtY(targetY: number, samples: ArcSample[]) {
  if (samples.length < 2) {
    return null;
  }

  if (targetY <= samples[0].y) {
    const current = samples[0];
    const next = samples[1];
    const dy = next.y - current.y;
    const dx = next.x - current.x;
    const slope = dx / Math.max(1e-6, dy);

    return {
      x: current.x + slope * (targetY - current.y),
      y: targetY,
      angle:
        (Math.atan2(next.x - current.x, next.y - current.y) * 180) / Math.PI,
    };
  }

  const lastIndex = samples.length - 1;

  if (targetY >= samples[lastIndex].y) {
    const previous = samples[lastIndex - 1];
    const current = samples[lastIndex];
    const dy = current.y - previous.y;
    const dx = current.x - previous.x;
    const slope = dx / Math.max(1e-6, dy);

    return {
      x: current.x + slope * (targetY - current.y),
      y: targetY,
      angle:
        (Math.atan2(current.x - previous.x, current.y - previous.y) * 180) /
        Math.PI,
    };
  }

  let low = 0;
  let high = lastIndex;

  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);

    if (samples[mid].y < targetY) {
      low = mid;
    } else {
      high = mid;
    }
  }

  const start = samples[low];
  const end = samples[high];
  const ratio = (targetY - start.y) / Math.max(1e-6, end.y - start.y);
  const x = start.x + (end.x - start.x) * ratio;
  const y = start.y + (end.y - start.y) * ratio;
  const angle = (Math.atan2(end.x - start.x, end.y - start.y) * 180) / Math.PI;

  return { x, y, angle };
}

export function ArcTrackList({ items }: ArcTrackListProps) {
  const arcViewportRef = useRef<HTMLDivElement>(null);
  const arcPathRef = useRef<SVGPathElement>(null);
  const itemRefs = useRef<Array<HTMLLIElement | null>>([]);
  const frameRef = useRef<number | null>(null);
  const arcLookupRef = useRef<ArcSample[]>([]);
  const [arcViewportHeight, setArcViewportHeight] = useState(
    ARC_VIEWPORT_FALLBACK_HEIGHT,
  );
  const arcTrackHeight =
    ARC_LEADING_PADDING +
    ARC_TRAILING_PADDING +
    ARC_ITEM_GAP * Math.max(items.length - 1, 0);
  const arcPath = getArcPath(arcViewportHeight);

  function updateArcItems() {
    const viewport = arcViewportRef.current;
    const samples = arcLookupRef.current;

    if (!viewport || samples.length < 2) {
      return;
    }

    const { topInset, bottomInset } = getArcGeometry(arcViewportHeight);
    const minVisibleY = topInset - ARC_VISIBLE_MARGIN;
    const maxVisibleY = arcViewportHeight - bottomInset + ARC_VISIBLE_MARGIN;

    items.forEach((_, index) => {
      const item = itemRefs.current[index];

      if (!item) {
        return;
      }

      const itemTop = ARC_LEADING_PADDING + ARC_ITEM_GAP * index;
      const viewportY = itemTop - viewport.scrollTop;

      if (viewportY < minVisibleY || viewportY > maxVisibleY) {
        item.style.opacity = "0";
        return;
      }

      const sample = getArcSampleAtY(viewportY, samples);

      if (!sample) {
        item.style.opacity = "0";
        return;
      }

      item.style.opacity = "1";
      item.style.transform =
        `translate3d(${sample.x}px, ${sample.y}px, 0) ` +
        `translate3d(calc(-100% + 2px), -50%, 0) rotate(${sample.angle}deg)`;
    });
  }

  function scheduleArcUpdate() {
    if (frameRef.current !== null) {
      return;
    }

    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      updateArcItems();
    });
  }

  useEffect(() => {
    const viewport = arcViewportRef.current;

    if (!viewport) {
      return;
    }

    const syncViewportMetrics = () => {
      setArcViewportHeight(
        viewport.clientHeight || ARC_VIEWPORT_FALLBACK_HEIGHT,
      );
    };

    syncViewportMetrics();

    const observer = new ResizeObserver(() => {
      syncViewportMetrics();
    });

    observer.observe(viewport);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const viewport = arcViewportRef.current;

    if (!viewport) {
      return;
    }

    viewport.scrollTop = 0;
    scheduleArcUpdate();
  }, [arcTrackHeight]);

  useEffect(() => {
    const viewport = arcViewportRef.current;
    const path = arcPathRef.current;

    if (!viewport || !path) {
      return;
    }

    arcLookupRef.current = buildArcLookup(path);
    updateArcItems();

    const handleScroll = () => {
      scheduleArcUpdate();
    };

    viewport.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      viewport.removeEventListener("scroll", handleScroll);

      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [arcViewportHeight, arcPath]);

  return (
    <div className="fixed inset-y-0 right-0 z-0 hidden min-[1180px]:block">
      <div className="relative h-screen w-72">
        <svg
          className="pointer-events-none absolute inset-0 z-0 overflow-visible"
          viewBox={`0 0 ${ARC_VIEWBOX_WIDTH} ${arcViewportHeight}`}
          fill="none"
          aria-hidden="true"
        >
          <path
            ref={arcPathRef}
            d={arcPath}
            className="stroke-[#b7b7b7]/32 dark:stroke-[#676767]/38"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <div
          ref={arcViewportRef}
          className="pointer-events-auto absolute inset-y-0 right-0 z-0 w-screen overflow-y-auto overscroll-y-contain hide-scrollbar"
        >
          <div className="relative" style={{ height: `${arcTrackHeight}px` }}>
            <div
              className="pointer-events-none sticky top-0 ml-auto h-screen overflow-visible"
              style={{ width: `${ARC_VIEWBOX_WIDTH}px` }}
            >
              <ul className="absolute inset-0 z-10 m-0 list-none p-0">
                {items.map((item, index) => (
                  <li
                    key={`${item}-${index}`}
                    ref={(node) => {
                      itemRefs.current[index] = node;
                    }}
                    className="pointer-events-auto absolute top-0 left-0 origin-right whitespace-nowrap opacity-0 will-change-transform"
                  >
                    <div className="flex items-center justify-end gap-3">
                      <ToolLabel
                        textClassName="text-[12px] text-[#404040] dark:text-[#a3a3a3]"
                        toolAnchor="right"
                        text={item}
                        tool={
                          <div className="flex justify-between w-full items-center">
                            <div />
                            <div className="flex h-fit">
                              <MaskL />
                              <CoverTool text="Push" />
                            </div>
                          </div>
                        }
                      />
                      <span className="size-1 rounded-full bg-[#4f4f4f]/70 dark:bg-[#bdbdbd]/70" />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
