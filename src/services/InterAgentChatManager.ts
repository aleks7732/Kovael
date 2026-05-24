import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConversationBus } from './ConversationBus.js';
import { Logger, rootLogger } from './Logger.js';

export interface BanterDialogue {
    senderId: string;
    senderName: string;
    recipientId: string;
    recipientName: string;
    content: string;
}

interface BanterConfig {
    technical: BanterDialogue[];
    interests: BanterDialogue[];
}

/**
 * Manages inter-agent banter chat — extracted from MeshOrchestrator to
 * reduce composition-root bloat. Loads dialogue data from an external
 * JSON config file for hot-reload and user customization.
 */
export class InterAgentChatManager {
    private readonly log: Logger = rootLogger;
    private readonly technicalDialogues: BanterDialogue[];
    private readonly interestsDialogues: BanterDialogue[];
    private interAgentTimer: NodeJS.Timeout | null = null;
    private currentTechnicalIndex = 0;
    private currentInterestsIndex = 0;
    private banterTopicId: string | null = null;

    public enabled = false;
    public mode: 'technical' | 'interests' = 'interests';

    constructor(
        private readonly conversationBus: ConversationBus,
        private readonly broadcast: (payload: unknown) => void,
    ) {
        const config = InterAgentChatManager.loadConfig();
        this.technicalDialogues = config.technical;
        this.interestsDialogues = config.interests;
    }

    private static loadConfig(): BanterConfig {
        const configPath = path.join(process.cwd(), 'config', 'banter-dialogues.json');
        try {
            const raw = fs.readFileSync(configPath, 'utf-8');
            const parsed = JSON.parse(raw) as BanterConfig;
            if (!Array.isArray(parsed.technical) || !Array.isArray(parsed.interests)) {
                throw new Error('banter config missing technical/interests arrays');
            }
            return parsed;
        } catch {
            // Fallback: empty dialogues if config is missing or malformed.
            return { technical: [], interests: [] };
        }
    }

    public start(): void {
        if (this.interAgentTimer) return;
        this.trigger();
        this.interAgentTimer = setInterval(() => {
            this.trigger();
        }, 10000);
        this.log.info('inter_agent_chat_loop_started');
    }

    public stop(): void {
        if (this.interAgentTimer) {
            clearInterval(this.interAgentTimer);
            this.interAgentTimer = null;
        }
        this.log.info('inter_agent_chat_loop_stopped');
    }

    public trigger(): void {
        const isTechnical = this.mode === 'technical';
        const dialogues = isTechnical ? this.technicalDialogues : this.interestsDialogues;
        if (dialogues.length === 0) return;

        let index = isTechnical ? this.currentTechnicalIndex : this.currentInterestsIndex;
        const dialogue = dialogues[index];

        if (isTechnical) {
            this.currentTechnicalIndex = (index + 1) % dialogues.length;
        } else {
            this.currentInterestsIndex = (index + 1) % dialogues.length;
        }

        if (!this.banterTopicId) {
            try {
                const topic = this.conversationBus.createTopic(
                    'Inter-Agent Banter',
                    ['nyx-antigravity', 'nyx-cli', 'shaev', 'nyx-openclaw'],
                );
                this.banterTopicId = topic.id;
            } catch (err: any) {
                this.log.error('failed_to_create_banter_topic', { error: err.message });
            }
        }

        if (this.banterTopicId) {
            try {
                this.conversationBus.postMessage(
                    this.banterTopicId,
                    dialogue.senderId,
                    'assistant',
                    dialogue.content,
                );
            } catch (err: any) {
                this.log.error('failed_to_post_banter_message', { error: err.message });
            }
        }

        const msg = {
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            ...dialogue,
        };

        this.broadcast({
            type: 'inter_agent_message',
            data: msg,
        });
    }
}
