// WebSocket transport with auto-reconnect and a 30s app-level heartbeat
// (keeps the connection alive across Cloudflare's ~100s idle timeout).

export function connect(url, { onopen, onmessage } = {}) {
    let ws = null;
    let alive = true;
    let pingTimer = null;

    const open = () => {
        ws = new WebSocket(url);
        ws.onopen = () => {
            pingTimer = setInterval(() => {
                if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ kind: 'ping' }));
            }, 30000);
            onopen?.();
        };
        ws.onmessage = e => {
            const msg = JSON.parse(e.data);
            if (msg.kind === 'pong') return;
            onmessage?.(msg);
        };
        ws.onclose = () => {
            clearInterval(pingTimer);
            pingTimer = null;
            if (alive) setTimeout(open, 1000);
        };
        ws.onerror = () => ws?.close();
    };

    open();

    return {
        send(x) {
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(x));
        },
        close() {
            alive = false;
            clearInterval(pingTimer);
            ws?.close();
        },
    };
}
