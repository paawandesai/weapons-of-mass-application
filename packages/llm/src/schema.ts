import { z } from 'zod';

type Json = Record<string, unknown>;

/** Keywords that blow up the constrained-decoding grammar; the zod schema re-checks them locally. */
const STRIPPED = new Set([
  '$schema',
  'pattern',
  'format',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'maxItems',
  'default',
]);

const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

/** For `{anyOf: [X, {type: 'null'}]}` returns X; otherwise null. */
function nonNullVariant(node: unknown): Json | null {
  if (isObj(node) && Array.isArray(node.type)) {
    const rest = (node.type as unknown[]).filter((t) => t !== 'null');
    return rest.length === 1 && node.type.length === 2 ? { ...node, type: rest[0] } : null;
  }
  if (!isObj(node) || !Array.isArray(node.anyOf) || node.anyOf.length !== 2) return null;
  const [a, b] = node.anyOf as unknown[];
  const isNull = (x: unknown) => isObj(x) && x.type === 'null';
  if (isNull(b) && isObj(a)) return a;
  if (isNull(a) && isObj(b)) return b;
  return null;
}

/**
 * Wire form of a schema node: bounds and formats dropped, objects closed, and nullable
 * properties turned into optional non-null ones (too many unions makes the grammar too large).
 */
function simplify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(simplify);
  if (!isObj(node)) return node;
  const out: Json = {};
  for (const [k, v] of Object.entries(node)) {
    if (STRIPPED.has(k)) continue;
    out[k] = k === 'properties' && isObj(v) ? simplifyProperties(v) : simplify(v);
  }
  if (isObj(out.properties)) {
    const required = new Set<string>(
      Array.isArray(node.required) ? (node.required as string[]) : [],
    );
    for (const [name, p] of Object.entries(node.properties as Json)) {
      if (nonNullVariant(p)) required.delete(name);
    }
    out.required = [...required];
  }
  if (out.type === 'object') out.additionalProperties = false;
  if (typeof out.minItems === 'number' && out.minItems > 1) out.minItems = 1;
  return out;
}

function simplifyProperties(props: Json): Json {
  return Object.fromEntries(
    Object.entries(props).map(([k, p]) => [k, simplify(nonNullVariant(p) ?? p)]),
  );
}

/** Puts back `null` for nullable properties the model left out (the inverse of `simplify`). */
function restore(schema: unknown, value: unknown): unknown {
  const inner = nonNullVariant(schema);
  if (inner) return value !== null ? restore(inner, value) : value;
  if (isObj(schema) && isObj(schema.properties) && isObj(value)) {
    const out: Json = { ...value };
    for (const [name, p] of Object.entries(schema.properties)) {
      if (!(name in out)) {
        if (nonNullVariant(p)) out[name] = null;
      } else {
        out[name] = restore(p, out[name]);
      }
    }
    return out;
  }
  if (isObj(schema) && isObj(schema.items) && Array.isArray(value)) {
    return value.map((v) => restore(schema.items, v));
  }
  return value;
}

export interface OutputFormatSchema {
  /** Sent as `output_config.format.schema`. */
  wire: Record<string, unknown>;
  /** Fills nullable properties the model omitted with null, before local zod validation. */
  restore(value: unknown): unknown;
}

/**
 * The JSON schema sent as `output_config.format`, derived from the zod schema, plus the inverse
 * for the reply. The caller still validates against the full zod schema and retries on failure.
 */
export function outputFormatFor(schema: z.ZodType): OutputFormatSchema {
  const full = z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' });
  return {
    wire: simplify(full) as Record<string, unknown>,
    restore: (value) => restore(full, value),
  };
}

export const outputJsonSchema = (schema: z.ZodType) => outputFormatFor(schema).wire;
