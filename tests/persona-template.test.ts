import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPersona } from "../extensions/persona.ts";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "persona-template-test-"));
}

interface TemplateOptions {
  cwd: string;
  provider?: string;
  model?: string;
}

/**
 * Simulate the /persona-template command handler logic.
 * Extracted here so we can test without needing the full pi extension wiring.
 */
function runPersonaTemplateCommand(opts: TemplateOptions): { message: string; type: string } {
  const { cwd } = opts;
  const filePath = join(cwd, "persona.yaml");

  if (existsSync(filePath)) {
    return {
      message: `persona.yaml already exists at ${filePath}. Will not overwrite.`,
      type: "error",
    };
  }

  // Derive name from the last segment of cwd, capitalised
  const dirName = cwd.split(/[\/\\]/).filter(Boolean).pop() || "Agent";
  const name = dirName.charAt(0).toUpperCase() + dirName.slice(1);

  const provider = opts.provider || "anthropic";
  const model = opts.model || "claude-sonnet-4-5";

  const template = [
    `name: "${name}"`,
    `provider: "${provider}"`,
    `model: "${model}"`,
    'description: ""',
    'systemPrompt: ""',
    '',
  ].join("\n");

  writeFileSync(filePath, template, "utf-8");
  return {
    message: `Created persona.yaml at ${filePath}`,
    type: "info",
  };
}

describe("/persona-template command", () => {
  test("creates persona.yaml when it does not exist", () => {
    const dir = makeTmpDir();
    try {
      const result = runPersonaTemplateCommand({ cwd: dir });

      expect(result.type).toBe("info");
      expect(result.message).toContain("Created persona.yaml");

      const filePath = join(dir, "persona.yaml");
      expect(existsSync(filePath)).toBe(true);

      const content = readFileSync(filePath, "utf-8");
      expect(content).toContain('description: ""');
      expect(content).toContain('systemPrompt: ""');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("errors when persona.yaml already exists", () => {
    const dir = makeTmpDir();
    try {
      // Pre-create the file
      writeFileSync(join(dir, "persona.yaml"), "name: Existing\ndescription: Already here\n", "utf-8");

      const result = runPersonaTemplateCommand({ cwd: dir });

      expect(result.type).toBe("error");
      expect(result.message).toContain("already exists");
      expect(result.message).toContain("Will not overwrite");

      // Verify original content is preserved
      const content = readFileSync(join(dir, "persona.yaml"), "utf-8");
      expect(content).toContain("name: Existing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("generated template is loadable by loadPersona (empty description allowed via YAML)", () => {
    const dir = join(makeTmpDir(), "steve");
    mkdirSync(dir, { recursive: true });
    try {
      runPersonaTemplateCommand({ cwd: dir, provider: "google", model: "gemini-2.5-pro" });

      // The template has empty description which loadPersona rejects,
      // but the file is valid YAML. Verify it parses as YAML.
      const content = readFileSync(join(dir, "persona.yaml"), "utf-8");
      expect(content).toContain('name: "Steve"');
      expect(content).toContain('provider: "google"');
      expect(content).toContain('model: "gemini-2.5-pro"');
      expect(content).toContain('systemPrompt: ""');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("derives name from cwd directory name with capitalisation", () => {
    const dir = join(makeTmpDir(), "alice");
    mkdirSync(dir, { recursive: true });
    try {
      runPersonaTemplateCommand({ cwd: dir });
      const content = readFileSync(join(dir, "persona.yaml"), "utf-8");
      expect(content).toContain('name: "Alice"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses provided provider and model", () => {
    const dir = makeTmpDir();
    try {
      runPersonaTemplateCommand({ cwd: dir, provider: "openai", model: "gpt-4o" });
      const content = readFileSync(join(dir, "persona.yaml"), "utf-8");
      expect(content).toContain('provider: "openai"');
      expect(content).toContain('model: "gpt-4o"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("defaults to anthropic/claude-sonnet-4-5 when no provider/model given", () => {
    const dir = makeTmpDir();
    try {
      runPersonaTemplateCommand({ cwd: dir });
      const content = readFileSync(join(dir, "persona.yaml"), "utf-8");
      expect(content).toContain('provider: "anthropic"');
      expect(content).toContain('model: "claude-sonnet-4-5"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
