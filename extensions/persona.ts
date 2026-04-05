import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { PersonaConfig } from "./types.ts";

const PERSONA_FILE = "persona.yaml";

/**
 * Load persona.yaml from the given directory.
 * Returns null if the file doesn't exist.
 * Throws on invalid YAML or missing required fields.
 */
export function loadPersona(cwd: string): PersonaConfig | null {
  const filePath = join(cwd, PERSONA_FILE);

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }

  const doc = YAML.parse(raw);

  if (doc == null || typeof doc !== "object") {
    throw new Error(`Invalid persona.yaml: expected a YAML mapping, got ${typeof doc}`);
  }

  const name = doc.name;
  const description = doc.description;

  if (name == null || (typeof name === "string" && name.trim() === "")) {
    throw new Error("persona.yaml: 'name' is required and must not be empty");
  }
  if (typeof name !== "string") {
    throw new Error("persona.yaml: 'name' must be a string");
  }

  if (description == null || (typeof description === "string" && description.trim() === "")) {
    throw new Error("persona.yaml: 'description' is required and must not be empty");
  }
  if (typeof description !== "string") {
    throw new Error("persona.yaml: 'description' must be a string");
  }

  // Collect any extra user-defined properties
  const knownKeys = new Set(["name", "description", "provider", "model", "systemPrompt"]);
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (!knownKeys.has(k)) {
      extras[k] = v;
    }
  }

  return {
    name: name.trim(),
    description: description.trim(),
    provider: typeof doc.provider === "string" ? doc.provider : null,
    model: typeof doc.model === "string" ? doc.model : null,
    systemPrompt: typeof doc.systemPrompt === "string" && doc.systemPrompt.trim() !== ""
      ? doc.systemPrompt.trim()
      : null,
    ...extras,
  };
}
