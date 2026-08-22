import { Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { parseCliArguments, runCodeModeCli } from "../src/cli.js";

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
