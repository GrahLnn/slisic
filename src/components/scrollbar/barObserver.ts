export type BarPayload = {
  scrollTop: number;
  scrollHeight: number;
};

class BarObserver {
  private subscribers: Array<(data: BarPayload) => void> = [];
  private state: BarPayload = {
    scrollTop: 0,
    scrollHeight: 0,
  };

  subscribe = (callback: (data: BarPayload) => void) => {
    this.subscribers.push(callback);
    callback(this.state);
    return () => {
      this.subscribers = this.subscribers.filter((sub) => sub !== callback);
    };
  };

  private publish = (data: Partial<BarPayload>) => {
    this.state = { ...this.state, ...data };
    for (const subscriber of this.subscribers) {
      subscriber(this.state);
    }
  };

  updateScrollTop(scrollTop: number) {
    this.publish({ scrollTop });
  }

  updateScrollHeight(scrollHeight: number) {
    this.publish({ scrollHeight });
  }
}

export const BarState = new BarObserver();
