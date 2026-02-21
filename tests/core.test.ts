import { describe, test, expect, mock } from 'bun:test';
import { batcher } from '../src/index';

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockBatchFn<K, V>(impl: (keys: K[]) => Map<K, V>) {
  return mock((keys: K[]) => Promise.resolve(impl(keys)));
}

describe('batching', () => {
  test('batches calls within the same microtask', async () => {
    const fn = mockBatchFn((keys: number[]) =>
      new Map(keys.map((k) => [k, `user-${k}`]))
    );
    const loader = batcher(fn);

    const [a, b, c] = await Promise.all([
      loader.load(1),
      loader.load(2),
      loader.load(3),
    ]);

    expect(a).toBe('user-1');
    expect(b).toBe('user-2');
    expect(c).toBe('user-3');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0]![0]).toEqual([1, 2, 3]);
  });

  test('separate microtasks create separate batches', async () => {
    const fn = mockBatchFn((keys: number[]) =>
      new Map(keys.map((k) => [k, k * 10]))
    );
    const loader = batcher(fn);

    const first = loader.load(1);
    await first;

    const second = loader.load(2);
    await second;

    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('single load works', async () => {
    const fn = mockBatchFn((keys: string[]) =>
      new Map(keys.map((k) => [k, k.toUpperCase()]))
    );
    const loader = batcher(fn);

    const result = await loader.load('hello');
    expect(result).toBe('HELLO');
  });
});

describe('deduplication', () => {
  test('dedupes duplicate keys in same batch', async () => {
    const fn = mockBatchFn((keys: number[]) =>
      new Map(keys.map((k) => [k, `val-${k}`]))
    );
    const loader = batcher(fn);

    const [a, b, c] = await Promise.all([
      loader.load(1),
      loader.load(1),
      loader.load(2),
    ]);

    expect(a).toBe('val-1');
    expect(b).toBe('val-1');
    expect(c).toBe('val-2');
    expect(fn).toHaveBeenCalledTimes(1);
    // only unique keys sent to batch function
    expect(fn.mock.calls[0]![0]).toEqual([1, 2]);
  });

  test('all callers for same key resolve with same value', async () => {
    const fn = mockBatchFn((keys: number[]) =>
      new Map(keys.map((k) => [k, k * 100]))
    );
    const loader = batcher(fn);

    const promises = Array.from({ length: 5 }, () => loader.load(42));
    const results = await Promise.all(promises);

    expect(results).toEqual([4200, 4200, 4200, 4200, 4200]);
    expect(fn.mock.calls[0]![0]).toEqual([42]);
  });
});

describe('per-key errors', () => {
  test('rejects if key is missing from result', async () => {
    const fn = mockBatchFn((_keys: number[]) => new Map<number, string>());
    const loader = batcher(fn);

    await expect(loader.load(1)).rejects.toThrow('no result for key');
  });

  test('resolves found keys and rejects missing ones', async () => {
    const fn = mockBatchFn((keys: number[]) => {
      const map = new Map<number, string>();
      for (const k of keys) {
        if (k !== 2) map.set(k, `val-${k}`);
      }
      return map;
    });
    const loader = batcher(fn);

    const results = await Promise.allSettled([
      loader.load(1),
      loader.load(2),
      loader.load(3),
    ]);

    expect(results[0]).toEqual({ status: 'fulfilled', value: 'val-1' });
    expect(results[1]!.status).toBe('rejected');
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'val-3' });
  });

  test('handles undefined as a valid value via has()', async () => {
    const fn = mockBatchFn((keys: string[]) => {
      const map = new Map<string, undefined>();
      for (const k of keys) map.set(k, undefined);
      return map;
    });
    const loader = batcher<string, undefined>(fn);

    const result = await loader.load('test');
    expect(result).toBeUndefined();
  });
});

describe('batch function errors', () => {
  test('rejects all pending items on batch function throw', async () => {
    const fn = mock((_keys: number[]) => Promise.reject(new Error('db down')));
    const loader = batcher(fn);

    const results = await Promise.allSettled([
      loader.load(1),
      loader.load(2),
    ]);

    expect(results[0]!.status).toBe('rejected');
    expect(results[1]!.status).toBe('rejected');
  });
});

describe('maxSize', () => {
  test('flushes immediately when maxSize is reached', async () => {
    const fn = mockBatchFn((keys: number[]) =>
      new Map(keys.map((k) => [k, k]))
    );
    const loader = batcher(fn, { maxSize: 2 });

    const [r1, r2, r3] = await Promise.all([
      loader.load(1),
      loader.load(2),
      loader.load(3),
    ]);

    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(r3).toBe(3);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[0]![0]).toEqual([1, 2]);
    expect(fn.mock.calls[1]![0]).toEqual([3]);
  });
});

describe('maxWait', () => {
  test('flushes after maxWait even if maxSize not reached', async () => {
    const fn = mockBatchFn((keys: number[]) =>
      new Map(keys.map((k) => [k, k]))
    );
    const loader = batcher(fn, { maxSize: 100, maxWait: 10 });

    const p1 = loader.load(1);
    await delay(50);
    const r1 = await p1;

    expect(r1).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('flush', () => {
  test('flush awaits batch completion', async () => {
    let resolved = false;
    const fn = mock(async (keys: number[]) => {
      await delay(20);
      resolved = true;
      return new Map(keys.map((k) => [k, k]));
    });
    const loader = batcher(fn);

    loader.load(1);
    await loader.flush();

    expect(resolved).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('flush on empty queue is a noop', async () => {
    const fn = mockBatchFn((_keys: number[]) => new Map());
    const loader = batcher(fn);

    await loader.flush();
    expect(fn).toHaveBeenCalledTimes(0);
  });
});

describe('key types', () => {
  test('works with string keys', async () => {
    const fn = mockBatchFn((keys: string[]) =>
      new Map(keys.map((k) => [k, k.length]))
    );
    const loader = batcher(fn);

    const result = await loader.load('hello');
    expect(result).toBe(5);
  });

  test('works with object keys (reference equality)', async () => {
    const keyA = { id: 1 };
    const keyB = { id: 2 };

    const fn = mockBatchFn((keys: typeof keyA[]) =>
      new Map(keys.map((k) => [k, `obj-${k.id}`]))
    );
    const loader = batcher(fn);

    const [a, b] = await Promise.all([
      loader.load(keyA),
      loader.load(keyB),
    ]);

    expect(a).toBe('obj-1');
    expect(b).toBe('obj-2');
  });
});
