# 🧺 microbatch

[![npm version](https://img.shields.io/npm/v/microbatch)](https://www.npmjs.com/package/microbatch)
[![npm bundle size](https://img.shields.io/npm/unpacked-size/microbatch)](https://www.npmjs.com/package/microbatch)
[![license](https://img.shields.io/github/license/jbingen/microbatch)](https://github.com/jbingen/microbatch/blob/main/LICENSE)

Automatic request batching. Collects individual calls into batches within a microtask.

For anyone dealing with N+1 queries, request fan-out, or redundant API calls.

```
npm install microbatch
```

```typescript
// before: 3 separate DB queries
const user1 = await getUser(1);
const user2 = await getUser(2);
const user3 = await getUser(3);

// after: 1 batched query, same API
const loader = batcher(ids => getUsersByIds(ids));
const [user1, user2, user3] = await Promise.all([
  loader.load(1),
  loader.load(2),
  loader.load(3),
]);
```

Individual `load()` calls within the same microtask are automatically collected and dispatched as a single batch. Each caller gets back just their result.

```typescript
import { batcher } from "microbatch";

const userLoader = batcher(async (ids: number[]) => {
  const users = await db.query("SELECT * FROM users WHERE id IN (?)", ids);
  return new Map(users.map(u => [u.id, u]));
});

// these fire one query, not three
const alice = await userLoader.load(1);
const bob = await userLoader.load(2);
const carol = await userLoader.load(3);
```

## Why

The N+1 problem shows up everywhere: rendering a list of items that each need to fetch related data, resolving GraphQL fields, hydrating objects from a cache. The usual fix is DataLoader, but that's tied to GraphQL conventions and carries more weight than most apps need.

microbatch is the batching primitive extracted. It works with any data source, any framework, and any key type. Zero dependencies.

## API

### `batcher(batchFn, options?)`

Creates a batcher. The `batchFn` receives an array of keys and must return a `Map` keyed by those same keys.

```typescript
const loader = batcher(async (ids: string[]) => {
  const results = await fetchMany(ids);
  return new Map(results.map(r => [r.id, r]));
});
```

Returns an object with `load` and `flush`.

### `.load(key)`

Queues a key for the next batch. Returns a promise that resolves with the value for that key.

```typescript
const result = await loader.load("abc");
```

If the batch function's result `Map` doesn't contain the key, the promise rejects with an error. If the batch function itself throws, all pending promises reject with that error.

### `.flush()`

Immediately dispatches any pending keys without waiting for the microtask.

```typescript
loader.load(1);
loader.load(2);
await loader.flush();
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxSize` | `number` | `Infinity` | Flush immediately when the queue reaches this size |
| `maxWait` | `number` | `0` | Max ms to wait before flushing (0 = microtask only) |

### `maxSize`

Caps the batch size. When the queue hits `maxSize`, it flushes immediately without waiting for the microtask. Remaining items go into the next batch.

```typescript
const loader = batcher(batchFn, { maxSize: 50 });
```

### `maxWait`

Adds a timer-based flush in addition to the microtask flush. Useful when loads trickle in across multiple ticks and you want to batch them within a time window.

```typescript
const loader = batcher(batchFn, { maxWait: 10 });
```

## How batching works

1. You call `load(key)` - the key is added to an internal queue
2. If `maxSize` is reached, the queue flushes immediately
3. Otherwise, a microtask is scheduled (or a timer if `maxWait` is set)
4. When the microtask fires, all queued keys are passed to `batchFn` as a single array
5. The returned `Map` is used to resolve each caller's promise individually
6. If a key is missing from the `Map`, that caller's promise rejects
7. If `batchFn` throws, all callers in that batch reject

No caching. Each `load()` call always goes through batching. If you want caching, layer it on top.

## Per-key error handling

The batch function returns a `Map`. If a key is present, the caller gets the value. If a key is missing, the caller gets a rejection. This lets you handle partial failures cleanly:

```typescript
const results = await Promise.allSettled([
  loader.load(1), // fulfilled
  loader.load(2), // rejected (missing from Map)
  loader.load(3), // fulfilled
]);
```

If the batch function itself throws (e.g., network error), every caller in that batch rejects with the same error.

## Design decisions

- Zero dependencies. Tiny footprint.
- Batches within a microtask by default. No timers unless you opt in with `maxWait`.
- Batch function must return a `Map` for per-key resolution. Arrays would require positional matching which is fragile.
- No caching, no deduplication, no memoization. This is just the batching primitive.
- Works with any key type that can be a `Map` key (strings, numbers, objects by reference).
- `maxSize` flushes synchronously so you can control memory and payload size.
