/**
 * A tiny, dependency-free fine-grained reactivity core - `signal` / `computed` / `effect` / `batch` / `untracked`
 * - in the spirit of SolidJS / Angular & Preact signals. It exists so webview UI state has ONE ground truth and
 * consumers (tree/detail rendering, toolbars) update themselves when it changes, instead of every call site
 * manually re-querying and re-rendering.
 *
 * Semantics (ported 1:1 from the Kotlin original used elsewhere in this toolkit):
 *  - **Automatic dependency tracking.** Reading a signal/computed's `.value` while a computed or effect is
 *    running subscribes that observer to it. No manual subscribe/unsubscribe.
 *  - **Lazy computed.** A `computed()` only recomputes when read (or pulled by a running effect) *and* a
 *    dependency actually changed. Unobserved computeds cost nothing.
 *  - **Glitch-free.** Uses two-level invalidation (CHECK = "a dependency *might* have changed", DIRTY =
 *    "definitely changed") so a diamond `a -> {b, c} -> d` recomputes `d` once, never with a half-updated input,
 *    and an effect never runs for a derived value that re-evaluated to the same result.
 *  - **Batched effects.** Effects run synchronously after the triggering write; wrap multiple writes in `batch`
 *    to flush dependent effects once.
 *  - **Cycle-safe.** A run-away feedback loop between effects is capped per flush - see `maxEffectRunsPerFlush`
 *    / `ReactiveCycleException`.
 *
 * **Lifecycle & disposal:** there is no GC-driven teardown. A live `effect` is kept alive by the signals it
 * observes, so it runs until you dispose it. Anything created for a *transient* owner (a panel that gets torn
 * down and rebuilt) should be registered in a `ReactiveScope` and disposed with that owner.
 *
 * **Threading:** webviews are single-threaded JS, so this is safe as-is - writes run their dependent effects
 * synchronously on the calling turn.
 */

/** Read-only reactive value. Reading `.value` inside a computed/effect subscribes to it. */
export interface ReactiveValue<T> {
  readonly value: T;

  /**
   * Subscribes `block` to this reactive value, running it on every change AFTER the current one (NOT
   * immediately). Register once, get called whenever the value changes. Returns a `Disposable` to unsubscribe.
   */
  subscribe(block: () => void): Disposable;
}

/** A writable reactive cell. */
export interface Signal<T> extends ReactiveValue<T> {
  value: T;

  /** Read the current value WITHOUT subscribing the running observer (same as `untracked` for one read). */
  peek(): T;

  /** Atomically set based on the current value, e.g. `count.update(v => v + 1)`. */
  update(transform: (value: T) => T): void;
}

/** Handle returned by `effect`; call `dispose` to stop it and release its subscriptions. */
export interface Disposable {
  dispose(): void;
}

/**
 * Thrown by a signal write (from inside the effect flush) when a single effect runs more than
 * `maxEffectRunsPerFlush` times during one synchronous flush - the signature of a feedback loop between effects.
 * Catch it at a top-level boundary to recover (log, reset state) instead of freezing the webview.
 */
export class ReactiveCycleException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReactiveCycleException';
  }
}

/**
 * Safety cap: the maximum number of times any one effect may execute within a single flush before a
 * `ReactiveCycleException` is raised. Generous by default - a healthy effect runs once (occasionally a few
 * times) per flush - so hitting it means a genuine cycle.
 */
export let maxEffectRunsPerFlush = 1000;

export function setMaxEffectRunsPerFlush(value: number): void {
  maxEffectRunsPerFlush = value;
}

// ---------------------------------------------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------------------------------------------

type NodeState = 'clean' | 'check' | 'dirty';
const CLEAN: NodeState = 'clean';
const CHECK: NodeState = 'check';
const DIRTY: NodeState = 'dirty';
const stateRank: Record<NodeState, number> = { clean: 0, check: 1, dirty: 2 };

let currentObserver: ReactiveNode | null = null;
let batchDepth = 0;
const pendingEffects: EffectNode[] = [];
let flushing = false;

/** Monotonic id of the current flush; effects use it to reset their per-flush run counter (cycle detection). */
let flushId = 0;

/**
 * Base for every node. A node can play two roles: a SOURCE (observable - `observers`/`version`) and an OBSERVER
 * (reads other sources - `sources`/`sourceVersions`/`state`). A signal is only a source, an effect only an
 * observer, and a computed is both.
 */
abstract class ReactiveNode {
  // Source role.
  readonly observers: ReactiveNode[] = [];
  version = 0;

  // Observer role.
  readonly sources: ReactiveNode[] = [];
  readonly sourceVersions: number[] = [];
  state: NodeState = CLEAN;

  /** True once an effect is disposed; a disposed observer must never re-register anywhere. */
  disposed = false;

  /** Subscribe the running observer (if any) to this source. */
  protected trackRead(): void {
    const obs = currentObserver;
    if (!obs || obs === (this as unknown as ReactiveNode) || obs.disposed || obs.sources.includes(this)) return;
    obs.sources.push(this);
    obs.sourceVersions.push(this.version);
    this.observers.push(obs);
  }

  /** Drop all of this observer's subscriptions (called before a re-run and on dispose). */
  protected clearSources(): void {
    for (const source of this.sources) {
      const idx = source.observers.indexOf(this);
      if (idx !== -1) source.observers.splice(idx, 1);
    }
    this.sources.length = 0;
    this.sourceVersions.length = 0;
  }

  /** Tell observers this source changed (DIRTY) or might have (CHECK). */
  protected notifyObservers(newState: NodeState): void {
    // observers list only grows during a run (never shrinks mid-notify), so reverse index is safe.
    for (let i = this.observers.length - 1; i >= 0; i--) {
      if (i < this.observers.length) this.observers[i].markStale(newState);
    }
  }

  private markStale(newState: NodeState): void {
    const wasClean = this.state === CLEAN;
    if (stateRank[this.state] < stateRank[newState]) this.state = newState;
    // onStale runs even when the state did not upgrade: an effect can be stale-but-unqueued (e.g. after its
    // body threw during a flush) and must be able to re-enqueue itself on the next source change.
    this.onStale(wasClean);
  }

  /** ComputedNode propagates CHECK downstream (once); EffectNode schedules itself (if not already queued). */
  protected onStale(_wasClean: boolean): void {
    // no-op by default
  }

  /** Recompute / run if stale. Default: nothing (a plain SignalNode is never stale). */
  updateIfNecessary(): void {
    // no-op by default
  }

  /** Pull each source up to date, then report whether any actually changed since we last read it. */
  protected anySourceChanged(): boolean {
    for (let i = 0; i < this.sources.length; i++) {
      this.sources[i].updateIfNecessary();
      if (this.sources[i].version !== this.sourceVersions[i]) return true;
    }
    return false;
  }
}

const UNSET = Symbol('unset');

abstract class ValueNode<T> extends ReactiveNode implements ReactiveValue<T> {
  abstract readonly value: T;

  subscribe(block: () => void): Disposable {
    let primed = false;
    return effect(() => {
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      this.value; // read to subscribe
      // The callback runs untracked so signals it happens to read don't become extra triggers.
      if (primed) untracked(block);
      else primed = true;
    });
  }
}

class SignalNode<T> extends ValueNode<T> implements Signal<T> {
  private current: T;
  private readonly equalsFn: (a: T, b: T) => boolean;

  constructor(initial: T, equalsFn: (a: T, b: T) => boolean) {
    super();
    this.current = initial;
    this.equalsFn = equalsFn;
  }

  get value(): T {
    this.trackRead();
    return this.current;
  }

  set value(newValue: T) {
    if (this.equalsFn(this.current, newValue)) return;
    this.current = newValue;
    this.version++;
    this.notifyObservers(DIRTY);
    if (batchDepth === 0) flushEffects();
  }

  peek(): T {
    return this.current;
  }

  update(transform: (value: T) => T): void {
    this.value = transform(this.peek());
  }
}

class ComputedNode<T> extends ValueNode<T> {
  private cached: T | typeof UNSET = UNSET;
  private readonly compute: () => T;
  private readonly equalsFn: (a: T, b: T) => boolean;

  constructor(compute: () => T, equalsFn: (a: T, b: T) => boolean) {
    super();
    this.compute = compute;
    this.equalsFn = equalsFn;
    this.state = DIRTY; // first read forces a compute
  }

  get value(): T {
    // Bring ourselves up to date FIRST, then subscribe - so the version a dependent records is our final,
    // post-recompute version. (Recording it before recompute would make every recheck look like a change.)
    this.updateIfNecessary();
    this.trackRead();
    return this.cached as T;
  }

  protected onStale(wasClean: boolean): void {
    // Our cached value may now be out of date - tell downstream observers to re-check (not necessarily re-run).
    if (wasClean) this.notifyObservers(CHECK);
  }

  updateIfNecessary(): void {
    switch (this.state) {
      case CLEAN:
        return;
      case CHECK:
        if (this.anySourceChanged()) this.recompute();
        else this.state = CLEAN;
        return;
      case DIRTY:
        this.recompute();
    }
  }

  private recompute(): void {
    this.clearSources();
    const prev = currentObserver;
    currentObserver = this;
    let next: T;
    try {
      next = this.compute();
    } finally {
      currentObserver = prev;
    }
    if (this.cached === UNSET || !this.equalsFn(this.cached as T, next)) {
      this.cached = next;
      this.version++; // observers compare against this to know we really changed
    }
    this.state = CLEAN;
  }
}

class EffectNode extends ReactiveNode implements Disposable {
  private readonly run: () => void;
  private readonly name: string | undefined;
  private readonly cleanups: Array<() => void> = [];

  /** True while this effect sits in `pendingEffects` - tracked explicitly so it is never enqueued twice. */
  queued = false;

  /** True while `execute` runs the body; a mid-run self-write must not reschedule the running effect. */
  private running = false;

  // Cycle detection: how many times this effect has executed within the current flush (`flushId`).
  private lastFlushId = -1;
  private runsThisFlush = 0;

  constructor(run: () => void, name: string | undefined) {
    super();
    this.run = run;
    this.name = name;
  }

  runInitial(): void {
    this.state = DIRTY;
    this.execute();
  }

  addCleanup(block: () => void): void {
    this.cleanups.push(block);
  }

  protected onStale(_wasClean: boolean): void {
    if (!this.queued && !this.running && !this.disposed) {
      this.queued = true;
      pendingEffects.push(this);
    }
  }

  updateIfNecessary(): void {
    if (this.disposed) return;
    switch (this.state) {
      case CLEAN:
        return;
      case CHECK:
        if (this.anySourceChanged()) this.execute();
        else this.state = CLEAN;
        return;
      case DIRTY:
        this.execute();
    }
  }

  private execute(): void {
    this.guardAgainstCycle();
    this.runCleanups();
    this.running = true;
    this.clearSources();
    const prev = currentObserver;
    currentObserver = this;
    try {
      this.run();
    } finally {
      currentObserver = prev;
      this.running = false;
      // Reset even when the body threw, so the effect stays runnable: the next change to a source it did
      // read re-marks it stale and onStale re-enqueues it, instead of wedging it DIRTY-but-unqueued forever.
      this.state = CLEAN;
    }
  }

  /** Trips when this effect keeps re-executing within one flush - i.e. it is part of a feedback loop. */
  private guardAgainstCycle(): void {
    if (this.lastFlushId !== flushId) {
      this.lastFlushId = flushId;
      this.runsThisFlush = 0;
    }
    if (++this.runsThisFlush > maxEffectRunsPerFlush) {
      throw new ReactiveCycleException(
        `Reactive cycle detected: effect '${this.name ?? '<anonymous>'}' ran ${this.runsThisFlush} times in a ` +
          `single flush (limit maxEffectRunsPerFlush=${maxEffectRunsPerFlush}). Two or more effects are likely ` +
          `writing signals that re-trigger one another. Name your effects to identify the culprit.`,
      );
    }
  }

  private runCleanups(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.runCleanups();
    this.clearSources();
    if (this.queued) {
      this.queued = false;
      const idx = pendingEffects.indexOf(this);
      if (idx !== -1) pendingEffects.splice(idx, 1);
    }
  }
}

function flushEffects(): void {
  if (flushing) return; // a write inside an effect just queues more work; the loop below drains it
  flushing = true;
  flushId++; // new flush: effects reset their per-flush run counters on first execution
  let thrown: unknown;
  const suppressed: unknown[] = [];
  try {
    while (pendingEffects.length > 0) {
      const next = pendingEffects.shift()!;
      next.queued = false;
      try {
        next.updateIfNecessary();
      } catch (t) {
        // One bad effect must not wedge the innocent ones queued behind it: keep draining, remember the
        // first failure and rethrow it afterwards (later ones ride along as suppressed).
        if (thrown === undefined) thrown = t;
        else suppressed.push(t);
      }
    }
  } finally {
    flushing = false;
  }
  if (thrown !== undefined) {
    if (suppressed.length > 0 && thrown instanceof Error) {
      (thrown as Error & { suppressed?: unknown[] }).suppressed = suppressed;
    }
    throw thrown;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------------------------

const defaultEquals = <T,>(a: T, b: T): boolean => Object.is(a, b);

/** Creates a writable `Signal` with the given initial value. `equals` decides whether a write is a real change. */
export function signal<T>(initial: T, equals: (a: T, b: T) => boolean = defaultEquals): Signal<T> {
  return new SignalNode(initial, equals);
}

/** Creates a lazily-evaluated, memoized derived value from `compute`. */
export function computed<T>(compute: () => T, equals: (a: T, b: T) => boolean = defaultEquals): ReactiveValue<T> {
  return new ComputedNode(compute, equals);
}

/**
 * Runs `run` immediately, tracking every signal/computed it reads, then re-runs it whenever any of those change.
 * Use `onCleanup` inside `run` to release resources (listeners, DOM nodes) before each re-run and on dispose.
 *
 * @param name optional label used only in diagnostics (e.g. the `ReactiveCycleException` message).
 */
export function effect(run: () => void, name?: string): Disposable {
  const node = new EffectNode(run, name);
  node.runInitial();
  return node;
}

/** Registers a callback to run before the current effect re-runs and when it is disposed. No-op outside an effect. */
export function onCleanup(block: () => void): void {
  if (currentObserver instanceof EffectNode) currentObserver.addCleanup(block);
}

/** Defers dependent-effect execution until `block` returns, so a burst of writes flushes effects once. */
export function batch<T>(block: () => T): T {
  batchDepth++;
  let thrown: unknown;
  try {
    return block();
  } catch (t) {
    thrown = t;
    throw t;
  } finally {
    batchDepth--;
    if (batchDepth === 0) {
      // Writes made before a throw are already committed, so still flush - but never let a flush failure
      // swallow the block's own exception.
      try {
        flushEffects();
      } catch (flushError) {
        if (thrown !== undefined) {
          if (thrown instanceof Error) (thrown as Error & { suppressed?: unknown[] }).suppressed = [flushError];
        } else {
          throw flushError;
        }
      }
    }
  }
}

/** Runs `block` without subscribing the currently-running observer to anything read inside it. */
export function untracked<T>(block: () => T): T {
  const prev = currentObserver;
  currentObserver = null;
  try {
    return block();
  } finally {
    currentObserver = prev;
  }
}

/**
 * Owns a set of `Disposable`s (effects, `subscribe`s, nested scopes) and tears them all down together. Use one
 * per transient lifecycle - a panel, a recreated view - and call `dispose` from that owner's teardown so its
 * effects stop running and release the DOM/state they captured.
 *
 * Registering after the scope is already disposed immediately disposes the newcomer, so late async wiring is safe.
 */
export class ReactiveScope implements Disposable {
  private readonly disposables: Disposable[] = [];
  private disposedFlag = false;

  /** True once `dispose` has run; a disposed scope immediately disposes anything newly registered. */
  get isDisposed(): boolean {
    return this.disposedFlag;
  }

  /** Registers `disposable` for later teardown and returns it. */
  register<D extends Disposable>(disposable: D): D {
    if (this.disposedFlag) disposable.dispose();
    else this.disposables.push(disposable);
    return disposable;
  }

  /** Creates an `effect` owned by this scope. */
  effect(run: () => void, name?: string): Disposable {
    return this.register(effect(run, name));
  }

  /** `subscribe`s to `value` within this scope. */
  subscribe(value: ReactiveValue<unknown>, block: () => void): Disposable {
    return this.register(value.subscribe(block));
  }

  dispose(): void {
    if (this.disposedFlag) return;
    this.disposedFlag = true;
    // Dispose in reverse so dependents tear down before the things they depend on.
    for (let i = this.disposables.length - 1; i >= 0; i--) this.disposables[i].dispose();
    this.disposables.length = 0;
  }
}
