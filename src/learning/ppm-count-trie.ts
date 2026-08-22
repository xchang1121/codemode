/**
 * Adapted from xchang1121/pi's speculative-action branch.
 * Original copyright (c) 2025 Mario Zechner, MIT License.
 */

export interface PpmCountTrieRow {
  readonly context: readonly string[];
  readonly counts: Readonly<Record<string, number>>;
  readonly lastSeen: number;
  /** Per-target recency overrides; omitted when equal to the row recency. */
  readonly targetLastSeen?: Readonly<Record<string, number>>;
}

export interface PpmProbabilityEstimate {
  readonly probability: number;
  /** Longest suffix order that contributed evidence for the target. */
  readonly order: number;
  readonly evidence: number;
  readonly escapeMass: number;
}

interface TargetCount {
  count: number;
  lastSeen: number;
}

interface CountNode {
  readonly children: Map<string, CountNode>;
  readonly targets: Map<string, TargetCount>;
  total: number;
  lastSeen: number;
}

/**
 * Bounded-order context counts with interpolated PPM escape.
 *
 * Edges are stored newest-event first. Observing one transition updates the
 * root and every bounded suffix once; estimating one target is O(maxOrder).
 */
export class PpmCountTrie {
  private root = createNode();
  private populatedContexts = 0;
  private order: number;

  constructor(maxOrder: number) {
    this.order = nonNegativeInteger(maxOrder);
  }

  get maxOrder(): number {
    return this.order;
  }

  get size(): number {
    return this.populatedContexts;
  }

  observe(history: readonly string[], target: string, sequence = 0): void {
    if (!target) return;
    const lastSeen = nonNegativeInteger(sequence);
    this.increment(this.root, target, lastSeen);
    let current = this.root;
    const suffix = history.slice(-this.order);
    for (let index = suffix.length - 1; index >= 0; index--) {
      const token = suffix[index];
      if (token === undefined) continue;
      const child = current.children.get(token) ?? createNode();
      current.children.set(token, child);
      current = child;
      this.increment(current, target, lastSeen);
    }
  }

  /** Set evidence for one exact context without changing its suffixes. */
  setCount(context: readonly string[], target: string, count: number, lastSeen = 0): void {
    if (!target || context.length > this.order) return;
    const normalizedCount = positiveCount(count);
    if (normalizedCount === undefined) return;
    let current = this.root;
    for (let index = context.length - 1; index >= 0; index--) {
      const token = context[index];
      if (token === undefined) continue;
      const child = current.children.get(token) ?? createNode();
      current.children.set(token, child);
      current = child;
    }
    const wasEmpty = current.total === 0;
    const previous = current.targets.get(target)?.count ?? 0;
    current.targets.set(target, {
      count: normalizedCount,
      lastSeen: nonNegativeInteger(lastSeen),
    });
    current.total = safeTotal(current.total + normalizedCount - previous);
    current.lastSeen = Math.max(current.lastSeen, nonNegativeInteger(lastSeen));
    if (wasEmpty && current.total > 0) this.populatedContexts++;
  }

  estimate(
    history: readonly string[],
    target: string,
    sequence = 0,
    halfLife = 0,
  ): PpmProbabilityEstimate | undefined {
    if (!target || this.root.total <= 0) return undefined;
    const suffixNodes: Array<{ readonly node: CountNode; readonly order: number }> = [
      { node: this.root, order: 0 },
    ];
    let current = this.root;
    const suffix = history.slice(-this.order);
    for (let index = suffix.length - 1, order = 1; index >= 0; index--, order++) {
      const token = suffix[index];
      if (token === undefined) continue;
      const child = current.children.get(token);
      if (!child) break;
      current = child;
      if (current.total > 0) suffixNodes.push({ node: current, order });
    }

    // A shorter deterministic suffix carries more evidence than a sparse,
    // equally deterministic extension.
    const deterministic = suffixNodes.findIndex(
      ({ node, order }) => order > 0 && node.targets.size === 1,
    );
    if (deterministic >= 0) suffixNodes.length = deterministic + 1;

    let remaining = 1;
    let probability = 0;
    let matchedOrder = -1;
    let evidence = 0;
    for (const item of suffixNodes.reverse()) {
      const weighted = [...item.node.targets.values()].map((value) =>
        decayedCount(value, sequence, halfLife),
      );
      const total = weighted.reduce((sum, count) => sum + count, 0);
      const distinct = weighted.filter((count) => count > 0).length;
      if (total <= 0 || distinct <= 0) continue;
      const denominator = total + distinct;
      const count = decayedCount(item.node.targets.get(target), sequence, halfLife);
      if (count > 0) {
        probability += remaining * (count / denominator);
        if (item.order > matchedOrder) {
          matchedOrder = item.order;
          evidence = count;
        }
      }
      remaining *= distinct / denominator;
    }
    if (matchedOrder < 0) return undefined;
    return {
      probability: clampProbability(probability),
      order: matchedOrder,
      evidence,
      escapeMass: clampProbability(remaining),
    };
  }

  probability(history: readonly string[], target: string, sequence = 0, halfLife = 0): number | undefined {
    return this.estimate(history, target, sequence, halfLife)?.probability;
  }

  snapshot(maxContexts = Number.POSITIVE_INFINITY): readonly PpmCountTrieRow[] {
    const rows: Array<PpmCountTrieRow & { readonly total: number }> = [];
    const visit = (current: CountNode, reverseContext: readonly string[]): void => {
      if (current.total > 0) {
        const targetLastSeen = Object.fromEntries(
          [...current.targets.entries()]
            .filter(([, value]) => value.lastSeen !== current.lastSeen)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([target, value]) => [target, value.lastSeen]),
        );
        rows.push({
          context: [...reverseContext].reverse(),
          counts: Object.fromEntries(
            [...current.targets.entries()]
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([target, value]) => [target, value.count]),
          ),
          lastSeen: current.lastSeen,
          ...(Object.keys(targetLastSeen).length ? { targetLastSeen } : {}),
          total: current.total,
        });
      }
      for (const [token, child] of [...current.children.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        visit(child, [...reverseContext, token]);
      }
    };
    visit(this.root, []);
    const root = rows.find((row) => row.context.length === 0);
    const descendants = rows
      .filter((row) => row.context.length > 0)
      .sort(
        (left, right) =>
          right.total - left.total ||
          right.context.length - left.context.length ||
          right.lastSeen - left.lastSeen ||
          contextKey(left.context).localeCompare(contextKey(right.context)),
      );
    const limit = Number.isFinite(maxContexts)
      ? Math.max(1, Math.floor(maxContexts))
      : Number.POSITIVE_INFINITY;
    return [...(root ? [root] : []), ...descendants]
      .slice(0, limit)
      .map(({ total: _total, ...row }) => row);
  }

  restore(rows: readonly unknown[]): void {
    this.root = createNode();
    this.populatedContexts = 0;
    for (const value of rows) {
      const row = parseCountRow(value);
      if (!row || row.context.length > this.order) continue;
      for (const [target, count] of Object.entries(row.counts)) {
        if (typeof count === "number") {
          this.setCount(
            row.context,
            target,
            count,
            row.targetLastSeen?.[target] ?? row.lastSeen,
          );
        }
      }
    }
  }

  reconfigure(maxOrder: number, maxContexts: number): void {
    const normalizedOrder = nonNegativeInteger(maxOrder);
    const rows = this.snapshot(maxContexts).filter((row) => row.context.length <= normalizedOrder);
    this.order = normalizedOrder;
    this.restore(rows);
  }

  trim(maxContexts: number): void {
    const limit = Math.max(1, Math.floor(maxContexts));
    if (this.size > limit) this.restore(this.snapshot(limit));
  }

  private increment(current: CountNode, target: string, lastSeen: number): void {
    const wasEmpty = current.total === 0;
    const previous = current.targets.get(target);
    const nextCount = safeCount((previous?.count ?? 0) + 1);
    current.targets.set(target, {
      count: nextCount,
      lastSeen: Math.max(previous?.lastSeen ?? 0, lastSeen),
    });
    current.total = safeTotal(current.total + nextCount - (previous?.count ?? 0));
    current.lastSeen = Math.max(current.lastSeen, lastSeen);
    if (wasEmpty) this.populatedContexts++;
  }
}

function createNode(): CountNode {
  return { children: new Map(), targets: new Map(), total: 0, lastSeen: 0 };
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function positiveCount(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? safeCount(value) : undefined;
}

function safeCount(value: number): number {
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.max(0, Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER),
  );
}

function safeTotal(value: number): number {
  const maximum = Number.MAX_VALUE / 2;
  return Math.min(maximum, Math.max(0, Number.isFinite(value) ? value : maximum));
}

function clampProbability(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function decayedCount(value: TargetCount | undefined, sequence: number, halfLife: number): number {
  if (!value) return 0;
  if (!Number.isFinite(sequence) || !Number.isFinite(halfLife) || halfLife <= 0) return value.count;
  return value.count * 2 ** (-Math.max(0, sequence - value.lastSeen) / halfLife);
}

function parseCountRow(value: unknown): PpmCountTrieRow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as {
    context?: unknown;
    counts?: unknown;
    lastSeen?: unknown;
    targetLastSeen?: unknown;
  };
  if (
    !Array.isArray(row.context) ||
    !row.context.every((item) => typeof item === "string") ||
    !row.counts ||
    typeof row.counts !== "object" ||
    Array.isArray(row.counts)
  ) {
    return undefined;
  }
  return {
    context: row.context,
    counts: row.counts as Record<string, number>,
    lastSeen: typeof row.lastSeen === "number" ? row.lastSeen : 0,
    ...(isNumberRecord(row.targetLastSeen)
      ? { targetLastSeen: row.targetLastSeen }
      : {}),
  };
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (item) => typeof item === "number" && Number.isFinite(item) && item >= 0,
    );
}

function contextKey(context: readonly string[]): string {
  return JSON.stringify(context);
}
