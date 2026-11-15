import type { WebNativeSubscription } from "../cloud/native-subscription.ts";
import type { HostedStaffAgent } from "../cloud/types.ts";
import { appNoteLead, splitAppNote } from "../cloud/wall-reply.ts";
import { t } from "../ui/preferences.ts";
import type { CompanyController } from "./company.ts";
import type { QuotedText } from "./quotes.ts";

/* A member's note to an agent: the member's own message in the agent's shared thread, which starts the agent's run as
 * any message there does. Two places send one:
 * - the Mailbox, when an agent is asked to answer or write an email, or to take an address (views/mailbox.ts, through
 *   CompanyMail.tell), its outside words as quotes;
 * - an interface app's page, through the bar outside its frame (`qorpera.tell`, app/app-actions.ts;
 *   deploy/first-node/RUNTIME-INTERFACE-APPS.md §5), to the agent that owns the app. Its first line, the app and what
 *   it is about (`header`), is never in the composer: the draft answers it (`answering`), the composer shows it
 *   above the field, and the send puts it first (cloud/wall-reply.ts). Where the draft is saved and shared it is the
 *   text's first line (app/company.ts' room hooks), so a reload, another tab or another member's client has it with
 *   the words.
 * A note goes from here only into a thread with nothing drafted in it and no line being answered there, on
 * the model account the cloud chooses for that thread, as the thread itself chooses it. Otherwise, or when the send
 * doesn't go (no model account, the cloud refused it), the note waits in that thread's composer for the member to
 * send: after what is drafted there, an app's under its line. An app's note that finds the thread's draft answering
 * something already (another app's note, or a line that names no app) is not added at all (`held`): one message answers
 * one line. Since 14 November 2026 nothing in the web sets a line that names no app: the agents' wall, whose questions
 * were answered that way, is gone. */

/** The member's model accounts, as a conversation's thread reads them (views/session-execution.ts). */
export type TellAccounts = Pick<WebNativeSubscription, "listConnections" | "selectSessionAccount">;

/** A note: its words and their quotes, and for an app's note the line it answers (cloud/wall-reply.ts `appNoteLine`). */
export interface TellNote extends QuotedText {
	readonly header?: string;
}

/** How a note went: sent, or waiting in the agent's thread (`href`, where it waits), or `held`: nothing was added, as
 * the thread's draft answers something else already. */
export interface TellResult {
	readonly sent: boolean;
	readonly href: string;
	readonly held?: true;
}

/** Sends `note` to the agent as the member's own message. `closed` says the company or its reader went away meanwhile:
 * then nothing is sent, and what was added waits. Throws when the agent's thread can't be opened or the note can't be
 * added to its draft. */
export async function tellAgent(
	company: CompanyController,
	accounts: TellAccounts,
	agentId: string,
	note: TellNote,
	closed: () => boolean = () => company.signal.aborted,
): Promise<TellResult> {
	const profileId = company.profile.profileId;
	const cofounder = agentId === company.cofounderId();
	const href = cofounder ? `#/c/${profileId}` : `#/c/${profileId}/staff/${agentId}`;
	let sessionId: string;
	if (cofounder) {
		const opened = await company.openCofounderConversation();
		if (!opened.sessionId) throw new Error(opened.reason ?? t("The Co-Founder's thread can't be opened here."));
		sessionId = opened.sessionId;
	} else {
		const agent = company.staffById(agentId);
		if (agent?.employmentStatus !== "active") throw new Error(t("That agent is no longer at work."));
		sessionId = await company.openStaffConversation(agent);
	}
	// What is drafted there decides: the member's own draft as this browser has it and, where drafts are shared, as the
	// room has it now. Only a note into nothing drafted goes from here. A line being answered there is drafted too: a
	// send would put that line in front of the note (cloud/wall-reply.ts `withReply`).
	const room = company.roomDrafts.room(sessionId);
	if (room) await room.refresh();
	if (closed()) return { sent: false, href };
	// The draft as the room has it, here too: what it answers comes with it (an app's line, which a reload or another
	// tab left there), before anything is read from it.
	company.roomDrafts.follow(sessionId);
	const conversation = () => company.conversation(sessionId, false).get();
	const shared = () => room?.draft(company.userId)?.body ?? "";
	const before = conversation();
	const header = note.header;
	// One message answers one line: a draft that answers something already (here, or in the room's text), or a message
	// on its way (whose send clears what its draft answers) or waiting to be tried again (with what it answered), takes
	// no app's note.
	if (
		header !== undefined &&
		(before.answering !== undefined || splitAppNote(shared()) || before.sending || before.retrySend)
	)
		return { sent: false, href, held: true };
	const empty =
		(!room || room.usable()) &&
		!shared().trim() &&
		!(before.draft ?? "").trim() &&
		!before.attachments?.length &&
		before.answering === undefined &&
		!before.sending &&
		!before.retrySend;
	// The app's line first, so the draft is shared with it from its first write (app/company.ts' room hooks).
	if (header !== undefined) company.conversation(sessionId, false).set({ answering: header });
	try {
		company.addToDraft(sessionId, note);
	} catch (error) {
		if (header !== undefined) company.setAnswering(sessionId, undefined);
		throw error;
	}
	// The submission meant: exactly the note. Anything that changes it while the account is chosen (another tab, a
	// merged shared draft, an attachment, another line to answer) leaves it in the composer for the member to send.
	const intended = conversation().draft ?? "";
	const shareable = (header === undefined ? "" : appNoteLead(header)) + intended;
	if (!empty || closed()) return { sent: false, href };
	await chooseThreadAccount(company, accounts, sessionId);
	const now = conversation();
	if (
		closed() ||
		now.draft !== intended ||
		now.attachments?.length ||
		now.answering !== header ||
		now.sending ||
		now.retrySend ||
		![shareable, ""].includes(shared())
	)
		return { sent: false, href };
	// Sent from here, not from the thread: the member's press stands for the thread on screen (`sendNote`).
	const sent = await company.sendNote(sessionId, intended);
	return { sent, href };
}

/** Gives the conversation the model account the cloud chooses for it, as its thread does when it opens
 * (views/session-execution.ts): the conversation's own account, never another one (founder decision 2026-10-04).
 * A conversation with a message on its way keeps the account that message carries, and one the cloud has no account
 * for keeps what it has. A choice that fails leaves the send (or an answer) to say what it needed. */
export async function chooseThreadAccount(
	company: CompanyController,
	accounts: TellAccounts,
	sessionId: string,
): Promise<void> {
	const conversation = company.conversation(sessionId, false).get();
	if (conversation.sending || conversation.retrySend || !accounts.selectSessionAccount) return;
	const signal = company.signal;
	try {
		const connectionId = await accounts.selectSessionAccount(sessionId, signal);
		if (!connectionId) return;
		const observed = await accounts.listConnections(signal);
		const now = company.conversation(sessionId, false).get();
		if (now.sending || now.retrySend) return;
		company.setExecutionSponsor(sessionId, observed, connectionId);
	} catch {
		// The send still goes, or says what is missing.
	}
}

/** Who hears a note from an interface app now (RUNTIME-INTERFACE-APPS.md §5 "tell"): the agent that owns the app, from
 * its manifest's `owner`, while it is at work; the Co-Founder when the app has no owner or its owner left. Refused, with
 * the reason a page is told (in English, as the bridge's other refusals), when the member may not write in the company
 * or there is nobody to hear it. */
export function noteReceiver(
	company: CompanyController,
	owner: string | null,
): { readonly agent: HostedStaffAgent } | { readonly refused: string } {
	const state = company.store.get();
	if (state.accessLost || !state.team?.capabilities.write)
		return { refused: "The member may not send messages in this company" };
	const owning = owner === null ? undefined : company.staffById(owner);
	if (owning?.employmentStatus === "active") return { agent: owning };
	const cofounder = company.staffById(company.cofounderId());
	if (cofounder?.employmentStatus === "active") return { agent: cofounder };
	return {
		refused: "Nobody can take a note from this app: its owner is not at work, and the company has no Co-Founder",
	};
}
