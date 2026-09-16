/**
 * Tool-schema conversion for the Antigravity (Cloud Code Assist) backend.
 *
 * agy 1.2.4 sends every tool as its own `tools[]` group with a single
 * `functionDeclarations` entry, and describes arguments with the protobuf
 * `Schema` message (`parameters`), whose `type` values are the uppercase enum
 * names — `OBJECT`, `STRING`, `INTEGER`, `NUMBER`, `BOOLEAN`, `ARRAY`.
 *
 * Captured from the CLI (agy 1.2.4, gemini-3.6-flash-low and claude-sonnet-4-6):
 * ```json
 * "tools": [
 *   { "functionDeclarations": [ { "name": "view_file", "description": "...",
 *       "parameters": { "type": "OBJECT",
 *         "properties": { "AbsolutePath": { "type": "STRING", "description": "..." } },
 *         "required": ["AbsolutePath"] } } ] },
 *   ...
 * ]
 * ```
 * Only `type`, `description`, `properties`, `required`, `items` and `enum` ever
 * appear. Everything else (JSON Schema `$ref`/`$defs`, `format`, `nullable`,
 * `additionalProperties`, `oneOf`, ...) is dropped rather than risk a 400.
 */
import { isRecord } from "../utils/util.js";

export type ToolLike = {
  name: string;
  description: string;
  parameters: unknown;
};

export type ProtoToolDeclaration = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ProtoToolGroup = {
  functionDeclarations: ProtoToolDeclaration[];
};

const PROTO_TYPES: Record<string, string> = {
  object: "OBJECT",
  string: "STRING",
  number: "NUMBER",
  integer: "INTEGER",
  boolean: "BOOLEAN",
  array: "ARRAY",
};

const PROTO_SCHEMA_ALLOW = new Set([
  "type",
  "description",
  "properties",
  "required",
  "items",
  "enum",
]);

/** JSON Schema type (or a union like `["string","null"]`) → protobuf Schema enum name. */
function toProtoType(value: unknown): string | undefined {
  const scalar = Array.isArray(value)
    ? value.find((entry): entry is string => typeof entry === "string" && entry !== "null")
    : typeof value === "string"
      ? value
      : undefined;
  if (!scalar) return undefined;
  return PROTO_TYPES[scalar.toLowerCase()] ?? scalar.toUpperCase();
}

function dereferenceSchema(
  schema: unknown,
  rootDefs: Record<string, unknown> = {},
  visited = new Set<unknown>(),
): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) {
    return schema.map((item) => dereferenceSchema(item, rootDefs, visited));
  }

  const s = schema as Record<string, unknown>;
  if (visited.has(s)) return s;
  visited.add(s);

  const defs: Record<string, unknown> = { ...rootDefs };
  if (isRecord(s.$defs)) Object.assign(defs, s.$defs);
  if (isRecord(s.definitions)) Object.assign(defs, s.definitions);

  if (typeof s.$ref === "string") {
    const ref = s.$ref;
    const match = ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/);
    if (match && match[1] && defs[match[1]] !== undefined) {
      const resolved = dereferenceSchema(defs[match[1]], defs, visited);
      if (isRecord(resolved)) {
        const { $ref: _, ...rest } = s;
        const restCleaned = dereferenceSchema(rest, defs, visited);
        return isRecord(restCleaned) ? { ...resolved, ...restCleaned } : resolved;
      }
      return resolved;
    }
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(s)) {
    out[key] = dereferenceSchema(value, defs, visited);
  }
  return out;
}

function ensureRootObjectSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) {
    return { type: "object", properties: {} };
  }
  if (!schema.type) {
    return { ...schema, type: "object", properties: schema.properties || {} };
  }
  return schema;
}

function stripMetaSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const omit = new Set([
    "$schema",
    "$id",
    "$anchor",
    "$dynamicAnchor",
    "$vocabulary",
    "$comment",
    "$defs",
    "definitions",
  ]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!omit.has(key)) out[key] = stripMetaSchema(value);
  }
  return out;
}

/** Keep only protobuf `Schema` fields and uppercase the `type` enum values. */
function normalizeProtoSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(normalizeProtoSchema);
  if (!isRecord(schema)) return {};

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!PROTO_SCHEMA_ALLOW.has(key)) continue;
    if (key === "type") {
      const protoType = toProtoType(value);
      if (protoType) out.type = protoType;
      continue;
    }
    if (key === "description") {
      if (typeof value === "string") out.description = value;
      continue;
    }
    if (key === "properties" && isRecord(value)) {
      // Property names are user-defined, not Schema keywords — never allowlist-filter them.
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        props[propName] = normalizeProtoSchema(propSchema);
      }
      out.properties = props;
      continue;
    }
    if (key === "required") {
      if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
        out.required = value;
      }
      continue;
    }
    if (key === "items") {
      out.items = normalizeProtoSchema(value);
      continue;
    }
    if (key === "enum") {
      // Protobuf Schema enums are strings only.
      if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
        out.enum = value;
      }
      continue;
    }
  }

  // Protobuf Schema requires a `type` on every node; agy always emits one.
  if (out.enum && !out.type) out.type = "STRING";
  if (out.properties && !out.type) out.type = "OBJECT";
  if (Object.keys(out).length === 0) return { type: "OBJECT" };
  return out;
}

/** Convert one JSON Schema into the protobuf `Schema` shape agy sends. */
export function toProtoSchema(schema: unknown): Record<string, unknown> {
  const root = ensureRootObjectSchema(dereferenceSchema(schema));
  const normalized = normalizeProtoSchema(stripMetaSchema(root));
  return isRecord(normalized) ? normalized : { type: "OBJECT", properties: {} };
}

/**
 * Pi tools → agy 1.2.4 `tools[]`, one `functionDeclarations` group per tool.
 * Exported for unit tests.
 */
export function convertTools(tools: ToolLike[] | undefined): ProtoToolGroup[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    functionDeclarations: [
      {
        name: tool.name,
        description: tool.description,
        parameters: toProtoSchema(tool.parameters),
      },
    ],
  }));
}
