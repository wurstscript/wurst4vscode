type Dispose = () => void;
type EffectFn = () => void;

interface Computation {
  run(): void;
  deps: Set<Computation>[];
  disposed: boolean;
}

let activeEffect: Computation | undefined;
let batchDepth = 0;
const pendingEffects = new Set<Computation>();

export interface Signal<T> {
  get(): T;
  set(value: T): void;
  update(map: (value: T) => T): void;
}

export function signal<T>(initial: T): Signal<T> {
  let value = initial;
  const subscribers = new Set<Computation>();
  return {
    get(): T {
      if (activeEffect && !activeEffect.disposed) {
        if (!subscribers.has(activeEffect)) {
          subscribers.add(activeEffect);
          activeEffect.deps.push(subscribers);
        }
      }
      return value;
    },
    set(next: T): void {
      if (Object.is(value, next)) return;
      value = next;
      for (const subscriber of Array.from(subscribers)) schedule(subscriber);
    },
    update(map: (current: T) => T): void {
      this.set(map(value));
    },
  };
}

export function effect(run: EffectFn): Dispose {
  const computation: Computation = {
    deps: [],
    disposed: false,
    run(): void {
      if (computation.disposed) return;
      cleanup(computation);
      const previous = activeEffect;
      activeEffect = computation;
      try {
        run();
      } finally {
        activeEffect = previous;
      }
    },
  };
  computation.run();
  return () => {
    computation.disposed = true;
    pendingEffects.delete(computation);
    cleanup(computation);
  };
}

export function batch<T>(run: () => T): T {
  batchDepth++;
  try {
    return run();
  } finally {
    batchDepth--;
    if (batchDepth === 0) flush();
  }
}

export function computed<T>(derive: () => T): Pick<Signal<T>, 'get'> {
  const value = signal(untracked(derive));
  effect(() => value.set(derive()));
  return { get: value.get };
}

export function untracked<T>(run: () => T): T {
  const previous = activeEffect;
  activeEffect = undefined;
  try {
    return run();
  } finally {
    activeEffect = previous;
  }
}

function cleanup(computation: Computation): void {
  for (const dep of computation.deps) dep.delete(computation);
  computation.deps.length = 0;
}

function schedule(computation: Computation): void {
  if (computation.disposed) return;
  if (batchDepth > 0) {
    pendingEffects.add(computation);
    return;
  }
  computation.run();
}

function flush(): void {
  while (pendingEffects.size) {
    const effects = Array.from(pendingEffects);
    pendingEffects.clear();
    for (const computation of effects) computation.run();
  }
}
