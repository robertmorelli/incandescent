import { collect_trees, create_analysis_session } from '../incandescent.ts';

const port = Number(process.env.PORT ?? 3000);
const webRoot = new URL('./', import.meta.url);

type SocketData = { source: string; trees: ReturnType<typeof collect_trees> | undefined; session: ReturnType<typeof create_analysis_session> };

function ranges(tree: any) {
    return [...tree.ranges_by_id.values()].map((r: any) => ({
        start: r.start,
        end: r.end,
        height: r.height,
        payload: {
            kind: r.payload.kind,
            type: r.payload.type,
            name: r.payload.name,
            definition: r.payload.definition,
        },
    }));
}

function best(tree: any, spans: [number, number][]) {
    return spans
        .map(([s, e]) => tree.query_max(s, e))
        .filter(Boolean)
        .sort((a: any, b: any) => b.height - a.height)[0];
}

function info(trees: ReturnType<typeof collect_trees>, start: number, end: number) {
    const point = start === end;
    const s = Math.min(start, end), e = Math.max(start, end);
    const spans: [number, number][] = point ? [[start, start + 1], [Math.max(0, start - 1), start]] : [[s, e]];
    const expr = best(trees.expression_types, spans);
    const use = best(trees.identifier_uses, spans);
    return {
        range: point ? { cursor: start } : { start: s, end: e },
        line: trees.lines.query_max(start, point ? start + 1 : end)?.payload.name,
        type: expr?.payload.type,
        definition: use?.payload.definition,
        expression_range: expr ? { start: expr.start, end: expr.end } : undefined,
        found_range: use?.payload.definition ? { start: use.payload.definition.start, end: use.payload.definition.end } : undefined,
    };
}

Bun.serve<SocketData>({
    port,
    hostname: process.env.HOST ?? '127.0.0.1',
    async fetch(req, server) {
        const url = new URL(req.url);

        if (url.pathname === '/ws') {
            return server.upgrade(req, { data: { source: '', trees: undefined, session: create_analysis_session() } })
                ? undefined
                : new Response('upgrade failed', { status: 400 });
        }

        if (url.pathname === '/favicon.ico') return new Response('', { status: 204 });

        const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
        const file = Bun.file(new URL(`.${pathname}`, webRoot));
        if (!(await file.exists())) return new Response('not found', { status: 404 });
        return new Response(file, { headers: { 'cache-control': 'no-store, max-age=0' } });
    },
    websocket: {
        message(ws, raw) {
            const msg = JSON.parse(String(raw));

            if (msg.kind === 'analyze') {
                const t0 = performance.now();
                ws.data.source = msg.source;
                const t1 = performance.now();
                const result = ws.data.session.collect_trees_timed(msg.source);
                ws.data.trees = result.trees;
                const t2 = performance.now();
                const highlights = ranges(ws.data.trees.highlights);
                const t3 = performance.now();
                ws.send(JSON.stringify({
                    kind: 'analyze',
                    seq: msg.seq,
                    client_sent_at: msg.client_sent_at,
                    highlights,
                    timing: {
                        bytes: msg.source.length,
                        server_receive_ms: +(t1 - t0).toFixed(2),
                        service_ms: result.timing.service_ms,
                        tree_build_ms: result.timing.tree_build_ms,
                        total_collect_ms: result.timing.total_collect_ms,
                        server_outer_collect_ms: +(t2 - t1).toFixed(2),
                        serialize_highlights_ms: +(t3 - t2).toFixed(2),
                        server_total_ms: +(t3 - t0).toFixed(2),
                    },
                }));
                return;
            }

            if (msg.kind === 'timing') {
                const t0 = performance.now();
                const trees = ws.data.session.collect_trees(ws.data.source || msg.source || '');
                const t1 = performance.now();
                ws.send(JSON.stringify({ kind: 'timing', timing: { bytes: (ws.data.source || msg.source || '').length, collect_trees_ms: +(t1 - t0).toFixed(2) } }));
                return;
            }

            if (msg.kind === 'info') {
                if (!ws.data.trees) ws.data.trees = ws.data.session.collect_trees(ws.data.source);
                ws.send(JSON.stringify({ kind: 'info', target: msg.target, data: info(ws.data.trees, msg.start, msg.end) }));
            }
        },
    },
});

console.log(`incandescent web demo: http://localhost:${port}`);
