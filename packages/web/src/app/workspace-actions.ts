import type { WebCompanyComputer } from "../cloud/computer.ts";
import type { HostedStaffAgent } from "../cloud/types.ts";
import type { FigureChoice } from "../ui/figure-picker.ts";

export interface AgentDraft extends FigureChoice {
	displayName: string;
	role: string;
	charter: string;
}

/** Member UI adapters. Computer access uses the shared cloud SDK; other
 * write ports remain unavailable until their product integration is ready. */
export interface WorkspaceActions {
	computer?: WebCompanyComputer;
	/** Supplies already-authorized bytes. No URL from a transcript is fetched. */
	previewAttachment?: (messageId: string, attachmentIndex: number, signal: AbortSignal) => Promise<Blob>;
	sendMessage?: (sessionId: string, text: string, signal: AbortSignal) => Promise<boolean>;
	updateAgent?: (agent: HostedStaffAgent, draft: AgentDraft, signal: AbortSignal) => Promise<void>;
	createAgent?: (profileId: string, draft: AgentDraft, signal: AbortSignal) => Promise<string>;
}
