import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

export interface StaffAgentAppearance {
	color: string;
	shape: string;
	creature?: string;
}

/** Durable per-agent model choice. Absent means the agent inherits the
 * company runtime default; the selection persists across sessions and wakes. */
export interface StaffAgentModel {
	provider: string;
	modelId: string;
}

export type StaffAgentEmploymentStatus = "active" | "archived";
export type StaffAgentLifecycleState = "setup" | "active";

export interface StaffAgent {
	id: string;
	displayName: string;
	role: string;
	charter: string;
	templateId?: string;
	departmentId?: string;
	appearance: StaffAgentAppearance;
	model?: StaffAgentModel;
	employmentStatus: StaffAgentEmploymentStatus;
	lifecycleState: StaffAgentLifecycleState;
	createdAt: string;
	updatedAt: string;
}

const STAFF_REGISTRY_RELATIVE_PATH = join(".qorpera", "staff.json");

function canonicalRoot(root: string): string {
	const canonical = realpathSync(resolve(root));
	const entry = lstatSync(canonical);
	if (!entry.isDirectory() || entry.isSymbolicLink())
		throw new Error("Staff registry requires a physical company root");
	return canonical;
}

export function staffRegistryPath(root: string): string {
	return join(canonicalRoot(root), STAFF_REGISTRY_RELATIVE_PATH);
}
