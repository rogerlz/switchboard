const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const modelRegistry = require("../../src/models/modelRegistryData.json");

const SRC = path.join(__dirname, "../../src");
const LOCALES = path.join(SRC, "locales");
const NAMESPACES = ["translation"];
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const T_CALL = /\bt\(\s*(['"`])([A-Za-z0-9_.-]+)\1/g;
// messageKey values are passed to t() as a variable, so the T_CALL scan
// cannot see them and a typo would render as the raw key string.
const MESSAGE_KEY = /\bmessageKey\s*[:=]\s*(['"`])([A-Za-z0-9_.-]+)\1/g;
const load = (lang, namespace) =>
  JSON.parse(fs.readFileSync(path.join(LOCALES, lang, `${namespace}.json`), "utf8"));

function flatten(value, prefix = "", out = new Map()) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
  } else {
    out.set(prefix, value);
  }
  return out;
}

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "locales" && entry.name !== "dist") sourceFiles(full, out);
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const stripPlural = (key) => key.replace(PLURAL_SUFFIX, "");

function registryDescriptionKeys(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) registryDescriptionKeys(child, out);
  } else if (node && typeof node === "object") {
    if (typeof node.descriptionKey === "string") out.push(node.descriptionKey);
    for (const child of Object.values(node)) registryDescriptionKeys(child, out);
  }
  return out;
}

test("every t() key referenced in source resolves in en", () => {
  const keys = new Set();
  for (const namespace of NAMESPACES) {
    for (const key of flatten(load("en", namespace)).keys()) keys.add(key);
  }
  // i18next also resolves a plural base and a parent path returned as an object.
  const bases = new Set([...keys].map(stripPlural));
  const parents = new Set();
  for (const key of keys) {
    const parts = key.split(".");
    for (let i = 1; i < parts.length; i += 1) parents.add(parts.slice(0, i).join("."));
  }

  const broken = [];
  for (const file of sourceFiles(SRC)) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(T_CALL)) {
      const key = match[2];
      if (!key.includes(".")) continue;
      if (keys.has(key) || bases.has(key) || parents.has(key)) continue;
      broken.push(
        `${path.relative(SRC, file)}:${source.slice(0, match.index).split("\n").length} → ${key}`
      );
    }
  }

  assert.deepEqual(broken, [], `Missing en translations:\n${broken.join("\n")}`);
});

// Model descriptions are data-driven (t(descriptionKey, { defaultValue })), so
// the source scan above can't see them and a missing key silently falls back
// to English. Other locales are covered by the en-parity test below.
test("every model registry descriptionKey resolves in en", () => {
  const en = flatten(load("en", "translation"));
  const keys = registryDescriptionKeys(modelRegistry);
  assert.ok(keys.length > 0, "no descriptionKey found in the model registry");

  const broken = keys.filter((key) => typeof en.get(key) !== "string" || en.get(key) === "");
  assert.deepEqual(broken, [], `Registry descriptionKeys missing in en:\n${broken.join("\n")}`);
});

test("every messageKey literal resolves in en", () => {
  const keys = new Set();
  for (const namespace of NAMESPACES) {
    for (const key of flatten(load("en", namespace)).keys()) keys.add(key);
  }

  const missing = [];
  for (const file of sourceFiles(SRC)) {
    const source = fs.readFileSync(file, "utf8");
    for (const [, , key] of source.matchAll(MESSAGE_KEY)) {
      if (!keys.has(stripPlural(key))) missing.push(`${key} (${path.relative(SRC, file)})`);
    }
  }

  assert.deepEqual(missing, [], `unresolved messageKey values:\n${missing.join("\n")}`);
});
