import { Writable } from "node:stream";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseCliArguments, runCodeModeCli } from "../src/cli.js";
import { CODEMODE_VERSION } from "../src/version.js";

describe("Code Mode CLI", () => {
  test("parses config and check flags", () => {
    expect(parseCliArguments(["--config", "custom.json", "--check"])).toEqual({
      configPath: "custom.json",
      check: true,
      help: false,
      version: false,
    });
    expect(() => parseCliArguments(["--unknown"])).toThrow(/Unknown argument/);
  });

  test("prints help and version without opening an MCP transport", async () => {
    const help = captureStream();
    await runCodeModeCli(["--help"], { stdout: help.stream, stderr: help.stream });
    expect(help.text()).toContain("Usage: codemode");

    const version = captureStream();
    await runCodeModeCli(["--version"], {
      stdout: version.stream,
      stderr: version.stream,
    });
    expect(version.text()).toMatch(/^0\.1\.0\n$/);
  });

  test("keeps the CLI version aligned with package metadata", async () => {
    const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
    const packageJson: unknown = JSON.parse(await readFile(packagePath, "utf8"));
    expect(asRecord(packageJson)?.version).toBe(CODEMODE_VERSION);
  });
});

function captureStream(): { readonly stream: Writable; readonly text: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
