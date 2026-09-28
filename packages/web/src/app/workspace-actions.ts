import type { WebCompanyComputer } from "../cloud/computer.ts";
import type { GroupChatDetails, GroupChatDraft } from "../cloud/group-details.ts";
import type { WebNativeSubscription } from "../cloud/native-subscription.ts";
import type { WebRoutines } from "../cloud/routines.ts";
import type { WebSessionModel } from "../cloud/session-model.ts";
import type { WebSessionRunControl } from "../cloud/session-run-control.ts";
import type { HostedStaffAgent } from "../cloud/types.ts";
import type { FigureChoice } from "../ui/figure-picker.ts";
import type { ComputerPanels } from "./views/computer.ts";

export interface AgentDraft extends FigureChoice {
	displayName: string;
	role: string;
	charter: string;
}

/** Retained until creation and roster projection are both confirmed. */
export interface AgentCreation extends AgentDraft {
	id: string;
	createdAt: string;
}

/** Member UI adapters over the shared cloud SDK. A view offers an action only
 * when its adapter is present. */
export interface WorkspaceActions {
	updateGroup?: (
		sessionId: string,
		observed: GroupChatDetails,
		draft: GroupChatDraft,
		signal: AbortSignal,
	) => Promise<void>;
	/** Deletes the group chat for everyone. */
	deleteGroup?: (sessionId: string, roomId: string, signal: AbortSignal) => Promise<void>;
	/** Company notices (all company computers in use). The conversation shows them above its composer. */
	notificationHost?: HTMLElement;
	computer?: WebCompanyComputer;
	/** The company's open computers, kept across the threads a member moves between. */
	computerPanels?: ComputerPanels;
	runControl?: WebSessionRunControl;
	sessionModel?: WebSessionModel;
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
	createAgent?: (profileId: string, draft: AgentCreation, signal: AbortSignal) => Promise<string>;
	/** Removes the agent for good: its document leaves the Company File. */
	deleteAgent?: (agent: HostedStaffAgent, signal: AbortSignal) => Promise<void>;
}
