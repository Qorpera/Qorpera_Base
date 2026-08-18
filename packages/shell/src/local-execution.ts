import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { companyHostStorageFile } from "./company-host-storage.ts";

export type LocalExecutionPermission = "always" | "never";

const LOCAL_EXECUTION_FILE = "local-execution.json";

export function localExecutionToolArgs(
	permission: LocalExecutionPermission,
	staffToolNames?: string,
): readonly string[] {
	if (permission === "never") return ["--tools", "request_connection"];
	return staffToolNames ? ["--tools", staffToolNames] : [];
}

export function localExecutionPreferencePath(userData: string, root: string): string {
	const normalized = process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root);
	const id = createHash("sha256").update(normalized).digest("hex");
	return companyHostStorageFile(userData, id, LOCAL_EXECUTION_FILE);
}

export function readLocalExecutionPermission(userData: string, root: string): LocalExecutionPermission {
	try {
		const parsed: unknown = JSON.parse(readFileSync(localExecutionPreferencePath(userData, root), "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "never";
		return (parsed as Record<string, unknown>).permission === "always" ? "always" : "never";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "always" : "never";
	}
}

export function writeLocalExecutionPermission(
	userData: string,
	root: string,
	permission: LocalExecutionPermission,
): boolean {
	const path = localExecutionPreferencePath(userData, root);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temporary, `${JSON.stringify({ permission }, null, "\t")}\n`, {
			encoding: "utf-8",
			mode: 0o600,
		});
		renameSync(temporary, path);
		return true;
	} catch {
		rmSync(temporary, { force: true });
		return false;
	}
}
