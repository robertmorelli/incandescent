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

// --- Annotation context / type-kind / literal classifiers -----------------

const CINDER_SCALAR_NAMES = new Set([
    '__static__.int64', '__static__.int32', '__static__.int16', '__static__.int8',
    '__static__.uint64', '__static__.uint32', '__static__.uint16', '__static__.uint8',
    '__static__.double', '__static__.float64', '__static__.float32', '__static__.cbool',
]);
const CINDER_CHECKED_NAMES = new Set(['__static__.CheckedList', '__static__.CheckedDict']);
const PYTHON_SCALAR_NAMES = new Set(['builtins.int', 'builtins.float', 'builtins.bool', 'builtins.str', 'builtins.bytes']);
const PYTHON_CONTAINER_NAMES = new Set(['builtins.list', 'builtins.dict', 'builtins.set', 'builtins.frozenset']);
const ITERATOR_NAMES = new Set(['typing.Iterator', 'typing.Generator', 'typing.Iterable']);

function full_name(typ: any): string | undefined {
    return typ?.shared?.fullName;
}

const NONE_NAMES = new Set(['builtins.NoneType', 'types.NoneType']);

function is_none_instance(typ: any): boolean {
    if (typ?.category !== 6 /* Class */) return false;
    const fn = full_name(typ);
    return !!fn && NONE_NAMES.has(fn);
}

export function classify_type_kind(typ: any): string {
    if (!typ) return 'dynamic_unknown';
    const cat = typ.category;
    if (cat === 1 /* Unknown */ || cat === 2 /* Any */) return 'dynamic_unknown';
    if (cat === 4 /* Function */ || cat === 5 /* Overloaded */) return 'callable';
    if (cat === 8 /* Union */) {
        const subs: any[] = typ.priv?.subtypes ?? [];
        if (subs.some(is_none_instance)) return 'optional';
        return 'union';
    }
    if (cat === 6 /* Class */) {
        const fn = full_name(typ);
        if (fn && NONE_NAMES.has(fn)) return 'none_only';
        if (fn && CINDER_SCALAR_NAMES.has(fn)) return 'cinder_scalar';
        if (fn && CINDER_CHECKED_NAMES.has(fn)) return 'cinder_checked_container';
        if (fn && PYTHON_SCALAR_NAMES.has(fn)) return 'python_scalar';
        if (fn && PYTHON_CONTAINER_NAMES.has(fn)) return 'python_container';
        if (fn === 'builtins.tuple') return 'python_tuple';
        if (fn && ITERATOR_NAMES.has(fn)) return 'iterator';
        return 'python_user_object';
    }
    return 'python_user_object';
}

// Print an annotation's resolved type, or '' if Pyright leaks Any/Unknown.
//
// We try getTypeOfAnnotation first because it correctly interprets annotation
// expressions (e.g. `int | None` becomes a Union of instances). If that comes
// back as Unknown/Any/Unbound, fall back to getTypeOfExpression — pyright may
// have indexed the symbol even when annotation interpretation flaked.
function annotation_type_object(a: Analysis, annotation: ParseNode): any | undefined {
    const isUseful = (t: any) =>
        t && t.category !== 0 /* Unbound */ && t.category !== 1 /* Unknown */ && t.category !== 2 /* Any */;
    let typ: any;
    try { typ = a.evaluator.getTypeOfAnnotation?.(annotation as any); } catch {}
    if (isUseful(typ)) return typ;
    let alt: any;
    try { alt = a.evaluator.getTypeOfExpression?.(annotation as any)?.type; } catch {}
    if (isUseful(alt)) return alt;
    return typ ?? alt;
}

export function printed_annotation_type(a: Analysis, annotation: ParseNode): { type: any; printed: string } {
    const typ = annotation_type_object(a, annotation);
    if (!typ) return { type: undefined, printed: '' };
    const kind = classify_type_kind(typ);
    if (kind === 'dynamic_unknown') return { type: typ, printed: '' };
    let printed = '';
    try { printed = print_type(a.evaluator, typ); } catch {}
    return { type: typ, printed };
}

function enclosing(node: ParseNode | undefined, kinds: string[]): ParseNode | undefined {
    let cur: any = node?.parent;
    while (cur) {
        if (kinds.includes(node_kind(cur))) return cur;
        cur = cur.parent;
    }
    return undefined;
}

function fn_name(fn: ParseNode | undefined, source: string): string | undefined {
    const nameNode = (fn as any)?.d?.name;
    return nameNode ? read_name(nameNode, source) : undefined;
}

function is_none_literal_node(node: ParseNode | undefined, source: string): boolean {
    if (!node) return false;
    if (node_kind(node) !== 'Constant') return false;
    // Match by source text — robust to enum drift.
    return source.slice(node.start, node.start + node.length) === 'None';
}

export function classify_annotation_context(
    annotation: ParseNode,
    source: string,
): string | undefined {
    const parent: any = (annotation as any).parent;
    if (!parent) return undefined;
    const pk = node_kind(parent);

    if (pk === 'Function') {
        // Return annotation.
        const enclClass = enclosing(parent, ['Class']);
        if (!enclClass) return 'function_return_annotation';
        const name = fn_name(parent, source);
        if (name === '__init__') return 'constructor_return_annotation';
        return 'method_return_annotation';
    }
    if (pk === 'Parameter') {
        const fn = enclosing(parent, ['Function', 'Lambda']);
        const enclClass = fn ? enclosing(fn, ['Class']) : undefined;
        if (!fn || !enclClass) return 'function_parameter_annotation';
        const name = fn_name(fn, source);
        if (name === '__init__') return 'constructor_parameter_annotation';
        return 'method_parameter_annotation';
    }
    if (pk === 'TypeAnnotation') {
        const valueExpr = (parent as any).d?.valueExpr;
        const isMember = valueExpr && node_kind(valueExpr) === 'MemberAccess';

        // Determine if the TypeAnnotation has an assigned value.
        let assignedValue: ParseNode | undefined;
        const gp: any = (parent as any).parent;
        if (gp && node_kind(gp) === 'Assignment' && gp.d?.leftExpr === parent) {
            assignedValue = gp.d?.rightExpr;
        }
        const suffix = !assignedValue
            ? '_no_value'
            : is_none_literal_node(assignedValue, source)
                ? '_with_none'
                : '_with_value';

        const fn = enclosing(parent, ['Function', 'Lambda']);
        const cls = enclosing(parent, ['Class']);

        if (isMember) {
            const name = fn ? fn_name(fn, source) : undefined;
            const prefix = name === '__init__'
                ? 'init_instance_variable_annotation'
                : 'non_init_instance_variable_annotation';
            return prefix + suffix;
        }
        if (!fn && !cls) return 'module_global_annotation' + suffix;
        if (!fn && cls) return 'class_attribute_annotation' + suffix;
        // Inside a function (and possibly a class).
        const enclClass = fn ? enclosing(fn, ['Class']) : undefined;
        let word: string;
        if (enclClass) {
            const name = fn_name(fn, source);
            word = name === '__init__' ? 'constructor' : 'method';
        } else {
            word = 'function';
        }
        return `${word}_local_annotation${suffix}`;
    }
    return undefined;
}

// Per-node literal tag. Returns undefined for nodes that aren't expressions
// where a literal/value distinction is meaningful.
const LITERAL_NODE_KINDS = new Set([
    'Constant', 'Number', 'StringList', 'String', 'FormatString', 'Ellipsis',
]);

export function classify_literal(node: ParseNode, source: string): 'literal' | 'none_literal' | 'value' | undefined {
    const k = node_kind(node);
    if (k === 'Constant') {
        return source.slice(node.start, node.start + node.length) === 'None' ? 'none_literal' : 'literal';
    }
    if (LITERAL_NODE_KINDS.has(k)) return 'literal';
    // Mark every other expression node as 'value'. Restrict to nodes Pyright treats as expressions.
    const behavior = (NODE as any)[k];
    if (behavior?.isExpression) return 'value';
    return undefined;
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
