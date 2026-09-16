import assert from "node:assert/strict";
import test from "node:test";
import {
  convertTools,
  toProtoSchema,
} from "../extensions/antigravity/stream/schema.js";

test("agy 1.2.4 shape: one functionDeclarations group per tool", () => {
  const tools = convertTools([
    { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } },
    { name: "bash", description: "Run a command", parameters: { type: "object", properties: {} } },
  ]);
  assert.ok(tools);
  assert.equal(tools.length, 2);
  for (const group of tools) assert.equal(group.functionDeclarations.length, 1);
  assert.equal(tools[0].functionDeclarations[0].name, "read");
  assert.equal(tools[1].functionDeclarations[0].name, "bash");
  assert.equal(convertTools([]), undefined);
  assert.equal(convertTools(undefined), undefined);
});

test("argument schemas use protobuf Schema types, not JSON Schema types", () => {
  const parameters = toProtoSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string", description: "Path to the file" },
      offset: { type: ["number", "null"] },
      lines: { type: "integer" },
      follow: { type: "boolean" },
      tags: { type: "array", items: { type: "string" } },
      nested: {
        type: "object",
        properties: { deep: { type: "string" } },
        required: ["deep"],
      },
      mode: { type: "string", enum: ["fast", "safe"] },
      anything: {},
    },
    required: ["path"],
  });

  assert.equal(parameters.type, "OBJECT");
  assert.deepEqual(parameters.required, ["path"]);
  const props = parameters.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.path.type, "STRING");
  assert.equal(props.path.description, "Path to the file");
  // Union types collapse to the first non-null scalar.
  assert.equal(props.offset.type, "NUMBER");
  assert.equal(props.lines.type, "INTEGER");
  assert.equal(props.follow.type, "BOOLEAN");
  assert.equal(props.tags.type, "ARRAY");
  assert.deepEqual(props.tags.items, { type: "STRING" });
  assert.equal(props.nested.type, "OBJECT");
  assert.deepEqual(props.nested.required, ["deep"]);
  assert.deepEqual(props.mode.enum, ["fast", "safe"]);
  // A schema with no declared type still becomes an open object.
  assert.equal(props.anything.type, "OBJECT");
  // JSON-Schema-only keywords never reach the backend.
  assert.equal("additionalProperties" in parameters, false);
  assert.equal("$schema" in parameters, false);
});

test("$ref/$defs are dereferenced before conversion", () => {
  const parameters = toProtoSchema({
    type: "object",
    $defs: { location: { type: "object", properties: { city: { type: "string" } } } },
    properties: { home: { $ref: "#/$defs/location" } },
    required: ["home"],
  });
  const props = parameters.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.home.type, "OBJECT");
  const city = (props.home.properties as Record<string, Record<string, unknown>>).city;
  assert.equal(city.type, "STRING");
});

test("non-string enums and meta keywords are dropped", () => {
  const parameters = toProtoSchema({
    type: "object",
    properties: {
      mixed: { type: "string", enum: ["a", 1] },
      formatted: { type: "string", format: "date-time" },
      nullableString: { type: "string", nullable: true },
    },
  });
  const props = parameters.properties as Record<string, Record<string, unknown>>;
  assert.equal("enum" in props.mixed, false);
  assert.equal("format" in props.formatted, false);
  assert.equal("nullable" in props.nullableString, false);
  assert.equal(props.nullableString.type, "STRING");
});
