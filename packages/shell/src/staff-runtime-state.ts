import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { companyRootId } from "./company-host-state.ts";
import { companyHostStorageFile } from "./company-host-storage.ts";

export type StaffIntroStatus = "pending" | "started" | "completed" | "failed";

export interface StaffOrientationContext {
	services: string[];
	otherService?: string;
}

export interface StaffIntroState {
	staffAgentId: string;
	trailFile: string;
	status: StaffIntroStatus;
	attempts: number;
	createdAt: string;
	updatedAt: string;
	error?: string;
	orientation?: StaffOrientationContext;
}

export interface StaffRuntimeState {
	version: 1;
	intros: Record<string, StaffIntroState>;
}

export interface StaffIntroClaim {
	claimed: boolean;
	state: StaffRuntimeState;
}

const STAFF_RUNTIME_STATE_FILE = "staff-runtime.json";
const MAX_ERROR_BYTES = 2_048;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_ORIENTATION_SERVICES = 24;
const MAX_ORIENTATION_SERVICE_BYTES = 128;
const MAX_OTHER_SERVICE_BYTES = 2_048;

function emptyState(): StaffRuntimeState {
	return { version: 1, intros: {} };
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && Boolean(value.trim()) && !value.includes("\0");
}

function timestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function orientationValue(value: unknown): StaffOrientationContext | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Record<string, unknown>;
	if (
		Object.keys(candidate).some((key) => key !== "services" && key !== "otherService") ||
		!Array.isArray(candidate.services) ||
		candidate.services.length > MAX_ORIENTATION_SERVICES ||
		candidate.services.some(
			(service) =>
				!nonEmptyString(service) ||
				service !== service.trim() ||
				/[\r\n]/.test(service) ||
				Buffer.byteLength(service, "utf-8") > MAX_ORIENTATION_SERVICE_BYTES,
		) ||
		new Set(candidate.services).size !== candidate.services.length ||
		(candidate.otherService !== undefined &&
			(!nonEmptyString(candidate.otherService) ||
				candidate.otherService !== candidate.otherService.trim() ||
				Buffer.byteLength(candidate.otherService, "utf-8") > MAX_OTHER_SERVICE_BYTES))
	) {
		return undefined;
	}
	return {
		services: [...candidate.services] as string[],
		...(typeof candidate.otherService === "string" ? { otherService: candidate.otherService } : {}),
	};
}

function introValue(value: unknown, key: string): StaffIntroState | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Record<string, unknown>;
	if (
		candidate.staffAgentId !== key ||
		!nonEmptyString(candidate.trailFile) ||
		(candidate.status !== "pending" &&
			candidate.status !== "started" &&
			candidate.status !== "completed" &&
			candidate.status !== "failed") ||
		!Number.isInteger(candidate.attempts) ||
		(candidate.attempts as number) < 0 ||
		!timestamp(candidate.createdAt) ||
		!timestamp(candidate.updatedAt) ||
		Date.parse(candidate.updatedAt) < Date.parse(candidate.createdAt) ||
		(candidate.error !== undefined &&
			(!nonEmptyString(candidate.error) || Buffer.byteLength(candidate.error, "utf-8") > MAX_ERROR_BYTES))
	) {
		return undefined;
	}
	const orientation = orientationValue(candidate.orientation);
	if (candidate.orientation !== undefined && !orientation) return undefined;
	return {
		staffAgentId: key,
		trailFile: candidate.trailFile,
		status: candidate.status,
		attempts: candidate.attempts as number,
		createdAt: candidate.createdAt,
		updatedAt: candidate.updatedAt,
		...(typeof candidate.error === "string" ? { error: candidate.error } : {}),
		...(orientation ? { orientation } : {}),
	};
}

export function staffRuntimeStatePath(userData: string, root: string): string {
	return companyHostStorageFile(userData, companyRootId(resolve(root)), STAFF_RUNTIME_STATE_FILE);
}

export function readStaffRuntimeState(path: string): StaffRuntimeState {
	if (!existsSync(path)) return emptyState();
	try {
		const entry = lstatSync(path);
		if (
			!entry.isFile() ||
			entry.isSymbolicLink() ||
			entry.nlink !== 1 ||
			entry.size > MAX_STATE_BYTES ||
			(process.platform !== "win32" && (entry.mode & 0o077) !== 0)
		) {
			return emptyState();
		}
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyState();
		const record = parsed as Record<string, unknown>;
		if (record.version !== 1 || !record.intros || typeof record.intros !== "object" || Array.isArray(record.intros)) {
			return emptyState();
		}
		const intros: Record<string, StaffIntroState> = {};
		for (const [staffAgentId, value] of Object.entries(record.intros)) {
			const intro = introValue(value, staffAgentId);
			if (intro) intros[staffAgentId] = intro;
		}
		return { version: 1, intros };
	} catch {
		return emptyState();
	}
}

export function writeStaffRuntimeState(path: string, state: StaffRuntimeState): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(state, null, "\t")}\n`, {
			encoding: "utf-8",
			flag: "wx",
			mode: 0o600,
		});
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function boundedError(value: string | undefined): string | undefined {
	const source = value?.trim();
	if (!source) return undefined;
	let bytes = 0;
	let result = "";
	for (const character of source) {
		const characterBytes = Buffer.byteLength(character, "utf-8");
		if (bytes + characterBytes > MAX_ERROR_BYTES) break;
		bytes += characterBytes;
		result += character;
	}
	return result || undefined;
}

export function recordStaffIntroPending(
	state: StaffRuntimeState,
	staffAgentId: string,
	trailFile: string,
	nowMs: number,
	orientation?: StaffOrientationContext,
): StaffRuntimeState {
	if (!nonEmptyString(staffAgentId) || !nonEmptyString(trailFile)) throw new Error("Staff intro identity is invalid");
	const checkedOrientation = orientationValue(orientation);
	if (orientation !== undefined && !checkedOrientation) throw new Error("Staff intro orientation is invalid");
	const existing = state.intros[staffAgentId];
	if (existing) {
		if (existing.trailFile !== trailFile) throw new Error("Staff intro is already bound to another trail");
		return state;
	}
	const now = new Date(nowMs).toISOString();
	return {
		...state,
		intros: {
			...state.intros,
			[staffAgentId]: {
				staffAgentId,
				trailFile,
				status: "pending",
				attempts: 0,
				createdAt: now,
				updatedAt: now,
				...(checkedOrientation ? { orientation: checkedOrientation } : {}),
			},
		},
	};
}

/** Claim delivery before writing the hidden prompt. Pending intros may only
 * be claimed by the automatic first delivery; failed intros require an
 * explicit retry. Started and completed intros are never claimable. */
export function claimStaffIntro(
	state: StaffRuntimeState,
	staffAgentId: string,
	trailFile: string,
	nowMs: number,
	retry: boolean,
): StaffIntroClaim {
	const current = state.intros[staffAgentId];
	if (
		!current ||
		current.trailFile !== trailFile ||
		(retry ? current.status !== "failed" : current.status !== "pending")
	) {
		return { claimed: false, state };
	}
	const next: StaffIntroState = {
		...current,
		status: "started",
		attempts: current.attempts + 1,
		updatedAt: new Date(nowMs).toISOString(),
	};
	delete next.error;
	return {
		claimed: true,
		state: {
			...state,
			intros: { ...state.intros, [staffAgentId]: next },
		},
	};
}

export function finishStaffIntro(
	state: StaffRuntimeState,
	staffAgentId: string,
	trailFile: string,
	success: boolean,
	nowMs: number,
	error?: string,
): StaffRuntimeState {
	const current = state.intros[staffAgentId];
	if (!current || current.trailFile !== trailFile || current.status !== "started") return state;
	const failure = boundedError(error);
	return {
		...state,
		intros: {
			...state.intros,
			[staffAgentId]: {
				...current,
				status: success ? "completed" : "failed",
				updatedAt: new Date(nowMs).toISOString(),
				...(!success && failure ? { error: failure } : {}),
			},
		},
	};
}
