import type { CloudCompanyPathControl } from "./cloud-company-path-gateway.ts";
import {
	type CloudNativeToolBinding,
	type CloudNativeToolIdentity,
	cloudToolRequest,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";
import { type CloudNativeTool, type CloudToolContext, cloudToolJsonText } from "./cloud-native-tool-boundary.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";

const ACTIONS = ["list", "create_section", "rename_section", "delete_section", "move_agent"] as const;
type SidebarAction = (typeof ACTIONS)[number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The fields each action takes; the cloud refuses anything else as well. */
const FIELDS: Record<SidebarAction, { required: readonly string[]; optional: readonly string[] }> = {
	list: { required: [], optional: [] },
	create_section: { required: ["name"], optional: [] },
	rename_section: { required: ["section", "name"], optional: [] },
	delete_section: { required: ["section"], optional: [] },
	move_agent: { required: ["agentId", "section"], optional: [] },
};

export const CLOUD_SIDEBAR_TOOL_DESCRIPTION =
	"Organize the company's sidebar sections, the groups agents appear under in every member's rail (the Co-Founder always stays on top, outside any section). Use it to keep the team findable as it grows: group agents who work together, and move yourself or a coworker when work shifts. No member approval is needed and everyone sees the change at once. " +
	"action list shows every section with its agents in order, then the Unassigned agents. create_section makes a section (a name that already exists is that section). rename_section and delete_section name the section by its id or name; deleting a section keeps its agents, they become Unassigned. move_agent moves agentId (yourself or a coworker id from your context) into section, or out of any section when section is null; it goes last in that section. " +
	"Sections are shared structure, not a place for notes: short plain names such as Research or Customer support. Tell the member what you changed. When the result has refused, nothing changed and it says why (no such section, the name is taken, the Co-Founder stays on top): correct the request or tell the member. Pins and hidden agents are each member's own and not yours to change.";

function sectionName(value: unknown): string {
	if (typeof value !== "string") throw new Error("Invalid sidebar section name");
	const name = value.trim().replace(/\s+/g, " ");
	if (!name || name.length > 60 || /\p{Cc}/u.test(name)) throw new Error("Invalid sidebar section name");
	return name;
}

function sectionRef(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 200 || /\p{Cc}/u.test(value))
		throw new Error("Invalid sidebar section");
	return value.trim();
}

/** The cloud derives the company and the acting agent from the run; the model
 * chooses only the section and which agent moves. */
export function cloudSidebarTools(
	binding: CloudNativeToolBinding,
	identity: CloudNativeToolIdentity,
	control: CloudCompanyPathControl,
): readonly CloudNativeTool[] {
	const admitted = parseCloudNativeToolBinding(binding),
		expected = Object.freeze({ ...identity });
	if (
		Object.entries(admitted).some(
			([key, value]) => key !== "credentialCapsuleId" && expected[key as keyof CloudNativeToolIdentity] !== value,
		)
	)
		throw new Error("Sidebar binding differs");
	const assertContext = (context: CloudToolContext) => {
		if (
			context.runId !== expected.runId ||
			context.companyId !== expected.companyId ||
			!context.identity ||
			Object.entries(expected).some(
				([key, value]) => context.identity![key as keyof CloudNativeToolIdentity] !== value,
			)
		)
			throw new Error("Sidebar tool identity differs");
		context.signal.throwIfAborted();
	};
	const tool: CloudNativeTool = {
		name: "organize_sidebar" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_SIDEBAR_TOOL_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["action"],
			properties: {
				action: { type: "string", enum: [...ACTIONS] },
				name: { type: "string", minLength: 1, maxLength: 60 },
				section: { type: ["string", "null"], minLength: 1, maxLength: 200 },
				agentId: { type: "string", pattern: UUID.source },
			},
		},
		parseArguments(value) {
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid sidebar request");
			const a = value as Record<string, unknown>;
			const action = a.action as SidebarAction;
			if (!ACTIONS.includes(action)) throw new Error("Invalid sidebar action");
			const fields = FIELDS[action];
			if (
				Object.keys(a).some(
					(key) => key !== "action" && !fields.required.includes(key) && !fields.optional.includes(key),
				) ||
				fields.required.some((key) => !Object.hasOwn(a, key))
			)
				throw new Error("Invalid sidebar request");
			const request: Record<string, unknown> = { action };
			if (Object.hasOwn(a, "name")) request.name = sectionName(a.name);
			if (Object.hasOwn(a, "section"))
				request.section = action === "move_agent" && a.section === null ? null : sectionRef(a.section);
			if (Object.hasOwn(a, "agentId")) {
				if (typeof a.agentId !== "string" || !UUID.test(a.agentId)) throw new Error("Invalid sidebar agent");
				request.agentId = a.agentId.toLowerCase();
			}
			return request as never;
		},
		async execute(value, context) {
			assertContext(context);
			const request = value as Record<string, unknown>;
			const result = await cloudToolRequest(
				(requestSignal) =>
					control.call("qorpera_manage_agent_sidebar", { p_binding: admitted, p_request: request }, requestSignal),
				context.signal,
			);
			const r = result as Record<string, unknown> | null;
			if (
				!r ||
				typeof r !== "object" ||
				r.schema !== "qorpera.agent-sidebar/v1" ||
				r.runId !== admitted.runId ||
				r.action !== request.action ||
				typeof r.changed !== "boolean" ||
				!Array.isArray(r.sections) ||
				!Array.isArray(r.unassigned) ||
				(r.refused !== undefined && (typeof r.refused !== "string" || r.changed))
			)
				throw new Error("Sidebar receipt differs");
			return { kind: "text", value: cloudToolJsonText(r) };
		},
	};
	return [tool];
}
