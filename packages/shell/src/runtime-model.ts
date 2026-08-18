import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { companyHostStorageFile } from "./company-host-storage.ts";

export interface RuntimeModelSelection {
	provider: string;
	modelId: string;
}

export interface RuntimeLaunchOptions {
	autonomousName?: string;
	sessionFile?: string;
	model?: RuntimeModelSelection;
}

const MODEL_PREFERENCE_FILE = "company-agent-model.json";
const LEGACY_MODEL_PREFERENCE_FILE = "controller-model.json";

export function defaultRuntimeModelPreferencePath(userData: string): string {
	return join(userData, MODEL_PREFERENCE_FILE);
}

export function companyRuntimeModelPreferencePath(userData: string, root: string): string {
	const normalized = process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root);
	const id = createHash("sha256").update(normalized).digest("hex");
	return companyHostStorageFile(userData, id, MODEL_PREFERENCE_FILE);
}

function legacyDefaultRuntimeModelPreferencePath(userData: string): string {
	return join(userData, LEGACY_MODEL_PREFERENCE_FILE);
}

function legacyCompanyRuntimeModelPreferencePath(userData: string, root: string): string {
	const normalized = process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root);
	const id = createHash("sha256").update(normalized).digest("hex");
	return companyHostStorageFile(userData, id, LEGACY_MODEL_PREFERENCE_FILE);
}

function modelSelection(value: unknown): RuntimeModelSelection | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.provider !== "string" || !record.provider) return undefined;
	const modelId = typeof record.modelId === "string" ? record.modelId : record.id;
	if (typeof modelId !== "string" || !modelId) return undefined;
	return { provider: record.provider, modelId };
}

/** Read the authoritative model from a successful RPC response. */
export function modelSelectionFromRpcFrame(frame: unknown): RuntimeModelSelection | undefined {
	if (!frame || typeof frame !== "object" || Array.isArray(frame)) return undefined;
	const response = frame as Record<string, unknown>;
	if (response.type !== "response" || response.success !== true) return undefined;
	if (response.command === "set_model") return modelSelection(response.data);
	if (response.command !== "get_state" || !response.data || typeof response.data !== "object") return undefined;
	return modelSelection((response.data as Record<string, unknown>).model);
}

export function runtimeModelArgs(model: RuntimeModelSelection | undefined): string[] {
	return model ? ["--model", `${model.provider}/${model.modelId}`] : [];
}

export function readCompanyRuntimeModelPreference(userData: string, root: string): RuntimeModelSelection | undefined {
	return (
		readModelPreference(
			companyRuntimeModelPreferencePath(userData, root),
			legacyCompanyRuntimeModelPreferencePath(userData, root),
		) ?? readDefaultRuntimeModelPreference(userData)
	);
}

export function readDefaultRuntimeModelPreference(userData: string): RuntimeModelSelection | undefined {
	return readModelPreference(
		defaultRuntimeModelPreferencePath(userData),
		legacyDefaultRuntimeModelPreferencePath(userData),
	);
}

function readModelPreference(path: string, legacyPath: string): RuntimeModelSelection | undefined {
	try {
		const current = modelSelection(JSON.parse(readFileSync(path, "utf-8")));
		if (current) return current;
	} catch {
		// Try the retired filename once below.
	}
	try {
		const legacy = modelSelection(JSON.parse(readFileSync(legacyPath, "utf-8")));
		if (!legacy) return undefined;
		if (writeModelPreference(path, legacy)) rmSync(legacyPath, { force: true });
		return legacy;
	} catch {
		return undefined;
	}
}

export function runtimeLaunchOptions(
	userData: string,
	root: string,
	kickoff: string | undefined,
	sessionFile: string | undefined,
): RuntimeLaunchOptions {
	const model = readCompanyRuntimeModelPreference(userData, root);
	return kickoff ? { autonomousName: "conception", model } : { sessionFile, model };
}

export function writeCompanyRuntimeModelPreference(
	userData: string,
	root: string,
	model: RuntimeModelSelection,
): boolean {
	return writeModelPreference(companyRuntimeModelPreferencePath(userData, root), model);
}

export function writeDefaultRuntimeModelPreference(userData: string, model: RuntimeModelSelection): boolean {
	return writeModelPreference(defaultRuntimeModelPreferencePath(userData), model);
}

export function clearCompanyRuntimeModelPreference(userData: string, root: string): boolean {
	const clearedCurrent = clearModelPreference(companyRuntimeModelPreferencePath(userData, root));
	const clearedLegacy = clearModelPreference(legacyCompanyRuntimeModelPreferencePath(userData, root));
	return clearedCurrent && clearedLegacy;
}

export function clearDefaultRuntimeModelPreference(userData: string): boolean {
	const clearedCurrent = clearModelPreference(defaultRuntimeModelPreferencePath(userData));
	const clearedLegacy = clearModelPreference(legacyDefaultRuntimeModelPreferencePath(userData));
	return clearedCurrent && clearedLegacy;
}

function clearModelPreference(path: string): boolean {
	try {
		rmSync(path, { force: true });
		return true;
	} catch {
		return false;
	}
}

function writeModelPreference(path: string, model: RuntimeModelSelection): boolean {
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
