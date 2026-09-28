/** An agent's folder in the company folder (contract 5.6): `agents/<agent-name>/`, holding its
 * `agent.md`, memory, skills, routines and todos. Every caller that needs an agent's folder asks
 * here, so runtime, database-free readers and the web client always agree on it.
 *
 * Until agents live in named folders with an `agent.md` and its index (workstream F2 of the
 * rebuild, folder-v2 companies), an agent's folder is `agents/<staffAgentId>`: an id never
 * changes, so nothing is orphaned by a rename in the meantime. This function is the one place
 * that then reads the indexed name instead. Browser-safe. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function cloudAgentFolder(agent: { readonly id: string }): string {
	if (!UUID.test(agent.id)) throw new Error("Invalid agent id");
	return `agents/${agent.id}`;
}
