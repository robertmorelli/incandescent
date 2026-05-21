import { getChildNodes } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/analyzer/parseTreeWalker.js';
import { isAliasDeclaration, isClassDeclaration, isFunctionDeclaration, isParamDeclaration, isTypeAliasDeclaration, isTypeParamDeclaration } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/analyzer/declaration.js';
import type { Analysis, Collector, DefinitionInfo, ParseNode, Range, Role } from './defs.ts';
import { child, NODE, node_kind, nodes, print_type, read_name } from './utility.ts';

// Decl kinds whose *defining name token* shouldn't be counted as a read or write
// of the declared thing — the token IS the declaration, not an event on it.
// (Variables are deliberately excluded: `x = 10` IS a write to x.)
function is_decl_name_not_use(decl: any): boolean {
    return isParamDeclaration(decl)
        || isTypeParamDeclaration(decl)
        || isTypeAliasDeclaration(decl)
        || isFunctionDeclaration(decl)
        || isClassDeclaration(decl)
        || isAliasDeclaration(decl);
}

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
    // Fail closed: type information comes from Pyright only. If Pyright does not
    // know, Incandescent does not guess.
    return pyright_type(a.evaluator, n);
}

export type DeclInfo = Omit<DefinitionInfo, 'id'> & { decl: any };

export function pyright_decl(a: Analysis, n: ParseNode): DeclInfo | undefined {
    try {
        const fact = a.facts.getDefinitionForNode(n);
        if (!fact) return undefined;
        const range = fact.range ? a.offsetAt(fact.range) : { start: fact.start, end: fact.end };
        return {
            decl: fact.decl,
            name: fact.name,
            start: range.start,
            end: range.end,
            type: fact.type ? print_type(a.evaluator, fact.type) : undefined,
        };
    } catch {
        return undefined;
    }
}

// --- Read/write split ------------------------------------------------------

// For a write use, return the range of the *assigned value* (rightExpr) — that's what the
// write actually produces. Falls back to undefined for bare annotations / dels / for-targets.
export function write_value_range(a: Analysis, useNode: ParseNode): { start: number; end: number } | undefined {
    const valueNode = a.facts.getUsageInfo(useNode).valueNode as any;
    return valueNode ? { start: valueNode.start, end: valueNode.start + valueNode.length } : undefined;
}

// True when `useNode` sits at the call-target position of a Call expression.
// Covers: the Call node itself, a Name as Call.leftExpr, a Name as MemberAccess.member of
// (possibly nested) MemberAccess that's the leftExpr of a Call, and the MemberAccess(es)
// themselves. Reads of `obj` in `obj.method()` still return false — they're real reads.
// --- Ties (override chains across MRO) -------------------------------------

export function compute_ties(a: Analysis, def_by_decl: Map<object, DefinitionInfo>): Map<number, number[]> {
    const ties = new Map<number, Set<number>>();
    const link = (x: number, y: number) => {
        if (x === y) return;
        if (!ties.has(x)) ties.set(x, new Set());
        if (!ties.has(y)) ties.set(y, new Set());
        ties.get(x)!.add(y);
        ties.get(y)!.add(x);
    };

    const cls = classes(a);
    for (const c of cls) {
        for (const pair of (a.facts.getOverridePairs(c.type) as any[])) {
            const myDecl = pair.derivedDecl;
            const aDecl = pair.baseDecl;
            const myDef = def_by_decl.get(myDecl);
            const aDef = def_by_decl.get(aDecl);
            if (myDef && aDef) link(myDef.id, aDef.id);
            // Pyright-side facts provide parameter declaration correspondences;
            // downstream only maps those declaration objects to visualizer ids.
            for (const pp of pair.parameterPairs ?? []) {
                const mpDef = def_by_decl.get(pp.derivedParamDecl);
                const apDef = def_by_decl.get(pp.baseParamDecl);
                if (mpDef && apDef) link(mpDef.id, apDef.id);
            }
        }
    }

    const out = new Map<number, number[]>();
    for (const [id, set] of ties) out.set(id, [...set]);
    return out;
}

// --- Payloads for the fan-out walk ----------------------------------------

export type UsePayload = {
    definition: DefinitionInfo;
    name: string;
    type?: string;
    node: ParseNode;
    mode: 'read' | 'write' | 'decl' | 'call';
    write_value_range?: { start: number; end: number };
};

// A Name that is the `.member` of a MemberAccess is redundant — the MemberAccess itself
// already records the use with the same definition.
function is_redundant_member_name(useNode: ParseNode): boolean {
    if (node_kind(useNode) !== 'Name') return false;
    const parent: any = (useNode as any).parent;
    return !!parent && node_kind(parent) === 'MemberAccess' && parent.d?.member === useNode;
}

// True when `useNode` is the very name token that declares `decl`, and `decl` is the kind
// where that token isn't a read or write of the declared thing (function/class/parameter/etc.).
function is_pure_decl_token(useNode: ParseNode, decl: any): boolean {
    if (!decl || !is_decl_name_not_use(decl)) return false;
    if (decl.node === useNode) return true;
    const declNameNode = decl.node?.d?.name;
    return declNameNode === useNode;
}

export function make_payloads(
    definitions: Map<object, DefinitionInfo>,
    roles: Map<number, Role>,
): Record<string, Collector['payload']> {
    let nextId = definitions.size;
    return {
        highlights: (node, target) => ({ kind: node_kind(node), node: target }),

        expression_types: (_node, target, a) => {
            const typ = pyright_type_with_recovery(a, target);
            if (!typ) return undefined;
            return { type: typ, node: target };
        },

        identifier_uses: (_node, target, a) => {
            if (is_redundant_member_name(target)) return undefined;
            const info = pyright_decl(a, target);
            if (!info) return undefined;
            let definition = definitions.get(info.decl);
            if (!definition) {
                definition = { id: nextId++, name: info.name, start: info.start, end: info.end, type: info.type };
                definitions.set(info.decl, definition);
                const role = a.facts.getDeclarationRole(info.decl) as Role | undefined;
                if (role) roles.set(definition.id, role);
            }
            const typ = pyright_type_with_recovery(a, target);
            if (typ && !definition.type) definition.type = typ;
            const usage = a.facts.getUsageInfo(target);
            const mode: 'read' | 'write' | 'decl' | 'call' =
                usage.kind === 'call' ? 'call'
                    : is_pure_decl_token(target, info.decl) ? 'decl'
                    : usage.kind === 'write' ? 'write'
                    : 'read';
            const payload: UsePayload = { definition, name: definition.name, type: typ, node: target, mode };
            if (mode === 'write') {
                const rhs = write_value_range(a, target);
                if (rhs) payload.write_value_range = rhs;
            }
            return payload;
        },
    };
}
