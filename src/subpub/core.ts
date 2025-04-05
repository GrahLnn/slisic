import { useEffect, useState } from "react";

type Subscriber<T> = (value: T) => void;

class Bus<T> {
  private value: T;
  private subscribers = new Set<Subscriber<T>>();

  constructor(initialValue: T) {
    this.value = initialValue;
  }

  subscribe(callback: Subscriber<T>) {
    this.subscribers.add(callback);
    callback(this.value); // 初次同步
    return () => {
      this.subscribers.delete(callback);
    };
  }

  set(value: T) {
    this.value = value;
    for (const cb of this.subscribers) {
      cb(value);
    }
  }

  get() {
    return this.value;
  }
}

export function createBus<T>(initialValue: T) {
  const bus = new Bus<T>(initialValue);

  function useValue() {
    const [value, setValue] = useState(() => bus.get());
    useEffect(() => {
      const unsubscribe = bus.subscribe(setValue);
      return unsubscribe;
    }, []);
    return value;
  }

  function setValue(value: T) {
    bus.set(value);
  }

  function getValue() {
    return bus.get();
  }

  return {
    useValue,
    setValue,
    getValue,
  };
}
