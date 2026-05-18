import { cn } from "@/lib/utils";
import { measureNaturalWidth, prepareWithSegments } from "@chenglou/pretext";
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
} from "react";
import { motion, useAnimationControls } from "motion/react";
import type { CollectionTitleTone } from "@/src/flow/appLogic/core";
import {
  collectionTitleLayoutTransition,
  collectionTitleColorTransition,
  collectionTitleTextClassName,
  collectionTitleTextStaticClassName,
  useCollectionTitleColor,
} from "./collectionTitle";

const EMPTY_TITLE_METRIC_ANCHOR = "A";
const EDITABLE_TITLE_NEW_SYMBOL_BAR_LENGTH_EM = 0.7;
const EDITABLE_TITLE_CURSOR_BLINK_RESET_TRANSITION = { duration: 0 };
const EDITABLE_TITLE_CURSOR_MOVE_TRANSITION = {
  duration: 0.12,
  ease: "easeOut",
} as const;
export const editableTitleNewSymbolOpacityClassName = cn(
  "opacity-60 transition-opacity duration-[160ms] ease-out",
  "group-hover/editable-title:opacity-80",
);

type EditableTitleProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  interactionDisabled?: boolean;
  layoutId?: string;
  handoffTone?: CollectionTitleTone | null;
  titleNativeHoverEnabled?: boolean;
  textClassName?: string;
  focusHitSlopWidthClassName?: string;
  customCursorEnabled?: boolean;
  isNewTitle?: boolean;
  onNewTitleActivate?: () => void;
} & Omit<ComponentProps<"div">, "onChange">;

export function resolveEditableTitleDisplayValue(value: string, placeholder?: string) {
  if (value.length > 0) {
    return value;
  }

  return placeholder ?? "";
}

export function resolveEditableTitleUsesMetricAnchor(args: {
  customCursorEnabled: boolean;
  isNewTitle: boolean;
  value: string;
}) {
  return args.isNewTitle || (args.customCursorEnabled && args.value.length === 0);
}

export function resolveEditableTitleDisplayText(args: {
  isNewTitle: boolean;
  usesMetricAnchor?: boolean;
  placeholder?: string;
  value: string;
}) {
  return args.isNewTitle || args.usesMetricAnchor
    ? EMPTY_TITLE_METRIC_ANCHOR
    : resolveEditableTitleDisplayValue(args.value, args.placeholder);
}

export function resolveEditableTitleInputReadOnly(args: {
  interactionDisabled: boolean;
  isAutoWriting: boolean;
  isNewTitle: boolean;
}) {
  return args.interactionDisabled || args.isAutoWriting || args.isNewTitle;
}

export function resolveEditableTitleSelectionBackground(color: string) {
  return `color-mix(in srgb, ${color} 60%, transparent)`;
}

export function resolveEditableTitleCursorIndex(args: { cursorIndex: number; value: string }) {
  return Math.min(Math.max(0, args.cursorIndex), args.value.length);
}

export function resolveEditableTitleCursorVisible(args: {
  cursorPointReady: boolean;
  inputReadOnly: boolean;
  isFocused: boolean;
  isNewTitle: boolean;
  value: string;
}) {
  return (
    args.isNewTitle ||
    (!args.inputReadOnly && args.cursorPointReady && (args.isFocused || args.value.length === 0))
  );
}

export function resolveEditableTitleCursorShouldBlink(args: {
  cursorVisible: boolean;
  isFocused: boolean;
  isNewTitle: boolean;
}) {
  return !args.isNewTitle && args.cursorVisible && args.isFocused;
}

export function resolveEditableTitleCursorOpacityAnimation(args: {
  cursorShouldBlink: boolean;
  cursorVisible: boolean;
  isNewTitle: boolean;
}) {
  return args.isNewTitle || args.cursorVisible ? 1 : 0;
}

export function resolveEditableTitleCursorOpacityTransition(args: { cursorShouldBlink: boolean }) {
  return args.cursorShouldBlink
    ? EDITABLE_TITLE_CURSOR_BLINK_RESET_TRANSITION
    : collectionTitleLayoutTransition;
}

export function resolveEditableTitleCustomCursorTone(): CollectionTitleTone {
  return "solid";
}

export function resolveEditableTitleCustomCursorOpacityClassName(args: { isNewTitle: boolean }) {
  return args.isNewTitle ? editableTitleNewSymbolOpacityClassName : undefined;
}

export function resolveEditableTitleCustomCursorUsesMotionOpacity(args: { isNewTitle: boolean }) {
  return !args.isNewTitle;
}

export function resolveEditableTitleCustomCursorInnerOpacityStyle(args: {
  cursorOpacityAnimation: number;
  isNewTitle: boolean;
}): CSSProperties {
  return {
    opacity: args.isNewTitle ? 1 : args.cursorOpacityAnimation,
  };
}

export type EditableTitleCursorPoint = {
  leftPx: number;
  topPx: number;
  lineHeightPx: number;
  motion: "instant" | "smooth";
  ready: boolean;
};

type EditableTitlePretextInput = {
  cursorIndex: number;
  font: string;
  letterSpacingPx: number;
  lineHeightPx: number;
  maxWidthPx: number;
  text: string;
};

export function resolveEditableTitleCustomCursorBarStyle(args: {
  isNewTitle: boolean;
  lineHeightPx: number;
}): CSSProperties {
  const lineHeightPx =
    Number.isFinite(args.lineHeightPx) && args.lineHeightPx > 0 ? args.lineHeightPx : 0;

  if (args.isNewTitle) {
    return {
      height: `${EDITABLE_TITLE_NEW_SYMBOL_BAR_LENGTH_EM}em`,
      width: `${EDITABLE_TITLE_NEW_SYMBOL_BAR_LENGTH_EM}em`,
    };
  }

  return {
    height: lineHeightPx > 0 ? `${lineHeightPx}px` : "100%",
    width: lineHeightPx > 0 ? `${lineHeightPx}px` : "100%",
  };
}

export function resolveEditableTitleCustomCursorBoxStyle(args: {
  isNewTitle: boolean;
  lineHeightPx: number;
}): CSSProperties {
  if (args.isNewTitle) {
    return {
      height: "0.9em",
    };
  }

  const lineHeightPx =
    Number.isFinite(args.lineHeightPx) && args.lineHeightPx > 0 ? args.lineHeightPx : 0;

  return {
    height: lineHeightPx > 0 ? `${lineHeightPx}px` : "100%",
  };
}

export function resolveEditableTitleCursorPointFromPretextPrefixLayout(args: {
  lastLineWidthPx: number;
  lineHeightPx: number;
  lineCount: number;
  prefixEndsWithHardBreak: boolean;
}) {
  const lineHeightPx =
    Number.isFinite(args.lineHeightPx) && args.lineHeightPx > 0 ? args.lineHeightPx : 0;

  if (args.lineCount <= 0) {
    return {
      leftPx: 0,
      topPx: 0,
      lineHeightPx,
      motion: "instant",
      ready: true,
    } satisfies EditableTitleCursorPoint;
  }

  return {
    leftPx: args.prefixEndsWithHardBreak ? 0 : Math.max(0, args.lastLineWidthPx),
    topPx:
      (args.prefixEndsWithHardBreak ? args.lineCount : Math.max(0, args.lineCount - 1)) *
      lineHeightPx,
    lineHeightPx,
    motion: "smooth",
    ready: true,
  } satisfies EditableTitleCursorPoint;
}

export function resolveEditableTitleCursorMoveTransition(args: {
  isNewTitle: boolean;
  point: EditableTitleCursorPoint;
}) {
  return !args.isNewTitle && args.point.ready && args.point.motion === "smooth"
    ? EDITABLE_TITLE_CURSOR_MOVE_TRANSITION
    : EDITABLE_TITLE_CURSOR_BLINK_RESET_TRANSITION;
}

function getFontFromComputedStyle(style: CSSStyleDeclaration) {
  if (style.font && style.font !== "") {
    return style.font;
  }

  return [
    style.fontStyle,
    style.fontVariant,
    style.fontWeight,
    style.fontSize,
    style.fontFamily,
  ].join(" ");
}

function parseComputedLineHeightPx(style: CSSStyleDeclaration) {
  const parsedLineHeight = Number.parseFloat(style.lineHeight);
  if (Number.isFinite(parsedLineHeight) && parsedLineHeight > 0) {
    return parsedLineHeight;
  }

  const parsedFontSize = Number.parseFloat(style.fontSize);
  return Number.isFinite(parsedFontSize) && parsedFontSize > 0 ? parsedFontSize * 1.2 : 24;
}

function parseComputedLetterSpacingPx(style: CSSStyleDeclaration) {
  const parsedLetterSpacing = Number.parseFloat(style.letterSpacing);
  return Number.isFinite(parsedLetterSpacing) ? parsedLetterSpacing : 0;
}

export function projectEditableTitleCursorPointWithPretext(
  input: EditableTitlePretextInput,
): EditableTitleCursorPoint {
  const cursorIndex = resolveEditableTitleCursorIndex({
    cursorIndex: input.cursorIndex,
    value: input.text,
  });
  const prefix = input.text.slice(0, cursorIndex);
  if (
    prefix.length === 0 ||
    !Number.isFinite(input.maxWidthPx) ||
    input.maxWidthPx <= 0 ||
    !Number.isFinite(input.lineHeightPx) ||
    input.lineHeightPx <= 0
  ) {
    return {
      leftPx: 0,
      topPx: 0,
      lineHeightPx: input.lineHeightPx,
      motion: "instant",
      ready: true,
    };
  }

  try {
    const prepared = prepareWithSegments(prefix, input.font, {
      letterSpacing: input.letterSpacingPx,
      whiteSpace: "pre-wrap",
    });
    return resolveEditableTitleCursorPointFromPretextPrefixLayout({
      lastLineWidthPx: measureNaturalWidth(prepared),
      lineHeightPx: input.lineHeightPx,
      lineCount: 1,
      prefixEndsWithHardBreak: prefix.endsWith("\n"),
    });
  } catch {
    return {
      leftPx: 0,
      topPx: 0,
      lineHeightPx: input.lineHeightPx,
      motion: "instant",
      ready: true,
    };
  }
}

export function resolveEditableTitleLayoutId(args: {
  layoutId?: string;
  interactionDisabled: boolean;
  isFocused: boolean;
  isAutoWriting: boolean;
}) {
  if (args.isFocused || args.isAutoWriting || !args.layoutId) {
    return undefined;
  }

  return args.layoutId;
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function waitForNextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

const EDITABLE_TITLE_AUTOFOCUS_DELAY_MS =
  Math.round(collectionTitleLayoutTransition.duration * 1000) + 16;

export interface EditableTitleHandle {
  commitResolvedValue(args: { value: string; animateTyping: boolean }): Promise<void>;
  blur(): Promise<void>;
}

/**
 * The visible title layer keeps the exact display typography, while the
 * overlaid textarea preserves native text editing semantics. Keeping both
 * layers separate avoids fighting textarea rendering quirks just to reproduce
 * the title's visual treatment.
 */
export const EditableTitle = forwardRef<EditableTitleHandle, EditableTitleProps>(
  function EditableTitle(
    {
      value,
      onChange,
      placeholder,
      autoFocus = false,
      interactionDisabled = false,
      layoutId,
      handoffTone = null,
      titleNativeHoverEnabled = true,
      textClassName,
      focusHitSlopWidthClassName,
      customCursorEnabled = false,
      isNewTitle = false,
      onNewTitleActivate,
      className,
      style,
      ...props
    }: EditableTitleProps,
    ref,
  ) {
    const usesMetricAnchor = resolveEditableTitleUsesMetricAnchor({
      customCursorEnabled,
      isNewTitle,
      value,
    });
    const displayText = resolveEditableTitleDisplayText({
      isNewTitle,
      placeholder,
      usesMetricAnchor,
      value,
    });
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const titleRootRef = useRef<HTMLDivElement>(null);
    const autoWriteRunRef = useRef(0);
    const pointerFocusPendingRef = useRef(false);
    const cursorOpacityControls = useAnimationControls();
    const [cursorIndex, setCursorIndex] = useState(value.length);
    const [cursorPoint, setCursorPoint] = useState<EditableTitleCursorPoint>({
      leftPx: 0,
      topPx: 0,
      lineHeightPx: 0,
      motion: "instant",
      ready: false,
    });
    const [cursorBlinkEpoch, setCursorBlinkEpoch] = useState(0);
    const [isFocused, setIsFocused] = useState(false);
    const [isAutoWriting, setIsAutoWriting] = useState(false);
    const targetTone: CollectionTitleTone = value.length === 0 ? "muted" : "solid";
    const targetColor = useCollectionTitleColor(targetTone);
    const customCursorColor = useCollectionTitleColor(resolveEditableTitleCustomCursorTone());
    const handoffColor = useCollectionTitleColor(handoffTone ?? targetTone);
    const resolvedLayoutId = resolveEditableTitleLayoutId({
      layoutId,
      interactionDisabled,
      isFocused,
      isAutoWriting,
    });
    const hasColorHandoff = Boolean(handoffTone && handoffColor !== targetColor);
    const layoutHostKey = layoutId ?? "__editable-title";
    const inputReadOnly = resolveEditableTitleInputReadOnly({
      interactionDisabled,
      isAutoWriting,
      isNewTitle,
    });
    const cursorVisible = resolveEditableTitleCursorVisible({
      cursorPointReady: cursorPoint.ready,
      inputReadOnly,
      isFocused,
      isNewTitle,
      value,
    });
    const cursorShouldBlink = resolveEditableTitleCursorShouldBlink({
      cursorVisible,
      isFocused,
      isNewTitle,
    });
    const cursorOpacityAnimation = resolveEditableTitleCursorOpacityAnimation({
      cursorShouldBlink,
      cursorVisible,
      isNewTitle,
    });
    const cursorOpacityTransition = resolveEditableTitleCursorOpacityTransition({
      cursorShouldBlink,
    });
    const customCursorBarStyle = resolveEditableTitleCustomCursorBarStyle({
      isNewTitle,
      lineHeightPx: cursorPoint.lineHeightPx,
    });
    const customCursorBoxStyle = resolveEditableTitleCustomCursorBoxStyle({
      isNewTitle,
      lineHeightPx: cursorPoint.lineHeightPx,
    });
    const customCursorOpacityClassName = resolveEditableTitleCustomCursorOpacityClassName({
      isNewTitle,
    });
    const customCursorUsesMotionOpacity = resolveEditableTitleCustomCursorUsesMotionOpacity({
      isNewTitle,
    });
    const customCursorInnerOpacityStyle = resolveEditableTitleCustomCursorInnerOpacityStyle({
      cursorOpacityAnimation,
      isNewTitle,
    });
    const cursorMoveTransition = resolveEditableTitleCursorMoveTransition({
      isNewTitle,
      point: cursorPoint,
    });

    const syncCursorPoint = useCallback(
      (node: HTMLTextAreaElement | null = inputRef.current) => {
        if (!node || isNewTitle) {
          setCursorPoint({
            leftPx: 0,
            lineHeightPx: 0,
            motion: "instant",
            ready: isNewTitle,
            topPx: 0,
          });
          return;
        }

        const ownerWindow = node.ownerDocument.defaultView ?? window;
        const computedStyle = ownerWindow.getComputedStyle(node);
        const lineHeightPx = parseComputedLineHeightPx(computedStyle);
        const letterSpacingPx = parseComputedLetterSpacingPx(computedStyle);
        const font = getFontFromComputedStyle(computedStyle);
        const nextPoint = projectEditableTitleCursorPointWithPretext({
          cursorIndex: node.selectionStart,
          font,
          letterSpacingPx,
          lineHeightPx,
          maxWidthPx: node.clientWidth,
          text: node.value,
        });
        setCursorPoint((current) =>
          current.leftPx === nextPoint.leftPx &&
          current.topPx === nextPoint.topPx &&
          current.lineHeightPx === nextPoint.lineHeightPx &&
          current.ready === nextPoint.ready
            ? current
            : {
                ...nextPoint,
                motion: current.ready && nextPoint.ready ? "smooth" : "instant",
              },
        );
      },
      [isNewTitle],
    );

    useLayoutEffect(() => {
      if (!customCursorEnabled || !customCursorUsesMotionOpacity) {
        cursorOpacityControls.stop();
        return;
      }

      cursorOpacityControls.stop();

      if (cursorShouldBlink) {
        cursorOpacityControls.set({ opacity: 1 });
        void cursorOpacityControls.start({
          opacity: [1, 1, 0, 0, 1],
          transition: {
            duration: 1,
            ease: "linear",
            repeat: Infinity,
            times: [0, 0.48, 0.5, 0.98, 1],
          },
        });
      } else {
        void cursorOpacityControls.start({
          opacity: cursorOpacityAnimation,
          transition: cursorOpacityTransition,
        });
      }

      return () => {
        cursorOpacityControls.stop();
      };
    }, [
      customCursorEnabled,
      cursorBlinkEpoch,
      cursorOpacityAnimation,
      cursorOpacityControls,
      cursorOpacityTransition,
      cursorShouldBlink,
      customCursorUsesMotionOpacity,
    ]);

    useLayoutEffect(() => {
      if (!interactionDisabled) {
        return;
      }

      inputRef.current?.blur();
    }, [interactionDisabled]);

    useLayoutEffect(() => {
      if (!customCursorEnabled || isNewTitle) {
        return;
      }

      syncCursorPoint();
    }, [customCursorEnabled, cursorIndex, isNewTitle, syncCursorPoint, value]);

    useLayoutEffect(() => {
      if (!customCursorEnabled || isNewTitle) {
        return;
      }

      const node = inputRef.current;
      const ownerWindow = node?.ownerDocument.defaultView ?? window;
      const ResizeObserverCtor = ownerWindow.ResizeObserver;
      if (!node || !ResizeObserverCtor) {
        return;
      }

      const observer = new ResizeObserverCtor(() => syncCursorPoint(node));
      observer.observe(node);

      return () => {
        observer.disconnect();
      };
    }, [customCursorEnabled, isNewTitle, syncCursorPoint]);

    useImperativeHandle(
      ref,
      () => ({
        async commitResolvedValue(args) {
          const node = inputRef.current;
          const runId = autoWriteRunRef.current + 1;
          autoWriteRunRef.current = runId;

          if (!node) {
            onChange(args.value);
            return;
          }

          if (!args.animateTyping) {
            onChange(args.value);
            node.focus();
            await waitForNextFrame();
            node.blur();
            await waitForNextFrame();
            return;
          }

          setIsAutoWriting(true);
          node.focus();
          node.setSelectionRange(0, 0);
          onChange("");
          await waitForNextFrame();

          for (let index = 0; index < args.value.length; index += 1) {
            if (autoWriteRunRef.current !== runId) {
              break;
            }

            onChange(args.value.slice(0, index + 1));
            await wait(22);
          }

          node.blur();
          await waitForNextFrame();
          if (autoWriteRunRef.current === runId) {
            setIsAutoWriting(false);
          }
        },
        async blur() {
          inputRef.current?.blur();
          await waitForNextFrame();
        },
      }),
      [onChange],
    );

    function commitInputCursor(node: HTMLTextAreaElement) {
      setCursorIndex(node.selectionStart);
      syncCursorPoint(node);
    }

    function resetCursorBlinkCycle() {
      setCursorBlinkEpoch((epoch) => epoch + 1);
    }

    function focusEditableInputNodeAtEnd(node: HTMLTextAreaElement | null) {
      if (!node || node.readOnly || !node.isConnected) {
        return false;
      }
      const cursor = node.value.length;
      node.setSelectionRange(cursor, cursor);
      node.focus();
      setCursorIndex(cursor);
      syncCursorPoint(node);
      return true;
    }

    function scheduleFocusWhenEditable(node: HTMLTextAreaElement | null) {
      if (!node) {
        return;
      }

      const ownerWindow = node.ownerDocument.defaultView ?? window;
      let attempts = 0;
      const focusWhenReady = () => {
        attempts += 1;
        if (focusEditableInputNodeAtEnd(node) || attempts >= 2) {
          return;
        }

        ownerWindow.requestAnimationFrame(focusWhenReady);
      };

      ownerWindow.requestAnimationFrame(focusWhenReady);
    }

    function focusInputFromHitSlop() {
      if (inputReadOnly) {
        return;
      }

      focusEditableInputNodeAtEnd(inputRef.current);
    }

    function activateNewTitle() {
      if (interactionDisabled || isAutoWriting || !onNewTitleActivate) {
        return;
      }

      const node = inputRef.current;
      onNewTitleActivate();
      scheduleFocusWhenEditable(node);
    }
    const newTitleActivationBlocked = interactionDisabled || isAutoWriting || !onNewTitleActivate;

    return (
      <div {...props}>
        <motion.div
          key={layoutHostKey}
          ref={titleRootRef}
          layoutId={resolvedLayoutId}
          className={cn(
            "relative w-fit max-w-full",
            isNewTitle && "group/editable-title",
            className,
          )}
          style={style}
        >
          <motion.div
            aria-hidden="true"
            className={cn(
              "pointer-events-none whitespace-pre-wrap wrap-break-word",
              usesMetricAnchor && "select-none opacity-0",
              titleNativeHoverEnabled
                ? collectionTitleTextClassName
                : collectionTitleTextStaticClassName,
              textClassName,
            )}
            initial={false}
            animate={{ color: targetColor }}
            transition={hasColorHandoff ? collectionTitleColorTransition : { duration: 0 }}
            style={{ color: hasColorHandoff ? handoffColor : targetColor }}
          >
            {displayText}
          </motion.div>
          <textarea
            ref={(node) => {
              inputRef.current = node;

              if (
                !node ||
                !autoFocus ||
                interactionDisabled ||
                node.dataset.autofocusReady === "true"
              ) {
                return;
              }

              node.dataset.autofocusReady = "true";
              window.setTimeout(() => {
                if (!node.isConnected || interactionDisabled) {
                  return;
                }

                const cursor = node.value.length;
                node.setSelectionRange(cursor, cursor);
                node.focus();
                setCursorIndex(cursor);
                syncCursorPoint(node);
              }, EDITABLE_TITLE_AUTOFOCUS_DELAY_MS);
            }}
            aria-label="List title"
            rows={1}
            spellCheck={false}
            readOnly={inputReadOnly}
            tabIndex={inputReadOnly ? -1 : undefined}
            value={value}
            onChange={(event) => {
              resetCursorBlinkCycle();
              commitInputCursor(event.target);
              onChange(event.target.value);
            }}
            onBlur={(event) => onChange(event.target.value.trim())}
            onFocus={(event) => {
              setIsFocused(true);
              if (pointerFocusPendingRef.current) {
                setCursorPoint((current) =>
                  current.ready
                    ? {
                        ...current,
                        motion: "instant",
                        ready: false,
                      }
                    : current,
                );
                return;
              }

              commitInputCursor(event.target);
            }}
            onPointerDownCapture={(event) => {
              pointerFocusPendingRef.current = true;
              if (event.currentTarget.ownerDocument.activeElement !== event.currentTarget) {
                setCursorPoint((current) =>
                  current.ready
                    ? {
                        ...current,
                        motion: "instant",
                        ready: false,
                      }
                    : current,
                );
              }
            }}
            onBlurCapture={() => {
              pointerFocusPendingRef.current = false;
              setIsFocused(false);
            }}
            onClick={(event) => {
              pointerFocusPendingRef.current = false;
              resetCursorBlinkCycle();
              commitInputCursor(event.currentTarget);
            }}
            onKeyUp={(event) => commitInputCursor(event.currentTarget)}
            onSelect={(event) => commitInputCursor(event.currentTarget)}
            className={cn(
              "absolute inset-0 block h-full w-full resize-none overflow-hidden bg-transparent",
              inputReadOnly ? "pointer-events-none" : "pointer-events-auto cursor-text",
              "whitespace-pre-wrap wrap-break-word text-transparent outline-none",
              titleNativeHoverEnabled
                ? collectionTitleTextClassName
                : collectionTitleTextStaticClassName,
              textClassName,
              customCursorEnabled ? "caret-transparent" : "caret-[#090909] dark:caret-[#f6f6f6]",
              customCursorEnabled &&
                "selection:bg-[var(--editable-title-selection-background)] selection:text-transparent",
            )}
            style={
              {
                "--editable-title-selection-background":
                  resolveEditableTitleSelectionBackground(targetColor),
                fontFamily: "inherit",
                fontSize: "inherit",
                lineHeight: "inherit",
              } as CSSProperties
            }
          />
          {customCursorEnabled && (
            <div
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute inset-0 z-10",
                isNewTitle
                  ? "flex items-center justify-center"
                  : "whitespace-pre-wrap wrap-break-word",
                titleNativeHoverEnabled
                  ? collectionTitleTextClassName
                  : collectionTitleTextStaticClassName,
                textClassName,
              )}
              style={{ color: customCursorColor }}
            >
              <motion.span
                layout
                className={cn(
                  "inline-flex align-middle text-current",
                  isNewTitle ? "relative w-[0.9em]" : "absolute top-0 left-0 w-0",
                )}
                initial={false}
                animate={{
                  x: isNewTitle ? 0 : cursorPoint.leftPx,
                  y: isNewTitle ? 0 : cursorPoint.topPx,
                }}
                transition={{
                  x: cursorMoveTransition,
                  y: cursorMoveTransition,
                }}
                style={customCursorBoxStyle}
              >
                <span className={cn("absolute inset-0 text-current", customCursorOpacityClassName)}>
                  <motion.span
                    initial={false}
                    animate={customCursorUsesMotionOpacity ? cursorOpacityControls : undefined}
                    className="absolute inset-0 text-current"
                    style={customCursorInnerOpacityStyle}
                  >
                    <span
                      className="absolute top-1/2 left-1/2 w-[0.075em] -translate-x-1/2 -translate-y-1/2 rounded-full bg-current"
                      style={{
                        height: customCursorBarStyle.height,
                      }}
                    />
                    <motion.span
                      className="absolute top-1/2 left-1/2 h-[0.075em] -translate-x-1/2 -translate-y-1/2 rounded-full bg-current"
                      style={{
                        width: customCursorBarStyle.width,
                      }}
                      initial={false}
                      animate={{ rotate: isNewTitle ? 0 : 90 }}
                      transition={collectionTitleLayoutTransition}
                    />
                  </motion.span>
                </span>
              </motion.span>
            </div>
          )}
          {isNewTitle && (
            <button
              type="button"
              aria-label="Activate new title"
              aria-disabled={newTitleActivationBlocked}
              tabIndex={newTitleActivationBlocked ? -1 : undefined}
              onPointerDown={(event) => {
                event.preventDefault();
              }}
              onClick={activateNewTitle}
              className={cn("absolute inset-0 z-20 border-0 bg-transparent p-0", "cursor-default")}
            />
          )}
          {focusHitSlopWidthClassName && (
            <div
              aria-label="Focus title"
              role="button"
              tabIndex={-1}
              onPointerDown={(event) => {
                event.preventDefault();
                focusInputFromHitSlop();
              }}
              onClick={focusInputFromHitSlop}
              className={cn(
                "absolute inset-y-0 left-full cursor-text border-0 bg-transparent p-0",
                focusHitSlopWidthClassName,
                inputReadOnly ? "pointer-events-none" : "pointer-events-auto",
              )}
            />
          )}
        </motion.div>
      </div>
    );
  },
);
