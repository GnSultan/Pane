/**
 * sanitize.mjs — Unicode sanitization for JSON serialization safety.
 *
 * Lone surrogate characters (U+D800–U+DFFF) are not valid Unicode scalar values.
 * Node.js JSON.stringify encodes them as \uD800 escapes, which Go's strict JSON
 * parser (RFC 8259 §7) rejects with HTTP 400. This utility replaces them before
 * serialization.
 *
 * Entry points: shell output, file reads, web fetch, grep results.
 * Serialization boundary: API request bodies.
 */

const LONE_SURROGATE_RE = /[\uD800-\uDFFF]/g;

/**
 * Sanitize a value by replacing lone surrogates with U+FFFD (replacement char).
 * Deep-walks objects and arrays. Mutates in place for performance — clone first
 * if immutability is needed.
 *
 * @param {any} value — the value to sanitize
 * @returns {any} — the sanitized value (same reference if object/array)
 */
export function sanitizeStrings(value) {
  if (typeof value === "string") {
    return value.replace(LONE_SURROGATE_RE, "\uFFFD");
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = sanitizeStrings(value[i]);
    }
    return value;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      const sanitizedKey = key.replace(LONE_SURROGATE_RE, "\uFFFD");
      value[sanitizedKey] = sanitizeStrings(value[key]);
      if (sanitizedKey !== key) {
        delete value[key];
      }
    }
    return value;
  }
  return value;
}

/**
 * Safe JSON.stringify — replaces lone surrogates in all strings before
 * serialization. Uses a replacer function so it works on any value without
 * cloning.
 *
 * @param {any} value
 * @param {Function|Array|null} [replacer]
 * @param {number|string} [space]
 * @returns {string}
 */
export function safeStringify(value, replacer = null, space = undefined) {
  return JSON.stringify(value, (key, val) => {
    // Run the user's replacer first (if any)
    const result = replacer ? replacer(key, val) : val;
    // Sanitize strings
    if (typeof result === "string" && LONE_SURROGATE_RE.test(result)) {
      return result.replace(LONE_SURROGATE_RE, "\uFFFD");
    }
    return result;
  }, space);
}

/**
 * Fast inline sanitize a single string — for use at tool result entry points
 * where we know the value is already a string.
 *
 * @param {string} str
 * @returns {string}
 */
export function sanitizeString(str) {
  return str.replace(LONE_SURROGATE_RE, "\uFFFD");
}
