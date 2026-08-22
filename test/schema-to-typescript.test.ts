import { describe, expect, test } from "vitest";
import { schemaToTypeScript } from "../src/tools/schema-to-typescript.js";

describe("schemaToTypeScript", () => {
  test("renders required, optional, arrays, enums and local references", () => {
    expect(
      schemaToTypeScript({
        type: "object",
        properties: {
          query: { type: "string" },
          mode: { enum: ["fast", "full"] },
          items: { type: "array", items: { $ref: "#/$defs/item" } },
        },
        required: ["query", "items"],
        $defs: {
          item: {
            type: "object",
            properties: { id: { type: "number" } },
            required: ["id"],
          },
        },
      }),
    ).toBe(
      '{ readonly "query": string; readonly "mode"?: "fast" | "full"; readonly "items": Array<{ readonly "id": number; }>; }',
    );
  });
});
