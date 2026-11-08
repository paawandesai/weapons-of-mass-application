import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { outputFormatFor } from './schema';
import type { LlmUsage, StructuredLlm, StructuredRequest, StructuredResponse } from './types';

/**
 * Subscription backends: each drives a locally installed CLI that is already logged in
 * (`claude login`, `codex login`, `gemini`), so calls count against that plan, not API tokens.
 *
 * Personal use only: one person's own login, running on their own machine.
 */
export type CliBackend = 'claude-code' | 'codex' | 'gemini';
export type LlmBackend = 'anthropic' | CliBackend;

const CLI_BACKENDS: readonly CliBackend[] = ['claude-code', 'codex', 'gemini'];

export function parseBackend(value: string | undefined): LlmBackend {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '' || v === 'anthropic' || v === 'api') return 'anthropic';
  if ((CLI_BACKENDS as readonly string[]).includes(v)) return v as CliBackend;
  throw new Error(
    `llm: unknown LLM_BACKEND "${value}" (use anthropic, claude-code, codex, gemini)`,
  );
}

const ZERO_USAGE: LlmUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

export interface CliRunInput {
  command: string;
  args: string[];
  stdin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}
export interface CliRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}
/** Runs one process to completion. Injected in tests. */
export type CliRunner = (input: CliRunInput) => Promise<CliRunResult>;

export const spawnRunner: CliRunner = (input) =>
  new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`llm: ${input.command} timed out after ${input.timeoutMs}ms`));
    }, input.timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(
        (e as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error(`llm: "${input.command}" is not installed or not on PATH`)
          : e,
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input.stdin);
  });

export interface CliLlmOptions {
  model?: string;
  /** Per-call limit. Default 300000 (5 minutes). */
  timeoutMs?: number;
  /** Calls in flight at once. Default LLM_CLI_CONCURRENCY or 2. */
  concurrency?: number;
  run?: CliRunner;
  env?: NodeJS.ProcessEnv;
}

interface Prepared {
  args: string[];
  stdin: string;
  /** Extracts the model's text/object and usage from the finished process. */
  parse(res: CliRunResult): Promise<Parsed>;
}
interface Parsed {
  /** Already-parsed structured output, when the CLI provides it. */
  object?: unknown;
  text?: string;
  usage: LlmUsage;
  model?: string;
  stopReason?: string | null;
}
interface PrepareCtx {
  req: StructuredRequest;
  wire: Record<string, unknown>;
  model: string | undefined;
  dir: string;
  imageFiles: string[];
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** Prompt for CLIs without a schema flag: the schema goes in the text and the reply is parsed. */
function inlineSchemaPrompt(c: PrepareCtx): string {
  const images = c.imageFiles.length
    ? `Attached image files (look at them): ${c.imageFiles.join(', ')}\n\n`
    : '';
  return [
    c.req.system,
    '',
    '---',
    images + c.req.user,
    '',
    '---',
    'Reply with one JSON object only, no prose and no code fence, matching this JSON Schema:',
    JSON.stringify(c.wire),
  ].join('\n');
}

/** First balanced-looking JSON object in free text (models sometimes wrap it in a fence). */
export function extractJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error('no JSON object in reply');
  }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const PROVIDERS: Record<
  CliBackend,
  {
    command: string;
    /** Credentials that would make the CLI bill an API key instead of the subscription login. */
    apiKeyVars: string[];
    prepare(c: PrepareCtx): Prepared;
  }
> = {
  'claude-code': {
    command: 'claude',
    apiKeyVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    prepare(c) {
      const args = [
        '-p',
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(c.wire),
        '--system-prompt',
        c.req.system,
        // No user hooks, plugins, skills or MCP servers: they add ~40k tokens to every call.
        '--setting-sources',
        '',
        '--strict-mcp-config',
        '--disable-slash-commands',
        '--no-session-persistence',
        '--tools',
        c.imageFiles.length ? 'Read' : '',
      ];
      if (c.imageFiles.length) args.push('--add-dir', c.dir);
      if (c.model) args.push('--model', c.model);
      const images = c.imageFiles.length
        ? `Look at these image files first: ${c.imageFiles.join(', ')}\n\n`
        : '';
      return {
        args,
        stdin: images + c.req.user,
        async parse(res) {
          const j = JSON.parse(res.stdout) as Record<string, unknown>;
          if (j.is_error) throw new Error(`llm: claude failed: ${String(j.result ?? res.stderr)}`);
          const u = (j.usage ?? {}) as Record<string, unknown>;
          const models = Object.keys((j.modelUsage ?? {}) as object);
          return {
            object: j.structured_output,
            text: typeof j.result === 'string' ? j.result : undefined,
            usage: {
              input_tokens: num(u.input_tokens),
              output_tokens: num(u.output_tokens),
              cache_creation_input_tokens: num(u.cache_creation_input_tokens),
              cache_read_input_tokens: num(u.cache_read_input_tokens),
            },
            model: models[0],
            stopReason: typeof j.stop_reason === 'string' ? j.stop_reason : null,
          };
        },
      };
    },
  },
  codex: {
    command: 'codex',
    apiKeyVars: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    prepare(c) {
      const out = join(c.dir, 'last-message.txt');
      const args = [
        'exec',
        '--skip-git-repo-check',
        '--ephemeral',
        '-s',
        'read-only',
        '--json',
        '-o',
        out,
      ];
      if (c.model) args.push('-m', c.model);
      for (const f of c.imageFiles) args.push('-i', f);
      args.push('-');
      return {
        args,
        stdin: inlineSchemaPrompt({ ...c, imageFiles: [] }),
        async parse(res) {
          let usage = ZERO_USAGE;
          for (const line of res.stdout.split('\n')) {
            if (!line.startsWith('{')) continue;
            try {
              const ev = JSON.parse(line) as { type?: string; usage?: Record<string, unknown> };
              if (ev.type === 'turn.completed' && ev.usage) {
                const cached = num(ev.usage.cached_input_tokens);
                usage = {
                  input_tokens: Math.max(0, num(ev.usage.input_tokens) - cached),
                  output_tokens: num(ev.usage.output_tokens),
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: cached,
                };
              }
            } catch {
              /* not an event line */
            }
          }
          return { text: await readFile(out, 'utf8'), usage };
        },
      };
    },
  },
  gemini: {
    command: 'gemini',
    apiKeyVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    prepare(c) {
      const args = ['-p', ''];
      if (c.model) args.push('-m', c.model);
      const refs = c.imageFiles.map((f) => `@${f}`).join(' ');
      return {
        args,
        stdin: (refs ? refs + '\n' : '') + inlineSchemaPrompt({ ...c, imageFiles: [] }),
        async parse(res) {
          return { text: res.stdout, usage: ZERO_USAGE };
        },
      };
    },
  },
};

/** At most `limit` tasks at once. */
function limiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

/**
 * A `StructuredLlm` that shells out to a logged-in CLI. Slower than the API (a process per call)
 * and limited by the plan's usage caps, so keep the daily run's `JUDGE_CAP_PER_RUN` modest.
 * Every call runs in a throwaway directory with no tools (a read-only image Read for Claude).
 */
export function createCliLlm(backend: CliBackend, options: CliLlmOptions = {}): StructuredLlm {
  const spec = PROVIDERS[backend];
  const run = options.run ?? spawnRunner;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const concurrency = options.concurrency ?? (Number(process.env.LLM_CLI_CONCURRENCY) || 2);
  const gate = limiter(Math.max(1, concurrency));
  const baseEnv = { ...(options.env ?? process.env) };
  // A stray API key would silently switch the CLI from the subscription to per-token billing.
  for (const k of spec.apiKeyVars) delete baseEnv[k];
  const model = options.model || undefined;

  return {
    model: model ?? backend,
    async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResponse> {
      const format = outputFormatFor(req.schema);
      return gate(async () => {
        const dir = await mkdtemp(join(tmpdir(), 'wma-llm-'));
        try {
          const imageFiles: string[] = [];
          for (const [i, img] of (req.images ?? []).entries()) {
            const f = join(dir, `image-${i}.${EXT[img.mediaType]}`);
            await writeFile(f, Buffer.from(img.data, 'base64'));
            imageFiles.push(f);
          }
          const prepared = spec.prepare({
            req: req as StructuredRequest,
            wire: format.wire,
            model,
            dir,
            imageFiles,
          });
          const res = await run({
            command: spec.command,
            args: prepared.args,
            stdin: prepared.stdin,
            cwd: dir,
            env: baseEnv,
            timeoutMs,
          });
          if (res.code !== 0) {
            throw new Error(
              `llm: ${spec.command} exited ${res.code}: ${(res.stderr || res.stdout).slice(0, 500)}`,
            );
          }
          const parsed = await prepared.parse(res);
          let output: unknown;
          try {
            const raw = parsed.object ?? extractJson(parsed.text ?? '');
            output = format.restore(raw);
          } catch {
            // Malformed: hand the raw text on so schema validation fails and the caller retries.
            output = parsed.text ?? '';
          }
          return {
            output,
            usage: parsed.usage,
            stopReason: parsed.stopReason ?? 'end_turn',
            model: parsed.model ?? model ?? backend,
          };
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    },
  };
}
