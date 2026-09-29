/** An agent's folder in the company folder (contract 5.6): `agents/<agent-name>/`, holding its
 * `agent.md`, memory, skills, routines and todos. Every caller that needs an agent's folder asks
 * here (the runtime's memory and skill tools, the web composer's skill list), so they always agree
 * on it.
 *
 * Where it is depends on the company's storage core, which is fixed when the company is created:
 * a snapshot-v1 company (every company today) keeps an agent's folder at `agents/<staffAgentId>`,
 * as its memory notebook's is: an id never changes, so nothing is orphaned by a rename. A folder-v2
 * company (the storage core's, workstream F2) keeps it at `agents/<handle>/`, beside its
 * `agent.md`, and a rename moves the folder with the agent. The run's context says which, and gives
 * the handle. This function is the one place the switch is made. Browser-safe. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A folder name the company folder accepts (lowercase words joined by single hyphens, at most 64
 * characters); `groups` holds the group chats. */
const HANDLE = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Where a company keeps its agents' folders. */
export type CloudAgentFolderPlace =
	| { readonly core: "snapshot-v1" }
	| { readonly core: "folder-v2"; readonly handle: string };

/** Every company today. */
export const CLOUD_AGENT_FOLDER_BY_ID: CloudAgentFolderPlace = Object.freeze({ core: "snapshot-v1" });

export function cloudAgentFolder(
	companyId: string,
	staffAgentId: string,
	place: CloudAgentFolderPlace = CLOUD_AGENT_FOLDER_BY_ID,
): string {
	if (!UUID.test(companyId) || !UUID.test(staffAgentId)) throw new Error("Invalid agent folder owner");
	if (place.core === "snapshot-v1") return `agents/${staffAgentId}`;
	if (place.core !== "folder-v2" || !HANDLE.test(place.handle) || place.handle === "groups")
		throw new Error("Invalid agent folder name");
	return `agents/${place.handle}`;
}
