import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  resolveMusicSpectrumContentFadeProps,
  resolveMusicSpectrumTitleFadeProps,
} from "./MusicSpectrumEditor";

describe("MusicSpectrumEditor", () => {
  test("keeps shared title visible instead of applying page content fade", () => {
    assert.deepEqual(resolveMusicSpectrumTitleFadeProps({ hasSharedTitleLayout: true }), {
      initial: { opacity: 1 },
      animate: { opacity: 1 },
      exit: { opacity: 1 },
      transition: {
        duration: 0.36,
        ease: [0.22, 1, 0.36, 1],
      },
    });
  });

  test("uses regular content fade when no shared title layout exists", () => {
    assert.deepEqual(resolveMusicSpectrumTitleFadeProps({ hasSharedTitleLayout: false }), {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      transition: {
        duration: 0.36,
        ease: [0.22, 1, 0.36, 1],
      },
    });
  });

  test("delays non-primary editor content for cascade entry", () => {
    assert.deepEqual(resolveMusicSpectrumContentFadeProps({ cascade: true }), {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      transition: {
        duration: 0.36,
        ease: [0.22, 1, 0.36, 1],
        delay: 0.04,
      },
    });
  });
});
