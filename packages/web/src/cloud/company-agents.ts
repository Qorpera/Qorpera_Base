import {
	COMPANY_STATE_RESERVED_AGENT_NAMES,
	type CompanyStateSetting,
	companyStatePath,
	setCompanyStateSettings,
	writeAgentFile,
} from "@qorpera/cloud-client/company-state-files";
import { isStaffCharacterId, type StaffCharacterId } from "@qorpera/cloud-client/staff-characters";
import { agentFileColour } from "./agent-colours.ts";
import type { WebCompanyFiles } from "./company-files.ts";
import {
	createStateFolder,
	deleteStateFolder,
	parentPath,
	parseStateFile,
	rewriteStateFile,
	type WebMemberFolder,
	withProblems,
	withStateBody,
} from "./company-folder-writes.ts";
import type { HostedStaffAgent } from "./types.ts";

/** What a member can change about an agent from the browser. */
export interface WebCompanyAgentDraft {
	displayName: string;
	role: string;
	charter: string;
	figure: string;
	color: string;
}

export interface WebCompanyAgentCreation extends WebCompanyAgentDraft {
	id: string;
	createdAt: string;
}

/** An agent is a folder of the company, `agents/<handle>`, described by its `agent.md` (folder core C4, P34a-2;
 * deploy/first-node/RUNTIME-COMPANY-FOLDER-C4-MEMBERS.md §5). Creating, changing or deleting one is a member's
 * change to the folder; the commit's hook keeps the roster, and the browser never writes the roster itself. */
export interface WebCompanyAgents {
	create(draft: WebCompanyAgentCreation, signal: AbortSignal): Promise<string>;
	/** Answers the roster version that shows the change: one more than the agent's for a write, the agent's own when
	 * there was nothing to write. */
	update(agent: HostedStaffAgent, draft: WebCompanyAgentDraft, signal: AbortSignal): Promise<number>;
	/** Deleting the agent's folder removes the agent for good (owner or admin; never the Co-Founder). */
	delete(agent: HostedStaffAgent, signal: AbortSignal): Promise<void>;
}

// The description is the agent's responsibilities in plain prose (founder decision 2026-09-20) and the
// reference it works from. It carries no name, because a rename must not leave a stale one behind, and no
// platform behavior: how an agent without responsibilities behaves belongs to the runtime's hire overlay.
const blankCharter =
	"No responsibilities have been written for this agent yet. Replace this text with what the agent is responsible for, in plain words.";

/** The folders a hired agent has, as the runtime's hire makes them. The web's form has no first assignment, so a
 * web-made agent has no first todo: it starts from its instructions when it is first messaged. */
const AGENT_FOLDERS = ["memory", "skills", "routines", "todos"] as const;

/** A figure's own shade, as the web draws it. */
type NativeShade = (figure: StaffCharacterId) => string;

function agentText(draft: WebCompanyAgentCreation, native?: NativeShade): string {
	const figure = isStaffCharacterId(draft.figure) ? draft.figure : null;
	return writeAgentFile({
		id: draft.id,
		name: draft.displayName,
		role: draft.role,
		agentKind: "agent",
		status: "active",
		colour: agentFileColour(draft.color, figure ? native?.(figure) : undefined),
		figure,
		model: null,
		effort: null,
		instructions: draft.charter || blankCharter,
	});
}

/** Validate before the view retains an attempt and locks its editable fields: the new `agent.md` must be a file the
 * shared parser accepts, at most 64 KiB. The handle is decided at the commit and cannot add a problem, nor can the
 * colour. */
export function prepareWebCompanyAgentCreation<T extends WebCompanyAgentDraft>(draft: T): T & WebCompanyAgentCreation {
	const creation = { ...draft, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
	const parsed = parseStateFile("agents/agent/agent.md", agentText(creation));
	if (!parsed.ok) throw new Error(withProblems("The agent cannot be saved as the company's files.", parsed.problems));
	return creation;
}

/** An agent's `agent.md` path from the member's state folders, or null when the agent has none (gone, or not
 * readable by this member). */
async function agentFile(folder: WebMemberFolder, agentId: string, signal: AbortSignal): Promise<string | null> {
	const file = (await folder.stateFolders(signal)).agents.find((item) => item.staffAgentId === agentId)?.file ?? null;
	if (file !== null && companyStatePath(file)?.kind !== "agent") throw new Error("The agent's folder is not readable");
	return file;
}

/** The editor's fields as the roster shows an agent, to tell what a draft changed. */
function rosterDraft(agent: HostedStaffAgent): WebCompanyAgentDraft {
	return {
		displayName: agent.displayName,
		role: agent.role,
		charter: agent.charter,
		figure: agent.appearance.creature ?? "",
		color: agent.appearance.color,
	};
}

export function createWebCompanyAgents(
	files: Pick<WebCompanyFiles, "signal" | "current" | "folder">,
	options: {
		/** What the editor shows for an agent: a draft field equal to it was not changed, so the file keeps its own
		 * value (an agent's own edit made meanwhile survives). The web passes its resolved figure and colour. */
		saved?: (agent: HostedStaffAgent) => WebCompanyAgentDraft;
		/** A figure's own shade: a draft in its figure's own shade writes no colour. The web passes the figure model's. */
		native?: NativeShade;
	} = {},
): WebCompanyAgents {
	const saved = options.saved ?? rosterDraft;
	const native = options.native;
	const scope = (signal: AbortSignal) => {
		const lifetime = AbortSignal.any([files.signal, signal]);
		const check = () => {
			lifetime.throwIfAborted();
			files.current();
		};
		check();
		return { lifetime, check, folder: files.folder() };
	};
	return {
		async create(draft, signal) {
			const { lifetime, check, folder } = scope(signal);
			// A retry of a draft whose answer was lost: its agent is there under the draft's id.
			const existing = await agentFile(folder, draft.id, lifetime);
			check();
			if (existing !== null) return draft.id;
			await createStateFolder(
				folder,
				{
					parent: "agents",
					name: draft.displayName,
					fallback: "agent",
					reserved: COMPANY_STATE_RESERVED_AGENT_NAMES,
					key: (handle) => `web:staff-create:${draft.id}:${handle}`,
					contents: [
						{ path: "agent.md", kind: "file", text: agentText(draft, native) },
						...AGENT_FOLDERS.map((path) => ({ path, kind: "folder" as const })),
					],
					failure: "The agent could not be created.",
				},
				lifetime,
				check,
			);
			return draft.id;
		},
		async update(agent, draft, signal) {
			const { lifetime, check, folder } = scope(signal);
			const before = saved(agent);
			const written = await rewriteStateFile(
				folder,
				{
					locate: () => agentFile(folder, agent.id, lifetime),
					rewrite: (text, path) => {
						const parsed = parseStateFile(path, text);
						if (!parsed.ok || parsed.file.kind !== "agent" || parsed.file.id !== agent.id)
							throw new Error("This agent's file has changed. Reopen it before saving.");
						const file = parsed.file;
						const changes: Record<string, CompanyStateSetting> = {};
						const name = draft.displayName.trim();
						if (name !== before.displayName && name !== file.name) changes.name = name;
						const role = draft.role.trim();
						if (role !== before.role && role !== file.role) changes.role = role;
						const figure = isStaffCharacterId(draft.figure) ? draft.figure : null;
						if (draft.figure !== before.figure && figure !== file.figure) changes.figure = figure;
						// A colour kept through a change of figure counts as chosen when the file has none: it was the
						// old figure's own shade, and the new figure is to wear it.
						if (draft.color !== before.color || (draft.figure !== before.figure && file.colour === null)) {
							const colour = agentFileColour(draft.color, figure ? native?.(figure) : undefined);
							if (colour !== file.colour) changes.colour = colour;
						}
						let next = Object.keys(changes).length ? setCompanyStateSettings(text, changes) : text;
						// An emptied description keeps the instructions: an agent always has some.
						const charter = draft.charter.trim();
						if (charter && charter !== before.charter.trim() && charter !== file.instructions)
							next = withStateBody(next, charter);
						return next === text ? null : next;
					},
					key: () => `web:staff-update:${agent.id}:${crypto.randomUUID()}`,
					gone: "This agent is no longer available.",
					failure: "The agent's changes could not be saved.",
				},
				lifetime,
				check,
			);
			// Each change to agent.md raises the roster's version by one.
			return written ? agent.version + 1 : agent.version;
		},
		async delete(agent, signal) {
			if (agent.templateId === "co-founder") throw new Error("The Co-Founder cannot be deleted.");
			const { lifetime, check, folder } = scope(signal);
			await deleteStateFolder(
				folder,
				{
					locate: async () => {
						const file = await agentFile(folder, agent.id, lifetime);
						return file === null ? null : parentPath(file);
					},
					key: () => `web:staff-delete:${agent.id}:${crypto.randomUUID()}`,
					failure: "The agent could not be deleted.",
				},
				lifetime,
				check,
			);
		},
	};
}
