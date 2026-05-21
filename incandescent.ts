import { getChildNodes } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/analyzer/parseTreeWalker.js';
import type { Analysis, BackMaps, DefinitionInfo, NodeInfo, ParseNode, SegItem } from './defs.ts';
import {
    classes,
    classify_annotation_context,
    classify_literal,
    classify_type_kind,
    compute_ties,
    make_payloads,
    printed_annotation_type,
} from './collectors.ts';
import type { Range, Role } from './defs.ts';
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
    annotation_owners: PrioritySegTree;
    line_to_char_range: Map<number, { start: number; end: number }>;
    backmaps: BackMaps;
};

function collect_from_analysis(a: Analysis): TreeMap {
    const definitions = new Map<object, DefinitionInfo>();
    const decl_id_by_decl = (d: object) => definitions.get(d)?.id;
    const roles = new Map<number, Role>();
    const line_list = [...line_items(a)];

    const collectors = build_collectors(make_payloads(definitions, roles));
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

    // ---- new tables ----
    const args_by_parameter_id   = new Map<number, Range[]>();
    const calls_by_function_id   = new Map<number, Range[]>();
    const returns_by_function_id = new Map<number, Range[]>();
    const indexed_by_id          = new Map<number, Range[]>();

    const push_range = (m: Map<number, Range[]>, id: number, r: Range) => {
        const list = m.get(id);
        if (list) list.push(r); else m.set(id, [r]);
    };

    // Walk the AST once. For each node:
    //   - If it's a Call: handle explicit function/method calls + len(x)/iter(x)/etc. builtin dispatch.
    //   - For everything else: ask the generic dispatcher whether the node implicitly invokes any
    //     dunder methods (Index, BinaryOperation, UnaryOperation, AugmentedAssignment, For, Await, With).
    //     Pyright's getBoundMagicMethod does the actual method lookup.
    for (const { node } of nodes(a.root)) {
        const k = node_kind(node);
        const d: any = (node as any).d;

        if (k === 'Call') {
            const targetDecl = a.facts.getCallInfo(node).declarations[0];
            if (targetDecl) {
                const funcId = decl_id_by_decl(targetDecl);
                if (funcId !== undefined) {
                    push_range(calls_by_function_id, funcId, { start: node.start, end: node.start + node.length });
                    for (const m of a.facts.getCallInfo(node).argMap) {
                        const paramId = m.paramDecl ? decl_id_by_decl(m.paramDecl) : undefined;
                        if (paramId === undefined) continue;
                        push_range(args_by_parameter_id, paramId, { start: m.argExpr.start, end: m.argExpr.start + m.argExpr.length });
                    }
                }
            }
            // len(x) / iter(x) / etc. — also record as a call of x's protocol dunder.
            for (const disp of a.facts.getBuiltinProtocolCalls(node)) {
                const dunderDecl = disp.declaration;
                const dunderId = dunderDecl ? decl_id_by_decl(dunderDecl) : undefined;
                if (dunderId !== undefined) push_range(calls_by_function_id, dunderId, { start: node.start, end: node.start + node.length });
            }
            continue;
        }

        if (k === 'Index') {
            const leftExpr = d.leftExpr;
            const baseInfo = leftExpr ? a.facts.getDefinitionForNode(leftExpr) : undefined;
            const baseId = baseInfo?.decl ? decl_id_by_decl(baseInfo.decl) : undefined;
            if (baseId !== undefined) {
                for (const item of d.items ?? []) {
                    const expr = item.d?.valueExpr ?? item;
                    push_range(indexed_by_id, baseId, { start: expr.start, end: expr.start + expr.length });
                }
            }
        }

        for (const disp of a.facts.getImplicitCalls(node)) {
            const dunderDecl = disp.declaration;
            if (!dunderDecl) continue;
            const funcId = decl_id_by_decl(dunderDecl);
            if (funcId === undefined) continue;
            push_range(calls_by_function_id, funcId, { start: disp.callRange.start, end: disp.callRange.start + disp.callRange.length });
            for (const m of disp.argMap ?? []) {
                const paramId = m.paramDecl ? decl_id_by_decl(m.paramDecl) : undefined;
                if (paramId === undefined) continue;
                push_range(args_by_parameter_id, paramId, { start: m.argExpr.start, end: m.argExpr.start + m.argExpr.length });
            }
        }
    }

    // For each Function decl we have an id for, walk its body for Return expressions.
    for (const [declObj, def] of definitions) {
        if ((declObj as any)?.type !== 5 /* Function */) continue;
        const fnNode = (declObj as any)?.node;
        if (!fnNode) continue;
        const rets = a.facts.getReturnInfo(fnNode).expressions;
        if (!rets.length) continue;
        returns_by_function_id.set(def.id, rets.map(r => ({ start: r.start, end: r.start + r.length })));
    }

    // Reads / writes split.
    const reads_by_id  = new Map<number, ReturnType<typeof group_ranges>['get'] extends any ? any : never>() as Map<number, any[]>;
    const writes_by_id = new Map<number, any[]>();
    for (const r of identifier_uses.ranges_by_id.values()) {
        const id = r.payload.definition?.id;
        if (id === undefined) continue;
        const mode = (r.payload as any).mode;
        if (mode === 'decl' || mode === 'call') continue;   // not reads or writes
        if (mode === 'write') {
            // Show the assigned VALUE (rightExpr), not the variable name on the LHS.
            const rhs = (r.payload as any).write_value_range;
            const synthetic = rhs ? { ...r, start: rhs.start, end: rhs.end } : r;
            const list = writes_by_id.get(id);
            if (list) list.push(synthetic); else writes_by_id.set(id, [synthetic]);
        } else {
            const list = reads_by_id.get(id);
            if (list) list.push(r); else reads_by_id.set(id, [r]);
        }
    }

    // Annotation owners come from Pyright facts: every typed location maps to
    // the annotated entity, not whatever class/type the annotation expression resolves to.
    const annotation_segs: SegItem[] = [];
    const context_label_by_annotation_id = new Map<number, string>();
    const type_kind_by_annotation_id     = new Map<number, string>();
    const printed_type_by_annotation_id  = new Map<number, string>();
    for (const { annotation, ownerDecl } of a.facts.getAnnotationOwners(a.root)) {
        const owner = definitions.get(ownerDecl);
        if (!owner) continue;
        const id = annotation_segs.length;
        annotation_segs.push({
            start: annotation.start, end: annotation.start + annotation.length, height: 0,
            payload: { definition: owner, name: owner.name, node: annotation },
            id,
        });
        const ctx = classify_annotation_context(annotation, a.sourceText);
        if (ctx) context_label_by_annotation_id.set(id, ctx);
        const { type: annType, printed } = printed_annotation_type(a, annotation);
        type_kind_by_annotation_id.set(id, classify_type_kind(annType));
        printed_type_by_annotation_id.set(id, printed);
    }
    const annotation_owners = new PrioritySegTree(annotation_segs);

    // Per-node literal tag. Walks the AST once and tags every expression node.
    const literal_tag_by_node_id = new Map<number, 'literal' | 'none_literal' | 'value'>();
    for (const { node } of nodes(a.root)) {
        const tag = classify_literal(node, a.sourceText);
        if (tag) literal_tag_by_node_id.set((node as any).id, tag);
    }

    // Ensure classes are cached before computing ties (already used by recovery).
    void classes(a);
    const direct_ties = compute_ties(a, definitions);

    // Tie-equivalence classes: transitively close `direct_ties` so a member of the same
    // override chain shares one Set. Used to reflow every id-keyed table below.
    const class_of = new Map<number, Set<number>>();
    for (const seed of direct_ties.keys()) {
        if (class_of.has(seed)) continue;
        const cls = new Set<number>();
        const queue = [seed];
        while (queue.length) {
            const x = queue.shift()!;
            if (cls.has(x)) continue;
            cls.add(x);
            for (const y of direct_ties.get(x) ?? []) if (!cls.has(y)) queue.push(y);
        }
        for (const x of cls) class_of.set(x, cls);
    }
    // Dedup ranges by (start,end). Different list entries that map to the same source span are
    // visually identical and shouldn't appear twice in the data column.
    const dedup_by_range = <V extends { start: number; end: number }>(arr: V[]): V[] => {
        const seen = new Set<string>();
        const out: V[] = [];
        for (const v of arr) {
            const k = `${v.start}:${v.end}`;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(v);
        }
        return out;
    };
    const reflow_list = <V extends { start: number; end: number }>(raw: Map<number, V[]>): Map<number, V[]> => {
        const out = new Map<number, V[]>();
        const seen_class = new WeakSet<Set<number>>();
        const merge = (cls: Set<number>) => {
            const m: V[] = [];
            for (const i of cls) for (const v of raw.get(i) ?? []) m.push(v);
            return dedup_by_range(m);
        };
        for (const id of raw.keys()) {
            const cls = class_of.get(id);
            if (!cls) { out.set(id, dedup_by_range(raw.get(id)!)); continue; }
            if (seen_class.has(cls)) continue;
            seen_class.add(cls);
            const merged = merge(cls);
            for (const i of cls) if (merged.length) out.set(i, merged);
        }
        // Classes whose members had no raw entries are simply absent — same as raw.
        return out;
    };
    const tied_to_id = new Map<number, number[]>();
    for (const [id, cls] of class_of) {
        const others = [...cls].filter(x => x !== id);
        if (others.length) tied_to_id.set(id, others);
    }

    return {
        highlights,
        expression_types,
        identifier_definitions,
        identifier_uses,
        lines,
        annotation_owners,
        line_to_char_range,
        backmaps: {
            uses_by_definition_id: group_ranges(identifier_uses, r => r.payload.definition?.id),
            expressions_by_type: group_ranges(expression_types, r => r.payload.type),
            role_by_id: roles,
            reads_by_id:            reflow_list(reads_by_id),
            writes_by_id:           reflow_list(writes_by_id),
            args_by_parameter_id:   reflow_list(args_by_parameter_id),
            calls_by_function_id:   reflow_list(calls_by_function_id),
            returns_by_function_id: reflow_list(returns_by_function_id),
            indexed_by_id:          reflow_list(indexed_by_id),
            tied_to_id,
            context_label_by_annotation_id,
            type_kind_by_annotation_id,
            printed_type_by_annotation_id,
            literal_tag_by_node_id,
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
