import { getChildNodes } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/analyzer/parseTreeWalker.js';
import type { Analysis, BackMaps, DefinitionInfo, NodeInfo, ParseNode } from './defs.ts';
import { make_payloads } from './collectors.ts';
import { create_session, type Session } from './init.ts';
import {
    build_collectors,
    emit_collector,
    emit_definition,
    emit_line,
    emit_token,
    group_ranges,
    line_items,
    node_kind,
    nodes,
    PrioritySegTree,
    stream,
    token_items,
    tree,
} from './utility.ts';

export type { BackMaps };

export type TreeMap = {
    highlights: PrioritySegTree;
    expression_types: PrioritySegTree;
    identifier_definitions: PrioritySegTree;
    identifier_uses: PrioritySegTree;
    lines: PrioritySegTree;
    line_to_char_range: Map<number, { start: number; end: number }>;
    backmaps: BackMaps;
};

function collect_from_analysis(a: Analysis): TreeMap {
    const definitions = new Map<object, DefinitionInfo>();
    const line_list = [...line_items(a)];

    const collectors = build_collectors(make_payloads(definitions));
    const emit_map: Record<string, ReturnType<typeof emit_collector>> = {};
    for (const [k, c] of Object.entries(collectors)) emit_map[k] = emit_collector(a, c);
    const ast = stream(nodes(a.root), emit_map);

    const token_list = stream(token_items(a), emit_token);
    const line_segs = stream(line_list, emit_line);
    const def_segs = stream(definitions.values(), emit_definition);

    const highlights = tree([...token_list, ...ast.highlights!]);
    const expression_types = tree(ast.expression_types!);
    const identifier_uses = tree(ast.identifier_uses!);
    const identifier_definitions = tree(def_segs);
    const lines = tree(line_segs);
    const line_to_char_range = new Map(line_list.map(l => [l.line, { start: l.start, end: l.end }]));

    return {
        highlights,
        expression_types,
        identifier_definitions,
        identifier_uses,
        lines,
        line_to_char_range,
        backmaps: {
            uses_by_definition_id: group_ranges(identifier_uses, r => r.payload.definition?.id),
            args_by_parameter_id: new Map(),
            expressions_by_type: group_ranges(expression_types, r => r.payload.type),
        },
    };
}

function collectNodes(root: ParseNode, source: string): NodeInfo[] {
    const list: NodeInfo[] = [];
    const ids = new WeakMap<ParseNode, number>();
    const ensure = (n: ParseNode) => {
        const existing = ids.get(n);
        if (existing !== undefined) return existing;
        const id = list.length;
        ids.set(n, id);
        list.push({
            id,
            type: node_kind(n),
            start: n.start,
            length: n.length,
            text: source.slice(n.start, n.start + n.length),
            children: [],
        });
        return id;
    };
    for (const { node } of nodes(root)) {
        const id = ensure(node);
        const children = getChildNodes(node) as Array<ParseNode | undefined>;
        list[id]!.children = children.filter((x): x is ParseNode => !!x).map(ensure);
    }
    return list;
}
export function create_analysis_session() {
    const session = create_session();
    return {
        analyze: session.analyze,
        collect_trees: (s: string) => collect_from_analysis(session.analyze(s)),
        collect_trees_timed(sourceText: string) {
            const t0 = performance.now();
            const analysis = session.analyze(sourceText);
            const t1 = performance.now();
            const trees = collect_from_analysis(analysis);
            const t2 = performance.now();
            return {
                trees,
                timing: {
                    service_ms: +(t1 - t0).toFixed(2),
                    tree_build_ms: +(t2 - t1).toFixed(2),
                    total_collect_ms: +(t2 - t0).toFixed(2),
                },
            };
        },
    };
}

export function collect_trees(sourceText: string): TreeMap {
    return collect_from_analysis(create_session().analyze(sourceText));
}

export function decorate_tree(sourceText: string): Map<number, NodeInfo> {
    const a = create_session().analyze(sourceText);
    const ns = collectNodes(a.root, sourceText);
    return new Map(ns.map(n => [n.id, n]));
}

export type { Session };
