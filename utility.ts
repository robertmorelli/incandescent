import type { DefinitionInfo, ParseNode } from './defs.ts';

export const EXPRESSION_NODE_TYPES = new Set([
    'AssignmentExpression', 'Await', 'BinaryOperation', 'Call', 'Comprehension', 'Constant', 'Dictionary',
    'DictionaryExpandEntry', 'DictionaryKeyEntry', 'Ellipsis', 'Error', 'FormatString', 'Index', 'Lambda',
    'List', 'MemberAccess', 'ModuleName', 'Name', 'Number', 'Set', 'Slice', 'String', 'StringList',
    'Ternary', 'Tuple', 'UnaryOperation', 'Unpack', 'Yield', 'YieldFrom', 'Assignment', 'TypeAnnotation', 'Parameter'
]);

export const HIGHLIGHT_NODE_TYPES = new Set(['Name', 'Number', 'String', 'StringList', 'Call', 'MemberAccess', 'BinaryOperation', 'UnaryOperation']);
export const USE_NODE_TYPES = new Set(['Name', 'MemberAccess', 'Call']);

export type SegPayload = { type?: string; definition?: DefinitionInfo; name?: string; kind?: string; node: ParseNode };
export type seg_item = { start: number; end: number; height: number; payload: SegPayload; id: number };

class SegRange {
    element: boolean;
    start: number;
    end: number;
    ids: Set<number>;
    payloads?: seg_item[];
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
    ranges_by_id: Map<number, seg_item>;

    constructor(ranges: seg_item[]) {
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

    query_max(s: number, e: number): seg_item | null {
        let node = this.root, best: seg_item | null = null;
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

    private bsearch(payloads: seg_item[] | undefined, s: number, e: number): seg_item | null {
        if (!payloads) return null;
        let lo = 0, hi = payloads.length - 1, best: seg_item | null = null;
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
