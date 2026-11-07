import { readFileSync } from 'node:fs';

const cache = new Map<string, string>();

/** Loads a versioned prompt file: prompts/<name>/<version>.md next to this package's src. */
export function loadPrompt(name: string, version: string): string {
  if (!/^[a-z0-9-]+$/.test(name) || !/^v\d+$/.test(version)) {
    throw new Error(`llm: invalid prompt reference ${name}/${version}`);
  }
  const key = `${name}/${version}`;
  let text = cache.get(key);
  if (text === undefined) {
    text = readFileSync(new URL(`../prompts/${name}/${version}.md`, import.meta.url), 'utf8');
    cache.set(key, text);
  }
  return text;
}
