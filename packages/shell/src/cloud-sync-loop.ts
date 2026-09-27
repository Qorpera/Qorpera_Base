import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const CLOUD_SYNC_HEALTH_SCHEMA = "qorpera.cloud-sync-health/v1";

export type CloudSyncChannel =
	| "company-projection"
	| "company-tree"
	| "sessions"
	| "staff"
	| "trail"
	| "workspace-inbox";
export type CloudSyncPhase = "idle" | "syncing" | "healthy" | "retrying" | "attention";

export interface CloudSyncHealth {
	phase: CloudSyncPhase;
	consecutiveFailures: number;
	lastAttemptAt?: string;
	lastSuccessAt?: string;
	lastError?: string;
	nextAttemptAt?: string;
}

interface PersistedCloudSyncHealth extends CloudSyncHealth {
	schema: typeof CLOUD_SYNC_HEALTH_SCHEMA;
	profileId: string;
	root: string;
	channel: CloudSyncChannel;
}

export interface DurableCloudSyncLoopOptions {
	root: string;
	userData: string;
	profileId: string;
	channel: CloudSyncChannel;
	sync: () => Promise<unknown>;
	onHealth?: (health: CloudSyncHealth) => void;
	retryable?: (error: unknown) => boolean;
	now?: () => number;
	steadyDelayMs?: number;
	minimumRetryDelayMs?: number;
	maximumRetryDelayMs?: number;
	setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

function normalizedRoot(root: string): string {
	const normalized = resolve(root);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function cloudSyncHealthPath(
	userData: string,
	root: string,
	profileId: string,
	channel: CloudSyncChannel,
): string {
	const rootHash = createHash("sha256").update(normalizedRoot(root)).digest("hex").slice(0, 24);
	return join(userData, "cloud-sync-health", `${profileId}-${rootHash}-${channel}.json`);
}

function timestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function emptyHealth(): CloudSyncHealth {
	return { phase: "idle", consecutiveFailures: 0 };
}

function readHealth(path: string, options: DurableCloudSyncLoopOptions): CloudSyncHealth {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) return emptyHealth();
		const input = value as Partial<PersistedCloudSyncHealth>;
		if (
			input.schema !== CLOUD_SYNC_HEALTH_SCHEMA ||
			input.profileId !== options.profileId ||
			input.root !== normalizedRoot(options.root) ||
			input.channel !== options.channel ||
			(input.phase !== "healthy" && input.phase !== "retrying" && input.phase !== "attention") ||
			!Number.isSafeInteger(input.consecutiveFailures) ||
			(input.consecutiveFailures ?? -1) < 0 ||
			(input.lastAttemptAt !== undefined && !timestamp(input.lastAttemptAt)) ||
			(input.lastSuccessAt !== undefined && !timestamp(input.lastSuccessAt)) ||
			(input.lastError !== undefined && typeof input.lastError !== "string") ||
			(input.nextAttemptAt !== undefined && !timestamp(input.nextAttemptAt))
		) {
			return emptyHealth();
		}
		return {
			phase: input.phase,
			consecutiveFailures: input.consecutiveFailures as number,
			...(input.lastAttemptAt ? { lastAttemptAt: input.lastAttemptAt } : {}),
			...(input.lastSuccessAt ? { lastSuccessAt: input.lastSuccessAt } : {}),
			...(input.lastError ? { lastError: input.lastError } : {}),
			...(input.nextAttemptAt ? { nextAttemptAt: input.nextAttemptAt } : {}),
		};
	} catch {
		return emptyHealth();
	}
}

function writeHealth(
	path: string,
	options: Pick<DurableCloudSyncLoopOptions, "root" | "profileId" | "channel">,
	health: CloudSyncHealth,
): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	const record: PersistedCloudSyncHealth = {
		schema: CLOUD_SYNC_HEALTH_SCHEMA,
		profileId: options.profileId,
		root: normalizedRoot(options.root),
		channel: options.channel,
		...health,
		phase: health.phase === "syncing" || health.phase === "idle" ? "retrying" : health.phase,
	};
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

/** Fold one attempt outcome into a channel's health. Failures classified
 * non-retryable surface as "attention" but carry no schedule of their own —
 * whether anything retries is the caller's policy, not this record's. */
export function cloudSyncHealthAfter(
	previous: CloudSyncHealth | undefined,
	outcome: { ok: true } | { ok: false; error: unknown },
	at: number = Date.now(),
): CloudSyncHealth {
	const lastAttemptAt = new Date(at).toISOString();
	if (outcome.ok) {
		return { phase: "healthy", consecutiveFailures: 0, lastAttemptAt, lastSuccessAt: lastAttemptAt };
	}
	const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
	return {
		phase: cloudSyncErrorIsRetryable(outcome.error) ? "retrying" : "attention",
		consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
		lastAttemptAt,
		...(previous?.lastSuccessAt ? { lastSuccessAt: previous.lastSuccessAt } : {}),
		lastError: message.slice(0, 2048),
	};
}

/** Durably record a channel's health outside a DurableCloudSyncLoop — for
 * channels (like session arbitration) whose retry cadence lives elsewhere but
 * whose degradation must still be visible on disk after the app closes. */
export function persistCloudSyncHealth(
	userData: string,
	root: string,
	profileId: string,
	channel: CloudSyncChannel,
	health: CloudSyncHealth,
): void {
	writeHealth(cloudSyncHealthPath(userData, root, profileId, channel), { root, profileId, channel }, health);
}

export function cloudSyncErrorIsRetryable(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return !/changed on this computer and in the cloud|workspace head changed|PT409|read-only|invalid|unknown schema|parts conflict|part conflicts|too large|sequence is discontinuous|permission|not shared|oauth|jwt/i.test(
		message,
	);
}

export class DurableCloudSyncLoop {
	readonly #options: DurableCloudSyncLoopOptions;
	readonly #statePath: string;
	readonly #now: () => number;
	readonly #setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	readonly #clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
	#health: CloudSyncHealth;
	#inFlight?: Promise<CloudSyncHealth>;
	#timer?: ReturnType<typeof setTimeout>;
	#started = false;
	#triggerPending = false;
	#closing?: Promise<void>;

	constructor(options: DurableCloudSyncLoopOptions) {
		this.#options = options;
		this.#statePath = cloudSyncHealthPath(options.userData, options.root, options.profileId, options.channel);
		this.#now = options.now ?? Date.now;
		this.#setTimer = options.setTimer ?? setTimeout;
		this.#clearTimer = options.clearTimer ?? clearTimeout;
		this.#health = readHealth(this.#statePath, options);
	}

	health(): CloudSyncHealth {
		return { ...this.#health };
	}

	start(): void {
		if (this.#closing || this.#started) return;
		this.#started = true;
		this.#schedule();
	}

	stop(): void {
		this.#started = false;
		this.#triggerPending = false;
		if (this.#timer) this.#clearTimer(this.#timer);
		this.#timer = undefined;
	}

	/** Permanently stop admission and drain the current attempt, including its durable health write. */
	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		this.stop();
		this.#closing = Promise.resolve().then(async () => {
			await this.#inFlight;
		});
		return this.#closing;
	}

	trigger(): Promise<CloudSyncHealth> {
		if (this.#closing) return Promise.resolve(this.health());
		if (this.#timer) this.#clearTimer(this.#timer);
		this.#timer = undefined;
		if (this.#inFlight) {
			this.#triggerPending = true;
			return this.#inFlight;
		}
		return this.syncNow();
	}

	syncNow(): Promise<CloudSyncHealth> {
		if (this.#closing) return Promise.resolve(this.health());
		if (this.#inFlight) return this.#inFlight;
		const operation = this.#run().finally(() => {
			if (this.#inFlight === operation) this.#inFlight = undefined;
			if (this.#triggerPending) {
				this.#triggerPending = false;
				void this.syncNow();
			} else if (this.#started) this.#schedule();
		});
		this.#inFlight = operation;
		return operation;
	}

	#notify(): void {
		this.#options.onHealth?.(this.health());
	}

	#schedule(): void {
		if (!this.#started || this.#inFlight || this.#health.phase === "attention") return;
		if (this.#timer) this.#clearTimer(this.#timer);
		const next = this.#health.nextAttemptAt ? Date.parse(this.#health.nextAttemptAt) : this.#now();
		const delay = Math.max(0, next - this.#now());
		this.#timer = this.#setTimer(() => {
			this.#timer = undefined;
			void this.syncNow();
		}, delay);
		this.#timer.unref?.();
	}

	async #run(): Promise<CloudSyncHealth> {
		const attemptedAt = new Date(this.#now()).toISOString();
		this.#health = { ...this.#health, phase: "syncing", lastAttemptAt: attemptedAt };
		delete this.#health.nextAttemptAt;
		this.#notify();
		try {
			await this.#options.sync();
			const nextAttemptAt = new Date(this.#now() + (this.#options.steadyDelayMs ?? 10_000)).toISOString();
			this.#health = {
				phase: "healthy",
				consecutiveFailures: 0,
				lastAttemptAt: attemptedAt,
				lastSuccessAt: new Date(this.#now()).toISOString(),
				nextAttemptAt,
			};
		} catch (error) {
			const consecutiveFailures = this.#health.consecutiveFailures + 1;
			const retryable = (this.#options.retryable ?? cloudSyncErrorIsRetryable)(error);
			const minimum = this.#options.minimumRetryDelayMs ?? 2_000;
			const maximum = this.#options.maximumRetryDelayMs ?? 5 * 60_000;
			const retryDelay = Math.min(maximum, minimum * 2 ** Math.min(consecutiveFailures - 1, 16));
			this.#health = {
				phase: retryable ? "retrying" : "attention",
				consecutiveFailures,
				lastAttemptAt: attemptedAt,
				...(this.#health.lastSuccessAt ? { lastSuccessAt: this.#health.lastSuccessAt } : {}),
				lastError: (error instanceof Error ? error.message : String(error)).slice(0, 2048),
				...(retryable ? { nextAttemptAt: new Date(this.#now() + retryDelay).toISOString() } : {}),
			};
		}
		writeHealth(this.#statePath, this.#options, this.#health);
		this.#notify();
		return this.health();
	}
}
