import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SHELL_APPEARANCE_FILE = "shell-appearance.json";
const SHELL_APPEARANCE_SCHEMA = "qorpera.shell-appearance/v1";

interface ShellAppearance {
	schema: typeof SHELL_APPEARANCE_SCHEMA;
	sidebarTranslucency: boolean;
}

export function shellAppearancePath(userData: string): string {
	return join(userData, SHELL_APPEARANCE_FILE);
}

export function readSidebarTranslucency(userData: string): boolean {
	try {
		const parsed: unknown = JSON.parse(readFileSync(shellAppearancePath(userData), "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return true;
		const value = parsed as Partial<ShellAppearance>;
		return value.schema === SHELL_APPEARANCE_SCHEMA && typeof value.sidebarTranslucency === "boolean"
			? value.sidebarTranslucency
			: true;
	} catch {
		return true;
	}
}

export function writeSidebarTranslucency(userData: string, enabled: boolean): boolean {
	const path = shellAppearancePath(userData);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			temporary,
			`${JSON.stringify({ schema: SHELL_APPEARANCE_SCHEMA, sidebarTranslucency: enabled }, null, "\t")}\n`,
			{ encoding: "utf-8", mode: 0o600 },
		);
		renameSync(temporary, path);
		return true;
	} catch {
		rmSync(temporary, { force: true });
		return false;
	}
}
