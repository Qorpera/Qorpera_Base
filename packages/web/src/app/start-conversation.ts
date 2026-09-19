import type {
	CloudMemberCompanyCommand,
	CloudMemberCompanyFileClient,
} from "@qorpera/cloud-client/cloud-member-company-editor";
import type { WebNativeSubscription } from "../cloud/native-subscription.ts";
import { UUID_PATTERN } from "../cloud/parse.ts";
import { type SessionExecutionSponsor, selectSessionExecutionSponsor } from "../cloud/session-input.ts";
import type { CompanyController } from "./company.ts";
import type { WorkspaceActions } from "./workspace-actions.ts";

/** One draft owns its room identity, including retries after an uncertain File
 * write. Once a session exists, ordinary conversation state owns send recovery. */
export function createConversationStarter(options: {
	company: CompanyController;
	native: Pick<WebNativeSubscription, "listConnections">;
	editor: (signal: AbortSignal) => Promise<Pick<CloudMemberCompanyFileClient, "read" | "edit" | "review">>;
	current: () => void;
	send: (sessionId: string, text: string, signal: AbortSignal) => Promise<boolean>;
}): NonNullable<WorkspaceActions["startConversation"]> {
	const company = options.company;
	let busy = false;
	let room: { recipients: string; id: string; text: string } | undefined;
	return async (recipientIds, text, viewSignal) => {
		if (busy) throw new Error("Wait for this conversation to finish opening.");
		const ids = [...new Set(recipientIds)];
		const signal = AbortSignal.any([company.signal, viewSignal]);
		const check = () => {
			signal.throwIfAborted();
			options.current();
			const state = company.store.get();
			if (state.accessLost || !state.team?.capabilities.write)
				throw new Error("You do not have permission to send messages in this company.");
			if (
				!ids.length ||
				ids.length > 255 ||
				ids.some((id) => {
					const agent = company.staffById(id);
					return !UUID_PATTERN.test(id) || !agent || agent.employmentStatus !== "active";
				})
			)
				throw new Error("Choose active agents from this company before sending.");
			if (ids.length > 1 && !state.team.capabilities.authorize)
				throw new Error("Only an owner or admin can create a group chat.");
		};
		check();
		if (!text.trim() || new TextEncoder().encode(text.trim()).length > 65536)
			throw new Error("Enter a message of no more than 64 KiB.");
		busy = true;
		try {
			const observed = await options.native.listConnections(signal);
			check();
			let sponsor: SessionExecutionSponsor | undefined;
			for (const connection of observed.connections) {
				try {
					sponsor = selectSessionExecutionSponsor(observed, connection.connectionId, company.userId);
					break;
				} catch {
					// As in the conversation picker, skip accounts unavailable to this member.
				}
			}
			if (!sponsor) throw new Error("Connect a model account in Settings → Connections to send messages.");
			let sessionId: string;
			if (ids.length === 1) {
				sessionId = await company.openStaffConversation(company.staffById(ids[0]!)!);
				check();
			} else {
				const recipients = JSON.stringify([...ids].sort());
				if (room?.recipients !== recipients) {
					const id = crypto.randomUUID();
					room = {
						recipients,
						id,
						text: JSON.stringify({
							schema: "qorpera.company-room/v1",
							roomId: id,
							key: `chat-${id}`,
							name: ids
								.map((id) => company.staffById(id)!.displayName)
								.join(", ")
								.slice(0, 256),
							purpose: "A group conversation with the selected agents.",
							status: "active",
							projectId: null,
							members: [
								{ kind: "member", id: company.userId },
								...ids.map((id) => ({ kind: "staff_agent", id })),
							],
							version: 1,
						}),
					};
				}
				const editor = await options.editor(signal);
				check();
				const apply = async (command: CloudMemberCompanyCommand) => {
					check();
					if (command.state === "review_required") {
						const reviewed = await editor.review(command, "approve", signal);
						check();
						if (!("commandId" in reviewed)) throw new Error("Group chat review changed kind.");
						command = reviewed;
					}
					if (command.state !== "applied" || !command.result)
						throw new Error("The group chat could not be created. Your message is still here.");
				};
				// Company bootstrap does not seed the rooms directory.
				const directory = await editor.read("organization/rooms", signal);
				check();
				if (directory.kind === "absent") {
					await apply(
						await editor.edit(
							{
								operation: "mkdir",
								operationKey: `room-directory:${room.id}`,
								path: "organization/rooms",
								expectedVersion: null,
							},
							signal,
						),
					);
				} else if (directory.kind !== "directory") throw new Error("The group chat directory is unavailable.");
				const path = `organization/rooms/${room.id}.json`;
				const current = await editor.read(path, signal);
				check();
				if (current.kind === "file") {
					if (current.text !== room.text) throw new Error("The group chat changed. Start a new conversation.");
				} else {
					if (current.kind !== "absent") throw new Error("The group chat path is unavailable.");
					await apply(
						await editor.edit(
							{
								operation: "write",
								operationKey: `room-create:${room.id}`,
								path,
								expectedVersion: null,
								text: room.text,
							},
							signal,
						),
					);
				}
				await company.refreshSessions();
				check();
				const session = company.store.get().sessions.find((item) => item.executionScope?.roomId === room!.id);
				if (!session || session.staffAgentId || session.status !== "open")
					throw new Error("The group chat is still opening. Send again to retry the same conversation.");
				sessionId = session.sessionId;
			}
			company.assertCanSend(sessionId);
			const conversation = company.conversation(sessionId, false);
			if (conversation.get().sending || conversation.get().retrySend)
				throw new Error("Open the existing conversation to finish its pending message before sending another.");
			if (conversation.get().draft?.trim() || conversation.get().attachments?.length)
				throw new Error(
					"This conversation has an unsent draft. Open it to finish or clear that draft before sending another.",
				);
			conversation.set({ draft: text, executionSponsor: sponsor });
			await options.send(sessionId, text, signal);
			check();
			// Failed sends retain the draft and exact retry identity in this session.
			return sessionId;
		} finally {
			busy = false;
		}
	};
}
