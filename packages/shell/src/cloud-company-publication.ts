import { type FSWatcher, watch } from "node:fs";
import {
	type CheckpointCloudCompanyFileInput,
	type CloudCompanyFileCheckpointResult,
	checkpointCloudCompanyFile,
} from "./cloud-company-file.ts";
import { cloudCompanyPathBelongsToLogicalTree } from "./cloud-company-snapshot.ts";
import type { CloudSyncHealth } from "./cloud-sync-loop.ts";
import { DurableCloudSyncLoop } from "./cloud-sync-loop.ts";

interface CompanyTreeWatcher {
	close(): void;
}

export type CloudCompanyCheckpointResult = CloudCompanyFileCheckpointResult;

export interface CloudCompanyPublicationOptions extends CheckpointCloudCompanyFileInput {
	debounceMs?: number;
	steadyDelayMs?: number;
	onCheckpoint?: (result: CloudCompanyCheckpointResult) => void | Promise<void>;
	onHealth?: (health: CloudSyncHealth) => void;
	onWatcherError?: (error: Error) => void;
	watchTree?: (root: string, onChange: (relativePath?: string) => void) => CompanyTreeWatcher;
	setDebounceTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	clearDebounceTimer?: (timer: ReturnType<typeof setTimeout>) => void;
	runCheckpoint?: (
		checkpoint: () => Promise<CloudCompanyCheckpointResult>,
	) => Promise<CloudCompanyCheckpointResult | undefined>;
}

function watchCompanyTree(root: string, onChange: (relativePath?: string) => void): FSWatcher {
	return watch(root, { recursive: true }, (_event, filename) => {
		onChange(filename === null ? undefined : filename.toString());
	});
}

export class CloudCompanyPublication {
	readonly #options: CloudCompanyPublicationOptions;
	readonly #loop: DurableCloudSyncLoop;
	readonly #setDebounceTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	readonly #clearDebounceTimer: (timer: ReturnType<typeof setTimeout>) => void;
	#watcher?: CompanyTreeWatcher;
	#debounceTimer?: ReturnType<typeof setTimeout>;
	#lastCheckpoint?: CloudCompanyCheckpointResult;
	#dirty = true;
	#generation = 0;
	#started = false;

	constructor(options: CloudCompanyPublicationOptions) {
		this.#options = options;
		this.#setDebounceTimer = options.setDebounceTimer ?? setTimeout;
		this.#clearDebounceTimer = options.clearDebounceTimer ?? clearTimeout;
		this.#loop = new DurableCloudSyncLoop({
			root: options.companyRoot,
			userData: options.userData,
			profileId: options.profileId,
			channel: "company-tree",
			steadyDelayMs: options.steadyDelayMs ?? 5 * 60_000,
			onHealth: options.onHealth,
			sync: async () => {
				const generation = this.#generation;
				const checkpoint = await (options.runCheckpoint ?? ((run) => run()))(() =>
					checkpointCloudCompanyFile(options),
				);
				if (!checkpoint) return;
				this.#lastCheckpoint = checkpoint;
				await options.onCheckpoint?.(checkpoint);
				this.#dirty = this.#generation !== generation;
				if (this.#dirty) void this.#loop.trigger();
			},
		});
	}

	health(): CloudSyncHealth {
		return this.#loop.health();
	}

	lastCheckpoint(): CloudCompanyCheckpointResult | undefined {
		return this.#lastCheckpoint
			? {
					...this.#lastCheckpoint,
					companyFile: { ...this.#lastCheckpoint.companyFile },
					snapshot: { ...this.#lastCheckpoint.snapshot, tree: { ...this.#lastCheckpoint.snapshot.tree } },
				}
			: undefined;
	}

	hasPendingWork(): boolean {
		return this.#dirty || this.#debounceTimer !== undefined;
	}

	start(): void {
		if (this.#started) return;
		this.#started = true;
		try {
			this.#watcher = (this.#options.watchTree ?? watchCompanyTree)(this.#options.companyRoot, (path) =>
				this.notifyPathChanged(path),
			);
		} catch (error) {
			this.#options.onWatcherError?.(error instanceof Error ? error : new Error(String(error)));
		}
		this.#loop.start();
	}

	stop(): void {
		this.#started = false;
		if (this.#debounceTimer) this.#clearDebounceTimer(this.#debounceTimer);
		this.#debounceTimer = undefined;
		this.#watcher?.close();
		this.#watcher = undefined;
		this.#loop.stop();
	}

	notifyPathChanged(relativePath?: string): void {
		if (relativePath !== undefined && !cloudCompanyPathBelongsToLogicalTree(relativePath)) return;
		this.#generation += 1;
		this.#dirty = true;
		if (this.#debounceTimer) this.#clearDebounceTimer(this.#debounceTimer);
		this.#debounceTimer = this.#setDebounceTimer(() => {
			this.#debounceTimer = undefined;
			void this.#loop.trigger();
		}, this.#options.debounceMs ?? 1_500);
		this.#debounceTimer.unref?.();
	}

	async publishNow(): Promise<CloudSyncHealth> {
		if (this.#debounceTimer) this.#clearDebounceTimer(this.#debounceTimer);
		this.#debounceTimer = undefined;
		let health = await this.#loop.syncNow();
		for (let attempt = 0; health.phase === "healthy" && this.#dirty && attempt < 7; attempt += 1) {
			if (this.#debounceTimer) this.#clearDebounceTimer(this.#debounceTimer);
			this.#debounceTimer = undefined;
			health = await this.#loop.syncNow();
		}
		if (health.phase === "healthy" && this.#dirty) {
			return { ...health, phase: "retrying", lastError: "Company File kept changing while it was synchronizing" };
		}
		return health;
	}
}
