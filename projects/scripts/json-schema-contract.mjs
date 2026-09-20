import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

// Development-only schema checking. Runtime input decoding stays in src.
const ajv = new Ajv2020({ allErrors: true, strict: true, addUsedSchema: false });
addFormats(ajv);
const validators = new WeakMap();

export function validateJsonSchema(schema, value) {
  let validate = validators.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    validators.set(schema, validate);
  }
  const valid = validate(value);
  return {
    valid,
    errors: (validate.errors ?? []).map((error) => `${error.instancePath || "/"}: ${error.message}`),
  };
}
