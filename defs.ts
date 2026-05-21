export type ParseNode = {
    nodeType: number;
    start: number;
    length: number;
    d?: unknown;
};

export interface NodeInfo {
    id: number;
    type: string;
    start: number;
    length: number;
    text: string;
    children: number[];
}

export interface DefinitionInfo {
    id: number;
    name: string;
    start: number;
    end: number;
    type?: string;
}

export type NodeBehavior = {
    isExpression?: boolean;
    isUse?: boolean;
    isClass?: boolean;
    highlightChild?: (d: any) => any;
    nameChild?: (d: any) => any;
    baseChild?: (d: any) => any;
};

export type SegPayload = {
    type?: string;
    definition?: DefinitionInfo;
    name?: string;
    kind?: string;
    node: ParseNode;
};

export type SegItem = {
    start: number;
    end: number;
    height: number;
    payload: SegPayload;
    id: number;
};

export type Seg = Omit<SegItem, 'id'>;

export type Emit<I> = (item: I) => Seg | undefined;

export type NodeItem  = { node: ParseNode; depth: number };
export type TokenItem = { start: number; end: number; height: number; kind: string };
export type LineItem  = { start: number; end: number; line: number };

export type Analysis = {
    sourceText: string;
    root: ParseNode;
    parseResults: any;
    evaluator: any;
    facts: any;
    diagnostics: unknown[];
    offsetAt: (range: any) => { start: number; end: number };
};

export type Role =
    | 'function_param'
    | 'method_param'
    | 'function_return'
    | 'method_return'
    | 'local'
    | 'member'
    | 'global';

export type Range = { start: number; end: number };

// The id-keyed tables below are *reflowed* across tied annotations: every id in
// the same tie-equivalence class (e.g. a method's params across override chains)
// sees the union of its class's entries, so a consumer can look up any id and
// get the whole linked picture. `tied_to_id[id]` is the full equivalence class
// minus self.
export type BackMaps = {
    uses_by_definition_id: Map<number, SegItem[]>;
    expressions_by_type: Map<string, SegItem[]>;

    role_by_id:             Map<number, Role>;
    reads_by_id:            Map<number, SegItem[]>;
    writes_by_id:           Map<number, SegItem[]>;
    args_by_parameter_id:   Map<number, Range[]>;
    calls_by_function_id:   Map<number, Range[]>;
    returns_by_function_id: Map<number, Range[]>;
    indexed_by_id:          Map<number, Range[]>;
    tied_to_id:             Map<number, number[]>;
};

export type Collector = {
    key: keyof NodeBehavior;
    height_base?: number;
    payload: (node: ParseNode, target: ParseNode, a: Analysis) => SegPayload | undefined;
};
