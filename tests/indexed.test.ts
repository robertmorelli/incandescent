import { describe, expect, test } from 'bun:test';
import { create_analysis_session } from '../incandescent.ts';

const session = () => create_analysis_session();
const textOf = (src: string, r: { start: number; end: number }) => src.slice(r.start, r.end);

function indexedFor(src: string, varName: string) {
    const trees = session().collect_trees(src);
    // Find the definition id for the named variable from identifier_definitions.
    const defs = [...trees.identifier_definitions.ranges_by_id.values()];
    const def = defs.find((d: any) => d.payload.definition?.name === varName);
    if (!def) return { id: undefined, ranges: [], all: trees.backmaps.indexed_by_id };
    const id = def.payload.definition.id;
    const ranges = trees.backmaps.indexed_by_id.get(id) ?? [];
    return { id, ranges, all: trees.backmaps.indexed_by_id };
}

describe('indexed_by_id', () => {
    test('records index expressions keyed to the indexed variable', () => {
        const src = `from typing import List\n\ndef use(f: List[int]):\n    a = 1\n    b = 2\n    x = f[a + b]\n`;
        const { ranges } = indexedFor(src, 'f');
        const texts = ranges.map(r => textOf(src, r));
        expect(texts).toContain('a + b');
    });

    test('records multiple index sites', () => {
        const src = `from typing import List\n\ndef use(f: List[int]):\n    x = f[0]\n    y = f[1 + 2]\n`;
        const { ranges } = indexedFor(src, 'f');
        const texts = ranges.map(r => textOf(src, r));
        expect(texts).toEqual(expect.arrayContaining(['0', '1 + 2']));
    });

    test('does not record indexing keyed to unrelated variables', () => {
        const src = `from typing import List\n\ndef use(f: List[int], g: List[int]):\n    x = f[7]\n`;
        const { ranges } = indexedFor(src, 'g');
        expect(ranges).toEqual([]);
    });

    test('dict-style key expression is recorded', () => {
        const src = `from typing import Dict\n\ndef use(d: Dict[str, int]):\n    k = 'hi'\n    v = d[k]\n`;
        const { ranges } = indexedFor(src, 'd');
        const texts = ranges.map(r => textOf(src, r));
        expect(texts).toContain('k');
    });
});
