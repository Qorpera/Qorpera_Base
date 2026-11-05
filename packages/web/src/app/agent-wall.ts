import { WALL_MAX_BYTES, wallPath } from "@qorpera/cloud-client/agent-wall";
import type { CloudMemberFolderClient } from "@qorpera/cloud-client/cloud-member-folder";

/* An agent's wall on the web (ui/agent-wall-poster.ts): the text of QorperaOS/agents/<handle>/wall.md, read with the
 * member's own folder client as the apps are (app/interface-apps.ts). The agent's folder handle comes from the member's
 * state folders (the agent's agent.md), once per thread; the file is read again only when its version changed. */

type Folder = Pick<CloudMemberFolderClient, "read" | "readFile" | "stateFolders">;

const TEXT = new TextDecoder("utf-8", { fatal: true });

/** Reads one thread's agent walls: the text, or null when the agent has no wall (or it is no text, or too large). */
export function agentWallReader(
	folder: () => Folder,
): (staffAgentId: string, signal: AbortSignal) => Promise<string | null> {
	const handles = new Map<string, string>();
	const last = new Map<string, { version: string; text: string }>();
	const handleOf = async (from: Folder, staffAgentId: string, signal: AbortSignal, fresh: boolean) => {
		const known = fresh ? undefined : handles.get(staffAgentId);
		if (known !== undefined) return known;
		const file = (await from.stateFolders(signal)).agents.find((item) => item.staffAgentId === staffAgentId)?.file;
		const handle = file?.split("/").at(-2);
		if (!handle) {
			handles.delete(staffAgentId);
			return null;
		}
		handles.set(staffAgentId, handle);
		return handle;
	};
	return async (staffAgentId, signal) => {
		const from = folder();
		let handle = await handleOf(from, staffAgentId, signal, false);
		if (handle === null) return null;
		let entry = (await from.read(wallPath(handle), signal)).entry;
		// The agent's folder may have moved (a rename): its handle is read again once.
		if (!entry) {
			const again = await handleOf(from, staffAgentId, signal, true);
			if (again === null) return null;
			if (again !== handle) {
				handle = again;
				entry = (await from.read(wallPath(handle), signal)).entry;
			}
		}
		if (entry?.kind !== "file" || !entry.file || entry.file.bytes > WALL_MAX_BYTES) {
			last.delete(staffAgentId);
			return null;
		}
		const kept = last.get(staffAgentId);
		if (kept?.version === entry.version) return kept.text;
		// A read that fails throws (the thread keeps what it showed); bytes that are no text are no wall.
		const bytes = await from.readFile(entry.file, signal, WALL_MAX_BYTES);
		let text: string;
		try {
			text = TEXT.decode(bytes);
		} catch {
			return null;
		}
		last.set(staffAgentId, { version: entry.version, text });
		return text;
	};
}
