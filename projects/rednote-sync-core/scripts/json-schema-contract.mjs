import assert from "node:assert/strict";

// Deliberately small, offline evaluator for only the 2020-12 keywords used by
// schemas/offline-input-v1.schema.json. FixtureSession remains runtime authority.
const SUPPORTED = new Set([
  "$schema", "$id", "$comment", "$defs", "$ref", "title",
  "type", "const", "enum", "pattern", "format", "minLength", "maxLength",
  "minimum", "maximum", "required", "properties", "additionalProperties",
  "items", "maxItems", "uniqueItems", "oneOf", "allOf", "if", "then", "not",
]);

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function schemaChildren(schema) {
  const children = [];
  for (const field of ["$defs", "properties"]) {
    if (schema[field] !== undefined) for (const child of Object.values(schema[field])) children.push(child);
  }
  for (const field of ["oneOf", "allOf"]) if (schema[field] !== undefined) children.push(...schema[field]);
  for (const field of ["items", "if", "then", "not"]) if (schema[field] !== undefined) children.push(schema[field]);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties === "object") children.push(schema.additionalProperties);
  return children;
}

export function assertSupportedSchema(schema) {
  const pending = [schema];
  while (pending.length > 0) {
    const current = pending.pop();
    assert.ok(current !== null && typeof current === "object" && !Array.isArray(current), "contract schema nodes must be objects");
    for (const key of Object.keys(current)) assert.ok(SUPPORTED.has(key), `unsupported contract schema keyword: ${key}`);
    if (current.format !== undefined) assert.equal(current.format, "uri", "only uri format is supported");
    pending.push(...schemaChildren(current));
  }
}

function resolveRef(root, ref) {
  assert.equal(typeof ref, "string");
  assert.match(ref, /^#(?:\/[^/]*)*$/u, "only local JSON Pointer refs are supported");
  let current = root;
  for (const encoded of ref.slice(2).split("/")) {
    if (ref === "#") break;
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    assert.ok(current !== null && typeof current === "object" && Object.hasOwn(current, key), `unresolved schema ref: ${ref}`);
    current = current[key];
  }
  return current;
}

function hasType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function evaluate(root, schema, value, path) {
  const errors = [];
  const add = (reason) => errors.push(`${path}: ${reason}`);
  if (schema.$ref !== undefined) errors.push(...evaluate(root, resolveRef(root, schema.$ref), value, path));

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => hasType(value, type))) {
      add(`expected type ${types.join("|")}`);
      return errors;
    }
  }
  if (schema.const !== undefined && stable(value) !== stable(schema.const)) add("const mismatch");
  if (schema.enum !== undefined && !schema.enum.some((candidate) => stable(value) === stable(candidate))) add("enum mismatch");

  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((candidate) => evaluate(root, candidate, value, path).length === 0).length;
    if (matches !== 1) add(`oneOf matched ${matches} branches`);
  }
  if (schema.allOf !== undefined) for (const candidate of schema.allOf) errors.push(...evaluate(root, candidate, value, path));
  if (schema.not !== undefined && evaluate(root, schema.not, value, path).length === 0) add("not schema matched");
  if (schema.if !== undefined && evaluate(root, schema.if, value, path).length === 0 && schema.then !== undefined) {
    errors.push(...evaluate(root, schema.then, value, path));
  }

  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) add("string shorter than minLength");
    if (schema.maxLength !== undefined && length > schema.maxLength) add("string longer than maxLength");
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) add("pattern mismatch");
    if (schema.format === "uri") {
      try { new URL(value); } catch { add("invalid uri"); }
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) add("number below minimum");
    if (schema.maximum !== undefined && value > schema.maximum) add("number above maximum");
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) add("array exceeds maxItems");
    if (schema.uniqueItems === true && new Set(value.map(stable)).size !== value.length) add("array items are not unique");
    if (schema.items !== undefined) value.forEach((item, index) => errors.push(...evaluate(root, schema.items, item, `${path}/${index}`)));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    if (schema.required !== undefined) for (const field of schema.required) if (!Object.hasOwn(value, field)) errors.push(`${path}: missing required ${field}`);
    for (const [field, child] of Object.entries(properties)) if (Object.hasOwn(value, field)) errors.push(...evaluate(root, child, value[field], `${path}/${field}`));
    const extras = Object.keys(value).filter((field) => !Object.hasOwn(properties, field));
    if (schema.additionalProperties === false) for (const field of extras) errors.push(`${path}: additional property ${field}`);
    else if (schema.additionalProperties !== undefined && typeof schema.additionalProperties === "object") {
      for (const field of extras) errors.push(...evaluate(root, schema.additionalProperties, value[field], `${path}/${field}`));
    }
  }
  return errors;
}

export function validateJsonSchema(schema, value) {
  assertSupportedSchema(schema);
  const errors = evaluate(schema, schema, value, "$");
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}
