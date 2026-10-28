import { osPath, writeGroupFile } from "@qorpera/cloud-client/company-state-files";
import {
	createStateFolder,
	WebCompanyFolderRejectedError,
	type WebMemberFolder,
} from "../cloud/company-folder-writes.ts";
import type { WebNativeSubscription } from "../cloud/native-subscription.ts";
import { UUID_PATTERN } from "../cloud/parse.ts";
import { type SessionExecutionSponsor, selectSessionExecutionSponsor } from "../cloud/session-input.ts";
import { t } from "../ui/preferences.ts";
import { type CompanyController, draftReplaced } from "./company.ts";
import type { WorkspaceActions } from "./workspace-actions.ts";

/** One draft owns its room identity, including retries after an uncertain folder
 * write. Once a session exists, ordinary conversation state owns send recovery. A
 * group chat is a company folder, `QorperaOS/agents/groups/<handle>` with its `group.md`
 * (folder core C4, P34a-2); the commit's hook opens its room and conversation. */
export function createConversationStarter(options: {
	company: CompanyController;
	native: Pick<WebNativeSubscription, "listConnections" | "selectSessionAccount" | "refreshAccountMetadata">;
	folder: (signal: AbortSignal) => WebMemberFolder;
	current: () => void;
	send: (sessionId: string, text: string, signal: AbortSignal) => Promise<boolean>;
}): NonNullable<WorkspaceActions["startConversation"]> {
	const company = options.company;
	let busy = false;
	let room: { recipients: string; id: string; name: string; text: string } | undefined;
	return async (recipientIds, text, viewSignal) => {
		if (busy) throw new Error(t("Wait for this conversation to finish opening."));
		const ids = [...new Set(recipientIds)];
		const signal = AbortSignal.any([company.signal, viewSignal]);
		const check = () => {
			signal.throwIfAborted();
			options.current();
			const state = company.store.get();
			if (state.accessLost || !state.team?.capabilities.write)
				throw new Error(t("You do not have permission to send messages in this company."));
			if (
				!ids.length ||
				ids.length > 255 ||
				ids.some((id) => {
					const agent = company.staffById(id);
					return !UUID_PATTERN.test(id) || !agent || agent.employmentStatus !== "active";
				})
			)
				throw new Error(t("Choose active agents from this company before sending."));
			if (ids.length > 1 && !state.team.capabilities.authorize)
				throw new Error(t("Only an owner or admin can create a group chat."));
		};
		check();
		if (!text.trim() || new TextEncoder().encode(text.trim()).length > 65536)
			throw new Error(t("Enter a message of no more than 64 KiB."));
		busy = true;
		try {
			if (options.native.refreshAccountMetadata) {
				await options.native.refreshAccountMetadata(signal);
				check();
			}
			const observed = await options.native.listConnections(signal);
			check();
			let sponsor: SessionExecutionSponsor | undefined;
			for (const connection of observed.connections) {
				try {
					sponsor = selectSessionExecutionSponsor(observed, connection.connectionId, company.userId);
					break;
				} catch {
					// Check account availability before creating a conversation.
				}
			}
			if (!sponsor) throw new Error(t("Connect a model account in Settings → My connections to send messages."));
			let sessionId: string;
			if (ids.length === 1) {
				sessionId = await company.openStaffConversation(company.staffById(ids[0]!)!);
				check();
			} else {
				const recipients = JSON.stringify([...ids].sort());
				if (room?.recipients !== recipients) {
					const id = crypto.randomUUID();
					// A group chat's name is at most 256 characters, cut on a character.
					const name = [
						...ids
							.map((id) => company.staffById(id)!.displayName)
							.join(", ")
							.trim(),
					]
						.slice(0, 256)
						.join("")
						.trim();
					room = {
						recipients,
						id,
						name,
						text: writeGroupFile({
							id,
							name,
							subtitle: null,
							agents: ids,
							people: [company.userId],
							// Saved in the company's folder as company content, so the same in every interface language.
							purpose: "A group conversation with the selected agents.",
						}),
					};
				}
				const created = room;
				const folder = options.folder(signal);
				// A retry after a lost answer finds the chat this draft made.
				const made = (await folder.stateFolders(signal)).groups.some((group) => group.roomId === created.id);
				check();
				if (!made)
					await createStateFolder(
						folder,
						{
							parent: osPath("agents/groups"),
							name: created.name,
							fallback: "group",
							key: (handle) => `web:room-create:${created.id}:${handle}`,
							contents: [{ path: "group.md", kind: "file", text: created.text }],
							failure: t("The group chat could not be created. Your message is still here."),
						},
						signal,
						check,
					).catch((error: unknown) => {
						// Nothing was written. The core keeps a refused change set's answer under its key, so the next try
						// is a new group chat: the same one again would only replay this answer.
						if (error instanceof WebCompanyFolderRejectedError && room === created) room = undefined;
						throw error;
					});
				await company.refreshSessions();
				check();
				const session = company.store.get().sessions.find((item) => item.executionScope?.roomId === created.id);
				if (!session || session.staffAgentId || session.status !== "open")
					throw new Error(t("The group chat is still opening. Send again to retry the same conversation."));
				sessionId = session.sessionId;
			}
			if (options.native.selectSessionAccount) {
				const connectionId = await options.native.selectSessionAccount(sessionId, signal);
				check();
				if (!connectionId)
					throw new Error(t("No model account is currently available. Try again after an account resets."));
				// Selection may have followed a runtime handoff, so read the current
				// sponsor version after the server has chosen this room's account.
				const currentAccounts = await options.native.listConnections(signal);
				check();
				sponsor = selectSessionExecutionSponsor(currentAccounts, connectionId, company.userId);
			}
			company.assertCanSend(sessionId);
			const conversation = company.conversation(sessionId, false);
			if (conversation.get().sending || conversation.get().retrySend)
				throw new Error(t("Open the existing conversation to finish its pending message before sending another."));
			if (conversation.get().draft?.trim() || conversation.get().attachments?.length)
				throw new Error(
					t(
						"This conversation has an unsent draft. Open it to finish or clear that draft before sending another.",
					),
				);
			conversation.set((state) => ({ draft: text, executionSponsor: sponsor, ...draftReplaced(state) }));
			await options.send(sessionId, text, signal);
			check();
			// Failed sends retain the draft and exact retry identity in this session.
			return sessionId;
		} finally {
			busy = false;
		}
	};
}
