import type { Clock } from './types';

/**
 * Calls `find` now and then every `intervalMs` until it returns a value or `capMs` has passed
 * (the last check happens at the cap). Time comes from the injected clock.
 */
export async function pollUntil<T>(
  clock: Clock,
  opts: { intervalMs: number; capMs: number },
  find: () => Promise<T | null>,
): Promise<T | null> {
  const start = clock.now().getTime();
  for (;;) {
    const hit = await find();
    if (hit) return hit;
    const elapsed = clock.now().getTime() - start;
    if (elapsed >= opts.capMs) return null;
    await clock.sleep(Math.min(opts.intervalMs, opts.capMs - elapsed));
  }
}
