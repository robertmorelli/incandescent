import type { Analysis, Collector, DefinitionInfo, ParseNode } from './defs.ts';
import { CALLABLE_RETURN_RE, child, EMPTY_TYPES, NODE, node_kind, nodes, print_type, read_name } from './utility.ts';

const classes_cache = new WeakMap<Analysis, { node: ParseNode; type: any }[]>();

export function classes(a: Analysis) {
    const cached = classes_cache.get(a);
    if (cached) return cached;
    const out: { node: ParseNode; type: any }[] = [];
    for (const { node } of nodes(a.root)) {
        if (!NODE[node_kind(node)]?.isClass) continue;
        const result = a.evaluator.getTypeOfClass?.(node);
        if (result?.classType) out.push({ node, type: result.classType });
    }
    classes_cache.set(a, out);
    return out;
}

function pyright_type(evaluator: any, node: ParseNode): string | undefined {
    try {
        const result = evaluator.getTypeOfExpression?.(node) ?? evaluator.getType?.(node);
        const typ = result?.type ?? result;
        if (!typ) return undefined;
        return print_type(evaluator, typ);
    } catch {
        return undefined;
    }
}

export function pyright_type_with_recovery(a: Analysis, n: ParseNode): string | undefined {
    const raw = pyright_type(a.evaluator, n);
    if (raw && !EMPTY_TYPES.has(raw)) return raw;
    return recover_closed_world_member_type(a, n) ?? raw;
}

function recover_closed_world_member_type(a: Analysis, n: ParseNode): string | undefined {
    const isCall = node_kind(n) === 'Call';
    const target = isCall ? (n.d as any)?.leftExpr : n;
    if (!target || node_kind(target) !== 'MemberAccess') return undefined;

    const member = child(target, 'nameChild');
    const base = child(target, 'baseChild');
    if (!member || !base) return undefined;

    const baseText = pyright_type(a.evaluator, base);
    const memberName = read_name(member, a.sourceText);
    if (!baseText || !memberName) return undefined;

    const found = new Set<string>();
    for (const c of classes(a)) {
        const names = c.type?.shared?.mro?.map((m: any) => m?.shared?.name).filter(Boolean) ?? [];
        if (!names.includes(baseText)) continue;
        const sym = c.type?.shared?.fields?.get?.(memberName);
        if (!sym) continue;
        try {
            const printed = print_type(a.evaluator, a.evaluator.getEffectiveTypeOfSymbol(sym));
            const recovered = isCall ? (CALLABLE_RETURN_RE.exec(printed)?.[1] ?? printed) : printed;
            if (recovered && !EMPTY_TYPES.has(recovered)) found.add(recovered);
        } catch {}
    }
    if (!found.size) return undefined;
    return [...found].join(' | ');
}

export type DeclInfo = Omit<DefinitionInfo, 'id'> & { decl: object };

export function pyright_decl(a: Analysis, n: ParseNode): DeclInfo | undefined {
    try {
        const nameNode = child(n, 'nameChild') ?? n;
        const info = a.evaluator.getDeclInfoForNameNode?.(nameNode);
        const decl = info?.decls?.[0];
        if (!decl?.range) return undefined;
        const range = a.offsetAt(decl.range);
        return {
            decl,
            name: read_name(nameNode, a.sourceText),
            start: range.start,
            end: range.end,
            type: pyright_type_with_recovery(a, n),
        };
    } catch {
        return undefined;
    }
}

export function make_payloads(definitions: Map<object, DefinitionInfo>): Record<string, Collector['payload']> {
    let nextId = definitions.size;
    return {
        highlights: (node, target) => ({ kind: node_kind(node), node: target }),

        expression_types: (_node, target, a) => {
            const typ = pyright_type_with_recovery(a, target);
            if (!typ) return undefined;
            return { type: typ, node: target };
        },

        identifier_uses: (_node, target, a) => {
            const info = pyright_decl(a, target);
            if (!info) return undefined;
            let definition = definitions.get(info.decl);
            if (!definition) {
                definition = { id: nextId++, name: info.name, start: info.start, end: info.end, type: info.type };
                definitions.set(info.decl, definition);
            }
            const typ = pyright_type_with_recovery(a, target);
            if (typ && !definition.type) definition.type = typ;
            return { definition, name: definition.name, type: typ, node: target };
        },
    };
}
