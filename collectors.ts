import { getChildNodes } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/analyzer/parseTreeWalker.js';
import type { Analysis, Collector, DefinitionInfo, ParseNode, Range, Role } from './defs.ts';
import { CALLABLE_RETURN_RE, child, EMPTY_TYPES, NODE, node_kind, nodes, print_type, read_name } from './utility.ts';

// Pyright DeclarationType numeric values. Pinned to current pyright version.
const DT_VARIABLE       = 1;
const DT_PARAMETER      = 2;
const DT_TYPE_PARAMETER = 3;
const DT_TYPE_ALIAS     = 4;
const DT_FUNCTION       = 5;
const DT_CLASS          = 6;
const DT_ALIAS          = 8;

// Decl types whose *defining name token* shouldn't be counted as a read or write
// of the declared thing — the token IS the declaration, not an event on it.
// (Variable is deliberately excluded: `x = 10` IS a write to x.)
const DECL_NAME_NOT_USE = new Set([
    DT_PARAMETER, DT_TYPE_PARAMETER, DT_TYPE_ALIAS, DT_FUNCTION, DT_CLASS, DT_ALIAS,
]);

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
    return found.size ? [...found].join(' | ') : undefined;
}

export type DeclInfo = Omit<DefinitionInfo, 'id'> & { decl: any };

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

// --- Role classification ---------------------------------------------------

function enclosing_kind(node: ParseNode, ...kinds: string[]): ParseNode | undefined {
    let n: any = node;
    while ((n = n?.parent)) {
        if (kinds.includes(node_kind(n))) return n;
    }
    return undefined;
}

export function classify_role(decl: any): Role | undefined {
    const t = decl?.type;
    const dn = decl?.node;
    if (!dn) return undefined;

    if (t === DT_PARAMETER) {
        const fn = enclosing_kind(dn, 'Function', 'Lambda');
        if (!fn) return undefined;
        return enclosing_kind(fn, 'Class') ? 'method_param' : 'function_param';
    }

    if (t === DT_FUNCTION) {
        return enclosing_kind(dn, 'Class') ? 'method_return' : 'function_return';
    }

    if (t === DT_VARIABLE) {
        if (decl.isDefinedByMemberAccess) return 'member';
        const scope = enclosing_kind(dn, 'Module', 'Class', 'Function', 'Lambda');
        const k = scope ? node_kind(scope) : undefined;
        if (k === 'Module') return 'global';
        if (k === 'Class')  return 'member';
        if (k === 'Function' || k === 'Lambda') return 'local';
        return undefined;
    }

    return undefined;
}

// --- Read/write split ------------------------------------------------------

// For a write use, return the range of the *assigned value* (rightExpr) — that's what the
// write actually produces. Falls back to undefined for bare annotations / dels / for-targets.
export function write_value_range(useNode: ParseNode): { start: number; end: number } | undefined {
    const rangeOf = (n: any) => n ? { start: n.start, end: n.start + n.length } : undefined;
    let cur: any = useNode;
    while (cur) {
        const parent: any = cur.parent;
        if (!parent) return undefined;
        const k = node_kind(parent);
        if (k === 'Assignment' && parent.d?.leftExpr === cur) return rangeOf(parent.d?.rightExpr);
        if (k === 'AugmentedAssignment' && (parent.d?.leftExpr === cur || parent.d?.destExpr === cur)) return rangeOf(parent.d?.rightExpr);
        if (k === 'TypeAnnotation' && parent.d?.valueExpr === cur) {
            const gp: any = parent.parent;
            if (gp && node_kind(gp) === 'Assignment' && gp.d?.leftExpr === parent) return rangeOf(gp.d?.rightExpr);
            return undefined;
        }
        if (k === 'Suite' || k === 'Module' || k === 'Function' || k === 'Class' || k === 'Lambda') return undefined;
        cur = parent;
    }
    return undefined;
}

export function is_write_use(useNode: ParseNode): boolean {
    let cur: any = useNode;
    while (cur) {
        const parent: any = cur.parent;
        if (!parent) return false;
        const k = node_kind(parent);
        if (k === 'Assignment' && parent.d?.leftExpr === cur) return true;
        if (k === 'AugmentedAssignment' && (parent.d?.leftExpr === cur || parent.d?.destExpr === cur)) return true;
        if (k === 'TypeAnnotation' && parent.d?.valueExpr === cur) return true;
        if (k === 'Del') return true;
        if (k === 'Parameter' && parent.d?.name === cur) return true;
        if (k === 'Suite' || k === 'Module' || k === 'Function' || k === 'Class' || k === 'Lambda') return false;
        cur = parent;
    }
    return false;
}

// --- Call resolution + arg→param matching ---------------------------------

// Returns the function/method decl that the call resolves to, if any. `Foo()` redirects to
// Foo's `__init__` (walking the MRO); overloads — any one is fine.
export function resolve_call_target(a: Analysis, callNode: ParseNode): any | undefined {
    const d: any = callNode.d;
    const left = d?.leftExpr;
    if (!left) return undefined;
    const nameNode = node_kind(left) === 'MemberAccess' ? (left.d as any)?.member : left;
    if (!nameNode) return undefined;
    try {
        const info = a.evaluator.getDeclInfoForNameNode?.(nameNode);
        const decls = info?.decls ?? [];
        const funcDecl = decls.find((dd: any) => dd?.type === DT_FUNCTION);
        if (funcDecl) return funcDecl;
        const classDecl = decls.find((dd: any) => dd?.type === DT_CLASS);
        if (classDecl) {
            const result = a.evaluator.getTypeOfClass?.(classDecl.node);
            const ct = result?.classType;
            const mro: any[] = ct?.shared?.mro ?? (ct ? [ct] : []);
            for (const cls of mro) {
                const sym = cls?.shared?.fields?.get?.('__init__');
                if (!sym) continue;
                const init = sym.getDeclarations?.()?.find((dd: any) => dd?.type === DT_FUNCTION);
                if (init) return init;
            }
        }
        return undefined;
    } catch {
        return undefined;
    }
}

function is_method(funcDeclNode: ParseNode): boolean {
    let n: any = funcDeclNode;
    while ((n = n?.parent)) {
        const k = node_kind(n);
        if (k === 'Class')    return true;
        if (k === 'Function' || k === 'Lambda' || k === 'Module') return false;
    }
    return false;
}

// True when `useNode` sits at the call-target position of a Call expression.
// Covers: the Call node itself, a Name as Call.leftExpr, a Name as MemberAccess.member of
// (possibly nested) MemberAccess that's the leftExpr of a Call, and the MemberAccess(es)
// themselves. Reads of `obj` in `obj.method()` still return false — they're real reads.
export function is_call_site(useNode: ParseNode): boolean {
    if (node_kind(useNode) === 'Call') return true;
    let n: any = useNode;
    while (n) {
        const parent: any = n.parent;
        if (!parent) return false;
        const pk = node_kind(parent);
        if (pk === 'Call' && parent.d?.leftExpr === n) return true;
        if (pk === 'MemberAccess' && parent.d?.member === n) { n = parent; continue; }
        return false;
    }
    return false;
}

// Match each argument expression to a parameter node. Positional → param[i]; keyword → param by name;
// overflow into *args / **kwargs paramater when present.
export function match_call_args(callNode: ParseNode, funcDeclNode: ParseNode): { paramNode: ParseNode; argExpr: ParseNode }[] {
    const callArgs: any[] = (callNode.d as any)?.args ?? [];
    const rawParams: any[] = (funcDeclNode.d as any)?.params ?? [];
    // Methods bind `self`/`cls` implicitly — drop the first param when matching call args.
    const params = is_method(funcDeclNode) && rawParams.length ? rawParams.slice(1) : rawParams;
    if (!params.length) return [];

    // Parameter.d.category: 0=Simple, 1=ArgsList(*args), 2=KwargsDict(**kwargs).
    const starIdx   = params.findIndex(p => p?.d?.category === 1);
    const kwargsIdx = params.findIndex(p => p?.d?.category === 2);

    const out: { paramNode: ParseNode; argExpr: ParseNode }[] = [];
    let pos = 0;
    for (const arg of callArgs) {
        const ad: any = arg?.d ?? {};
        const expr: ParseNode = ad.valueExpr ?? arg;
        const isKeyword = !!ad.name;
        if (isKeyword) {
            const argName = (ad.name as any)?.d?.value;
            const namedIdx = params.findIndex((p, i) => i !== kwargsIdx && p?.d?.name?.d?.value === argName);
            if (namedIdx >= 0) out.push({ paramNode: params[namedIdx], argExpr: expr });
            else if (kwargsIdx >= 0) out.push({ paramNode: params[kwargsIdx], argExpr: expr });
            continue;
        }
        // Positional
        if (starIdx >= 0 && pos >= starIdx) {
            out.push({ paramNode: params[starIdx], argExpr: expr });
        } else if (pos < params.length) {
            const p = params[pos];
            if (p?.d?.category !== 1 && p?.d?.category !== 2) {
                out.push({ paramNode: p, argExpr: expr });
            }
        }
        pos++;
    }
    return out;
}

// --- Returns extraction ----------------------------------------------------

export function returns_in_function(funcNode: ParseNode): ParseNode[] {
    const out: ParseNode[] = [];
    const visit = (n: ParseNode) => {
        const k = node_kind(n);
        if (k === 'Function' && n !== funcNode) return;
        if (k === 'Lambda' && n !== funcNode) return;
        if (k === 'Return') {
            const ret = (n.d as any)?.expr;
            if (ret) out.push(ret);
            return;
        }
        if (k === 'Lambda' && n === funcNode) {
            const body = (n.d as any)?.expr;
            if (body) out.push(body);
            return;
        }
        const children = getChildNodes(n) as Array<ParseNode | undefined>;
        for (const c of children) if (c) visit(c);
    };
    visit(funcNode);
    return out;
}

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
    const class_by_type = new Map<any, { node: ParseNode; type: any }>();
    for (const c of cls) class_by_type.set(c.type, c);

    for (const c of cls) {
        const mro: any[] = c.type?.shared?.mro ?? [];
        const myFields = c.type?.shared?.fields;
        if (!myFields) continue;
        for (const [name, sym] of myFields.entries() as Iterable<[string, any]>) {
            const myDecls = sym?.getDeclarations?.() ?? [];
            for (const myDecl of myDecls) {
                const myDef = def_by_decl.get(myDecl);
                if (!myDef) continue;
                for (const ancestor of mro) {
                    if (ancestor === c.type) continue;
                    const aFields = ancestor?.shared?.fields;
                    const aSym = aFields?.get?.(name);
                    if (!aSym) continue;
                    for (const aDecl of aSym?.getDeclarations?.() ?? []) {
                        const aDef = def_by_decl.get(aDecl);
                        if (aDef) link(myDef.id, aDef.id);
                        // For function decls, also pair parameters positionally.
                        if (myDecl?.type === DT_FUNCTION && aDecl?.type === DT_FUNCTION) {
                            const myParams: any[] = (myDecl.node?.d as any)?.params ?? [];
                            const aParams:  any[] = (aDecl.node?.d as any)?.params ?? [];
                            const len = Math.min(myParams.length, aParams.length);
                            for (let i = 0; i < len; i++) {
                                const mp = myParams[i], ap = aParams[i];
                                // Find decl objects for these parameter nodes via their name nodes.
                                const mpd = find_param_decl(a, mp);
                                const apd = find_param_decl(a, ap);
                                const mpDef = mpd ? def_by_decl.get(mpd) : undefined;
                                const apDef = apd ? def_by_decl.get(apd) : undefined;
                                if (mpDef && apDef) link(mpDef.id, apDef.id);
                            }
                        }
                    }
                }
            }
        }
    }

    const out = new Map<number, number[]>();
    for (const [id, set] of ties) out.set(id, [...set]);
    return out;
}

function find_param_decl(a: Analysis, paramNode: any): any | undefined {
    const nameNode = paramNode?.d?.name;
    if (!nameNode) return undefined;
    try {
        return a.evaluator.getDeclInfoForNameNode?.(nameNode)?.decls?.[0];
    } catch { return undefined; }
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

// True when `useNode` is the very name token that declares `decl`, and `decl` is the kind
// where that token isn't a read or write of the declared thing (function/class/parameter/etc.).
function is_pure_decl_token(useNode: ParseNode, decl: any): boolean {
    if (!decl || !DECL_NAME_NOT_USE.has(decl.type)) return false;
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
            const info = pyright_decl(a, target);
            if (!info) return undefined;
            let definition = definitions.get(info.decl);
            if (!definition) {
                definition = { id: nextId++, name: info.name, start: info.start, end: info.end, type: info.type };
                definitions.set(info.decl, definition);
                const role = classify_role(info.decl);
                if (role) roles.set(definition.id, role);
            }
            const typ = pyright_type_with_recovery(a, target);
            if (typ && !definition.type) definition.type = typ;
            const mode: 'read' | 'write' | 'decl' | 'call' =
                is_pure_decl_token(target, info.decl) ? 'decl'
                    : is_call_site(target) ? 'call'
                    : is_write_use(target) ? 'write'
                    : 'read';
            const payload: UsePayload = { definition, name: definition.name, type: typ, node: target, mode };
            if (mode === 'write') {
                const rhs = write_value_range(target);
                if (rhs) payload.write_value_range = rhs;
            }
            return payload;
        },
    };
}
