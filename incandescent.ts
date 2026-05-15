import { getChildNodes } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/analyzer/parseTreeWalker.js';
import { AnalyzerService } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/analyzer/service.js';
import { ConfigOptions } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/common/configOptions.js';
import { NullConsole } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/common/console.js';
import { FullAccessHost } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/common/fullAccessHost.js';
import { createFromRealFileSystem } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/common/realFileSystem.js';
import { createServiceProvider } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/common/serviceProviderExtensions.js';
import { UriEx } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/common/uri/uriUtils.js';
import { ParseNodeTypeNameMap } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/parser/parseNodeUtils.js';
import { PyrightFileSystem } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/pyrightFileSystem.js';
import type { DefinitionInfo, NodeInfo, ParseNode, SourceInfo, WalkCallback } from './defs.ts';
import { EXPRESSION_NODE_TYPES, HIGHLIGHT_NODE_TYPES, PrioritySegTree, USE_NODE_TYPES, type seg_item } from './utility.ts';

type Analysis = {
    sourceText: string;
    root: ParseNode;
    evaluator: any;
    diagnostics: unknown[];
    offsetAt: (range: any) => { start: number; end: number };
};

export type BackMaps = {
    uses_by_definition_id: Map<number, seg_item[]>;
    args_by_parameter_id: Map<number, seg_item[]>;
    expressions_by_type: Map<string, seg_item[]>;
};

export type TreeMap = {
    highlights: PrioritySegTree;
    expression_types: PrioritySegTree;
    identifier_definitions: PrioritySegTree;
    identifier_uses: PrioritySegTree;
    lines: PrioritySegTree;
    line_to_char_range: Map<number, { start: number; end: number }>;
    backmaps: BackMaps;
};

export function analyzeSource(sourceText: string): SourceInfo {
    const analysis = analyze_with_pyright(sourceText);
    return { parseResults: { parserOutput: { parseTree: analysis.root } }, diagnostics: analysis.diagnostics, nodes: collectNodes(analysis.root, sourceText) };
}

export function parseSource(sourceText: string) {
    return { parserOutput: { parseTree: analyze_with_pyright(sourceText).root } };
}

export function walkAst(root: ParseNode, callback: WalkCallback): void {
    const visit = (node: ParseNode, depth: number, parent: ParseNode | undefined) => {
        if (callback(node, { depth, parent }) === false) return;
        for (const child of getChildNodes(node) as Array<ParseNode | undefined>) if (child) visit(child, depth + 1, node);
    };
    visit(root, 0, undefined);
}

export function collect_trees(sourceText: string): TreeMap {
    const a = analyze_with_pyright(sourceText);
    const highlights = collect_highlights(a.root);
    const expression_types = collect_expression_types(a);
    const { definitions, identifier_definitions, identifier_uses } = collect_identifier_tables(a);
    const { lines, line_to_char_range } = collect_lines(sourceText);
    return {
        highlights,
        expression_types,
        identifier_definitions,
        identifier_uses,
        lines,
        line_to_char_range,
        backmaps: {
            uses_by_definition_id: group_ranges(identifier_uses, r => r.payload.definition?.id),
            args_by_parameter_id: collect_parameter_args(a, definitions),
            expressions_by_type: group_ranges(expression_types, r => r.payload.type),
        },
    };
}

export function collect_highlights(root: ParseNode): PrioritySegTree {
    const ranges: seg_item[] = [];
    walkAst(root, (node, ctx) => {
        const kind = node_kind(node);
        if (HIGHLIGHT_NODE_TYPES.has(kind)) ranges.push({ start: node.start, end: node.start + node.length, height: ctx.depth, payload: { kind, node }, id: ranges.length });
    });
    return new PrioritySegTree(ranges);
}

export function collect_expression_types(a: Analysis): PrioritySegTree {
    const ranges: seg_item[] = [];
    walkAst(a.root, (node, ctx) => {
        if (!EXPRESSION_NODE_TYPES.has(node_kind(node))) return;
        const type = pyright_type(a.evaluator, node);
        if (type) ranges.push({ start: node.start, end: node.start + node.length, height: ctx.depth, payload: { type, node }, id: ranges.length });
    });
    return new PrioritySegTree(ranges);
}

export function collect_identifier_definitions(definitions: Map<string, DefinitionInfo>): PrioritySegTree {
    return new PrioritySegTree([...definitions.values()].map((d, id): seg_item => ({ start: d.start, end: d.end, height: 0, payload: { definition: d, name: d.name, type: d.type, node: {} as ParseNode }, id })));
}

export function collect_identifier_uses(a: Analysis, definitions = new Map<string, DefinitionInfo>()): PrioritySegTree {
    return collect_identifier_tables(a, definitions).identifier_uses;
}

export function collect_lines(sourceText: string): { lines: PrioritySegTree; line_to_char_range: Map<number, { start: number; end: number }> } {
    const ranges: seg_item[] = [], line_to_char_range = new Map<number, { start: number; end: number }>();
    let start = 0, line = 1;
    for (let i = 0; i <= sourceText.length; i++) if (i === sourceText.length || sourceText[i] === '\n') {
        line_to_char_range.set(line, { start, end: i });
        ranges.push({ start, end: i, height: 0, payload: { name: String(line), node: {} as ParseNode }, id: line - 1 });
        start = i + 1; line++;
    }
    return { lines: new PrioritySegTree(ranges), line_to_char_range };
}

export function buildSourceAnnotationTree(sourceText: string): PrioritySegTree { return collect_trees(sourceText).expression_types; }
export function buildSourceDefinitionTree(sourceText: string): PrioritySegTree { return collect_trees(sourceText).identifier_uses; }

function analyze_with_pyright(sourceText: string): Analysis {
    const console = new NullConsole();
    const fs = new PyrightFileSystem(createFromRealFileSystem(undefined, console));
    const sp = createServiceProvider(fs, console);
    const cwd = typeof process !== 'undefined' && process.cwd ? process.cwd() : '/';
    const root = UriEx.file(cwd, sp);
    const configOptions = new ConfigOptions(root);
    configOptions.typeshedPath = UriEx.file(`${cwd}/pyright/packages/pyright-internal/typeshed-fallback`, sp);
    configOptions.stubPath = UriEx.file(`${cwd}/stubs`, sp);
    configOptions.defaultExtraPaths = [UriEx.file(`${cwd}/stubs`, sp)];
    configOptions.useLibraryCodeForTypes = true;
    configOptions.indexing = true;

    const service = new AnalyzerService('incandescent', sp, {
        console,
        hostFactory: () => new FullAccessHost(sp),
        configOptions,
        shouldRunAnalysis: () => true,
    });

    const uri = UriEx.file(`${cwd}/__incandescent_input.py`, sp);
    service.setFileOpened(uri, 1, sourceText);
    let guard = 0;
    while (service.test_program.analyze() && guard++ < 1000) {}

    const sourceFile = service.test_program.getBoundSourceFile(uri);
    const parseResults = sourceFile.getParseResults();
    const lines = line_starts(sourceText);
    return {
        sourceText,
        root: parseResults.parserOutput.parseTree,
        evaluator: service.test_program.evaluator,
        diagnostics: sourceFile.getDiagnostics?.() ?? [],
        offsetAt: (range: any) => ({ start: offset_of(lines, range.start.line, range.start.character), end: offset_of(lines, range.end.line, range.end.character) }),
    };
}

function collect_identifier_tables(a: Analysis, known = new Map<string, DefinitionInfo>()) {
    const definitions = known.size ? known : new Map<string, DefinitionInfo>();
    const identifier_uses: seg_item[] = [];
    let nextId = definitions.size;

    walkAst(a.root, (node, ctx) => {
        if (!USE_NODE_TYPES.has(node_kind(node))) return;
        const decl = pyright_decl(a, node);
        if (!decl) return;
        const key = `${decl.start}:${decl.end}:${decl.name}`;
        if (!definitions.has(key)) definitions.set(key, { id: nextId++, ...decl });
        const definition = definitions.get(key)!;
        const type = pyright_type(a.evaluator, node);
        if (type && !definition.type) definition.type = type;
        identifier_uses.push({ start: node.start, end: node.start + node.length, height: ctx.depth, payload: { definition, name: definition.name, type, node }, id: identifier_uses.length });
    });

    return { definitions, identifier_definitions: collect_identifier_definitions(definitions), identifier_uses: new PrioritySegTree(identifier_uses) };
}

function pyright_type(evaluator: any, node: ParseNode): string | undefined {
    try {
        const result = evaluator.getTypeOfExpression?.(node) ?? evaluator.getType?.(node);
        const type = result?.type ?? result;
        return type ? evaluator.printType(type, { enforcePythonSyntax: true, printUnknownWithAny: true, omitTypeArgsIfUnknown: false }) : undefined;
    } catch { return undefined; }
}

function pyright_decl(a: Analysis, node: ParseNode): Omit<DefinitionInfo, 'id'> | undefined {
    try {
        const nameNode = node_kind(node) === 'Call' ? (node.d as any)?.leftExpr : node_kind(node) === 'MemberAccess' ? (node.d as any)?.member : node;
        if (!nameNode) return undefined;
        const info = a.evaluator.getDeclInfoForNameNode?.(nameNode);
        const decl = info?.decls?.[0];
        if (!decl?.range) return undefined;
        const range = a.offsetAt(decl.range);
        return { name: read_name(nameNode, a.sourceText), start: range.start, end: range.end, type: pyright_type(a.evaluator, node) };
    } catch { return undefined; }
}

function collect_parameter_args(_a: Analysis, _definitions: Map<string, DefinitionInfo>): Map<number, seg_item[]> {
    // Parameter/argument binding belongs to Pyright's call resolver; don't fake it here.
    return new Map();
}

export function collect_hierarchy(sourceText: string) {
    const a = analyze_with_pyright(sourceText);
    const id_to_range = new Map<number, DefinitionInfo>();
    const method_to_all_methods = new Map<number, number[]>();
    const method_param_to_all_method_param = new Map<number, number[]>();
    const instance_variable_to_all_instance_variable = new Map<number, number[]>();
    let id = 0;

    const classes: any[] = [];
    walkAst(a.root, node => {
        if (node_kind(node) !== 'Class') return;
        const result = a.evaluator.getTypeOfClass?.(node);
        if (result?.classType) classes.push({ node, type: result.classType });
    });

    for (const c of classes) {
        const members = c.type?.shared?.mro?.flatMap((x: any) => [...(x?.shared?.fields?.entries?.() ?? [])]) ?? [];
        for (const [name, sym] of members) for (const decl of sym?.getDeclarations?.() ?? []) if (decl.range) {
            const r = a.offsetAt(decl.range);
            const type = sym ? a.evaluator.printType(a.evaluator.getEffectiveTypeOfSymbol(sym), { enforcePythonSyntax: true, printUnknownWithAny: true, omitTypeArgsIfUnknown: false }) : undefined;
            const d = { id: id++, name, start: r.start, end: r.end, type };
            id_to_range.set(d.id, d);
        }
    }

    return {
        instance_variable_to_all_instance_variable,
        method_param_to_all_method_param,
        method_to_all_methods,
        instance_variable_to_first_instance_variable: new Map<number, number>(),
        method_param_to_first_method_param: new Map<number, number>(),
        method_to_first_method: new Map<number, number>(),
        id_to_range,
    };
}

export function decorate_tree(sourceText: string): Map<number, NodeInfo> {
    return new Map(analyzeSource(sourceText).nodes.map((node) => [node.id, node]));
}

function group_ranges<K>(tree: PrioritySegTree, key: (range: seg_item) => K | undefined): Map<K, seg_item[]> {
    const out = new Map<K, seg_item[]>();
    for (const range of tree.ranges_by_id.values()) {
        const k = key(range);
        if (k === undefined) continue;
        out.set(k, [...(out.get(k) ?? []), range]);
    }
    return out;
}

function collectNodes(root: ParseNode, sourceText: string): NodeInfo[] {
    const nodes: NodeInfo[] = [], ids = new WeakMap<ParseNode, number>();
    const ensure = (node: ParseNode) => ids.get(node) ?? (ids.set(node, nodes.length), nodes.push({ id: nodes.length, type: node_kind(node), start: node.start, length: node.length, text: sourceText.slice(node.start, node.start + node.length), children: [] }) - 1);
    walkAst(root, node => { nodes[ensure(node)]!.children = (getChildNodes(node) as Array<ParseNode | undefined>).filter((x): x is ParseNode => !!x).map(ensure); });
    return nodes;
}

function line_starts(s: string) { const out = [0]; for (let i = 0; i < s.length; i++) if (s[i] === '\n') out.push(i + 1); return out; }
function offset_of(starts: number[], line: number, char: number) { return (starts[line] ?? 0) + char; }
const node_kind = (node: ParseNode) => ParseNodeTypeNameMap[node.nodeType] ?? String(node.nodeType);
const read_name = (node: ParseNode | undefined, sourceText: string) => node ? String((node.d as any)?.value ?? sourceText.slice(node.start, node.start + node.length)) : '';
