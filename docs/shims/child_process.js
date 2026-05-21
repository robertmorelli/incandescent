export function spawn() { return { on: () => {}, stdout: { on: () => {} }, stderr: { on: () => {} } }; }
export function fork() { return { on: () => {} }; }
export function exec() {}
export function execSync() { return Buffer.alloc(0); }
export function spawnSync() { return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; }
