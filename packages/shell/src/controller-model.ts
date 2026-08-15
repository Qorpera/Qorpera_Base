import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface ControllerModelSelection {
	provider: string;
	modelId: string;
}

export interface ControllerLaunchOptions {
	autonomousName?: string;
	sessionFile?: string;
	model?: ControllerModelSelection;
}

const MODEL_PREFERENCE_FILE = "controller-model.json";

export function defaultControllerModelPreferencePath(userData: string): string {
	return join(userData, MODEL_PREFERENCE_FILE);
}

export function controllerModelPreferencePath(userData: string, root: string): string {
	const normalized = process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root);
	const id = createHash("sha256").update(normalized).digest("hex");
	return join(userData, "company-kernel-state", id, MODEL_PREFERENCE_FILE);
}

function modelSelection(value: unknown): ControllerModelSelection | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.provider !== "string" || !record.provider) return undefined;
	const modelId = typeof record.modelId === "string" ? record.modelId : record.id;
	if (typeof modelId !== "string" || !modelId) return undefined;
	return { provider: record.provider, modelId };
}

/** Read the authoritative model from a successful RPC response. */
export function modelSelectionFromRpcFrame(frame: unknown): ControllerModelSelection | undefined {
	if (!frame || typeof frame !== "object" || Array.isArray(frame)) return undefined;
	const response = frame as Record<string, unknown>;
	if (response.type !== "response" || response.success !== true) return undefined;
	if (response.command === "set_model") return modelSelection(response.data);
	if (response.command !== "get_state" || !response.data || typeof response.data !== "object") return undefined;
	return modelSelection((response.data as Record<string, unknown>).model);
}

export function controllerModelArgs(model: ControllerModelSelection | undefined): string[] {
	return model ? ["--model", `${model.provider}/${model.modelId}`] : [];
}

export function readControllerModelPreference(userData: string, root: string): ControllerModelSelection | undefined {
	try {
		return modelSelection(JSON.parse(readFileSync(controllerModelPreferencePath(userData, root), "utf-8")));
	} catch {
		return readDefaultControllerModelPreference(userData);
	}
}

export function readDefaultControllerModelPreference(userData: string): ControllerModelSelection | undefined {
	try {
		return modelSelection(JSON.parse(readFileSync(defaultControllerModelPreferencePath(userData), "utf-8")));
	} catch {
		return undefined;
	}
}

export function controllerLaunchOptions(
	userData: string,
	root: string,
	kickoff: string | undefined,
	sessionFile: string | undefined,
): ControllerLaunchOptions {
	const model = readControllerModelPreference(userData, root);
	return kickoff ? { autonomousName: "conception", model } : { sessionFile, model };
}

export function writeControllerModelPreference(
	userData: string,
	root: string,
	model: ControllerModelSelection,
): boolean {
	return writeModelPreference(controllerModelPreferencePath(userData, root), model);
}

export function writeDefaultControllerModelPreference(userData: string, model: ControllerModelSelection): boolean {
	return writeModelPreference(defaultControllerModelPreferencePath(userData), model);
}

function writeModelPreference(path: string, model: ControllerModelSelection): boolean {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temporary, `${JSON.stringify(model, null, "\t")}\n`, {
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
