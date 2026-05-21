const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? '127.0.0.1';
const webRoot = new URL('./', import.meta.url);

Bun.serve({
    port,
    hostname,
    async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/favicon.ico') return new Response('', { status: 204 });

        const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
        const file = Bun.file(new URL(`.${pathname}`, webRoot));
        if (!(await file.exists())) return new Response('not found', { status: 404 });

        return new Response(file, {
            headers: { 'cache-control': 'no-store, max-age=0' },
        });
    },
});

console.log(`incandescent web demo: http://${hostname === '0.0.0.0' ? 'localhost' : hostname}:${port}`);
