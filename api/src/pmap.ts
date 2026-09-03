/** Bounded-concurrency map. Keeps GraphHopper from being hit with 60 parallel
 *  round-trip requests, which starves the flexible-mode routing threads. */
export async function pMap<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]!, i);
      }
    },
  );

  await Promise.all(workers);
  return results;
}
