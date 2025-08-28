import React, { useEffect, useRef, useCallback } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "@studio-freight/lenis";
import { me } from "@/lib/matchable";

gsap.registerPlugin(ScrollTrigger);

export interface SpotlightSectionProps<T> {
  items: T[];
  render: (item: T, index: number) => React.ReactNode;
  gap?: number;
  speed?: number;
  arcRadius?: number;
  pinVhMultiplier?: number;
}

export function SpotlightSection<T>({
  items,
  render,
  gap = 0.08,
  speed = 0.3,
  arcRadius = 500,
  pinVhMultiplier = 10,
}: SpotlightSectionProps<T>) {
  return (
    <section className="relative w-full h-full">
      <div className="absolute inset-0">
        <div className="absolute top-0 w-full h-full overflow-hidden">
          <div className="relative left-[5%] w-[60%] h-full flex z-10 items-center justify-center gap-2">
            {Array.from({ length: 70 }).map((_, i) => (
              <div key={i} className="h-1 w-1 rounded-full bg-[#737373]" />
            ))}
          </div>
        </div>
      </div>
      <div className="absolute top-0 right-0 w-[40%] min-w-[300px] h-full z-20 pointer-events-auto overflow-y-auto overflow-x-hidden hide-scrollbar">
        <div className="flex flex-col items-center gap-16 my-48">
          {items.map((item, i) => render(item, i))}
        </div>
      </div>
    </section>
  );
}

// import React, { useEffect, useRef, useCallback } from "react";
// import gsap from "gsap";
// import { ScrollTrigger } from "gsap/ScrollTrigger";
// import Lenis from "@studio-freight/lenis";
// import { me } from "@/lib/matchable";
// import { log } from "@/lib/e";
// import {
//   animate,
//   createScope,
//   createSpring,
//   createDraggable,
//   type Scope,
// } from "animejs";
// import { cn } from "@/lib/utils";

// gsap.registerPlugin(ScrollTrigger);

// export interface SpotlightSectionProps<T> {
//   items: T[];
//   render: (item: T, index: number) => React.ReactNode;
//   gap?: number;
//   speed?: number;
//   arcRadius?: number;
//   pinVhMultiplier?: number;
// }

// export function SpotlightSection<T>({
//   items,
//   render,
//   gap = 0.08,
//   speed = 0.3,
//   arcRadius = 500,
//   pinVhMultiplier = 10,
// }: SpotlightSectionProps<T>) {
//   const sectionRef = useRef<HTMLElement | null>(null);
//   const floatRefs = useRef<HTMLDivElement[]>([]);
//   const root = useRef<HTMLElement | null>(null);
//   const scope = useRef<Scope | null>(null);
//   const stRef = useRef<ScrollTrigger | null>(null);
//   const lenisRef = useRef<Lenis | null>(null);
//   const snappedRef = useRef(false);

//   const VELOCITY_THRESHOLD = 1;

//   const setFloatRef = (el: HTMLDivElement | null, i: number) => {
//     if (el) floatRefs.current[i] = el;
//   };

//   /** 二次贝塞尔曲线轨迹 */
//   const getBezierPosition = useCallback(
//     (t: number) => {
//       const w = window.innerWidth * 0.3;
//       const h = window.innerHeight;
//       const sx = w - 220;
//       const sy = -200;
//       const ey = h + 200;
//       const cx = sx + arcRadius;
//       const cy = h / 2;
//       const u = 1 - t;
//       const x = u * u * sx + 2 * u * t * cx + t * t * sx;
//       const y = u * u * sy + 2 * u * t * cy + t * t * ey;
//       return { x, y };
//     },
//     [arcRadius]
//   );

//   useEffect(() => {
//     scope.current = createScope({ root }).add((self) => {});
//     return () => scope.current?.revert();
//   });

//   return (
//     <section ref={sectionRef} className="relative w-full h-full">
//       <div className="absolute inset-0">
//         <div className="absolute top-8 w-full h-full overflow-hidden">
//           <div className="relative left-[5%] w-[60%] h-full flex z-10 items-center justify-center gap-2">
//             {Array.from({ length: 70 }).map((_, i) => (
//               <div key={i} className="h-1 w-1 rounded-full bg-[#737373]" />
//             ))}
//           </div>
//         </div>
//       </div>

//       <div
//         className="absolute top-0 right-0 w-1/2 min-w-[300px] h-full z-[1]"
//         ref={(el) => {
//           root.current = el as HTMLElement;
//         }}
//       >
//         {items.map((item, i) => (
//           <div
//             key={`float-${i}`}
//             ref={(el) => setFloatRef(el as HTMLDivElement, i)}
//             className={cn([
//               `float-${i}`,
//               "absolute w-[200px] h-[150px] will-change-transform opacity-0",
//             ])}
//             style={{ top: 0, left: 0 }}
//           >
//             {render(item, i)}
//           </div>
//         ))}
//       </div>
//     </section>
//   );
// }
