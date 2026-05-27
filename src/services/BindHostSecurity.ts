export type RemoteAccessMode = 'loopback' | 'token_gated_bind';

export interface BindHostResolution {
    bindHost: string;
    remoteAccessMode: RemoteAccessMode;
}

const LOOPBACK_HOSTS = new Set([
    '127.0.0.1',
    'localhost',
    '::1',
    '[::1]',
]);

export function resolveBindHost(
    requestedHost: string | undefined,
    env: NodeJS.ProcessEnv = process.env,
): BindHostResolution {
    const bindHost = requestedHost?.trim() || '127.0.0.1';
    if (isLoopbackBindHost(bindHost)) {
        return { bindHost, remoteAccessMode: 'loopback' };
    }

    if (!env.KOVAEL_API_TOKEN?.trim()) {
        throw new Error(
            `KOVAEL_BIND_HOST=${bindHost} requires KOVAEL_API_TOKEN. ` +
                'Use the default loopback bind with SSH local forwarding for remote access.',
        );
    }

    return { bindHost, remoteAccessMode: 'token_gated_bind' };
}

export function isLoopbackBindHost(host: string): boolean {
    return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}
