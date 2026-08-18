import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readStaffAgents, replaceStaffAgents, type StaffAgent } from "@qorpera/pi-coding-agent/company-staff";
import type { HostedStaffAgent, QorperaHostedPrimary } from "./hosted-primary.ts";

const CLOUD_STAFF_STATE_SCHEMA = "qorpera.cloud-staff-sync/v1";

type CloudStaffPrimary = Pick<QorperaHostedPrimary, "listStaff" | "putStaff">;

interface StaffSyncStateEntry {
	version: number;
	contentHash: string;
}

interface CloudStaffState {
	schema: typeof CLOUD_STAFF_STATE_SCHEMA;
	profileId: string;
	root: string;
	agents: Record<string, StaffSyncStateEntry>;
}

export interface CloudStaffSyncResult {
	created: number;
	updated: number;
	downloaded: number;
}

export interface CloudStaffSynchronizerOptions {
	root: string;
	userData: string;
	profileId: string;
	primary: CloudStaffPrimary;
	canWrite: () => boolean;
}

function normalizedRoot(root: string): string {
	const normalized = resolve(root);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function cloudStaffSyncStatePath(userData: string, root: string, profileId: string): string {
	const rootHash = createHash("sha256").update(normalizedRoot(root)).digest("hex").slice(0, 24);
	return join(userData, "cloud-staff-sync", `${profileId}-${rootHash}.json`);
}

function emptyState(options: CloudStaffSynchronizerOptions): CloudStaffState {
	return {
		schema: CLOUD_STAFF_STATE_SCHEMA,
		profileId: options.profileId,
		root: normalizedRoot(options.root),
		agents: {},
	};
}

function readState(path: string, options: CloudStaffSynchronizerOptions): CloudStaffState {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) return emptyState(options);
		const input = value as Partial<CloudStaffState>;
		if (
			input.schema !== CLOUD_STAFF_STATE_SCHEMA ||
			input.profileId !== options.profileId ||
			input.root !== normalizedRoot(options.root) ||
			!input.agents ||
			typeof input.agents !== "object" ||
			Array.isArray(input.agents)
		) {
			return emptyState(options);
		}
		const agents: Record<string, StaffSyncStateEntry> = {};
		for (const [id, candidate] of Object.entries(input.agents)) {
			if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
			const entry = candidate as Partial<StaffSyncStateEntry>;
			if (
				Number.isSafeInteger(entry.version) &&
				(entry.version ?? 0) > 0 &&
				typeof entry.contentHash === "string" &&
				/^[0-9a-f]{64}$/.test(entry.contentHash)
			) {
				agents[id] = { version: entry.version as number, contentHash: entry.contentHash };
			}
		}
		return { ...emptyState(options), agents };
	} catch {
		return emptyState(options);
	}
}

function writeState(path: string, state: CloudStaffState): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function localStaff(hosted: HostedStaffAgent): StaffAgent {
	return {
		id: hosted.id,
		displayName: hosted.displayName,
		role: hosted.role,
		charter: hosted.charter,
		...(hosted.templateId ? { templateId: hosted.templateId } : {}),
		...(hosted.departmentId ? { departmentId: hosted.departmentId } : {}),
		appearance: { ...hosted.appearance },
		...(hosted.model ? { model: { ...hosted.model } } : {}),
		employmentStatus: hosted.employmentStatus,
		lifecycleState: hosted.lifecycleState,
		createdAt: hosted.createdAt,
		updatedAt: hosted.updatedAt,
	};
}

function contentHash(staff: StaffAgent): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				id: staff.id,
				displayName: staff.displayName,
				role: staff.role,
				charter: staff.charter,
				templateId: staff.templateId ?? null,
				departmentId: staff.departmentId ?? null,
				appearance: {
					color: staff.appearance.color,
					shape: staff.appearance.shape,
					creature: staff.appearance.creature ?? null,
				},
				model: staff.model ? { provider: staff.model.provider, modelId: staff.model.modelId } : null,
				employmentStatus: staff.employmentStatus,
				lifecycleState: staff.lifecycleState,
				createdAt: staff.createdAt,
			}),
		)
		.digest("hex");
}

function conflict(id: string): Error {
	return new Error(`Shared staff changed on this computer and in the cloud: ${id}`);
}

export class CloudStaffSynchronizer {
	readonly #options: CloudStaffSynchronizerOptions;
	readonly #statePath: string;
	#inFlight?: Promise<CloudStaffSyncResult>;

	constructor(options: CloudStaffSynchronizerOptions) {
		this.#options = options;
		this.#statePath = cloudStaffSyncStatePath(options.userData, options.root, options.profileId);
	}

	sync(): Promise<CloudStaffSyncResult> {
		if (this.#inFlight) return this.#inFlight;
		const operation = this.#syncOnce().finally(() => {
			if (this.#inFlight === operation) this.#inFlight = undefined;
		});
		this.#inFlight = operation;
		return operation;
	}

	async #syncOnce(): Promise<CloudStaffSyncResult> {
		const result: CloudStaffSyncResult = { created: 0, updated: 0, downloaded: 0 };
		const state = readState(this.#statePath, this.#options);
		const localById = new Map(readStaffAgents(this.#options.root).map((staff) => [staff.id, staff]));
		const hostedById = new Map(
			(await this.#options.primary.listStaff(this.#options.profileId)).map((staff) => [staff.id, staff]),
		);
		const ids = new Set([...localById.keys(), ...hostedById.keys()]);

		for (const id of ids) {
			const local = localById.get(id);
			let hosted = hostedById.get(id);
			const previous = state.agents[id];
			if (local && hosted) {
				const localHash = contentHash(local);
				const hostedHash = contentHash(localStaff(hosted));
				if (localHash === hostedHash) {
					// A previous upload may have committed remotely before its response
					// or local checkpoint landed. Equal content is convergence, not a
					// concurrent edit.
				} else if (!previous) {
					if (localHash !== hostedHash) throw conflict(id);
				} else {
					const localChanged = localHash !== previous.contentHash;
					const hostedChanged = hosted.version !== previous.version || hostedHash !== previous.contentHash;
					if (localChanged && hostedChanged) throw conflict(id);
					if (localChanged) {
						if (!this.#options.canWrite()) throw new Error(`Shared staff is read-only on this profile: ${id}`);
						hosted = await this.#options.primary.putStaff(this.#options.profileId, local, previous.version);
						hostedById.set(id, hosted);
						state.agents[id] = { version: hosted.version, contentHash: contentHash(localStaff(hosted)) };
						writeState(this.#statePath, state);
						result.updated++;
					} else if (hostedChanged) {
						result.downloaded++;
					}
				}
			} else if (local) {
				if (previous) throw new Error(`Shared staff is missing from the cloud: ${id}`);
				if (!this.#options.canWrite()) throw new Error(`Shared staff is read-only on this profile: ${id}`);
				hosted = await this.#options.primary.putStaff(this.#options.profileId, local);
				hostedById.set(id, hosted);
				state.agents[id] = { version: hosted.version, contentHash: contentHash(localStaff(hosted)) };
				writeState(this.#statePath, state);
				result.created++;
			} else if (hosted) {
				result.downloaded++;
			}
		}

		const authoritative = [...hostedById.values()]
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
			.map(localStaff);
		if (JSON.stringify(readStaffAgents(this.#options.root)) !== JSON.stringify(authoritative)) {
			replaceStaffAgents(this.#options.root, authoritative);
		}
		state.agents = Object.fromEntries(
			[...hostedById.values()].map((staff) => [
				staff.id,
				{ version: staff.version, contentHash: contentHash(localStaff(staff)) },
			]),
		);
		writeState(this.#statePath, state);
		return result;
	}
}
