import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ScheduledJobEffort } from "@qorpera/pi-coding-agent/company-connections";
import { companyHostStorageFile } from "./company-host-storage.ts";

export type CustomTriggerBuildStatus = "queued" | "building" | "ready" | "failed";

export interface CustomTriggerBuild {
	id: string;
	staffAgentId: string;
	routineKey: string;
	title: string;
	instructions: string;
	eventDescription: string;
	sourceHints: string[];
	checkEveryMinutes: number;
	effort: ScheduledJobEffort;
	reviewerStaffIds?: string[];
	status: CustomTriggerBuildStatus;
	requestedAt: string;
	updatedAt: string;
	jobId?: string;
	error?: string;
}

export interface CustomTriggerBuildState {
	version: 1;
	builds: CustomTriggerBuild[];
}

function normalizedRoot(root: string): string {
	const value = resolve(root);
	return process.platform === "win32" ? value.toLowerCase() : value;
}

export function customTriggerBuildStatePath(userData: string, root: string): string {
	const id = createHash("sha256").update(normalizedRoot(root)).digest("hex");
	return companyHostStorageFile(userData, id, "custom-trigger-builds.json");
}

export function readCustomTriggerBuildState(path: string): CustomTriggerBuildState {
	if (!existsSync(path)) return { version: 1, builds: [] };
	try {
		const value = JSON.parse(readFileSync(path, "utf-8")) as CustomTriggerBuildState;
		if (value.version !== 1 || !Array.isArray(value.builds)) throw new Error("invalid custom-trigger state");
		return value;
	} catch {
		return { version: 1, builds: [] };
	}
}

export function writeCustomTriggerBuildState(path: string, state: CustomTriggerBuildState): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(state, null, "\t")}\n`, { encoding: "utf-8", mode: 0o600 });
	try {
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

export function queueCustomTriggerBuild(
	state: CustomTriggerBuildState,
	input: Omit<CustomTriggerBuild, "id" | "status" | "requestedAt" | "updatedAt" | "jobId" | "error">,
	now = new Date().toISOString(),
): { state: CustomTriggerBuildState; build: CustomTriggerBuild } {
	const build: CustomTriggerBuild = {
		id: randomUUID(),
		...input,
		status: "queued",
		requestedAt: now,
		updatedAt: now,
	};
	return {
		state: {
			version: 1,
			builds: [
				...state.builds.filter(
					(candidate) =>
						candidate.staffAgentId !== input.staffAgentId || candidate.routineKey !== input.routineKey,
				),
				build,
			],
		},
		build,
	};
}

export function claimNextCustomTriggerBuild(
	state: CustomTriggerBuildState,
	now = new Date().toISOString(),
): { state: CustomTriggerBuildState; build?: CustomTriggerBuild } {
	// A persisted `building` record has no live owner when the host asks for
	// work again: the scheduler never calls this while a builder child exists.
	// Reclaim it so a desktop crash cannot orphan the requested trigger.
	const index = state.builds.findIndex((build) => build.status === "building" || build.status === "queued");
	if (index < 0) return { state };
	const build = { ...state.builds[index], status: "building" as const, updatedAt: now };
	const builds = [...state.builds];
	builds[index] = build;
	return { state: { version: 1, builds }, build };
}

export function finishCustomTriggerBuild(
	state: CustomTriggerBuildState,
	id: string,
	result: { status: "ready"; jobId: string } | { status: "failed"; error: string },
	now = new Date().toISOString(),
): { state: CustomTriggerBuildState; build: CustomTriggerBuild } {
	const index = state.builds.findIndex((build) => build.id === id);
	if (index < 0) throw new Error(`Unknown custom trigger build: ${id}`);
	const current = state.builds[index];
	if (current.status !== "building") throw new Error(`Custom trigger build is not active: ${id}`);
	const build: CustomTriggerBuild = {
		...current,
		status: result.status,
		updatedAt: now,
		...(result.status === "ready" ? { jobId: result.jobId } : { error: result.error.slice(0, 2_000) }),
	};
	const builds = [...state.builds];
	builds[index] = build;
	return { state: { version: 1, builds }, build };
}
