import { BarState } from "./barObserver";

export const scrollbar = {
  updateScrollTop(scrollTop: number) {
    BarState.updateScrollTop(scrollTop);
  },
  updateContainerHeight(scrollHeight: number) {
    BarState.updateScrollHeight(scrollHeight);
  },
};
