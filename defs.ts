export type ParseNode = { nodeType: number; start: number; length: number; d?: unknown };
export type ParseFileResults = { parserOutput: { parseTree: ParseNode }; [key: string]: unknown };

export interface NodeInfo {
    id: number;
    type: string;
    start: number;
    length: number;
    text: string;
    children: number[];
}

export interface SourceInfo {
    parseResults: ParseFileResults;
    diagnostics: unknown[];
    nodes: NodeInfo[];
}

export interface WalkContext {
    parent: ParseNode | undefined;
    depth: number;
}

export type WalkCallback = (node: ParseNode, context: WalkContext) => void;