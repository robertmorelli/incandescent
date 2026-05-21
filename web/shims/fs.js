export const constants = {
    O_RDONLY: 0,
    O_WRONLY: 1,
    O_RDWR: 2,
    O_CREAT: 0x40,
    O_EXCL: 0x80,
    O_TRUNC: 0x200,
    F_OK: 0,
    R_OK: 4,
    W_OK: 2,
    X_OK: 1,
};

export function existsSync() { return false; }
export function statSync() { throw new Error("fs.statSync not supported in browser"); }
export function readFileSync() { throw new Error("fs.readFileSync not supported in browser"); }
export function readdirSync() { return []; }
export function readdirEntriesSync() { return []; }
export function mkdirSync() {}
export function writeFileSync() {}
export function unlinkSync() {}
export function rmdirSync() {}
export function realpathSync(p) { return p; }
export function copyFileSync() {}
export function createReadStream() { throw new Error("fs.createReadStream not supported in browser"); }
export function createWriteStream() { throw new Error("fs.createWriteStream not supported in browser"); }
export const promises = {
    readFile() { throw new Error("fs.promises.readFile not supported in browser"); },
    stat() { throw new Error("fs.promises.stat not supported in browser"); }
};
export default {
    existsSync,
    statSync,
    readFileSync,
    readdirSync,
    readdirEntriesSync,
    mkdirSync,
    writeFileSync,
    unlinkSync,
    rmdirSync,
    realpathSync,
    copyFileSync,
    createReadStream,
    createWriteStream,
    constants,
    promises
};
