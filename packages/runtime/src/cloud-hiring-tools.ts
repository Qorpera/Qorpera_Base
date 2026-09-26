import { createHash } from "node:crypto";
import type { CloudCompanyPathGateway } from "./cloud-company-path-gateway.ts";
import { CloudCompanyPathRpcRefusal } from "./cloud-company-path-refusal.ts";
import type { CloudNativeToolIdentity } from "./cloud-native-tool-authority.ts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContext,
	cloudToolJsonText,
} from "./cloud-native-tool-boundary.ts";
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

/** One identity per (run, operation key): a retried proposal addresses the same agent document. */
function agentIdFor(runId: string, operationKey: string): string {
	const hex = createHash("sha256").update(`qorpera.agent-hire/v1:${runId}:${operationKey}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

interface Bound {
	request: string;
	document: string;
	/** What this run knows of applying the document: never tried, an unanswered try, or applied. */
	apply: "none" | "unknown" | "applied";
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

export const CLOUD_HIRE_TOOL_DESCRIPTION =
	"Hire a new coworker for this company. When the result says applied, the agent exists and its first run is queued, so tell the member who you hired and why. If the result says proposed, it is waiting for a member instead; say that. " +
	"Hire for a continuing responsibility that nobody owns, not for a one-off task. First see who already owns what: each coworker's responsibilities are written in its agent document under organization/agents. An existing coworker who can own it beats a new hire. Write jobDescription as the new agent's thin job specification: mission, the outcomes it owns, its voice, and when it should escalate and to whom. Write firstAssignment as the first concrete piece of work it should start on when it wakes. " +
	"The new agent starts with default read/write access to ordinary shared Company File paths, subject to protected-path approval and narrower access rules. Automatic approval requires your current authority to cover that nonexpiring default in every company environment; otherwise a member must approve the proposal. This tool cannot assign additional grants. figure picks its avatar. " +
	"Keep operationKey stable for one intended hire and reuse it only with identical arguments; an unconfirmed result needs the same key and arguments again, never a new key.";

export const CLOUD_GROUP_CHAT_TOOL_DESCRIPTION =
	"Open a group chat with coworkers when work needs several of you in one place; for a question to one coworker use send_coworker_message instead. No member approval is needed. " +
	"coworkerIds are the ids of coworkers listed in your context; you are always a member, and the member who asked is included unless you set includeRequestingMember to false. Give it a short name people will recognise and a one-sentence purpose. " +
	"When the result says applied the chat exists: tell the member its name. Keep operationKey stable for one intended chat and reuse it only with identical arguments; an unconfirmed result needs the same key and arguments again.";

/** The hire is an ordinary governed Company File write of the canonical agent
 * document (contract 14.1), so attribution, proposal, approval and the
 * projection that creates the agent and its single first-run wake are the
 * existing kernel's. The model never supplies an identity, a grant or a path.
 */
export function cloudHiringTools(
	gateway: Pick<CloudCompanyPathGateway, "mutate" | "applyOwnOrganizationDocument">,
	identity: CloudNativeToolIdentity,
	now: () => Date = () => new Date(),
): readonly CloudNativeTool[] {
	const expected = Object.freeze({ ...identity });
	// One request per operation key in this run. The document is built once, so a retry carries
	// identical bytes, and every receipt field is read from it, never from a later request.
	const hires = new Map<string, Bound>();
	const chats = new Map<string, Bound>();
	// The earlier request may already have taken effect (an unconfirmed result), so the refusal
	// points at where it would be rather than inviting a second one under a new key.
	const refuseRebinding = (
		bound: Map<string, Bound>,
		operationKey: string,
		request: string,
		kind: "hire" | "chat",
	) => {
		const previous = bound.get(operationKey);
		if (previous && previous.request !== request)
			throw new CloudToolArgumentRefusal(
				kind === "hire"
					? "operationKey is already used in this run for a different hire, which may already exist: check organization/agents before hiring again, and repeat this operationKey only with identical arguments"
					: "operationKey is already used in this run for a different group chat, which may already exist: check organization/rooms before opening another, and repeat this operationKey only with identical arguments",
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
	// A new agent or room document is approved by policy and applied at once. A validated refusal
	// from the cloud leaves it a proposal for a member, but only while no apply of it was ever
	// tried: a refusal (an expired lease, a stop) can also meet a document that is already applied.
	// An applied document stays applied, so a replay reports it without asking again. Any other
	// failure may follow the commit, so the outcome is read back once through the same proposal:
	// the approval lane replays an applied proposal as applied and finishes an approved one. Still
	// unknown, the call throws, is reported unconfirmed, and the same key settles it later.
	const settle = async (
		result: Awaited<ReturnType<CloudCompanyPathGateway["mutate"]>>,
		bound: Bound,
		signal: AbortSignal,
	): Promise<"applied" | "proposed"> => {
		if (result.state !== "proposed" || !result.proposalId) return result.state;
		if (bound.apply === "applied") return "applied";
		for (;;) {
			try {
				await gateway.applyOwnOrganizationDocument(result.proposalId, bound.document, signal);
				bound.apply = "applied";
				return "applied";
			} catch (error) {
				signal.throwIfAborted();
				if (error instanceof CloudCompanyPathRpcRefusal && bound.apply === "none") return "proposed";
				if (bound.apply === "unknown") throw error;
				bound.apply = "unknown";
			}
		}
	};
	const tool: CloudNativeTool = {
		name: "hire_agent" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_HIRE_TOOL_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["operationKey", "name", "role", "jobDescription", "firstAssignment"],
			properties: {
				operationKey: { type: "string", pattern: OPERATION_KEY.source },
				name: { type: "string", minLength: 1, maxLength: 160 },
				role: { type: "string", minLength: 1, maxLength: 320 },
				jobDescription: { type: "string", minLength: 1, maxLength: 16384 },
				firstAssignment: { type: "string", minLength: 1, maxLength: 8192 },
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
			if (a.figure !== undefined && !FIGURES.includes(a.figure as (typeof FIGURES)[number]))
				throw new Error("Invalid hire figure");
			const hire = {
				operationKey: a.operationKey,
				name: text(a.name, 160, true),
				role: text(a.role, 320, true),
				jobDescription: text(a.jobDescription, 16384, false),
				firstAssignment: text(a.firstAssignment, 8192, false),
				figure: (a.figure as string | undefined) ?? "planet",
			};
			refuseRebinding(hires, hire.operationKey, hireRequest(hire), "hire");
			return hire;
		},
		async execute(value, context) {
			assertContext(context);
			const hire = value as Record<string, string>;
			const request = hireRequest(hire);
			refuseRebinding(hires, hire.operationKey, request, "hire");
			let bound = hires.get(hire.operationKey);
			if (!bound) {
				const agentId = agentIdFor(expected.runId, hire.operationKey);
				const document = `${JSON.stringify(
					{
						schema: "qorpera.company-agent/v1",
						agentId,
						revision: 1,
						displayName: hire.name,
						role: hire.role,
						hireOverlay: { charter: hire.jobDescription, templateId: null },
						appearance: { color: "native", shape: "round", creature: hire.figure },
						modelPolicy: { provider: null, modelId: null },
						reasoningPolicy: { effort: "low" },
						grants: { responsibilities: [], projects: [], rooms: [], resources: [] },
						startupInstructions: hire.firstAssignment,
						employmentStatus: "active",
						lifecycleState: "setup",
						createdAt: now().toISOString(),
					},
					null,
					2,
				)}\n`;
				bound = { request, document, apply: "none" };
				hires.set(hire.operationKey, bound);
			}
			const committed = JSON.parse(bound.document) as { agentId: string; displayName: string; role: string };
			const result = await gateway.mutate(
				"write",
				{
					path: `organization/agents/${committed.agentId}.json`,
					operationKey: `hire:${hire.operationKey}`,
					expectedVersion: null,
					text: bound.document,
				},
				context.signal,
				context.observation,
			);
			const state = await settle(result, bound, context.signal);
			return {
				kind: "text",
				value: cloudToolJsonText({
					schema: "qorpera.agent-hire-receipt/v1",
					runId: expected.runId,
					agentId: committed.agentId,
					name: committed.displayName,
					role: committed.role,
					state,
					proposalId: result.proposalId,
					receiptId: result.receiptId,
					awaiting: state === "proposed" ? "member_approval" : null,
				}),
			};
		},
	};
	const roomFields = ["operationKey", "name", "purpose", "coworkerIds", "includeRequestingMember"] as const;
	const roomTool: CloudNativeTool = {
		name: "create_group_chat" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_GROUP_CHAT_TOOL_DESCRIPTION,
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
			let bound = chats.get(chat.operationKey);
			if (!bound) {
				const roomId = agentIdFor(expected.runId, `room:${chat.operationKey}`);
				bound = {
					request,
					apply: "none",
					document: JSON.stringify({
						schema: "qorpera.company-room/v1",
						roomId,
						key: `chat-${roomId}`,
						name: chat.name,
						purpose: chat.purpose,
						status: "active",
						projectId: null,
						members: [
							...(chat.includeRequestingMember ? [{ kind: "member", id: expected.requesterUserId }] : []),
							{ kind: "staff_agent", id: expected.staffAgentId },
							...chat.coworkerIds.map((id) => ({ kind: "staff_agent", id })),
						],
						version: 1,
					}),
				};
				chats.set(chat.operationKey, bound);
			}
			const committed = JSON.parse(bound.document) as { roomId: string; name: string };
			const result = await gateway.mutate(
				"write",
				{
					path: `organization/rooms/${committed.roomId}.json`,
					operationKey: `room:${chat.operationKey}`,
					expectedVersion: null,
					text: bound.document,
				},
				context.signal,
				context.observation,
			);
			const state = await settle(result, bound, context.signal);
			return {
				kind: "text",
				value: cloudToolJsonText({
					schema: "qorpera.group-chat-receipt/v1",
					runId: expected.runId,
					roomId: committed.roomId,
					name: committed.name,
					state,
					proposalId: result.proposalId,
					receiptId: result.receiptId,
					awaiting: state === "proposed" ? "member_approval" : null,
				}),
			};
		},
	};
	return [tool, roomTool];
}
