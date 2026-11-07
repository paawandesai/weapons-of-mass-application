export function getAt(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function setAt<T>(obj: T, path: string, value: unknown): T {
  const next = structuredClone(obj) as Record<string, unknown>;
  const parts = path.split('.');
  let cur = next;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur[parts[i]!] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
  return next as T;
}

export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
