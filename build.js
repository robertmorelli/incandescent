import path from 'path';

const browserGlobals = `
(() => {
  if (typeof globalThis.process === 'undefined') {
    globalThis.process = {
      env: {}, argv: ['browser'], execArgv: [], pid: 1, platform: 'browser',
      version: 'v20.0.0', versions: { node: '20.0.0' }, cwd: () => '/', chdir: () => {},
      nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
      addListener: () => globalThis.process, on: () => globalThis.process, once: () => globalThis.process,
      removeListener: () => globalThis.process, emit: () => false, emitWarning: (...args) => console.warn(...args),
      exit: (code) => { throw new Error('process.exit(' + code + ')'); }, kill: () => {},
      stderr: { isTTY: false, columns: 80, getColorDepth: () => 1, write: (...args) => console.error(...args) },
      stdin: { fd: 0 }, stdout: { isTTY: false, columns: 80, write: (...args) => console.log(...args) },
    };
  }
  if (typeof globalThis.Buffer === 'undefined') {
    class BrowserBuffer extends Uint8Array {
      static from(value, encoding) {
        if (typeof value === 'string') {
          if (encoding === 'hex') {
            const out = new BrowserBuffer(value.length / 2);
            for (let i = 0; i < out.length; i++) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
            return out;
          }
          return new BrowserBuffer(new TextEncoder().encode(value));
        }
        if (value instanceof ArrayBuffer) return new BrowserBuffer(value);
        return new BrowserBuffer(value ?? []);
      }
      static alloc(size, fill = 0) { const b = new BrowserBuffer(size); b.fill(fill); return b; }
      static isBuffer(value) { return value instanceof Uint8Array; }
      static byteLength(value) { return typeof value === 'string' ? new TextEncoder().encode(value).length : value?.byteLength ?? value?.length ?? 0; }
      static concat(chunks) { const len = chunks.reduce((n, c) => n + c.length, 0); const out = new BrowserBuffer(len); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out; }
      compare(other) { const n = Math.min(this.length, other.length); for (let i = 0; i < n; i++) if (this[i] !== other[i]) return this[i] - other[i]; return this.length - other.length; }
      toString(encoding = 'utf8') { if (encoding === 'hex') return [...this].map(b => b.toString(16).padStart(2, '0')).join(''); return new TextDecoder().decode(this); }
    }
    globalThis.Buffer = BrowserBuffer;
  }
})();
`;

const browserifyPlugin = {
    name: 'browserify-plugin',
    setup(build) {
        build.onResolve({ filter: /^(worker_threads|child_process|fs|os|readline)$/ }, args => {
            const shimPath = path.resolve(`./web/shims/${args.path}.js`);
            return { path: shimPath };
        });

        // Pyright's compiled CJS imports resolve jsonc-parser to its UMD build,
        // which contains dynamic require("./impl/format") calls that browsers
        // cannot execute. Force the package to its ESM browser-safe entrypoint.
        build.onResolve({ filter: /^jsonc-parser$/ }, () => ({
            path: path.resolve('./pyright/node_modules/jsonc-parser/lib/esm/main.js'),
        }));
    }
};

console.log("Bundling web/demo.js for the browser...");
const result = await Bun.build({
    entrypoints: ['web/demo-entry.js'],
    bundle: true,
    minify: true,
    plugins: [browserifyPlugin],
    target: 'browser',
    banner: browserGlobals,
    define: {
        process: 'globalThis.process',
        Buffer: 'globalThis.Buffer',
    },
});

if (result.success) {
    if (result.outputs.length > 0) {
        await Bun.write('web/demo.bundled.js', result.outputs[0]);
        console.log("Web demo bundled successfully into web/demo.bundled.js!");
    } else {
        console.error("No outputs returned from build!");
    }
} else {
    console.error("Bundle failed:");
    for (const log of result.logs) {
        console.error(log);
    }
    process.exit(1);
}
