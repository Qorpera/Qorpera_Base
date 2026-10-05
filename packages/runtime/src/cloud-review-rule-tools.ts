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

const OPERATION_KEY = /^[A-Za-z0-9_:.-]{1,128}$/;

export const CLOUD_REVIEW_RULE_TOOL_DESCRIPTION =
	'Add an Ask first rule for the member you work for. From then on, before any agent does that kind of action for them, the member is asked to approve it on a card first. Use it when the member asks you to check with them before something, for example "always ask me before you email a customer"; never add a rule the member did not ask for. ' +
	'when finishes the sentence "When an agent wants to ..." as the member would, in their language, for example "email a customer" (1 to 280 characters). ' +
	"You can only add Ask first rules. To let something run without asking, the member changes their rules at the bottom of Settings → General. The rule is the member's own: they see it there and can remove it. Tell the member the rule you added. " +
	"Keep operationKey stable when you retry: the same key is the same rule. A sentence the member already has is that rule (added is false). When the result has refused, nothing was added and it says why.";

/** One rule sentence as the kernel keeps it: trimmed, 1-280 characters, no control characters. */
function ruleText(value: unknown): string {
	if (typeof value !== "string") throw new Error("Invalid rule");
	const text = value.trim();
	if (!text || [...text].length > 280 || /\p{Cc}/u.test(text)) throw new Error("Invalid rule");
	return text;
}

/** The agent tool add_review_rule (auto-review v130, founder decision D4): an
 * agent adds an Ask first rule for the member its run works for. The cloud
 * derives the company, the member and the agent from the run. */
export function cloudReviewRuleTools(
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
		throw new Error("Review rule binding differs");
	const assertContext = (context: CloudToolContext) => {
		if (
			context.runId !== expected.runId ||
			context.companyId !== expected.companyId ||
			!context.identity ||
			Object.entries(expected).some(
				([key, value]) => context.identity![key as keyof CloudNativeToolIdentity] !== value,
			)
		)
			throw new Error("Review rule tool identity differs");
		context.signal.throwIfAborted();
	};
	const tool: CloudNativeTool = {
		name: "add_review_rule" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_REVIEW_RULE_TOOL_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["operationKey", "when"],
			properties: {
				operationKey: { type: "string", pattern: OPERATION_KEY.source },
				when: { type: "string", minLength: 1, maxLength: 280 },
			},
		},
		parseArguments(value) {
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid rule request");
			const a = value as Record<string, unknown>;
			if (
				Object.keys(a).some((key) => key !== "operationKey" && key !== "when") ||
				typeof a.operationKey !== "string" ||
				!OPERATION_KEY.test(a.operationKey)
			)
				throw new Error("Invalid rule request");
			return { operationKey: a.operationKey, when: ruleText(a.when) };
		},
		async execute(value, context) {
			assertContext(context);
			const request = value as { operationKey: string; when: string };
			// The tool's first effect: a refusal of it is the tool's answer (control calls, 4 Oct 2026).
			const result = await refusals.call(request.operationKey, () =>
				cloudToolRequest(
					(requestSignal) =>
						control.call(
							"qorpera_add_agent_review_rule",
							{ p_binding: admitted, p_request: request },
							requestSignal,
						),
					context.signal,
				),
			);
			const r = result as Record<string, unknown> | null;
			const rule = r?.rule as Record<string, unknown> | null | undefined;
			if (
				!r ||
				typeof r !== "object" ||
				r.schema !== "qorpera.agent-review-rule/v1" ||
				r.runId !== admitted.runId ||
				typeof r.added !== "boolean" ||
				(r.refused !== undefined && (typeof r.refused !== "string" || r.added || rule !== null)) ||
				(r.refused === undefined &&
					(!rule ||
						typeof rule !== "object" ||
						rule.scope !== "member" ||
						rule.outcome !== "ask_first" ||
						typeof rule.when !== "string"))
			)
				throw new Error("Review rule receipt differs");
			return { kind: "text", value: cloudToolJsonText(r) };
		},
	};
	return [tool];
}
