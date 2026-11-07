import { loadPrompt } from '@wma/llm';

export interface PromptMeta {
  name: string;
  version: string;
  model?: string;
  effort?: string;
  output_schema?: string;
  cache_breakpoint?: string;
}

export interface LoadedPrompt {
  /** `name@vN`, recorded with every call result. */
  id: string;
  meta: PromptMeta;
  body: string;
}

/** Splits the `---` frontmatter block (flat `key: value` lines) from a prompt file's body. */
export function parsePrompt(text: string): { meta: Record<string, string>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (kv) meta[kv[1]!] = kv[2]!.trim().replace(/^"(.*)"$/, '$1');
  }
  return { meta, body: m[2]!.trim() };
}

export function loadVersionedPrompt(name: string, version: string): LoadedPrompt {
  const { meta, body } = parsePrompt(loadPrompt(name, version));
  return { id: `${name}@${version}`, meta: { name, version, ...meta }, body };
}
