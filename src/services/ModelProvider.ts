export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
    name?: string;
}

export interface TokenUsage {
    input: number;
    output: number;
    total: number;
    runtimeMs: number;
    source: 'estimate' | 'reported';
}

export interface ModelProviderOptions {
    system: string;
    messages: ChatMessage[];
    signal?: AbortSignal;
    topicId?: string;
    agentId?: string;
}

export interface ModelProvider {
    id: string;
    stream(opts: ModelProviderOptions): AsyncIterable<{ delta: string; usage?: TokenUsage }>;
}
