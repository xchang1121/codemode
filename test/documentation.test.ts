import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MARKDOWN_FILES = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/architecture.md",
  "docs/learning.md",
  "docs/security.md",
];

describe("documentation", () => {
  test("all relative Markdown links resolve to checked-in files", async () => {
    const missing: string[] = [];
    for (const relativeFile of MARKDOWN_FILES) {
      const filePath = resolve(ROOT, relativeFile);
      const markdown = await readFile(filePath, "utf8");
      const prose = markdown
        .replace(/```[\s\S]*?```/g, "")
        .replace(/`[^`\n]*`/g, "");
      for (const match of prose.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1]?.split("#", 1)[0];
        if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        const resolved = resolve(dirname(filePath), decodeURIComponent(target));
        await access(resolved).catch(() => missing.push(`${relativeFile} -> ${target}`));
      }
    }
    expect(missing).toEqual([]);
  });
});
