import { getChildNodes } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/analyzer/parseTreeWalker.js';
import { DiagnosticSink } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/common/diagnosticSink.js';
import { Parser, ParseOptions } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/parser/parser.js';
import { ParseNodeTypeNameMap } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/parser/parseNodeUtils.js';
import type { NodeInfo, ParseFileResults, ParseNode, SourceInfo,WalkCallback, WalkContext } from './defs.ts'; 
import { EXPRESSION_NODE_TYPES, IDENT_NODE_TYPES, ANNO_NODE_TYPES } from './utility.ts';


export function analyzeSource(sourceText: string) {
    const diagSink = new DiagnosticSink();
    const parseResults = new Parser().parseSourceFile(sourceText, new ParseOptions(), diagSink) as ParseFileResults;
    const diagnostics = diagSink.fetchAndClear() as unknown[];
    return { parseResults, diagnostics };
}

export function walkAst(root: ParseNode): void {
    //TODO: setup psegtree in here
    let id = 0;
    const ranges = [];
    const all_enpoints = [];
    const _visit = (node: ParseNode, depth: number) => {
        ranges.push([node.start - 0.5, node.start + node.length + 0.5, depth, node])
        const children = getChildNodes(node);
        for (const child of children) _visit(child, depth + 1);
        const type_name = ParseNodeTypeNameMap[node.nodeType] ?? String(node.nodeType)
    };
    _visit(root, 0);
}

type seg_item = {start: number, end: number, height: number, payload: any, id: number};

class SegRange {
    element: boolean
    start: number
    end: number
    ids: Set<number>
    payloads?: seg_item[]
    left?: SegRange
    right?: SegRange
    constructor(locations: number[], payload?: Set<number>, left?: SegRange, right?: SegRange) {
        this.element = locations.length === 1;
        this.start = locations.at(0)!;
        this.end = locations.at(-1)!;
        this.ids = new Set(payload) ?? new Set();
        this.left = left;
        this.right = right;
    }
}

//TODO: convert to int tree
class PrioritySegTree {
    root: SegRange
    ranges_by_id: Map<number, seg_item>

    constructor(ranges: seg_item[]) {
        const units = [...new Set(ranges.flatMap(e => [e.start, e.end]))]
            .toSorted((a, b) => a - b);
        this.ranges_by_id = new Map(ranges.map(e => [e.id, e]));
        const events = ranges
            .flatMap(e => [
                {is_start: true,  location: e.start, id: e.id},
                {is_start: false, location: e.end,   id: e.id},
            ])
            .toSorted((a, b) => a.location - b.location || (a.is_start ? 1 : -1));

        let ei = 0;
        const active_ids: Set<number> = new Set();
        let level: SegRange[] = [];

        for (let i = 0; i < units.length - 1; i++) {
            while (ei < events.length && events[ei].location <= units[i]) {
                const ev = events[ei++];
                if (ev.is_start) active_ids.add(ev.id);
                else active_ids.delete(ev.id);
            }
            level.push(new SegRange([units[i]]));
            level.push(new SegRange([units[i], units[i+1]], new Set(active_ids)));
        }
        level.push(new SegRange([units.at(-1)!]));

        while (level.length > 1) {
            const level_swap: SegRange[] = [];
            while (level.length >= 2) {
                const left  = level.shift()!;
                const right = level.shift()!;
                const shared = left.ids.intersection(right.ids);
                left.ids  = left.ids.difference(shared);
                right.ids = right.ids.difference(shared);
                left.payloads  = Array.from(left.ids)
                    .map(id => this.ranges_by_id.get(id)!)
                    .toSorted((a, b) => a.end - b.end);
                right.payloads = Array.from(right.ids)
                    .map(id => this.ranges_by_id.get(id)!)
                    .toSorted((a, b) => a.end - b.end);
                const parent = new SegRange([left.start, right.end], shared, left, right);
                parent.payloads = Array.from(shared)
                    .map(id => this.ranges_by_id.get(id)!)
                    .toSorted((a, b) => a.end - b.end);
                level_swap.push(parent);
            }
            if (level.length === 1) level_swap.push(level[0]);
            level = level_swap;
        }
        this.root = level[0];
    }

    query_max(s: number, e: number): seg_item | null {
        let node = this.root;
        let best: seg_item | null = null;
        while (!node.element) {
            const found = this.bsearch(node.payloads, s, e);
            if (found) best = found;
            node = (node.left && node.left.end >= s) ? node.left : node.right!;
        }
        const found = this.bsearch(node.payloads, s, e);
        if (found) best = found;
        return best;
    }

    private bsearch(payloads: seg_item[] | undefined, s: number, e: number): seg_item | null {
        let lo = 0, hi = payloads!.length - 1, best: seg_item | null = null;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (payloads![mid].end < e) { lo = mid + 1; continue; }
            if (payloads![mid].start <= s) best = payloads![mid];
            hi = mid - 1;
        }
        return best;
    }
}