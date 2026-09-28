import type { CloudMemberCompanyFileClient } from "@qorpera/cloud-client/cloud-member-company-editor";
import { describeError } from "../cloud/client.ts";
import type { GroupChatDraft } from "../cloud/group-details.ts";
import { record, UUID_PATTERN } from "../cloud/parse.ts";
import { t } from "../ui/preferences.ts";
import type { CompanyController } from "./company.ts";
import type { WorkspaceActions } from "./workspace-actions.ts";

const ROOM_FIELDS = ["schema", "roomId", "key", "name", "purpose", "status", "projectId", "members", "version"];

/** This invocation failed before sending a write; an earlier invocation may still be uncertain. */
export class GroupUpdateNotWrittenError extends Error {}

/** The group's participants would not pass: fewer than two active agents, someone who left, or a duplicate. */
export class GroupParticipantsError extends Error {}

type GroupEditor = Pick<CloudMemberCompanyFileClient, "read" | "edit" | "review">;

/** Every room change is an owner's or admin's (a protected Company File path). */
function assertGroupEditor(company: CompanyController): void {
	const state = company.store.get();
	if (
		state.accessLost ||
		!state.team?.capabilities.write ||
		!state.team.capabilities.authorize ||
		!["owner", "admin"].includes(state.team.role) ||
		state.team.profileId !== company.profile.profileId
	)
		throw new Error(t("Only an owner or admin can change group chats."));
}

/** A room document change is protected: its author approves the review, then it must have applied. */
async function applyGroupCommand(
	editor: GroupEditor,
	command: Awaited<ReturnType<GroupEditor["edit"]>>,
	signal: AbortSignal,
	check: () => void,
	failure: string,
): Promise<void> {
	let result = command;
	if (result.state === "review_required") {
		const reviewed = await editor.review(result, "approve", signal);
		check();
		if (!("commandId" in reviewed)) throw new Error(t("Group chat review changed kind."));
		result = reviewed;
	}
	if (result.state !== "applied" || !result.result) throw new Error(failure);
}

function memberKey(members: GroupChatDraft["members"]): string {
	return JSON.stringify(members.map(({ kind, id }) => `${kind}:${id}`).sort());
}

/** Edits the canonical room document with both its File and room revision checks. */
export function createGroupUpdater(options: {
	company: CompanyController;
	editor: (signal: AbortSignal) => Promise<GroupEditor>;
	current: () => void;
}): NonNullable<WorkspaceActions["updateGroup"]> {
	const company = options.company;
	let busy = false;
	return async (sessionId, observed, draft, viewSignal) => {
		if (busy) throw new GroupUpdateNotWrittenError(t("Wait for this group chat to finish saving."));
		busy = true;
		let writeStarted = false;
		try {
			const signal = AbortSignal.any([company.signal, viewSignal]);
			const changes = {
				name: draft.name.trim(),
				...(draft.subtitle !== undefined ? { subtitle: draft.subtitle.trim() } : {}),
				purpose: draft.purpose.trim(),
				members: draft.members.map((m) => ({ ...m })),
			};
			const check = () => {
				signal.throwIfAborted();
				options.current();
				assertGroupEditor(company);
				const state = company.store.get();
				const session = state.sessions.find((item) => item.sessionId === sessionId);
				if (
					!session ||
					session.staffAgentId ||
					session.status !== "open" ||
					session.profileId !== company.profile.profileId ||
					session.environmentId !== company.profile.environmentId ||
					observed.sessionId !== sessionId ||
					observed.environmentId !== session.environmentId ||
					!UUID_PATTERN.test(observed.roomId) ||
					session.executionScope?.roomId !== observed.roomId ||
					observed.status !== "active" ||
					!Number.isSafeInteger(observed.version) ||
					observed.version < 1 ||
					observed.version >= Number.MAX_SAFE_INTEGER
				)
					throw new Error(t("This group chat is no longer available."));
				if (
					changes.members.length > 256 ||
					changes.members.filter((member) => member.kind === "staff_agent").length < 2 ||
					new Set(changes.members.map((member) => `${member.kind}:${member.id}`)).size !==
						changes.members.length ||
					changes.members.some((member) => {
						if (!UUID_PATTERN.test(member.id)) return true;
						if (member.kind === "member")
							return !state.team?.members.some((person) => person.userId === member.id);
						if (member.kind !== "staff_agent") return true;
						const agent = company.staffById(member.id);
						return !agent || agent.profileId !== session.profileId || agent.employmentStatus !== "active";
					})
				)
					throw new GroupParticipantsError(
						t("Choose at least two active agents and current company members, with no duplicate participants."),
					);
			};
			check();
			if (!changes.name || [...changes.name].length > 256)
				throw new Error(t("Enter a group name of no more than 256 characters."));
			if (changes.subtitle !== undefined && [...changes.subtitle].length > 256)
				throw new Error(t("Enter a group subtitle of no more than 256 characters."));
			if (!changes.purpose) throw new Error(t("Enter a description for this group chat."));
			const editor = await options.editor(signal);
			check();
			const path = `organization/rooms/${observed.roomId}.json`;
			const current = await editor.read(path, signal);
			check();
			if (
				current.kind !== "file" ||
				!current.version ||
				!UUID_PATTERN.test(current.version) ||
				current.path !== path
			)
				throw new Error(t("This group chat is no longer available."));
			const document = record(JSON.parse(current.text), "group chat document");
			if (
				Object.keys(document).some((field) => field !== "subtitle" && !ROOM_FIELDS.includes(field)) ||
				ROOM_FIELDS.some((field) => !Object.hasOwn(document, field)) ||
				document.schema !== "qorpera.company-room/v1" ||
				document.roomId !== observed.roomId ||
				typeof document.key !== "string" ||
				!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(document.key) ||
				typeof document.name !== "string" ||
				(Object.hasOwn(document, "subtitle") &&
					(typeof document.subtitle !== "string" || [...document.subtitle].length > 256)) ||
				typeof document.purpose !== "string" ||
				document.status !== "active" ||
				(document.projectId !== null &&
					(typeof document.projectId !== "string" || !UUID_PATTERN.test(document.projectId))) ||
				!Number.isSafeInteger(document.version) ||
				!Array.isArray(document.members)
			)
				throw new Error(t("This group chat document has changed. Reopen its details before saving."));
			const members = document.members.map((value): GroupChatDraft["members"][number] => {
				const member = record(value, "group participant");
				if (
					Object.keys(member).length !== 2 ||
					(member.kind !== "member" && member.kind !== "staff_agent") ||
					typeof member.id !== "string" ||
					!UUID_PATTERN.test(member.id)
				)
					throw new Error(t("Invalid group participant."));
				return { kind: member.kind, id: member.id };
			});
			if (document.version !== observed.version) {
				// A lost apply response can be retried without advancing the document twice.
				if (
					document.version === observed.version + 1 &&
					document.name === changes.name &&
					(changes.subtitle === undefined || document.subtitle === changes.subtitle) &&
					document.purpose === changes.purpose &&
					memberKey(members) === memberKey(changes.members)
				)
					return;
				throw new Error(t("This group chat changed while you were editing. Reopen its details before saving."));
			}
			const text = JSON.stringify({ ...document, ...changes, version: observed.version + 1 });
			if (new TextEncoder().encode(text).length > 32768)
				throw new Error(t("The group details are too long. Shorten the description."));
			writeStarted = true;
			const command = await editor.edit(
				{
					operation: "write",
					operationKey: `group-update:${observed.roomId}:${crypto.randomUUID()}`,
					path,
					expectedVersion: current.version,
					text,
				},
				signal,
			);
			check();
			await applyGroupCommand(editor, command, signal, check, t("The group chat changes could not be saved."));
		} catch (error) {
			if (!writeStarted) throw new GroupUpdateNotWrittenError(describeError(error), { cause: error });
			throw error;
		} finally {
			busy = false;
		}
	};
}

/** Deletes a group chat for everyone: its room document leaves the Company File, the
 * cloud removes the room and closes its conversation (20260918010000). Owners and
 * admins only, as for every room change. */
export function createGroupDeleter(options: {
	company: CompanyController;
	editor: (signal: AbortSignal) => Promise<GroupEditor>;
	current: () => void;
}): NonNullable<WorkspaceActions["deleteGroup"]> {
	const company = options.company;
	return async (sessionId, roomId, signal) => {
		const check = () => {
			signal.throwIfAborted();
			company.signal.throwIfAborted();
			options.current();
			assertGroupEditor(company);
			const session = company.store.get().sessions.find((item) => item.sessionId === sessionId);
			if (
				!session ||
				session.staffAgentId ||
				session.profileId !== company.profile.profileId ||
				!UUID_PATTERN.test(roomId) ||
				String(session.executionScope?.roomId).toLowerCase() !== roomId.toLowerCase()
			)
				throw new Error(t("This group chat is no longer available."));
		};
		check();
		const editor = await options.editor(signal);
		check();
		const path = `organization/rooms/${roomId.toLowerCase()}.json`;
		const current = await editor.read(path, signal);
		check();
		// Deleted already (by another member, or by a lost answer to this request).
		if (current.kind === "absent") return;
		if (current.kind !== "file" || !current.version || current.path !== path)
			throw new Error(t("This group chat is no longer available."));
		const document = record(JSON.parse(current.text), "group chat document");
		if (
			document.schema !== "qorpera.company-room/v1" ||
			String(document.roomId).toLowerCase() !== roomId.toLowerCase()
		)
			throw new Error(t("This group chat is no longer available."));
		const command = await editor.edit(
			{
				operation: "delete",
				operationKey: `group-delete:${roomId.toLowerCase()}:${crypto.randomUUID()}`,
				path,
				expectedVersion: current.version,
			},
			signal,
		);
		check();
		await applyGroupCommand(editor, command, signal, check, t("The group chat could not be deleted."));
	};
}
