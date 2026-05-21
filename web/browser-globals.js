import { Buffer } from 'buffer';
import processShim from 'process/browser';

if (typeof globalThis.Buffer === 'undefined') {
    globalThis.Buffer = Buffer;
}

if (typeof globalThis.process === 'undefined') {
    globalThis.process = processShim;
}

Object.assign(globalThis.process, {
    env: globalThis.process.env ?? {},
    argv: globalThis.process.argv ?? ['browser'],
    execArgv: globalThis.process.execArgv ?? [],
    pid: globalThis.process.pid ?? 1,
    platform: globalThis.process.platform ?? 'browser',
    version: globalThis.process.version ?? 'v20.0.0',
    versions: globalThis.process.versions ?? { node: '20.0.0' },
    cwd: globalThis.process.cwd ?? (() => '/'),
    chdir: globalThis.process.chdir ?? (() => {}),
    stderr: globalThis.process.stderr ?? { isTTY: false, columns: 80, getColorDepth: () => 1, write: (...args) => console.error(...args) },
    stdin: globalThis.process.stdin ?? { fd: 0 },
    stdout: globalThis.process.stdout ?? { isTTY: false, columns: 80, write: (...args) => console.log(...args) },
});
