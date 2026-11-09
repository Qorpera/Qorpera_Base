import type { JsonValue } from "@qorpera/contracts";
import type { CloudCompanyPathControl } from "./cloud-company-path-gateway.ts";
import {
	type CloudNativeToolBinding,
	type CloudNativeToolIdentity,
	cloudToolRequest,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";
import {
	CloudControlRefusalRelay,
	type CloudNativeTool,
	type CloudToolContext,
	cloudToolJsonText,
} from "./cloud-native-tool-boundary.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";

/* The Co-Founder deals the team out between the members (migrations 20260930700000 and 20260930702000; Jonas, 9 Nov
 * 2026: "the co-founder should hire some categories/sections to one member/subscription, and another category of agent
 * to another member"). Each agent works for one member, whose ChatGPT carries the work handed to it. The Co-Founder
 * sees who works for whom (crew_and_members) and asks a member to take agents (offer_agents_to_member); nothing moves
 * until the member says yes on the Members page. The cloud derives the company and the Co-Founder from the run. */

export const CLOUD_CREW_AND_MEMBERS_DESCRIPTION =
	"See the company's members and its team: each member's name, role and whether their ChatGPT can carry work now " +
	"(ready, full until a time, needs a new sign-in, or none connected), each agent with the member it works for " +
	"(null: nobody), and the open asks to take agents. The member an agent works for carries the work handed to it on " +
	"their ChatGPT. Use it before offer_agents_to_member.";

export const CLOUD_OFFER_AGENTS_DESCRIPTION =
	"Ask one member to take some agents, so the work handed to them runs on that member's ChatGPT. member is their " +
	"name, first name or email; agents are 1 to 20 agent names; why is one short sentence the member sees (up to 280 " +
	"characters), such as which area is theirs. Nothing moves until the member says yes on the Members page, and an " +
	"agent that already works for them or already waits for an answer is left as it is. With two or more founders, " +
	"deal the team out by area so each founder carries the areas that fit what they said they want to own; offer a " +
	"member's agents to another when one carries far more, or when someone's ChatGPT is full or needs a new sign-in " +
	"while their agents wait. Never offer agents to a viewer or to a member with no ChatGPT connected. Tell the members " +
	"once, briefly, what you offered whom and why.";

const TEXT = (value: unknown, max: number) =>
	typeof value === "string" && value.trim().length > 0 && [...value.trim()].length <= max && !/\p{Cc}/u.test(value);

/** The tools crew_and_members and offer_agents_to_member, the Co-Founder's only (the cloud refuses any other run). */
export function cloudMemberOfferTools(
	binding: CloudNativeToolBinding,
	identity: CloudNativeToolIdentity,
	control: CloudCompanyPathControl,
): readonly CloudNativeTool[] {
	const admitted = parseCloudNativeToolBinding(binding),
		expected = Object.freeze({ ...identity });
	const refusals = new CloudControlRefusalRelay();
	if (
		Object.entries(admitted).some(
			([key, value]) => key !== "credentialCapsuleId" && expected[key as keyof CloudNativeToolIdentity] !== value,
		)
	)
		throw new Error("Member offer binding differs");
	const assertContext = (context: CloudToolContext) => {
		if (
			context.runId !== expected.runId ||
			context.companyId !== expected.companyId ||
			!context.identity ||
			Object.entries(expected).some(
				([key, value]) => context.identity![key as keyof CloudNativeToolIdentity] !== value,
			)
		)
			throw new Error("Member offer tool identity differs");
		context.signal.throwIfAborted();
	};
	const answered = (result: unknown, schema: string): Record<string, unknown> => {
		const r = result as Record<string, unknown> | null;
		if (!r || typeof r !== "object" || r.schema !== schema || r.runId !== admitted.runId)
			throw new Error("Member offer receipt differs");
		return r;
	};
	const crew: CloudNativeTool = {
		name: "crew_and_members" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_CREW_AND_MEMBERS_DESCRIPTION,
		inputSchema: { type: "object", additionalProperties: false, properties: {} },
		parseArguments(value) {
			if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 0)
				throw new Error("crew_and_members takes no arguments");
			return {};
		},
		async execute(_value, context) {
			assertContext(context);
			const result = await refusals.call(undefined, () =>
				cloudToolRequest(
					(requestSignal) => control.call("qorpera_cofounder_crew", { p_binding: admitted }, requestSignal),
					context.signal,
				),
			);
			const r = answered(result, "qorpera.cofounder-crew/v1");
			if (!Array.isArray(r.members) || !Array.isArray(r.agents) || !Array.isArray(r.asks))
				throw new Error("Member offer receipt differs");
			const names = new Map(
				(r.members as Record<string, unknown>[]).map((member) => [member.userId, member.name as string]),
			);
			const agents = new Map((r.agents as Record<string, unknown>[]).map((agent) => [agent.agentId, agent.name]));
			const lines = [
				...(r.members as Record<string, unknown>[]).map((member) =>
					cloudToolJsonText({
						member: member.name as JsonValue,
						role: member.role as JsonValue,
						chatgpt: member.login as JsonValue,
						agents: (r.agents as Record<string, unknown>[])
							.filter((agent) => agent.worksFor === member.userId)
							.map((agent) => agent.name as JsonValue),
					}),
				),
				cloudToolJsonText({
					worksForNobody: (r.agents as Record<string, unknown>[])
						.filter((agent) => agent.worksFor === null || !names.has(agent.worksFor))
						.map((agent) => agent.name as JsonValue),
				}),
				...(r.asks as Record<string, unknown>[]).map((ask) =>
					cloudToolJsonText({
						waiting: (agents.get(ask.agentId) ?? "an agent") as JsonValue,
						for: (names.get(ask.answerBy) ?? "a member") as JsonValue,
						to: (names.get(ask.to) ?? "a member") as JsonValue,
						...(typeof ask.why === "string" ? { why: ask.why } : {}),
					}),
				),
			];
			return { kind: "text", value: lines.join("\n") };
		},
	};
	const offer: CloudNativeTool = {
		name: "offer_agents_to_member" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_OFFER_AGENTS_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["member", "agents"],
			properties: {
				member: { type: "string", minLength: 1, maxLength: 320 },
				agents: {
					type: "array",
					minItems: 1,
					maxItems: 20,
					items: { type: "string", minLength: 1, maxLength: 160 },
				},
				why: { type: "string", minLength: 1, maxLength: 280 },
			},
		},
		parseArguments(value) {
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid offer");
			const a = value as Record<string, unknown>;
			if (
				Object.keys(a).some((key) => !["member", "agents", "why"].includes(key)) ||
				!TEXT(a.member, 320) ||
				!Array.isArray(a.agents) ||
				a.agents.length < 1 ||
				a.agents.length > 20 ||
				!a.agents.every((agent) => TEXT(agent, 160)) ||
				(a.why !== undefined && !TEXT(a.why, 280))
			)
				throw new Error("Invalid offer");
			return {
				member: (a.member as string).trim(),
				agents: (a.agents as string[]).map((agent) => agent.trim()),
				...(a.why === undefined ? {} : { why: (a.why as string).trim() }),
			};
		},
		async execute(value, context) {
			assertContext(context);
			// The same offer again asks nothing twice, so a refusal of a retry is the tool's answer.
			const result = await refusals.call(undefined, () =>
				cloudToolRequest(
					(requestSignal) =>
						control.call(
							"qorpera_offer_agents_to_member",
							{ p_binding: admitted, p_request: value as JsonValue },
							requestSignal,
						),
					context.signal,
				),
			);
			const r = answered(result, "qorpera.agent-offers/v1");
			if (!Array.isArray(r.asked) || !Array.isArray(r.alreadyTheirs) || !Array.isArray(r.alreadyAsked))
				throw new Error("Member offer receipt differs");
			return {
				kind: "text",
				value: cloudToolJsonText({
					member: r.member as JsonValue,
					asked: r.asked as JsonValue,
					alreadyTheirs: r.alreadyTheirs as JsonValue,
					alreadyWaiting: r.alreadyAsked as JsonValue,
					next: "Nothing moves until the member says yes on the Members page.",
				}),
			};
		},
	};
	return [crew, offer];
}
