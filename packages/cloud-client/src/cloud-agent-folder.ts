/** An agent's folder in the company folder (contract 5.6): `QorperaOS/agents/<agent-name>/`, holding its
 * `agent.md`, memory, skills, routines and todos. Every caller that needs an agent's folder asks
 * here (the runtime's memory and skill tools), so they agree on it.
 *
 * Every company is a folder-v2 company (the storage core's, workstream F2): it keeps an agent's
 * folder at `QorperaOS/agents/<handle>/`, beside its `agent.md`, and a rename moves the folder with the agent.
 * The run's context gives the handle. Browser-safe. */
import { UUID_PATTERN } from "@qorpera/contracts";
import { osPath, osRelative } from "./company-state-shared.ts";

/** A folder name the company folder accepts (lowercase words joined by single hyphens, at most 64
 * characters); `groups` holds the group chats. */
const HANDLE = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Where a company keeps an agent's folder: its folder name. */
export type CloudAgentFolderPlace = { readonly core: "folder-v2"; readonly handle: string };

export function cloudAgentFolder(companyId: string, staffAgentId: string, place: CloudAgentFolderPlace): string {
	if (!UUID_PATTERN.test(companyId) || !UUID_PATTERN.test(staffAgentId)) throw new Error("Invalid agent folder owner");
	if (place.core !== "folder-v2" || !HANDLE.test(place.handle) || place.handle === "groups")
		throw new Error("Invalid agent folder name");
	return osPath(`agents/${place.handle}`);
}

/** Whether a path is an agent's folder as cloudAgentFolder gives it. */
export function isCloudAgentFolder(path: string): boolean {
	const below = osRelative(path) ?? "";
	const name = below.startsWith("agents/") ? below.slice("agents/".length) : "";
	return HANDLE.test(name) && name !== "groups";
}
