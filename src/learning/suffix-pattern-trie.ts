interface TrieNode {
  readonly children: Map<string, TrieNode>;
  readonly patternIds: Set<string>;
}

/** Exact suffix index for learned tool contexts. */
export class SuffixPatternTrie {
  private readonly root: TrieNode = createNode();

  insert(context: readonly string[], patternId: string): void {
    if (!context.length || !patternId) return;
    let current = this.root;
    for (let index = context.length - 1; index >= 0; index--) {
      const token = context[index];
      if (token === undefined) continue;
      const child = current.children.get(token) ?? createNode();
      current.children.set(token, child);
      current = child;
    }
    current.patternIds.add(patternId);
  }

  matching(history: readonly string[]): ReadonlySet<string> {
    const result = new Set<string>();
    let current = this.root;
    for (let index = history.length - 1; index >= 0; index--) {
      const token = history[index];
      if (token === undefined) continue;
      const child = current.children.get(token);
      if (!child) break;
      current = child;
      for (const patternId of current.patternIds) result.add(patternId);
    }
    return result;
  }
}

function createNode(): TrieNode {
  return { children: new Map(), patternIds: new Set() };
}
