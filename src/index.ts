export type BatchOptions = {
  maxSize?: number;
  maxWait?: number;
};

export type BatchFn<K, V> = (keys: K[]) => Promise<Map<K, V>>;

type Pending<V> = {
  resolve: (value: V) => void;
  reject: (error: unknown) => void;
};

export type Batcher<K, V> = {
  load: (key: K) => Promise<V>;
  flush: () => Promise<void>;
};

export function batcher<K, V>(
  batchFn: BatchFn<K, V>,
  options?: BatchOptions,
): Batcher<K, V> {
  const maxSize = options?.maxSize ?? Infinity;
  const maxWait = options?.maxWait ?? 0;

  let queue = new Map<K, Pending<V>[]>();
  let scheduled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;

  function schedule() {
    if (scheduled) return;
    scheduled = true;

    if (maxWait > 0) {
      timer = setTimeout(dispatch, maxWait);
    }

    queueMicrotask(() => {
      if (scheduled) dispatch();
    });
  }

  function dispatch() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    scheduled = false;

    if (queue.size === 0) return;

    const batch = queue;
    queue = new Map();

    inFlight = executeBatch(batch).finally(() => { inFlight = null; });
  }

  async function executeBatch(batch: Map<K, Pending<V>[]>) {
    const keys = [...batch.keys()];

    try {
      const results = await batchFn(keys);

      for (const [key, items] of batch) {
        if (results.has(key)) {
          const value = results.get(key) as V;
          for (const item of items) item.resolve(value);
        } else {
          const err = new Error(`Batch function returned no result for key: ${String(key)}`);
          for (const item of items) item.reject(err);
        }
      }
    } catch (err) {
      for (const items of batch.values()) {
        for (const item of items) item.reject(err);
      }
    }
  }

  return {
    load(key: K): Promise<V> {
      return new Promise<V>((resolve, reject) => {
        const existing = queue.get(key);
        if (existing) {
          existing.push({ resolve, reject });
        } else {
          queue.set(key, [{ resolve, reject }]);
        }

        if (queue.size >= maxSize) {
          dispatch();
        } else {
          schedule();
        }
      });
    },

    async flush() {
      while (true) {
        dispatch();
        if (inFlight) await inFlight;
        if (queue.size === 0 && !inFlight && !scheduled) return;
      }
    },
  };
}
