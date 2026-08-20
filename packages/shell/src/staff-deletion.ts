import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export function removeStaffWorkspace(agentDirectory: string, keepArtifacts: boolean): void {
	if (!existsSync(agentDirectory)) return;
	if (!keepArtifacts) {
		rmSync(agentDirectory, { recursive: true, force: true });
		return;
	}

	const entries = readdirSync(agentDirectory, { withFileTypes: true });
	const hasPhysicalArtifactsDirectory = entries.some(
		(entry) => entry.name === "artifacts" && entry.isDirectory() && !entry.isSymbolicLink(),
	);
	if (!hasPhysicalArtifactsDirectory) {
		rmSync(agentDirectory, { recursive: true, force: true });
		return;
	}
	for (const entry of entries) {
		if (entry.name === "artifacts" && entry.isDirectory() && !entry.isSymbolicLink()) continue;
		rmSync(join(agentDirectory, entry.name), { recursive: true, force: true });
	}
}
