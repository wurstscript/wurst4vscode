type Subscriber = () => void;

let activeEffect: Subscriber | undefined;

export interface Signal<T> {
  get(): T;
  set(value: T): void;
}

export function signal<T>(initial: T): Signal<T> {
  let value = initial;
  const subscribers = new Set<Subscriber>();
  return {
    get(): T {
      if (activeEffect) subscribers.add(activeEffect);
      return value;
    },
    set(next: T): void {
      if (Object.is(value, next)) return;
      value = next;
      for (const subscriber of Array.from(subscribers)) subscriber();
    },
  };
}

export function effect(run: Subscriber): void {
  const wrapped = () => {
    activeEffect = wrapped;
    try {
      run();
    } finally {
      activeEffect = undefined;
    }
  };
  wrapped();
}
