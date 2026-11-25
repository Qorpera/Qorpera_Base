import { osPath } from "@qorpera/cloud-client/company-state-files";
import { POSTGRES_UUID_ANY_CASE_PATTERN as UUID } from "@qorpera/contracts";
import type { CloudFolderSidebar, CloudFolderSidebarRequest } from "./cloud-folder-sidebar.ts";
import {
	type CloudNativeToolBinding,
	type CloudNativeToolIdentity,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";
import type { CloudNativeTool, CloudToolContext } from "./cloud-native-tool-boundary.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";

const ACTIONS = ["list", "create_section", "rename_section", "delete_section", "move_agent"] as const;
type SidebarAction = (typeof ACTIONS)[number];
/** The fields each action takes; the cloud refuses anything else as well. */
const FIELDS: Record<SidebarAction, { required: readonly string[]; optional: readonly string[] }> = {
	list: { required: [], optional: [] },
	create_section: { required: ["name"], optional: [] },
	rename_section: { required: ["section", "name"], optional: [] },
	delete_section: { required: ["section"], optional: [] },
	move_agent: { required: ["agentId", "section"], optional: [] },
};

export const CLOUD_SIDEBAR_TOOL_DESCRIPTION = [
	"Organize the company's sidebar sections, the groups agents appear under in the members' rails (the Co-Founder always stays on top, outside any section), to keep the team findable as it grows: group agents who work together, and move yourself or a coworker when work shifts. No member approval is needed, and every member sees a change, except where a member placed things themself. Pins, hidden agents and what a member placed themself are each member's own, not yours to change.",
	"Actions:",
	"- list: every section with its agents in order, then the agents in no section (Unassigned).",
	"- create_section: a section called name (a name that already exists is that section). Short plain names, such as Research or Customer support: sections are shared structure, not a place for notes.",
	"- rename_section, delete_section: name the section by its name; deleting one keeps its agents, which become Unassigned.",
	"- move_agent: agentId (yourself or a coworker's id from your context) goes last into section, or out of any section with section null.",
	`Tell the member what you changed. refused changed nothing and says why (no such section, the name is taken, the Co-Founder stays on top): correct the request or tell the member. The sections are the file ${osPath("agents/sections.md")}: a change already made saves nothing and says so; when one is refused because the file changed since it was read, call again.`,
].join("\n");

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
	/** The run's sections file writer. */
	options: { folderSidebar: CloudFolderSidebar },
): readonly CloudNativeTool[] {
	const folderSidebar = options.folderSidebar;
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
			// A company's sections are a file; the folder core decides each save.
			return folderSidebar.run(request as unknown as CloudFolderSidebarRequest, context);
		},
	};
	return [tool];
}
