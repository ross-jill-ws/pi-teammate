import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPersona } from "../extensions/persona.ts";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "persona-test-"));
}

function writePersona(dir: string, content: string): void {
  writeFileSync(join(dir, "persona.yaml"), content, "utf-8");
}

describe("loadPersona", () => {
  test("loads valid persona.yaml with all fields", () => {
    const dir = makeTmpDir();
    try {
      writePersona(dir, [
        "name: Alice",
        "description: A helpful assistant",
        "provider: anthropic",
        "model: claude-sonnet-4-5",
      ].join("\n"));

      const result = loadPersona(dir);
      expect(result).toEqual({
        name: "Alice",
        description: "A helpful assistant",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loads persona.yaml with only required fields (name, description)", () => {
    const dir = makeTmpDir();
    try {
      writePersona(dir, [
        "name: Bob",
        "description: Just a bot",
      ].join("\n"));

      const result = loadPersona(dir);
      expect(result).toEqual({
        name: "Bob",
        description: "Just a bot",
        provider: null,
        model: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null when persona.yaml does not exist", () => {
    const dir = makeTmpDir();
    try {
      const result = loadPersona(dir);
      expect(result).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws on invalid YAML syntax", () => {
    const dir = makeTmpDir();
    try {
      writePersona(dir, "name: [\ninvalid: {{\n");
      expect(() => loadPersona(dir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws when name is missing", () => {
    const dir = makeTmpDir();
    try {
      writePersona(dir, "description: Some description\n");
      expect(() => loadPersona(dir)).toThrow("name");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws when description is missing", () => {
    const dir = makeTmpDir();
    try {
      writePersona(dir, "name: Alice\n");
      expect(() => loadPersona(dir)).toThrow("description");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("trims whitespace from name and description", () => {
    const dir = makeTmpDir();
    try {
      writePersona(dir, [
        "name: '  Alice  '",
        "description: '  A helpful assistant  '",
      ].join("\n"));

      const result = loadPersona(dir);
      expect(result).not.toBeNull();
      expect(result!.name).toBe("Alice");
      expect(result!.description).toBe("A helpful assistant");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider and model default to null when omitted", () => {
    const dir = makeTmpDir();
    try {
      writePersona(dir, [
        "name: Charlie",
        "description: Minimal config",
      ].join("\n"));

      const result = loadPersona(dir);
      expect(result).not.toBeNull();
      expect(result!.provider).toBeNull();
      expect(result!.model).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
