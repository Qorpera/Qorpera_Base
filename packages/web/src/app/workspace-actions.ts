import type { HostedStaffAgent } from "../cloud/types.ts";
import type { FigureChoice } from "../ui/figure-picker.ts";

export interface AgentDraft extends FigureChoice {
	displayName: string;
	role: string;
	charter: string;
}

/** UI ports only. Production supplies none until each authorized cloud write
 * path is ready. Fixtures can exercise complete forms without waking agents. */
export interface WorkspaceActions {
	/** Supplies already-authorized bytes. No URL from a transcript is fetched. */
	previewAttachment?: (messageId: string, attachmentIndex: number, signal: AbortSignal) => Promise<Blob>;
	sendMessage?: (sessionId: string, text: string, signal: AbortSignal) => Promise<boolean>;
	updateAgent?: (agent: HostedStaffAgent, draft: AgentDraft, signal: AbortSignal) => Promise<void>;
	createAgent?: (profileId: string, draft: AgentDraft, signal: AbortSignal) => Promise<string>;
}
