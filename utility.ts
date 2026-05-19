import { getChildNodes } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/analyzer/parseTreeWalker.js';
import { ParseNodeTypeNameMap } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/parser/parseNodeUtils.js';
import data from './data.json' with { type: 'json' };
import type { Analysis, Collector, DefinitionInfo, Emit, LineItem, NodeBehavior, NodeItem, ParseNode, Seg, SegItem, TokenItem } from './defs.ts';

// Re-export for callers that still reference utility's old names.
export type seg_item = SegItem;

const raw_node = data.NODE as Record<string, {
    isExpression?: boolean;
    isUse?: boolean;
    isClass?: boolean;
    highlightChild?: string;
    nameChild?: string;
    baseChild?: string;
}>;

const make_pick = (field: string | undefined) => field ? (d: any) => d?.[field] : undefined;

export const NODE: Record<string, NodeBehavior> = Object.fromEntries(
    Object.entries(raw_node).map(([kind, b]) => [kind, {
        isExpression: b.isExpression,
        isUse: b.isUse,
        isClass: b.isClass,
        highlightChild: make_pick(b.highlightChild),
        nameChild: make_pick(b.nameChild),
        baseChild: make_pick(b.baseChild),
    }])
);

export const TOKEN_KIND: Record<number, string> = Object.fromEntries(
    Object.entries(data.TOKEN_KIND as Record<string, string>).map(([k, v]) => [Number(k), v])
);

export const KEYWORD_KIND: Record<number, 'keyword' | 'control' | 'builtin'> = Object.fromEntries(
    Object.entries(data.KEYWORD_KIND as Record<string, string>).map(([k, v]) => [Number(k), v as 'keyword' | 'control' | 'builtin'])
);

export const COLLECTOR_SPECS = data.COLLECTORS as Record<string, { key: string; height_base?: number }>;
export const TOKEN_HEIGHTS = data.TOKEN_HEIGHTS as { comment: number; main: number };
export const PRINT_OPTS = data.PRINT_OPTS as Record<string, boolean>;
export const EMPTY_TYPES = new Set(data.EMPTY_TYPES as string[]);
export const CALLABLE_RETURN_RE = new RegExp(data.CALLABLE_RETURN_PATTERN as string);

export const PYRIGHT = data.PYRIGHT as {
    analyzer_name: string;
    input_filename: string;
    analyze_loop_guard: number;
    typeshed_path: string;
    stub_path: string;
    extra_paths: string[];
    useLibraryCodeForTypes: boolean;
    indexing: boolean;
};

export const node_kind = (n: ParseNode) =>
    ParseNodeTypeNameMap[n.nodeType] ?? String(n.nodeType);

export const child = (n: ParseNode, role: 'highlightChild' | 'nameChild' | 'baseChild') =>
    NODE[node_kind(n)]?.[role]?.(n.d as any);

export const read_name = (n: ParseNode | undefined, source: string) => {
    if (!n) return '';
    const value = (n.d as any)?.value;
    return String(value ?? source.slice(n.start, n.start + n.length));
};

export const print_type = (evaluator: any, typ: any) => evaluator.printType(typ, PRINT_OPTS);

export const token_kind = (token: any) => {
    const kind = TOKEN_KIND[token.type];
    if (kind !== '__keyword__') return kind;
    return KEYWORD_KIND[token.keywordType] ?? 'keyword';
};

export function* nodes(root: ParseNode, depth = 0): Generator<NodeItem> {
    yield { node: root, depth };
    const children = getChildNodes(root) as Array<ParseNode | undefined>;
    for (const c of children) {
        if (c) yield* nodes(c, depth + 1);
    }
}

export function* token_items(a: Analysis): Generator<TokenItem> {
    const tokens = a.parseResults.tokenizerOutput.tokens._items ?? a.parseResults.tokenizerOutput.tokens;
    for (const t of tokens) {
        for (const c of t.comments ?? []) {
            yield { start: c.start, end: c.start + c.length, height: TOKEN_HEIGHTS.comment, kind: 'comment' };
        }
        const kind = token_kind(t);
        if (kind) yield { start: t.start, end: t.start + t.length, height: TOKEN_HEIGHTS.main, kind };
    }
}

export function* line_items(a: Analysis): Generator<LineItem> {
    const lines = a.parseResults.tokenizerOutput.lines;
    const items = lines._items ?? lines;
    const source = a.sourceText;
    let line = 1;
    for (const r of items) {
        let end = r.start + r.length;
        if (end > r.start && source[end - 1] === '\n') end--;
        yield { start: r.start, end, line };
        line++;
    }
}

export function stream<I>(items: Iterable<I>, emit: Emit<I>): Seg[];
export function stream<I>(items: Iterable<I>, emit: Record<string, Emit<I>>): Record<string, Seg[]>;
export function stream<I>(items: Iterable<I>, emit: Emit<I> | Record<string, Emit<I>>): Seg[] | Record<string, Seg[]> {
    if (typeof emit === 'function') {
        const out: Seg[] = [];
        for (const item of items) {
            const seg = emit(item);
            if (seg) out.push(seg);
        }
        return out;
    }
    const keys = Object.keys(emit);
    const out: Record<string, Seg[]> = {};
    for (const k of keys) out[k] = [];
    for (const item of items) {
        for (const k of keys) {
            const seg = emit[k]!(item);
            if (seg) out[k]!.push(seg);
        }
    }
    return out;
}

export function tree(items: Iterable<Seg>): PrioritySegTree {
    const ranges: SegItem[] = [];
    for (const r of items) {
        if (!Number.isFinite(r.start) || r.end < r.start) continue;
        ranges.push({ ...r, id: ranges.length });
    }
    return new PrioritySegTree(ranges);
}

export const emit_token: Emit<TokenItem> = i => ({
    start: i.start,
    end: i.end,
    height: i.height,
    payload: { kind: i.kind, node: {} as ParseNode },
});

export const emit_line: Emit<LineItem> = ({ start, end, line }) => ({
    start,
    end,
    height: 0,
    payload: { name: String(line), node: {} as ParseNode },
});

export const emit_definition: Emit<DefinitionInfo> = d => ({
    start: d.start,
    end: d.end,
    height: 0,
    payload: { definition: d, name: d.name, type: d.type, node: {} as ParseNode },
});

export const emit_collector = (a: Analysis, c: Collector): Emit<NodeItem> => ({ node, depth }) => {
    const behavior = NODE[node_kind(node)];
    if (!behavior) return undefined;
    const v = behavior[c.key];
    if (!v) return undefined;
    const target = typeof v === 'function' ? v(node.d as any) : node;
    if (!target) return undefined;
    const payload = c.payload(node, target, a);
    if (!payload) return undefined;
    return {
        start: target.start,
        end: target.start + target.length,
        height: (c.height_base ?? 0) + depth,
        payload,
    };
};

export function build_collectors(payloads: Record<string, Collector['payload']>): Record<string, Collector> {
    const out: Record<string, Collector> = {};
    for (const [k, spec] of Object.entries(COLLECTOR_SPECS)) {
        out[k] = { key: spec.key as Collector['key'], height_base: spec.height_base, payload: payloads[k]! };
    }
    return out;
}

export function group_ranges<K>(t: PrioritySegTree, key: (r: SegItem) => K | undefined): Map<K, SegItem[]> {
    const out = new Map<K, SegItem[]>();
    for (const r of t.ranges_by_id.values()) {
        const k = key(r);
        if (k === undefined) continue;
        const existing = out.get(k) ?? [];
        existing.push(r);
        out.set(k, existing);
    }
    return out;
}

class SegRange {
    element: boolean;
    start: number;
    end: number;
    ids: Set<number>;
    payloads?: SegItem[];
    left?: SegRange;
    right?: SegRange;

    constructor(locations: number[], payload?: Set<number>, left?: SegRange, right?: SegRange) {
        this.element = locations.length === 1;
        this.start = locations.at(0)!;
        this.end = locations.at(-1)!;
        this.ids = new Set(payload ?? []);
        this.left = left;
        this.right = right;
    }
}

export class PrioritySegTree {
    root: SegRange | null;
    ranges_by_id: Map<number, SegItem>;

    constructor(ranges: SegItem[]) {
        const units = [...new Set(ranges.flatMap(e => [e.start, e.end]))].toSorted((a, b) => a - b);
        this.ranges_by_id = new Map(ranges.map(e => [e.id, e]));
        this.root = null;
        if (units.length === 0) return;

        const events = ranges.flatMap(e => [
            {is_start: true, location: e.start, id: e.id},
            {is_start: false, location: e.end, id: e.id},
        ]).toSorted((a, b) => a.location - b.location || (a.is_start ? 1 : -1));

        let ei = 0, level: SegRange[] = [];
        const active_ids = new Set<number>();

        for (let i = 0; i < units.length - 1; i++) {
            while (ei < events.length && events[ei]!.location <= units[i]!) {
                const ev = events[ei++]!;
                if (ev.is_start) active_ids.add(ev.id); else active_ids.delete(ev.id);
            }
            level.push(new SegRange([units[i]!]));
            level.push(new SegRange([units[i]!, units[i + 1]!], new Set(active_ids)));
        }
        level.push(new SegRange([units.at(-1)!]));

        while (level.length > 1) {
            const level_swap: SegRange[] = [];
            while (level.length >= 2) {
                const left = level.shift()!, right = level.shift()!;
                const shared = setIntersection(left.ids, right.ids);
                left.ids = setDifference(left.ids, shared);
                right.ids = setDifference(right.ids, shared);
                left.payloads = this.sorted(left.ids);
                right.payloads = this.sorted(right.ids);
                const parent = new SegRange([left.start, right.end], shared, left, right);
                parent.payloads = this.sorted(shared);
                level_swap.push(parent);
            }
            if (level.length === 1) level_swap.push(level[0]!);
            level = level_swap;
        }
        this.root = level[0]!;
    }

    query_max(s: number, e: number): SegItem | null {
        let node = this.root, best: SegItem | null = null;
        while (node && !node.element) {
            const found = this.bsearch(node.payloads, s, e);
            if (found && (!best || found.height > best.height)) best = found;
            if (node.left && s < node.left.end) node = node.left;
            else node = node.right ?? node.left ?? null;
        }
        const found = node ? this.bsearch(node.payloads, s, e) : null;
        return found && (!best || found.height > best.height) ? found : best;
    }

    query_type(s: number, e: number): string | undefined { return this.query_max(s, e)?.payload.type; }
    query_definition(s: number, e: number): DefinitionInfo | undefined { return this.query_max(s, e)?.payload.definition; }

    private sorted(ids: Set<number>) {
        return Array.from(ids).map(id => this.ranges_by_id.get(id)!).toSorted((a, b) => a.end - b.end || b.height - a.height);
    }

    private bsearch(payloads: SegItem[] | undefined, s: number, e: number): SegItem | null {
        if (!payloads) return null;
        let lo = 0, hi = payloads.length - 1, best: SegItem | null = null;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1, item = payloads[mid]!;
            if (item.end < e) { lo = mid + 1; continue; }
            if (item.start <= s && (!best || item.height > best.height)) best = item;
            hi = mid - 1;
        }
        return best;
    }
}

function setIntersection<T>(a: Set<T>, b: Set<T>) { const r = new Set<T>(); for (const x of a) if (b.has(x)) r.add(x); return r; }
function setDifference<T>(a: Set<T>, b: Set<T>) { const r = new Set<T>(); for (const x of a) if (!b.has(x)) r.add(x); return r; }
