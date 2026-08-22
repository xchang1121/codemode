import { describe, expect, test } from "vitest";
import { SuffixPatternTrie } from "../src/learning/suffix-pattern-trie.js";

describe("SuffixPatternTrie", () => {
  test("returns every exact suffix pattern without matching a prefix", () => {
    const trie = new SuffixPatternTrie();
    trie.insert(["search"], "short");
    trie.insert(["login", "search"], "long");
    trie.insert(["other", "search"], "other");

    expect([...trie.matching(["start", "login", "search"])]).toEqual(["short", "long"]);
    expect([...trie.matching(["start", "login"])]).toEqual([]);
  });
});
