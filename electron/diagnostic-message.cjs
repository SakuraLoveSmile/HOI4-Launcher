"use strict";

const english = Object.assign(
  Object.create(null),
  ...[
    "en-backend-a",
    "en-backend-b",
    "en-backend-c",
    "en-part-a",
    "en-part-b",
    "en-shell",
  ].map((name) => require(`../src/locales/${name}.json`)),
);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

// Clone only this bounded data format. Raw error properties and provider data
// are never recursively interpreted as application messages.
function plainDiagnostic(input) {
  let nodes = 0,
    characters = 0;
  function text(value) {
    if (typeof value !== "string" || (characters += value.length) > 8192)
      throw new Error();
    return value;
  }
  function visit(value, depth = 0) {
    if (++nodes > 128 || depth > 8) throw new Error();
    if (typeof value === "string") return text(value);
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    if (value.kind === "literal")
      return { kind: "literal", text: text(value.text) };
    if (
      value.kind === "message" &&
      typeof value.key === "string" &&
      own(english, value.key)
    ) {
      const key = text(value.key),
        values = value.values === undefined ? [] : value.values;
      if (!Array.isArray(values) || values.length > 64) throw new Error();
      return {
        kind: "message",
        key,
        values: values.map((part) => visit(part, depth + 1)),
      };
    }
    if (
      value.kind === "sequence" &&
      Array.isArray(value.parts) &&
      value.parts.length <= 64
    )
      return {
        kind: "sequence",
        parts: value.parts.map((part) => visit(part, depth + 1)),
      };
    throw new Error();
  }
  try {
    if (!input || typeof input !== "object" || Array.isArray(input))
      return null;
    return visit(input);
  } catch {
    return null;
  }
}
function diagnostic(key, values = []) {
  return plainDiagnostic({ kind: "message", key, values });
}
function sequence(parts) {
  return plainDiagnostic({ kind: "sequence", parts });
}
function original(node) {
  let nodes = 0;
  function render(value, depth = 0) {
    if (++nodes > 128 || depth > 8)
      throw new TypeError("Invalid application diagnostic");
    if (
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      return String(value);
    if (!value || typeof value !== "object")
      throw new TypeError("Invalid application diagnostic");
    if (value.kind === "literal" && typeof value.text === "string")
      return value.text;
    if (value.kind === "sequence" && Array.isArray(value.parts))
      return value.parts.map((part) => render(part, depth + 1)).join("");
    if (
      value.kind === "message" &&
      typeof value.key === "string" &&
      own(english, value.key) &&
      Array.isArray(value.values)
    )
      return value.key.replace(/\{(\d+)\}/g, (match, index) =>
        own(value.values, index)
          ? render(value.values[index], depth + 1)
          : match,
      );
    throw new TypeError("Invalid application diagnostic");
  }
  return render(node);
}
function diagnosticError(key, values = []) {
  if (typeof key !== "string" || !own(english, key) || !Array.isArray(values))
    throw new TypeError("Invalid application diagnostic");
  const node = diagnostic(key, values);
  // Metadata limits must not replace an actionable legacy error with a new
  // internal failure merely because a user path or literal is unusually long.
  let message = key;
  try {
    message = original({ kind: "message", key, values });
  } catch {}
  return attachDiagnostic(new Error(message), node);
}
function errorDiagnostic(error) {
  try {
    return (
      plainDiagnostic(error?.diagnostic) || {
        kind: "literal",
        text:
          typeof error?.message === "string"
            ? error.message
            : "操作失败，请重试。",
      }
    );
  } catch {
    return null;
  }
}
function attachDiagnostic(error, node) {
  const checked = plainDiagnostic(node);
  if (checked) error.diagnostic = checked;
  else delete error.diagnostic;
  return error;
}

module.exports = {
  diagnostic,
  sequence,
  diagnosticError,
  errorDiagnostic,
  attachDiagnostic,
  plainDiagnostic,
  original,
};
