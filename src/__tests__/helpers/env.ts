/** Restore a single env var to a captured prior value (delete it if it was unset). */
export function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}
