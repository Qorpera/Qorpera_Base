import type { WebCompanyComputer } from "../cloud/computer.ts";
import type { WebNativeSubscription } from "../cloud/native-subscription.ts";
import type { WebRoutines } from "../cloud/routines.ts";
import type { WebSessionRunControl } from "../cloud/session-run-control.ts";
import type { HostedStaffAgent } from "../cloud/types.ts";
import type { FigureChoice } from "../ui/figure-picker.ts";

export interface AgentDraft extends FigureChoice {
	displayName: string;
	role: string;
	charter: string;
}

/** Member UI adapters over the shared cloud SDK. A view offers an action only
 * when its adapter is present. */
export interface WorkspaceActions {
	/** Shared workspace surface for transient notifications owned by the view. */
	notificationHost?: HTMLElement;
	computer?: WebCompanyComputer;
	runControl?: WebSessionRunControl;
	nativeSubscription?: WebNativeSubscription;
	routines?: WebRoutines;
	/** Supplies already-authorized bytes. No URL from a transcript is fetched. */
	previewAttachment?: (messageId: string, attachmentIndex: number, signal: AbortSignal) => Promise<Blob>;
	sendMessage?: (sessionId: string, text: string, signal: AbortSignal) => Promise<boolean>;
	/** Opens the selected recipients and submits the first message. Failed sends
	 * remain in the returned session so its normal retry UI can recover them. */
	startConversation?: (recipientIds: readonly string[], text: string, signal: AbortSignal) => Promise<string>;
	/** Returns the exact applied agent document revision, also projected as roster version. */
	updateAgent?: (agent: HostedStaffAgent, draft: AgentDraft, signal: AbortSignal) => Promise<number>;
	createAgent?: (profileId: string, draft: AgentDraft, signal: AbortSignal) => Promise<string>;
}
