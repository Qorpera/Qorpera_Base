import { type CompanyStateSetting, setCompanyStateSettings } from "@qorpera/cloud-client/company-state-files";
import { describeError } from "../cloud/client.ts";
import {
	deleteStateFolder,
	parentPath,
	parseStateFile,
	rewriteStateFile,
	type WebMemberFolder,
	withStateBody,
} from "../cloud/company-folder-writes.ts";
import type { GroupChatDraft } from "../cloud/group-details.ts";
import { UUID_PATTERN } from "../cloud/parse.ts";
import { t } from "../ui/preferences.ts";
import type { CompanyController } from "./company.ts";
import type { WorkspaceActions } from "./workspace-actions.ts";

/* A group chat is a company folder, `agents/groups/<handle>`, described by its `group.md` (folder core C4, P34a-2;
 * deploy/first-node/RUNTIME-COMPANY-FOLDER-C4-MEMBERS.md §5). Editing one rewrites that file; deleting its folder
 * closes the chat for everyone. The commit's hook keeps the room, its members and its conversation. */

/** This invocation failed before sending a write; an earlier invocation may still be uncertain. */
export class GroupUpdateNotWrittenError extends Error {}

/** The group's participants would not pass: fewer than two active agents, someone who left, or a duplicate. */
export class GroupParticipantsError extends Error {}

/** Every room change is an owner's or admin's. */
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

function memberKey(members: GroupChatDraft["members"]): string {
	return JSON.stringify(members.map(({ kind, id }) => `${kind}:${id}`).sort());
}

/** A group chat's `group.md` path from the member's state folders, or null when it has none. */
async function groupFile(folder: WebMemberFolder, roomId: string, signal: AbortSignal): Promise<string | null> {
	const id = roomId.toLowerCase();
	return (await folder.stateFolders(signal)).groups.find((group) => group.roomId === id)?.file ?? null;
}

/** The new `group.md` for a draft: only what the member changed since `observed` (the details they opened) is written,
 * so a change made meanwhile to another field survives. Null when the file already says it all. */
export function rewriteGroupFile(
	text: string,
	path: string,
	roomId: string,
	observed: GroupChatDraft,
	draft: GroupChatDraft,
): string | null {
	const parsed = parseStateFile(path, text);
	if (!parsed.ok || parsed.file.kind !== "group" || parsed.file.id !== roomId.toLowerCase())
		throw new Error(t("This group chat is no longer available."));
	const file = parsed.file;
	const changes: Record<string, CompanyStateSetting> = {};
	if (draft.name !== observed.name && draft.name !== file.name) changes.name = draft.name;
	if (draft.subtitle !== undefined && draft.subtitle !== (observed.subtitle ?? "") && draft.subtitle !== file.subtitle)
		changes.subtitle = draft.subtitle;
	// The agents and the people are two lists: each is written only when the member changed it.
	for (const [setting, kind] of [
		["agents", "staff_agent"],
		["people", "member"],
	] as const) {
		const of = (members: GroupChatDraft["members"]) => members.filter((member) => member.kind === kind);
		if (memberKey(of(draft.members)) === memberKey(of(observed.members))) continue;
		const ids = of(draft.members).map((member) => member.id);
		if (JSON.stringify(ids) !== JSON.stringify(file[setting])) changes[setting] = ids;
	}
	let next = Object.keys(changes).length ? setCompanyStateSettings(text, changes) : text;
	if (draft.purpose !== observed.purpose.trim() && draft.purpose !== file.purpose.trim())
		next = withStateBody(next, draft.purpose);
	return next === text ? null : next;
}

/** Edits a group chat's `group.md`, naming the version it read. Answers whether it wrote: false when the file already
 * said it all. */
export function createGroupUpdater(options: {
	company: CompanyController;
	folder: (signal: AbortSignal) => WebMemberFolder;
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
			const changes: GroupChatDraft = {
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
					observed.status !== "active"
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
			const folder = options.folder(signal);
			return await rewriteStateFile(
				folder,
				{
					locate: () => groupFile(folder, observed.roomId, signal),
					rewrite: (text, path) => rewriteGroupFile(text, path, observed.roomId, observed, changes),
					key: () => `web:group-update:${observed.roomId.toLowerCase()}:${crypto.randomUUID()}`,
					gone: t("This group chat is no longer available."),
					failure: t("The group chat changes could not be saved."),
					sent: (sending) => {
						writeStarted = sending;
					},
				},
				signal,
				check,
			);
		} catch (error) {
			if (!writeStarted) throw new GroupUpdateNotWrittenError(describeError(error), { cause: error });
			throw error;
		} finally {
			busy = false;
		}
	};
}

/** Deletes a group chat for everyone: its folder leaves the company folder, and the commit's hook archives the room
 * and closes its conversation. Owners and admins only, as for every room change. */
export function createGroupDeleter(options: {
	company: CompanyController;
	folder: (signal: AbortSignal) => WebMemberFolder;
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
		const folder = options.folder(signal);
		// Deleted already (by another member, or by a lost answer to this request): nothing to do.
		await deleteStateFolder(
			folder,
			{
				locate: async () => {
					const file = await groupFile(folder, roomId, signal);
					return file === null ? null : parentPath(file);
				},
				key: () => `web:group-delete:${roomId.toLowerCase()}:${crypto.randomUUID()}`,
				failure: t("The group chat could not be deleted."),
			},
			signal,
			check,
		);
	};
}
