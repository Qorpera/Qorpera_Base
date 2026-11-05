import type { WebCompanyComputer } from "../cloud/computer.ts";
import type { GroupChatDetails, GroupChatDraft } from "../cloud/group-details.ts";
import type { InterfaceChange, InterfaceUndo } from "../cloud/interface-changes.ts";
import type { WebMessageErases } from "../cloud/message-erases.ts";
import type { WebNativeSubscription } from "../cloud/native-subscription.ts";
import type { WebRoutines } from "../cloud/routines.ts";
import type { WebSessionModel } from "../cloud/session-model.ts";
import type { WebSessionRunControl } from "../cloud/session-run-control.ts";
import type { SkillSuggestion } from "../cloud/skills.ts";
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
	/** Answers whether it wrote: a write raises the room's version by one, and nothing written leaves it. */
	updateGroup?: (
		sessionId: string,
		observed: GroupChatDetails,
		draft: GroupChatDraft,
		signal: AbortSignal,
	) => Promise<boolean>;
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
	/** Takes back an agent's change to the company's interfaces or tables, as the member's own change (I10). Not
	 * passed while agents make no pages (Interfaces C6a), so the thread offers no Undo. */
	undoInterfaceChange?: (change: InterfaceChange, signal: AbortSignal) => Promise<InterfaceUndo>;
	/** Erases one message of a conversation for the whole company, and reads how far it got (summary trees M3c). The
	 * route takes owners and admins; the thread offers it to them. */
	messageErases?: WebMessageErases;
	/** An agent's wall (QorperaOS/agents/<handle>/wall.md, app/agent-wall.ts), pinned on top of its own thread. */
	agentWall?: {
		/** The wall's text, read with the member's own folder client; null when the agent has none. */
		read(staffAgentId: string, signal: AbortSignal): Promise<string | null>;
		/** Calls `listener` after a change hint of the company's folder; answers the way to stop. */
		onFolderChange(listener: () => void): () => void;
	};
	/** Supplies already-authorized bytes. No URL from a transcript is fetched. */
	previewAttachment?: (messageId: string, attachmentIndex: number, signal: AbortSignal) => Promise<Blob>;
	sendMessage?: (sessionId: string, text: string, signal: AbortSignal) => Promise<boolean>;
	/** The skills a member calls with "/" in the composer: the agent's own (agentId), then the company's. */
	skills?: (agentId: string | null, signal: AbortSignal) => Promise<readonly SkillSuggestion[]>;
	/** Opens the selected recipients and submits the first message. Failed sends
	 * remain in the returned session so its normal retry UI can recover them. */
	startConversation?: (recipientIds: readonly string[], text: string, signal: AbortSignal) => Promise<string>;
	/** Returns the exact applied agent document revision, also projected as roster version. */
	updateAgent?: (agent: HostedStaffAgent, draft: AgentDraft, signal: AbortSignal) => Promise<number>;
	createAgent?: (profileId: string, draft: AgentCreation, signal: AbortSignal) => Promise<string>;
	/** Removes the agent for good: its document leaves the Company File. */
	deleteAgent?: (agent: HostedStaffAgent, signal: AbortSignal) => Promise<void>;
}
