import { osPath } from "@qorpera/cloud-client/company-state-files";
import { isStaffCharacterId, STAFF_CHARACTER_IDS } from "@qorpera/cloud-client/staff-characters";
import type { CloudFolderGroupChat, CloudFolderGroupChats } from "./cloud-folder-group-chats.ts";
import {
	type CloudFolderHire,
	type CloudFolderHiring,
	type CloudFolderRoleEnd,
	type CloudFolderTeamHire,
	TEAM_HIRES_MAX,
	TEAM_HIRES_MIN,
} from "./cloud-folder-hiring.ts";
import type { CloudNativeToolIdentity } from "./cloud-native-tool-authority.ts";
import { type CloudNativeTool, CloudToolArgumentRefusal, type CloudToolContext } from "./cloud-native-tool-boundary.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";

const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FIELDS = ["operationKey", "name", "role", "jobDescription", "firstAssignment", "figure"] as const;
const MEMBER_FIELDS = ["name", "role", "jobDescription", "firstAssignment", "figure"] as const;
const TEAM_FIELDS = ["operationKey", "hires"] as const;
const TEAM_ARGUMENT_BYTES = 90 * 1024;
/** The todo a folder-v2 hire's first assignment becomes holds at most this much (§2 "todo"). */
const FOLDER_ASSIGNMENT_BYTES = 4000;

const HIRE_HOLDS = "name, role, jobDescription, firstAssignment and figure (figure is optional)";
const KEY_RULE =
	"one key for the call: 1 to 96 letters, digits, '.', '_', ':' or '-', starting with a letter or a digit";

function text(value: unknown, field: string, maxBytes: number, singleLine: boolean, where: string, bound = ""): string {
	const refuse = (problem: string) => new CloudToolArgumentRefusal(`${where}${field} ${problem}`);
	if (value === undefined) throw refuse("is missing");
	if (typeof value !== "string") throw refuse("must be text");
	if (!value.trim()) throw refuse("is empty");
	if (value.includes("\0")) throw refuse("holds a NUL character: remove it");
	if (singleLine && /[\r\n]/.test(value)) throw refuse("must be one line, with no line breaks");
	if (Buffer.from(value).toString("utf8") !== value) throw refuse("is not valid text");
	if (Buffer.byteLength(value.trim()) > maxBytes) throw refuse(`holds at most ${maxBytes} bytes${bound}: shorten it`);
	return value.trim();
}

function holdsOther(value: object, allowed: readonly string[]): boolean {
	return Object.keys(value).some((key) => !allowed.includes(key));
}

function operationKeyOf(value: unknown): string {
	if (value === undefined) throw new CloudToolArgumentRefusal(`operationKey is missing: ${KEY_RULE}`);
	if (typeof value !== "string" || !OPERATION_KEY.test(value))
		throw new CloudToolArgumentRefusal(`operationKey is not a valid key: ${KEY_RULE}`);
	return value;
}

function hireFields(a: Record<string, unknown>, where: string) {
	const hire = {
		name: text(a.name, "name", 160, true, where),
		role: text(a.role, "role", 320, true, where),
		jobDescription: text(a.jobDescription, "jobDescription", 16384, false, where),
		firstAssignment: text(
			a.firstAssignment,
			"firstAssignment",
			FOLDER_ASSIGNMENT_BYTES,
			false,
			where,
			" in this company",
		),
	};
	if (a.figure !== undefined && !isStaffCharacterId(a.figure))
		throw new CloudToolArgumentRefusal(`${where}figure must be one of ${STAFF_CHARACTER_IDS.join(", ")}`);
	return { ...hire, figure: (a.figure as string | undefined) ?? "planet" };
}

function teamRequest(team: { operationKey: string; hires: readonly Record<string, string>[] }): string {
	return JSON.stringify([
		team.operationKey,
		team.hires.map((hire) => [hire.name, hire.role, hire.jobDescription, hire.firstAssignment, hire.figure]),
	]);
}

const MEMBER_PROPERTIES = {
	name: {
		type: "string",
		minLength: 1,
		maxLength: 160,
		description:
			"How everyone finds it in the app, so name it by its work: one to three plain words for what it owns, in the founders' language (such as Customer research, Market, Brand or Bookkeeping). Never a person's name, and never a name a coworker already has.",
	},
	role: { type: "string", minLength: 1, maxLength: 320 },
	jobDescription: {
		type: "string",
		minLength: 1,
		maxLength: 16384,
		description:
			"Its thin job specification: mission, the outcomes it owns, its voice, and when to escalate and to whom.",
	},
	firstAssignment: {
		type: "string",
		minLength: 1,
		maxLength: FOLDER_ASSIGNMENT_BYTES,
		description: `The first concrete piece of work it starts on, at most ${FOLDER_ASSIGNMENT_BYTES} bytes.`,
	},
	figure: { type: "string", enum: [...STAFF_CHARACTER_IDS], description: "Its avatar." },
};

/** Everything a hire request decides, in a fixed order: what one operation key is bound to. */
function hireRequest(hire: Record<string, string>): string {
	return JSON.stringify([
		hire.operationKey,
		hire.name,
		hire.role,
		hire.jobDescription,
		hire.firstAssignment,
		hire.figure,
	]);
}

function chatRequest(chat: {
	operationKey: string;
	name: string;
	purpose: string;
	coworkerIds: string[];
	includeRequestingMember: boolean;
}): string {
	return JSON.stringify([chat.operationKey, chat.name, chat.purpose, chat.coworkerIds, chat.includeRequestingMember]);
}

/** A folder-v2 company's group chat (thin writers W4b): its folder under QorperaOS/agents/groups, with group.md. */
export const CLOUD_GROUP_CHAT_TOOL_DESCRIPTION_FOLDER = [
	"Open a group chat with coworkers when work needs several of you in one place; a question to one coworker goes by send_coworker_message.",
	`The chat is its own folder, ${osPath("agents/groups")}/<name>/group.md, which lists its agents and people and holds its purpose. You are always a member, and the member who asked is included unless includeRequestingMember is false. When the answer's outcome is saved the chat exists: tell the member its name. A conflict or a refusal needs a new operationKey.`,
].join("\n");

/** A folder-v2 company's hire (thin writers W4a): the agent's folder, with the first assignment as a todo. */
export const CLOUD_HIRE_TOOL_DESCRIPTION_FOLDER = [
	`Hire one new coworker, at any time as the company evolves, for a continuing responsibility that nobody owns, not for a one-off task (give that to a worker). To hire two or more at one time, above all the first team, use hire_team. First see who owns what: each coworker's agent.md under ${osPath("agents")}/ says what it does. Give it to an existing coworker only when it is the same kind of work and that coworker has room; otherwise hire.`,
	`The hire is the agent's own folder: ${osPath("agents")}/<name>/agent.md holds its job description, the instructions it works by, and its first assignment becomes an open todo in its todos folder. When the answer's outcome is saved, the platform starts the agent on its first assignment by itself, usually within a minute: tell the member who you hired and why, and send it a coworker message only if it has not begun after a few minutes. When your own access to the company's files is limited, the hire waits for an owner or admin to approve it on a card.`,
	"A conflict or a refusal needs a new operationKey.",
].join("\n");
export const CLOUD_HIRE_TEAM_TOOL_DESCRIPTION = [
	`Hire two or more new coworkers at one time, above all the company's first team, so that each starts knowing the others: one call, one review, and the whole team is saved together. Each is for a continuing responsibility that nobody owns, not for a one-off task (give that to a worker); one hire, at any later time as the company evolves, goes by hire_agent. First see who owns what: each coworker's agent.md under ${osPath("agents")}/ says what it does.`,
	`operationKey is given once, for the whole call, never inside a hire. hires holds 2 to 12 hires, and each hire holds only name (one line of at most 160 bytes, a name no other hire or coworker has), role (one line of at most 320 bytes), jobDescription (at most 16,384 bytes), firstAssignment (at most 4,000 bytes) and figure (optional). Each hire is the agent's own folder, ${osPath("agents")}/<name>/agent.md, with its job description and the instructions it works by; its first assignment becomes an open todo in its todos folder. When the answer's outcome is saved, the platform starts each on its first assignment by itself, usually within a minute, and each one's first run already lists the whole team: tell the member who you hired and why. When your own access to the company's files is limited, the team waits for an owner or admin to approve it on one card.`,
	"All hires together hold at most about 80 KB of text; hire a larger team in two calls. A conflict or a refusal needs a new operationKey.",
].join("\n");
/** The end of an agent's role (the company's reading of itself, 20260930766000): its agent.md set to archived. */
export const CLOUD_END_ROLE_TOOL_DESCRIPTION = [
	`End an agent's role when its work is over: its ${osPath("agents")}/<name>/agent.md is set to archived, through the automatic review, which may ask a member on a card.`,
	`agent is its folder name under ${osPath("agents")}/; reason is one sentence a founder reads on why its work is over, at most 280 characters. The Co-Founder's role, your own and one already ended are refused.`,
	"When the answer's outcome is saved, the platform pauses its routines and closes its threads by itself; its files stay, and a member can bring it back: tell the founders who and why. A conflict or a refusal needs a new operationKey.",
].join("\n");
/** One sentence of why a role ends, in characters. */
const END_ROLE_REASON_CHARS = 280;

/** A company's hire, group chat and end of a role on the company folder (thin writers W4a, W4b; 20260930766000): each is
 * saved by its folder writer as the agent's or the chat's own folder, or the agent's agent.md, under the call's receipt
 * and its review. The model never supplies an identity, a grant or a path.
 */
export function cloudHiringTools(
	identity: CloudNativeToolIdentity,
	writers: { folderHiring: CloudFolderHiring; folderGroupChats: CloudFolderGroupChats },
): readonly CloudNativeTool[] {
	const { folderHiring, folderGroupChats } = writers;
	const expected = Object.freeze({ ...identity });
	// One request per operation key in this run: a key is bound to the first request that ran under it.
	const hires = new Map<string, string>();
	const teams = new Map<string, string>();
	const chats = new Map<string, string>();
	const ends = new Map<string, string>();
	// The earlier request may already have taken effect (an unconfirmed result), so the refusal
	// points at where it would be rather than inviting a second one under a new key.
	const refuseRebinding = (
		bound: Map<string, string>,
		operationKey: string,
		request: string,
		kind: "hire" | "team" | "chat" | "end",
	) => {
		const previous = bound.get(operationKey);
		if (previous !== undefined && previous !== request)
			throw new CloudToolArgumentRefusal(
				kind === "hire" || kind === "team"
					? `operationKey is already used in this run for a different hire, which may already exist: check ${osPath("agents")}/ before hiring again, and repeat this operationKey only with identical arguments`
					: kind === "chat"
						? `operationKey is already used in this run for a different group chat, which may already exist: check ${osPath("agents/groups")}/ before opening another, and repeat this operationKey only with identical arguments`
						: "operationKey is already used in this run for ending another role, which may already have ended: repeat this operationKey only with identical arguments",
			);
	};
	const assertContext = (context: CloudToolContext) => {
		if (
			context.runId !== expected.runId ||
			context.companyId !== expected.companyId ||
			!context.identity ||
			Object.entries(expected).some(
				([key, value]) => context.identity![key as keyof CloudNativeToolIdentity] !== value,
			)
		)
			throw new Error("Hiring tool identity differs");
		context.signal.throwIfAborted();
	};
	const tool: CloudNativeTool = {
		name: "hire_agent" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_HIRE_TOOL_DESCRIPTION_FOLDER,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["operationKey", "name", "role", "jobDescription", "firstAssignment"],
			properties: {
				operationKey: { type: "string", pattern: OPERATION_KEY.source },
				...MEMBER_PROPERTIES,
			},
		},
		parseArguments(value) {
			if (!value || typeof value !== "object" || Array.isArray(value))
				throw new CloudToolArgumentRefusal(`hire_agent takes one object with operationKey, ${HIRE_HOLDS}`);
			if (holdsOther(value, FIELDS))
				throw new CloudToolArgumentRefusal(
					`hire_agent takes operationKey, ${HIRE_HOLDS}; it was given a key that is none of these`,
				);
			const a = value as Record<string, unknown>;
			const hire = { operationKey: operationKeyOf(a.operationKey), ...hireFields(a, "") };
			refuseRebinding(hires, hire.operationKey, hireRequest(hire), "hire");
			// The hire's files are checked now, before the automatic review.
			folderHiring.check(hire as unknown as CloudFolderHire);
			return hire;
		},
		async execute(value, context) {
			assertContext(context);
			const hire = value as Record<string, string>;
			const request = hireRequest(hire);
			refuseRebinding(hires, hire.operationKey, request, "hire");
			// The agent's folder, saved under this call's receipt with its review. The key is bound to this request first,
			// so reusing it with other arguments is refused, not retried.
			if (!hires.has(hire.operationKey)) hires.set(hire.operationKey, request);
			return folderHiring.hire(hire as unknown as CloudFolderHire, context);
		},
	};
	const roomFields = ["operationKey", "name", "purpose", "coworkerIds", "includeRequestingMember"] as const;
	const roomTool: CloudNativeTool = {
		name: "create_group_chat" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_GROUP_CHAT_TOOL_DESCRIPTION_FOLDER,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["operationKey", "name", "purpose", "coworkerIds"],
			properties: {
				operationKey: { type: "string", pattern: OPERATION_KEY.source },
				name: { type: "string", minLength: 1, maxLength: 256, description: "A short name people will recognise." },
				purpose: { type: "string", minLength: 1, maxLength: 2048, description: "One sentence." },
				coworkerIds: {
					type: "array",
					minItems: 1,
					maxItems: 16,
					uniqueItems: true,
					items: { type: "string", pattern: UUID.source },
					description: "The ids of coworkers listed in your context, up to 16.",
				},
				includeRequestingMember: { type: "boolean" },
			},
		},
		parseArguments(value) {
			if (
				!value ||
				typeof value !== "object" ||
				Array.isArray(value) ||
				Object.keys(value).some((key) => !roomFields.includes(key as (typeof roomFields)[number]))
			)
				throw new Error("Invalid group chat request");
			const a = value as Record<string, unknown>;
			if (typeof a.operationKey !== "string" || !OPERATION_KEY.test(a.operationKey))
				throw new Error("Invalid group chat key");
			if (
				!Array.isArray(a.coworkerIds) ||
				a.coworkerIds.length < 1 ||
				a.coworkerIds.length > 16 ||
				a.coworkerIds.some((id) => typeof id !== "string" || !UUID.test(id) || id === expected.staffAgentId) ||
				new Set(a.coworkerIds).size !== a.coworkerIds.length
			)
				throw new Error("Invalid group chat coworkers");
			if (a.includeRequestingMember !== undefined && typeof a.includeRequestingMember !== "boolean")
				throw new Error("Invalid group chat membership");
			const chat = {
				operationKey: a.operationKey,
				name: text(a.name, "name", 256, true, ""),
				purpose: text(a.purpose, "purpose", 2048, false, ""),
				coworkerIds: [...(a.coworkerIds as string[])].sort(),
				includeRequestingMember: a.includeRequestingMember !== false,
			};
			refuseRebinding(chats, chat.operationKey, chatRequest(chat), "chat");
			// The chat's file is checked now, before the automatic review.
			folderGroupChats.check(chat);
			return chat;
		},
		async execute(value, context) {
			assertContext(context);
			const chat = value as {
				operationKey: string;
				name: string;
				purpose: string;
				coworkerIds: string[];
				includeRequestingMember: boolean;
			};
			const request = chatRequest(chat);
			refuseRebinding(chats, chat.operationKey, request, "chat");
			// The chat's folder, saved under this call's receipt with its review. The key is bound to this request first,
			// so reusing it with other arguments is refused, not retried.
			if (!chats.has(chat.operationKey)) chats.set(chat.operationKey, request);
			return folderGroupChats.create(chat satisfies CloudFolderGroupChat, context);
		},
	};
	const endFields = ["operationKey", "agent", "reason"] as const;
	const endRequest = (end: CloudFolderRoleEnd) => JSON.stringify([end.operationKey, end.agent, end.reason]);
	const endTool: CloudNativeTool = {
		name: "end_role" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_END_ROLE_TOOL_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["operationKey", "agent", "reason"],
			properties: {
				operationKey: { type: "string", pattern: OPERATION_KEY.source },
				agent: { type: "string" },
				reason: { type: "string" },
			},
		},
		parseArguments(value) {
			if (
				!value ||
				typeof value !== "object" ||
				Array.isArray(value) ||
				Object.keys(value).some((key) => !endFields.includes(key as (typeof endFields)[number]))
			)
				throw new Error("Invalid end of a role");
			const a = value as Record<string, unknown>;
			if (typeof a.operationKey !== "string" || !OPERATION_KEY.test(a.operationKey))
				throw new Error("Invalid end of a role key");
			const reason = typeof a.reason === "string" ? a.reason.trim() : "";
			if (!reason || /[\r\n\0]/.test(reason) || [...reason].length > END_ROLE_REASON_CHARS)
				throw new CloudToolArgumentRefusal(
					`reason is one sentence of at most ${END_ROLE_REASON_CHARS} characters on why the work is over`,
				);
			if (typeof a.agent !== "string" || !a.agent.trim())
				throw new CloudToolArgumentRefusal(`agent is the agent's folder name under ${osPath("agents")}/`);
			const end = { operationKey: a.operationKey, agent: a.agent.trim(), reason };
			refuseRebinding(ends, end.operationKey, endRequest(end), "end");
			return end;
		},
		// The agent is read before the review: the card names it, and what cannot end is refused before any card.
		async prepare(value, context) {
			assertContext(context);
			return (await folderHiring.prepareEndRole(value as unknown as CloudFolderRoleEnd, context.signal)) as never;
		},
		async execute(value, context) {
			assertContext(context);
			const end = value as unknown as CloudFolderRoleEnd;
			const request = endRequest(end);
			refuseRebinding(ends, end.operationKey, request, "end");
			// Bound before it runs, so reusing the key with other arguments is refused, not retried.
			if (!ends.has(end.operationKey)) ends.set(end.operationKey, request);
			return folderHiring.endRole(end, context);
		},
	};
	const teamTool: CloudNativeTool = {
		name: "hire_team" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_HIRE_TEAM_TOOL_DESCRIPTION,
		maxArgumentBytes: TEAM_ARGUMENT_BYTES,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["operationKey", "hires"],
			properties: {
				operationKey: { type: "string", pattern: OPERATION_KEY.source },
				hires: {
					type: "array",
					minItems: TEAM_HIRES_MIN,
					maxItems: TEAM_HIRES_MAX,
					items: {
						type: "object",
						additionalProperties: false,
						required: ["name", "role", "jobDescription", "firstAssignment"],
						properties: MEMBER_PROPERTIES,
					},
				},
			},
		},
		parseArguments(value) {
			const takes = `hire_team takes operationKey, once for the whole call, and hires, a list of ${TEAM_HIRES_MIN} to ${TEAM_HIRES_MAX} hires`;
			if (!value || typeof value !== "object" || Array.isArray(value))
				throw new CloudToolArgumentRefusal(`${takes}, as one object`);
			if (holdsOther(value, TEAM_FIELDS))
				throw new CloudToolArgumentRefusal(`${takes}; it was given a key that is neither`);
			const a = value as Record<string, unknown>;
			const operationKey = operationKeyOf(a.operationKey);
			if (a.hires === undefined)
				throw new CloudToolArgumentRefusal(`hires is missing: ${takes}, each holding ${HIRE_HOLDS}`);
			if (!Array.isArray(a.hires))
				throw new CloudToolArgumentRefusal(
					`hires must be a list of hire objects${typeof a.hires === "string" ? ", not text holding one: send the list itself" : ""}`,
				);
			if (a.hires.length < TEAM_HIRES_MIN || a.hires.length > TEAM_HIRES_MAX)
				throw new CloudToolArgumentRefusal(
					`hires holds ${TEAM_HIRES_MIN} to ${TEAM_HIRES_MAX} hires and has ${a.hires.length}; ${a.hires.length < TEAM_HIRES_MIN ? "hire one coworker with hire_agent" : "hire a larger team in two calls"}`,
				);
			const team = {
				operationKey,
				hires: a.hires.map((hire: unknown, index: number) => {
					const where = `hire ${index + 1}: `;
					if (!hire || typeof hire !== "object" || Array.isArray(hire))
						throw new CloudToolArgumentRefusal(`hire ${index + 1} must be an object holding ${HIRE_HOLDS}`);
					if ("operationKey" in hire)
						throw new CloudToolArgumentRefusal(
							`${where}operationKey is given once for the whole call, never inside a hire. A hire holds ${HIRE_HOLDS}`,
						);
					if (holdsOther(hire, MEMBER_FIELDS))
						throw new CloudToolArgumentRefusal(
							`${where}holds a key that is not a field of a hire. A hire holds ${HIRE_HOLDS}`,
						);
					return hireFields(hire as Record<string, unknown>, where);
				}),
			};
			refuseRebinding(teams, team.operationKey, teamRequest(team), "team");
			folderHiring.checkTeam(team as unknown as CloudFolderTeamHire);
			return team;
		},
		async execute(value, context) {
			assertContext(context);
			const team = value as { operationKey: string; hires: Record<string, string>[] };
			const request = teamRequest(team);
			refuseRebinding(teams, team.operationKey, request, "team");
			if (!teams.has(team.operationKey)) teams.set(team.operationKey, request);
			return folderHiring.hireTeam(team as unknown as CloudFolderTeamHire, context);
		},
	};
	return [tool, roomTool, endTool, teamTool];
}
