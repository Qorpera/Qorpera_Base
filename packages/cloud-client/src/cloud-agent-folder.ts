/** An agent's folder in the company folder (contract 5.6): `agents/<agent-name>/`, holding its
 * `agent.md`, memory, skills, routines and todos. Every caller that needs an agent's folder asks
 * here (the runtime's skill tools and catalog, the web composer's skill list), so they always
 * agree on it.
 *
 * Until a company keeps its agents in named folders with an `agent.md` and its index (the
 * storage core's folder-v2 companies, workstream F2), an agent's folder is
 * `agents/<staffAgentId>`, as its memory notebook's is: an id never changes, so nothing is
 * orphaned by a rename. The company is an argument because that switch is made company by
 * company; this function is the one place it is made. Browser-safe. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function cloudAgentFolder(companyId: string, staffAgentId: string): string {
	if (!UUID.test(companyId) || !UUID.test(staffAgentId)) throw new Error("Invalid agent folder owner");
	return `agents/${staffAgentId}`;
}
