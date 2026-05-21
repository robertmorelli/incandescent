export function platform() { return 'browser'; }
export function homedir() { return '/'; }
export function tmpdir() { return '/tmp'; }
export const EOL = '\n';
export const constants = {
    errno: {
        EBADF: 9,
        ENOENT: 2,
    },
};

export default { platform, homedir, tmpdir, EOL, constants };
