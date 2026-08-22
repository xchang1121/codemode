#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_CONFIG_FILE, loadCodeModeConfig } from "./config.js";
import { createCodeModeRuntime, type CodeModeRuntime } from "./runtime.js";
import { CODEMODE_VERSION } from "./version.js";

export interface CodeModeCliIo {
  readonly stdout: CodeModeTextWriter;
  readonly stderr: CodeModeTextWriter;
}

export interface CodeModeTextWriter {
  write(value: string): unknown;
}

export interface ParsedCliArguments {
  readonly configPath: string;
  readonly check: boolean;
  readonly help: boolean;
  readonly version: boolean;
}

export async function runCodeModeCli(
  argv: readonly string[],
  io: CodeModeCliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<void> {
  const args = parseCliArguments(argv);
  if (args.help) {
    io.stdout.write(helpText());
    return;
  }
  if (args.version) {
    io.stdout.write(`${CODEMODE_VERSION}\n`);
    return;
  }

  const config = await loadCodeModeConfig(args.configPath);
  const runtime = await createCodeModeRuntime(config, {
    onPersistenceError: (error) => {
      io.stderr.write(`[codemode] state save failed: ${formatError(error)}\n`);
    },
  });
  reportStateWarning(runtime, io.stderr);
  if (args.check) {
    try {
      io.stdout.write(
        `Code Mode config is valid: ${config.servers.length} upstream server(s), ` +
          `${runtime.registry.list().length} tool(s), state ${runtime.stateLoadResult?.status ?? "disabled"}.\n`,
      );
    } finally {
      await runtime.close();
    }
    return;
  }
  await serveStdio(runtime, io.stderr);
}

export function parseCliArguments(argv: readonly string[]): ParsedCliArguments {
  let configPath = DEFAULT_CONFIG_FILE;
  let check = false;
  let help = false;
  let version = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--config" || argument === "-c") {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a file path`);
      configPath = value;
    } else if (argument === "--check") {
      check = true;
    } else if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument === "--version" || argument === "-v") {
      version = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { configPath, check, help, version };
}

async function serveStdio(
  runtime: CodeModeRuntime,
  stderr: CodeModeTextWriter,
): Promise<void> {
  const transport = new StdioServerTransport();
  await runtime.connect(transport);
  await new Promise<void>((resolveClosed) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      process.removeListener("SIGINT", finish);
      process.removeListener("SIGTERM", finish);
      resolveClosed();
    };
    runtime.gateway.server.onclose = finish;
    runtime.gateway.server.onerror = (error) => {
      stderr.write(`[codemode] MCP server error: ${formatError(error)}\n`);
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
  await runtime.close();
}

function reportStateWarning(
  runtime: CodeModeRuntime,
  stderr: CodeModeTextWriter,
): void {
  const state = runtime.stateLoadResult;
  if (state?.status === "invalid") {
    stderr.write(`[codemode] ignoring invalid learner state: ${state.reason}\n`);
  }
}

function helpText(): string {
  return [
    `codemode ${CODEMODE_VERSION}`,
    "",
    "Usage: codemode [--config <file>] [--check]",
    "",
    "Options:",
    `  -c, --config <file>  JSON config path (default: ${DEFAULT_CONFIG_FILE})`,
    "      --check          Connect upstream servers, validate tools, then exit",
    "  -h, --help           Show this help",
    "  -v, --version        Show the version",
    "",
  ].join("\n");
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  void runCodeModeCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[codemode] ${formatError(error)}\n`);
    process.exitCode = 1;
  });
}
