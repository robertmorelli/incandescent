import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { create_analysis_session } from '../incandescent.ts';
import { nodes, node_kind } from '../utility.ts';

const session = () => create_analysis_session();
const textOf = (src: string, r: { start: number; end?: number; length?: number }) => src.slice(r.start, r.end ?? r.start + (r.length ?? 0));

function callsIn(a: any) {
    return [...nodes(a.root)].map(({ node }) => node).filter((n: any) => node_kind(n) === 'Call');
}

describe('pyrightification guardrails', () => {
    test('downstream collectors do not reintroduce semantic fallbacks', () => {
        const downstream = [
            readFileSync(new URL('../collectors.ts', import.meta.url), 'utf8'),
            readFileSync(new URL('../incandescent.ts', import.meta.url), 'utf8'),
        ].join('\n');

        expect(downstream).not.toContain('recover_closed_world_member_type');
        expect(downstream).not.toContain('find_dunder_decl');
        expect(downstream).not.toContain('getCallArgsMapping(callNode)');
        expect(downstream).not.toContain('Fallback for');
        expect(downstream).not.toContain('manual arg');
    });
});

describe('pyrightification facts', () => {
    test('N2/N3 usage facts classify reads, writes, calls, destructuring, patterns', () => {
        const src = `class C:\n    def m(self): pass\n\ndef f(c: C):\n    a,b = x,y\n    c.m()\n    match c:\n        case [p, q]: pass\n`;
        const trees = session().collect_trees(src);
        const rows = [...trees.identifier_uses.ranges_by_id.values()].map((r: any) => ({
            text: textOf(src, r),
            name: r.payload.name,
            mode: r.payload.mode,
            value: r.payload.write_value_range ? textOf(src, r.payload.write_value_range) : undefined,
        }));

        expect(rows).toContainEqual(expect.objectContaining({ text: 'a', name: 'a', mode: 'write', value: 'x' }));
        expect(rows).toContainEqual(expect.objectContaining({ text: 'b', name: 'b', mode: 'write', value: 'y' }));
        expect(rows).toContainEqual(expect.objectContaining({ text: 'c.m', name: 'm', mode: 'call' }));
        expect(rows).toContainEqual(expect.objectContaining({ text: 'c', name: 'c', mode: 'read' }));
        expect(rows).toContainEqual(expect.objectContaining({ text: 'p', name: 'p', mode: 'write', value: 'c' }));
        expect(rows).toContainEqual(expect.objectContaining({ text: 'q', name: 'q', mode: 'write', value: 'c' }));
    });

    test('N4 call facts resolve constructors, callable instances, and arg maps through Pyright', () => {
        const src = `class C:\n    def __init__(self, x: int): pass\n    def __call__(self, y: int, *args: int, **kw: int): return y\n\ndef f():\n    c = C(1)\n    return c(2, 3, z=4)\n`;
        const a = session().analyze(src);
        const calls = callsIn(a);
        const byText = new Map(calls.map((n: any) => [textOf(src, n), n]));

        expect(a.facts.getCallInfo(byText.get('C(1)')).declarations[0]?.node?.d?.name?.d?.value).toBe('__init__');
        expect(a.facts.getCallInfo(byText.get('c(2, 3, z=4)')).declarations[0]?.node?.d?.name?.d?.value).toBe('__call__');

        const callInfo = a.facts.getCallInfo(byText.get('c(2, 3, z=4)'));
        expect(callInfo.returnType).toBeTruthy();
        expect(callInfo.calleeType).toBeTruthy();
        expect(callInfo.argMap.map((m: any) => [m.paramName, textOf(src, m.argExpr), m.paramDecl?.node?.d?.name?.d?.value])).toEqual([
            ['y', '2', 'y'],
            ['args', '3', 'args'],
            ['z', '4', 'kw'],
        ]);
    });

    test('N5 implicit and builtin protocol calls carry Pyright declarations and result types', () => {
        const src = `class C:\n    def __add__(self, other): return self\n    def __len__(self): return 1\n\ndef f(a: C, b: C):\n    return len(a + b)\n`;
        const a = session().analyze(src);
        const binary = [...nodes(a.root)].map(({ node }) => node).find((n: any) => node_kind(n) === 'BinaryOperation') as any;
        const lenCall = callsIn(a).find((n: any) => textOf(src, n) === 'len(a + b)') as any;

        const implicit = a.facts.getImplicitCalls(binary);
        expect(implicit[0].method).toBe('__add__');
        expect(implicit[0].declaration?.node?.d?.name?.d?.value).toBe('__add__');
        expect(implicit[0].resultType).toBeTruthy();
        expect(implicit[0].argMap.map((m: any) => [textOf(src, m.argExpr), m.paramDecl?.node?.d?.name?.d?.value])).toEqual([
            ['b', 'other'],
        ]);

        const builtin = a.facts.getBuiltinProtocolCalls(lenCall);
        expect(builtin[0].method).toBe('__len__');
        expect(builtin[0].declaration?.node?.d?.name?.d?.value).toBe('__len__');
        expect(builtin[0].resultType).toBeTruthy();
    });

    test('N6 override facts include method and parameter declaration pairs', () => {
        const src = `class A:\n    def f(self, x): return x\nclass B(A):\n    def f(self, x): return x\n`;
        const a = session().analyze(src);
        const classNodes = [...nodes(a.root)].map(({ node }) => node).filter((n: any) => node_kind(n) === 'Class') as any[];
        const bType = a.evaluator.getTypeOfClass(classNodes[1]).classType;
        const pairs = a.facts.getOverridePairs(bType);
        const fPair = pairs.find((p: any) => p.derivedDecl?.node?.d?.name?.d?.value === 'f');
        expect(fPair).toBeTruthy();
        expect(fPair.parameterPairs.map((p: any) => [p.derivedParamDecl.node.d.name.d.value, p.baseParamDecl.node.d.name.d.value])).toEqual([
            ['self', 'self'],
            ['x', 'x'],
        ]);
    });

    test('D2/D3 starred destructuring and imports are Pyright-side write bindings', () => {
        const src = `a,*b,c = x,y,z,w\nd,*e,f = xs\nimport os\nimport pkg.sub as ps\nfrom sys import path\nfrom sys import version as ver\n`;
        const trees = session().collect_trees(src);
        const rows = [...trees.identifier_uses.ranges_by_id.values()].map((r: any) => ({
            text: textOf(src, r),
            name: r.payload.name,
            mode: r.payload.mode,
            value: r.payload.write_value_range ? textOf(src, r.payload.write_value_range) : undefined,
        }));
        expect(rows).toContainEqual(expect.objectContaining({ text: 'a', name: 'a', mode: 'write', value: 'x' }));
        expect(rows).toContainEqual(expect.objectContaining({ text: 'b', name: 'b', mode: 'write', value: 'y,z' }));
        expect(rows).toContainEqual(expect.objectContaining({ text: 'c', name: 'c', mode: 'write', value: 'w' }));
        expect(rows).toContainEqual(expect.objectContaining({ text: 'd', name: 'd', mode: 'write', value: 'xs' }));
        expect(rows).toContainEqual(expect.objectContaining({ text: 'e', name: 'e', mode: 'write', value: 'xs' }));
        expect(rows).toContainEqual(expect.objectContaining({ text: 'f', name: 'f', mode: 'write', value: 'xs' }));
        expect(rows).toContainEqual(expect.objectContaining({ text: 'os', name: 'os', mode: 'write' }));
        expect(rows).toContainEqual(expect.objectContaining({ text: 'ps', name: 'ps', mode: 'write' }));
        expect(rows).toContainEqual(expect.objectContaining({ text: 'path', name: 'path', mode: 'write' }));
        expect(rows).toContainEqual(expect.objectContaining({ text: 'ver', name: 'ver', mode: 'write' }));
    });

    test('N7 return facts filter unreachable returns and expose inferred return type', () => {
        const src = `def f(flag: bool):\n    if flag:\n        return 1\n    return 2\n    return 'dead'\n`;
        const a = session().analyze(src);
        const fn = [...nodes(a.root)].map(({ node }) => node).find((n: any) => node_kind(n) === 'Function') as any;
        const info = a.facts.getReturnInfo(fn);
        expect(info.expressions.map((r: any) => textOf(src, r))).toEqual(['1', '2']);
        expect(info.inferredReturnType).toBeTruthy();
    });

    test('definition facts are Pyright-side', () => {
        const src = `def f(x: int):\n    return x\ny = f(1)\n`;
        const a = session().analyze(src);
        const call = callsIn(a).find((n: any) => textOf(src, n) === 'f(1)') as any;
        const fact = a.facts.getDefinitionForNode(call.d.leftExpr);
        expect(fact.name).toBe('f');
        expect(textOf(src, a.offsetAt(fact.range))).toBe('f');
        expect(fact.type).toBeTruthy();
    });

    test('declaration role facts are Pyright-side', () => {
        const src = `x = 1\nclass C:\n    y = 2\n    def m(self, p):\n        z = p\ndef f(q):\n    r = q\n`;
        const a = session().analyze(src);
        const roles = [...a.facts.getAnnotationOwners ? [] : []];
        const declRoles: Record<string, string | undefined> = {};
        for (const tree of [session().collect_trees(src)]) {
            for (const r of tree.identifier_definitions.ranges_by_id.values() as any) {
                declRoles[r.payload.name] ??= tree.backmaps.role_by_id.get(r.payload.definition.id);
            }
        }
        expect(declRoles.x).toBe('global');
        expect(declRoles.y).toBe('member');
        expect(declRoles.m).toBe('method_return');
        expect(declRoles.self).toBe('method_param');
        expect(declRoles.p).toBe('method_param');
        expect(declRoles.f).toBe('function_return');
        expect(declRoles.q).toBe('function_param');
        expect(declRoles.r).toBe('local');
    });

    test('annotation owner facts are Pyright-side and warmed', () => {
        const src = `def f(x: int) -> str:\n    y: float = 1.0\n    return str(x)\n`;
        const a = session().analyze(src);
        const owners = a.facts.getAnnotationOwners(a.root).map((o: any) => [textOf(src, o.annotation), o.ownerDecl?.node?.d?.name?.d?.value ?? o.ownerDecl?.node?.d?.value]);
        expect(owners).toEqual([
            ['str', 'f'],
            ['int', 'x'],
            ['float', 'y'],
        ]);
    });

    test('D1 facts are warmed and cached during analysis creation', () => {
        const a = session().analyze('def f(x):\n    return x + 1\ny = f(2)\n');
        const before = a.facts.stats();
        expect(before.usages).toBeGreaterThan(0);
        expect(before.calls).toBeGreaterThan(0);
        expect(before.returns).toBeGreaterThan(0);
        const after = a.facts.stats();
        expect(after).toEqual(before);
    });

    test('D5 return facts include async, generator, implicit None, and NoReturn facts', () => {
        const src = `from typing import NoReturn\nasync def af():\n    return 1\nasync def ag():\n    yield 1\ndef g():\n    yield 1\n    yield from xs\ndef maybe(flag: bool):\n    if flag:\n        return 1\ndef die() -> NoReturn:\n    raise RuntimeError()\n`;
        const a = session().analyze(src);
        const fns = [...nodes(a.root)].map(({ node }) => node).filter((n: any) => node_kind(n) === 'Function') as any[];
        const asyncInfo = a.facts.getReturnInfo(fns[0]);
        const asyncGenInfo = a.facts.getReturnInfo(fns[1]);
        const genInfo = a.facts.getReturnInfo(fns[2]);
        const maybeInfo = a.facts.getReturnInfo(fns[3]);
        const dieInfo = a.facts.getReturnInfo(fns[4]);
        expect(asyncInfo.isAsync).toBe(true);
        expect(asyncInfo.isGenerator).toBe(false);
        expect(asyncInfo.isAsyncGenerator).toBe(false);
        expect(asyncInfo.expressions.map((r: any) => textOf(src, r))).toEqual(['1']);
        expect(asyncGenInfo.isAsync).toBe(true);
        expect(asyncGenInfo.isGenerator).toBe(true);
        expect(asyncGenInfo.isAsyncGenerator).toBe(true);
        expect(genInfo.isAsync).toBe(false);
        expect(genInfo.isGenerator).toBe(true);
        expect(genInfo.yields.map((r: any) => textOf(src, r))).toEqual(['1']);
        expect(genInfo.yieldFroms.map((r: any) => textOf(src, r))).toEqual(['xs']);
        expect(maybeInfo.hasImplicitNone).toBe(true);
        expect(dieInfo.isNoReturn).toBe(true);
    });
});
