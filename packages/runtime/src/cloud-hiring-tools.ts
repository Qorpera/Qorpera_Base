import { osPath } from "@qorpera/cloud-client/company-state-files";
import type { CloudFolderGroupChat, CloudFolderGroupChats } from "./cloud-folder-group-chats.ts";
import type { CloudFolderHire, CloudFolderHiring } from "./cloud-folder-hiring.ts";
import type { CloudNativeToolIdentity } from "./cloud-native-tool-authority.ts";
import { type CloudNativeTool, CloudToolArgumentRefusal, type CloudToolContext } from "./cloud-native-tool-boundary.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";

const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The figures a client can draw (cloud-client staff-characters). The colour follows the figure. */
const FIGURES = ["planet", "acorn", "flame", "rocket", "crown", "heart", "ghost"] as const;
const FIELDS = ["operationKey", "name", "role", "jobDescription", "firstAssignment", "figure"] as const;

function text(value: unknown, maxBytes: number, singleLine: boolean): string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.includes("\0") ||
		(singleLine && /[\r\n]/.test(value)) ||
		Buffer.byteLength(value.trim()) > maxBytes ||
		Buffer.from(value).toString("utf8") !== value
	)
		throw new Error("Invalid hire text");
	return value.trim();
}

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
export const CLOUD_GROUP_CHAT_TOOL_DESCRIPTION_FOLDER =
	`Open a group chat with coworkers when work needs several of you in one place; for a question to one coworker use send_coworker_message instead. The chat is saved as its own folder, ${osPath("agents/groups")}/<name>/group.md, which lists its agents and people and holds its purpose. ` +
	"coworkerIds are the ids of coworkers listed in your context; you are always a member, and the member who asked is included unless you set includeRequestingMember to false. Give it a short name people will recognise and a one-sentence purpose. " +
	"When the result's outcome is saved the chat exists: tell the member its name. Keep operationKey stable for one intended chat and reuse it only with identical arguments: an unconfirmed result needs the same key and arguments again. A conflict or a refusal needs a new key.";

/** A folder-v2 company's hire (thin writers W4a): the agent's folder, with the first assignment as a todo. */
export const CLOUD_HIRE_TOOL_DESCRIPTION_FOLDER =
	`Hire a new coworker for this company. The hire is saved as the agent's own folder: ${osPath("agents")}/<name>/agent.md holds its job description, the instructions it works by, and its first assignment becomes an open todo in its todos folder. When the result's outcome is saved, the platform starts the agent on its first assignment by itself, usually within a minute: tell the member who you hired and why; send a coworker message only if it has not begun after a few minutes. If your own access to the company's files is limited, the hire waits for an owner or admin to approve it on a card. ` +
	`Hire for a continuing responsibility that nobody owns, not for a one-off task. First see who already owns what: each coworker's agent.md under ${osPath("agents")}/ says what it does. An existing coworker who can own it beats a new hire. Write jobDescription as the new agent's thin job specification: mission, the outcomes it owns, its voice, and when it should escalate and to whom. Write firstAssignment (at most 4000 bytes) as the first concrete piece of work it should start on. figure picks its avatar. ` +
	"Keep operationKey stable for one intended hire and reuse it only with identical arguments: an unconfirmed result needs the same key and arguments again, never a new key. A conflict or a refusal needs a new key.";
/** The todo a folder-v2 hire's first assignment becomes holds at most this much (§2 "todo"). */
const FOLDER_ASSIGNMENT_BYTES = 4000;

/** A company's hire and group chat on the company folder (thin writers W4a, W4b): each is saved by its folder writer
 * as the agent's or the chat's own folder, under the call's receipt and its review. The model never supplies an
 * identity, a grant or a path.
 */
export function cloudHiringTools(
	identity: CloudNativeToolIdentity,
	writers: { folderHiring: CloudFolderHiring; folderGroupChats: CloudFolderGroupChats },
): readonly CloudNativeTool[] {
	const { folderHiring, folderGroupChats } = writers;
	const expected = Object.freeze({ ...identity });
	// One request per operation key in this run: a key is bound to the first request that ran under it.
	const hires = new Map<string, string>();
	const chats = new Map<string, string>();
	// The earlier request may already have taken effect (an unconfirmed result), so the refusal
	// points at where it would be rather than inviting a second one under a new key.
	const refuseRebinding = (
		bound: Map<string, string>,
		operationKey: string,
		request: string,
		kind: "hire" | "chat",
	) => {
		const previous = bound.get(operationKey);
		if (previous !== undefined && previous !== request)
			throw new CloudToolArgumentRefusal(
				kind === "hire"
					? `operationKey is already used in this run for a different hire, which may already exist: check ${osPath("agents")}/ before hiring again, and repeat this operationKey only with identical arguments`
					: `operationKey is already used in this run for a different group chat, which may already exist: check ${osPath("agents/groups")}/ before opening another, and repeat this operationKey only with identical arguments`,
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
				name: { type: "string", minLength: 1, maxLength: 160 },
				role: { type: "string", minLength: 1, maxLength: 320 },
				jobDescription: { type: "string", minLength: 1, maxLength: 16384 },
				firstAssignment: { type: "string", minLength: 1, maxLength: FOLDER_ASSIGNMENT_BYTES },
				figure: { type: "string", enum: [...FIGURES] },
			},
		},
		parseArguments(value) {
			if (
				!value ||
				typeof value !== "object" ||
				Array.isArray(value) ||
				Object.keys(value).some((key) => !FIELDS.includes(key as (typeof FIELDS)[number]))
			)
				throw new Error("Invalid hire request");
			const a = value as Record<string, unknown>;
			if (typeof a.operationKey !== "string" || !OPERATION_KEY.test(a.operationKey))
				throw new Error("Invalid hire key");
			// The schema counts characters; the todo the assignment becomes holds bytes.
			if (
				typeof a.firstAssignment === "string" &&
				Buffer.byteLength(a.firstAssignment.trim()) > FOLDER_ASSIGNMENT_BYTES
			)
				throw new CloudToolArgumentRefusal(
					`firstAssignment holds at most ${FOLDER_ASSIGNMENT_BYTES} bytes in this company: shorten it`,
				);
			if (a.figure !== undefined && !FIGURES.includes(a.figure as (typeof FIGURES)[number]))
				throw new Error("Invalid hire figure");
			const hire = {
				operationKey: a.operationKey,
				name: text(a.name, 160, true),
				role: text(a.role, 320, true),
				jobDescription: text(a.jobDescription, 16384, false),
				firstAssignment: text(a.firstAssignment, FOLDER_ASSIGNMENT_BYTES, false),
				figure: (a.figure as string | undefined) ?? "planet",
			};
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
				name: { type: "string", minLength: 1, maxLength: 256 },
				purpose: { type: "string", minLength: 1, maxLength: 2048 },
				coworkerIds: {
					type: "array",
					minItems: 1,
					maxItems: 16,
					uniqueItems: true,
					items: { type: "string", pattern: UUID.source },
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
				name: text(a.name, 256, true),
				purpose: text(a.purpose, 2048, false),
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
	return [tool, roomTool];
}
