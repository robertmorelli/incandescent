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

export type WalkCallback = (node: ParseNode, context: WalkContext) => void | boolean;
export type AnnotationCallback = (node: ParseNode, context: WalkContext) => string | undefined;

export interface AnnotationRange {
    id: number;
    start: number;
    end: number;
    priority: number;
    type: string;
    node: ParseNode;
}

export interface DefinitionInfo {
    id: number;
    name: string;
    start: number;
    end: number;
    type?: string;
}
