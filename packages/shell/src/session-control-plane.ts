import { randomUUID } from "node:crypto";
import {
	createReadStream,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
	advanceTrailAuditState,
	appendKernelSessionRuntimeObservation,
	createTrailAuditState,
	type TrailAuditState,
	type TrailBinding,
} from "./agent-runtime.ts";

export type SessionRuntimeStatus =
	| "starting"
	| "idle"
	| "running"
	| "finishing"
	| "reconnecting"
	| "detached"
	| "settled"
	| "interrupted";

export type SessionRuntimeActivity =
	| { kind: "starting" }
	| { kind: "thinking" }
	| { kind: "writing" }
	| { kind: "tool"; tool: string; subject?: string };

interface SessionRuntimeEventBase {
	at: string;
	kernelInstanceId: string;
	executorId: string;
}

export type SessionRuntimeEvent =
	| (SessionRuntimeEventBase & { kind: "executor_started"; pid?: number; attachmentSequence?: number })
	| (SessionRuntimeEventBase & { kind: "executor_ready" })
	| (SessionRuntimeEventBase & { kind: "turn_started"; origin: string })
	| (SessionRuntimeEventBase & {
			kind: "activity";
			activity: SessionRuntimeActivity;
	  })
	| (SessionRuntimeEventBase & { kind: "turn_settled" })
	| (SessionRuntimeEventBase & { kind: "turn_interrupted"; origin: string })
	| (SessionRuntimeEventBase & {
			kind: "executor_exited";
			expected: boolean;
			code: number | null;
			signal: string | null;
			busy: boolean;
			detail?: string;
	  })
	| (SessionRuntimeEventBase & {
			kind: "reconnect_scheduled";
			attempt: number;
			code: number | null;
			detail?: string;
	  })
	| (SessionRuntimeEventBase & {
			kind: "reconnect_failed";
			attempt: number;
			detail?: string;
	  })
	| (SessionRuntimeEventBase & { kind: "persistence_failed" });

export type SessionRuntimeEventInput =
	| { kind: "executor_started"; executorId: string; pid?: number }
	| { kind: "executor_ready"; executorId: string }
	| { kind: "turn_started"; executorId: string; origin: string }
	| { kind: "turn_settled"; executorId: string }
	| { kind: "turn_interrupted"; executorId: string; origin: string }
	| {
			kind: "executor_exited";
			executorId: string;
			expected: boolean;
			code: number | null;
			signal: string | null;
			busy: boolean;
			detail?: string;
	  }
	| {
			kind: "reconnect_scheduled";
			executorId: string;
			attempt: number;
			code: number | null;
			detail?: string;
	  }
	| {
			kind: "reconnect_failed";
			executorId: string;
			attempt: number;
			detail?: string;
	  };

export interface SessionRuntimeView {
	trailFile: string;
	sessionId: string;
	actor: "controller" | "product-worker";
	autonomous: boolean;
	label?: string;
	department?: string;
	worktree?: string;
	group?: string;
	parentSession?: string;
	status: SessionRuntimeStatus;
	live: boolean;
	kernelInstanceId: string;
	executorId: string;
	attachmentSequence?: number;
	updatedAt: string;
	turnStartedAt?: string;
	/** The preceding turn lost its executor before it settled. A replacement
	 * can be attached and idle without pretending that request completed. */
	turnInterrupted?: boolean;
	activity?: SessionRuntimeActivity;
	reconnectAttempt?: number;
	exit?: {
		code: number | null;
		signal: string | null;
		busy: boolean;
		expected: boolean;
	};
}

export interface SessionRuntimeSnapshot {
	revision: number;
	generatedAt: string;
	sessions: SessionRuntimeView[];
}

export interface SessionRuntimeUpdate {
	event: SessionRuntimeEvent;
	session: SessionRuntimeView;
	snapshot: SessionRuntimeSnapshot;
}

export interface SessionRuntimeSource {
	snapshot: () => SessionRuntimeSnapshot;
	subscribe: (listener: (update: SessionRuntimeUpdate) => void) => () => void;
	isTrailVisible?: (trailFile: string) => boolean;
}

interface SessionAuthority {
	actor?: unknown;
	autonomous?: unknown;
	label?: unknown;
	department?: unknown;
	worktree?: unknown;
	group?: unknown;
	parentSession?: unknown;
}

interface ObservedSessionRuntimeEvent {
	trailFile: string;
	sessionId: string;
	authority: SessionAuthority;
	event: SessionRuntimeEvent;
}

const ACTIVE_STATUSES = new Set<SessionRuntimeStatus>(["starting", "idle", "running", "finishing", "reconnecting"]);
const SESSION_RUNTIME_CUSTOM_TYPE = "qorpera_kernel_session_runtime";
const POST_EXIT_EVENTS = new Set<SessionRuntimeEvent["kind"]>([
	"executor_started",
	"reconnect_scheduled",
	"reconnect_failed",
	"persistence_failed",
]);
const SESSION_RUNTIME_STATUSES = new Set<SessionRuntimeStatus>([
	...ACTIVE_STATUSES,
	"detached",
	"settled",
	"interrupted",
]);

interface SessionReadModelCache {
	version: 2;
	files: Record<
		string,
		TrailMetadata & {
			session?: SessionRuntimeView;
		}
	>;
}

interface TrailMetadata {
	size: string;
	mtimeNs: string;
	ctimeNs: string;
	device: string;
	inode: string;
}

function sameTrailMetadata(left: TrailMetadata | undefined, right: TrailMetadata): boolean {
	return (
		left?.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs &&
		left.device === right.device &&
		left.inode === right.inode
	);
}

function normalizedPath(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPhysicalFile(path: string): boolean {
	try {
		const entry = lstatSync(path);
		return (
			entry.isFile() &&
			!entry.isSymbolicLink() &&
			entry.nlink === 1 &&
			normalizedPath(realpathSync(path)) === normalizedPath(path)
		);
	} catch {
		return false;
	}
}

function canonicalTrailDirectory(root: string): string | undefined {
	try {
		const canonicalRoot = realpathSync(resolve(root));
		const trail = resolve(canonicalRoot, "trail");
		const rel = relative(canonicalRoot, trail);
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
		const entry = lstatSync(trail);
		if (
			!entry.isDirectory() ||
			entry.isSymbolicLink() ||
			normalizedPath(realpathSync(trail)) !== normalizedPath(trail)
		) {
			return undefined;
		}
		return trail;
	} catch {
		return undefined;
	}
}

function trailMetadata(root: string): Map<string, TrailMetadata> {
	const trail = canonicalTrailDirectory(root);
	const metadata = new Map<string, TrailMetadata>();
	if (!trail) return metadata;
	let files: string[];
	try {
		files = readdirSync(trail).filter((name) => name.endsWith(".jsonl"));
	} catch {
		return metadata;
	}
	for (const file of files) {
		if (basename(file) !== file) continue;
		const path = join(trail, file);
		if (!isPhysicalFile(path)) continue;
		try {
			const stat = statSync(path, { bigint: true });
			metadata.set(file, {
				size: stat.size.toString(),
				mtimeNs: stat.mtimeNs.toString(),
				ctimeNs: stat.ctimeNs.toString(),
				device: stat.dev.toString(),
				inode: stat.ino.toString(),
			});
		} catch {
			// A file changing during discovery is scanned on a later open.
		}
	}
	return metadata;
}

function validCachedSession(value: unknown, trailFile: string): value is SessionRuntimeView {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Partial<SessionRuntimeView>;
	const validOptionalString = (field: unknown): boolean => field === undefined || typeof field === "string";
	const validOptionalDate = (field: unknown): boolean =>
		field === undefined || (typeof field === "string" && Number.isFinite(Date.parse(field)));
	const exit = candidate.exit;
	return (
		candidate.trailFile === trailFile &&
		typeof candidate.sessionId === "string" &&
		(candidate.actor === "controller" || candidate.actor === "product-worker") &&
		typeof candidate.autonomous === "boolean" &&
		validOptionalString(candidate.label) &&
		validOptionalString(candidate.department) &&
		validOptionalString(candidate.worktree) &&
		validOptionalString(candidate.group) &&
		validOptionalString(candidate.parentSession) &&
		typeof candidate.status === "string" &&
		SESSION_RUNTIME_STATUSES.has(candidate.status as SessionRuntimeStatus) &&
		typeof candidate.live === "boolean" &&
		typeof candidate.kernelInstanceId === "string" &&
		typeof candidate.executorId === "string" &&
		typeof candidate.updatedAt === "string" &&
		Number.isFinite(Date.parse(candidate.updatedAt)) &&
		validOptionalDate(candidate.turnStartedAt) &&
		(candidate.turnInterrupted === undefined || typeof candidate.turnInterrupted === "boolean") &&
		(candidate.attachmentSequence === undefined ||
			(Number.isSafeInteger(candidate.attachmentSequence) && candidate.attachmentSequence > 0)) &&
		(candidate.activity === undefined || validActivity(candidate.activity)) &&
		(candidate.reconnectAttempt === undefined ||
			(Number.isSafeInteger(candidate.reconnectAttempt) && candidate.reconnectAttempt > 0)) &&
		(exit === undefined ||
			(exit !== null &&
				typeof exit === "object" &&
				(exit.code === null || typeof exit.code === "number") &&
				(exit.signal === null || typeof exit.signal === "string") &&
				typeof exit.busy === "boolean" &&
				typeof exit.expected === "boolean"))
	);
}

function readSessionCache(path: string): SessionReadModelCache | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return undefined;
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<SessionReadModelCache>;
		if (parsed.version !== 2 || !parsed.files || typeof parsed.files !== "object" || Array.isArray(parsed.files)) {
			return undefined;
		}
		for (const [file, entry] of Object.entries(parsed.files)) {
			if (
				basename(file) !== file ||
				!file.endsWith(".jsonl") ||
				!entry ||
				typeof entry !== "object" ||
				Array.isArray(entry) ||
				typeof entry.size !== "string" ||
				typeof entry.mtimeNs !== "string" ||
				typeof entry.ctimeNs !== "string" ||
				typeof entry.device !== "string" ||
				typeof entry.inode !== "string" ||
				(entry.session !== undefined && !validCachedSession(entry.session, file))
			) {
				return undefined;
			}
		}
		return parsed as SessionReadModelCache;
	} catch {
		return undefined;
	}
}

function writeSessionCache(
	path: string,
	metadata: Map<string, TrailMetadata>,
	sessions: Map<string, SessionRuntimeView>,
): void {
	const files: SessionReadModelCache["files"] = {};
	for (const [file, observed] of metadata) {
		const session = sessions.get(file);
		files[file] = {
			...observed,
			...(session
				? {
						session: {
							...session,
							activity: undefined,
							exit: session.exit ? { ...session.exit } : undefined,
						},
					}
				: {}),
		};
	}
	const cache: SessionReadModelCache = { version: 2, files };
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(cache)}\n`, { encoding: "utf-8", flag: "wx" });
	renameSync(temporary, path);
}

function validActivity(value: unknown): value is SessionRuntimeActivity {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as {
		kind?: unknown;
		tool?: unknown;
		subject?: unknown;
	};
	if (candidate.kind === "starting" || candidate.kind === "thinking" || candidate.kind === "writing") return true;
	return (
		candidate.kind === "tool" &&
		typeof candidate.tool === "string" &&
		(candidate.subject === undefined || typeof candidate.subject === "string")
	);
}

function validRuntimeEvent(value: unknown): value is SessionRuntimeEvent {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	if (
		typeof candidate.at !== "string" ||
		!Number.isFinite(Date.parse(candidate.at)) ||
		typeof candidate.kernelInstanceId !== "string" ||
		!candidate.kernelInstanceId ||
		typeof candidate.executorId !== "string" ||
		!candidate.executorId ||
		typeof candidate.kind !== "string"
	) {
		return false;
	}
	switch (candidate.kind) {
		case "executor_started":
			return (
				(candidate.pid === undefined || (typeof candidate.pid === "number" && Number.isInteger(candidate.pid))) &&
				(candidate.attachmentSequence === undefined ||
					(typeof candidate.attachmentSequence === "number" &&
						Number.isSafeInteger(candidate.attachmentSequence) &&
						candidate.attachmentSequence > 0))
			);
		case "executor_ready":
		case "turn_settled":
			return true;
		case "turn_started":
		case "turn_interrupted":
			return typeof candidate.origin === "string";
		case "activity":
			return validActivity(candidate.activity);
		case "executor_exited":
			return (
				typeof candidate.expected === "boolean" &&
				(candidate.code === null || typeof candidate.code === "number") &&
				(candidate.signal === null || typeof candidate.signal === "string") &&
				typeof candidate.busy === "boolean" &&
				(candidate.detail === undefined || typeof candidate.detail === "string")
			);
		case "reconnect_scheduled":
			return (
				typeof candidate.attempt === "number" &&
				Number.isInteger(candidate.attempt) &&
				candidate.attempt > 0 &&
				(candidate.code === null || typeof candidate.code === "number") &&
				(candidate.detail === undefined || typeof candidate.detail === "string")
			);
		case "reconnect_failed":
			return (
				typeof candidate.attempt === "number" &&
				Number.isInteger(candidate.attempt) &&
				candidate.attempt > 0 &&
				(candidate.detail === undefined || typeof candidate.detail === "string")
			);
		default:
			return false;
	}
}

async function* readObservedEvents(
	root: string,
	trailFiles?: ReadonlySet<string>,
	onAudit?: (trailFile: string, audit: TrailAuditState) => void,
	onInvalid?: (trailFile: string) => void,
): AsyncGenerator<ObservedSessionRuntimeEvent> {
	const trail = canonicalTrailDirectory(root);
	if (!trail) return;
	let files: string[];
	try {
		files = trailFiles ? [...trailFiles] : readdirSync(trail).filter((file) => file.endsWith(".jsonl"));
	} catch {
		return;
	}
	for (const trailFile of files.sort()) {
		if (basename(trailFile) !== trailFile) continue;
		const path = join(trail, trailFile);
		if (!isPhysicalFile(path)) continue;
		let header: { id: string; qorpera?: SessionAuthority } | undefined;
		const audit = createTrailAuditState();
		let verified = true;
		try {
			const lines = createInterface({ input: createReadStream(path, { encoding: "utf-8" }), crlfDelay: Infinity });
			for await (const line of lines) {
				if (!header) {
					try {
						const candidate = JSON.parse(line) as {
							type?: unknown;
							id?: unknown;
							qorpera?: SessionAuthority;
						};
						if (candidate.type !== "session" || typeof candidate.id !== "string") break;
						header = { id: candidate.id, qorpera: candidate.qorpera };
					} catch {
						verified = false;
						break;
					}
					continue;
				}
				if (!line.trim()) continue;
				let entry: {
					type?: unknown;
					customType?: unknown;
					data?: unknown;
					provenance?: { source?: unknown; trust?: unknown };
				};
				try {
					entry = JSON.parse(line) as typeof entry;
					advanceTrailAuditState(audit, entry, path);
				} catch {
					// Earlier verified facts remain useful, but no event after a broken
					// hash-chain link is authoritative.
					verified = false;
					break;
				}
				if (
					entry.type !== "custom" ||
					entry.customType !== SESSION_RUNTIME_CUSTOM_TYPE ||
					entry.provenance?.source !== "kernel" ||
					entry.provenance.trust !== "observed" ||
					!validRuntimeEvent(entry.data)
				) {
					continue;
				}
				yield {
					trailFile,
					sessionId: header.id,
					authority: header.qorpera ?? {},
					event: entry.data,
				};
			}
			if (header && verified) onAudit?.(trailFile, audit);
			else if (header) onInvalid?.(trailFile);
		} catch {
			// A trail that becomes unreadable during replay cannot erase others.
			if (header) onInvalid?.(trailFile);
		}
	}
}

function authorityIdentity(
	authority: SessionAuthority,
): Pick<SessionRuntimeView, "actor" | "autonomous" | "label" | "department" | "worktree" | "group" | "parentSession"> {
	return {
		actor: authority.actor === "product-worker" ? "product-worker" : "controller",
		autonomous: authority.autonomous === true,
		label: typeof authority.label === "string" ? authority.label : undefined,
		department: typeof authority.department === "string" ? authority.department : undefined,
		worktree: typeof authority.worktree === "string" ? authority.worktree : undefined,
		group: typeof authority.group === "string" ? authority.group : undefined,
		parentSession: typeof authority.parentSession === "string" ? authority.parentSession : undefined,
	};
}

function eventActivityEqual(left: SessionRuntimeActivity | undefined, right: SessionRuntimeActivity): boolean {
	return Boolean(left) && JSON.stringify(left) === JSON.stringify(right);
}

export class SessionControlPlane implements SessionRuntimeSource {
	readonly #kernelInstanceId: string;
	readonly #sessions = new Map<string, SessionRuntimeView>();
	readonly #audits = new Map<string, TrailAuditState>();
	readonly #invalidTrails = new Set<string>();
	readonly #listeners = new Set<(update: SessionRuntimeUpdate) => void>();
	#lastAttachedTrailFile: string | undefined;
	#attachmentSequence = 0;
	#revision = 0;
	#generatedAt = new Date(0).toISOString();

	private constructor(kernelInstanceId: string) {
		this.#kernelInstanceId = kernelInstanceId;
	}

	static async create(root: string, kernelInstanceId: string, cachePath?: string): Promise<SessionControlPlane> {
		const plane = new SessionControlPlane(kernelInstanceId);
		const before = trailMetadata(root);
		const cache = cachePath ? readSessionCache(cachePath) : undefined;
		const changed = new Set<string>();
		for (const [trailFile, metadata] of before) {
			const cached = cache?.files[trailFile];
			if (cached && sameTrailMetadata(cached, metadata)) {
				if (cached.session) plane.#restore(cached.session);
				continue;
			}
			changed.add(trailFile);
		}
		// Every session owns one append-only trail. Preserve physical line order:
		// timestamps are presentation data and may move backwards when the host
		// clock is corrected. Cross-session ordering is irrelevant to projection.
		for await (const observed of readObservedEvents(
			root,
			changed,
			(trailFile, audit) => plane.#rememberAudit(trailFile, audit),
			(trailFile) => plane.#invalidTrails.add(trailFile),
		)) {
			plane.#apply(observed);
		}
		plane.#reconcilePreviousKernel();
		plane.#generatedAt = new Date().toISOString();
		if (cachePath) {
			try {
				const after = trailMetadata(root);
				const stable = new Map<string, TrailMetadata>();
				for (const [trailFile, metadata] of before) {
					if (plane.#invalidTrails.has(trailFile)) continue;
					const finalMetadata = after.get(trailFile);
					if (finalMetadata && sameTrailMetadata(finalMetadata, metadata)) {
						stable.set(trailFile, finalMetadata);
					}
				}
				writeSessionCache(cachePath, stable, plane.#sessions);
			} catch (error) {
				// The cache is an acceleration layer only. A future open will replay
				// the trail if a cache refresh cannot be committed atomically.
				console.warn(`session read-model cache refresh failed: ${(error as Error).message}`);
			}
		}
		return plane;
	}

	record(binding: TrailBinding, input: SessionRuntimeEventInput): SessionRuntimeView {
		const event = {
			...input,
			...(input.kind === "executor_started" ? { attachmentSequence: ++this.#attachmentSequence } : {}),
			at: new Date().toISOString(),
			kernelInstanceId: this.#kernelInstanceId,
		} as SessionRuntimeEvent;
		appendKernelSessionRuntimeObservation(binding, event);
		this.rememberAudit(binding);
		const session = this.#apply({
			trailFile: binding.file,
			sessionId: binding.sessionId,
			authority: binding.authority,
			event,
		});
		this.#publish(event, session);
		return session;
	}

	auditForTrail(trailFile: string): TrailAuditState | undefined {
		const audit = this.#audits.get(trailFile);
		return audit ? { ids: new Set(audit.ids), sequence: audit.sequence, lastHash: audit.lastHash } : undefined;
	}

	rememberAudit(binding: TrailBinding): void {
		this.#rememberAudit(binding.file, binding.audit);
	}

	/** High-frequency narration is useful live but is not durable lifecycle.
	 * Keeping it in-memory prevents thinking/tool beats from inflating the
	 * append-only company history. */
	observeActivity(binding: TrailBinding, executorId: string, activity: SessionRuntimeActivity): SessionRuntimeView {
		const current = this.#sessions.get(binding.file);
		if (
			current?.executorId === executorId &&
			current.status === "running" &&
			eventActivityEqual(current.activity, activity)
		) {
			return current;
		}
		const event: SessionRuntimeEvent = {
			kind: "activity",
			activity,
			executorId,
			at: new Date().toISOString(),
			kernelInstanceId: this.#kernelInstanceId,
		};
		const session = this.#apply({
			trailFile: binding.file,
			sessionId: binding.sessionId,
			authority: binding.authority,
			event,
		});
		this.#publish(event, session);
		return session;
	}

	/** An append failure cannot be durable by definition, but the live read
	 * model must immediately stop claiming that executor is healthy. Restart
	 * reconciliation then derives the conservative state from the last fact
	 * that did reach the trail. */
	observePersistenceFailure(binding: TrailBinding, executorId: string): SessionRuntimeView {
		const event: SessionRuntimeEvent = {
			kind: "persistence_failed",
			executorId,
			at: new Date().toISOString(),
			kernelInstanceId: this.#kernelInstanceId,
		};
		const session = this.#apply({
			trailFile: binding.file,
			sessionId: binding.sessionId,
			authority: binding.authority,
			event,
		});
		this.#publish(event, session);
		return session;
	}

	/** Last founder-led controller session attached by the kernel. Older
	 * companies without lifecycle observations fall back to filename-based
	 * discovery in the caller. */
	latestAttendedControllerTrailFile(): string | undefined {
		const candidates = [...this.#sessions.values()]
			.filter(
				(session) =>
					!this.#invalidTrails.has(session.trailFile) &&
					session.actor === "controller" &&
					!session.autonomous &&
					!session.label &&
					!session.department &&
					!session.worktree,
			)
			.sort(
				(left, right) =>
					(right.attachmentSequence ?? 0) - (left.attachmentSequence ?? 0) ||
					right.updatedAt.localeCompare(left.updatedAt),
			);
		if ((candidates[0]?.attachmentSequence ?? 0) > 0) return candidates[0]?.trailFile;
		const newestAt = candidates[0]?.updatedAt;
		if (newestAt && this.#lastAttachedTrailFile) {
			const tied = candidates.find(
				(session) => session.updatedAt === newestAt && session.trailFile === this.#lastAttachedTrailFile,
			);
			if (tied) return tied.trailFile;
		}
		return candidates[0]?.trailFile;
	}

	snapshot = (): SessionRuntimeSnapshot => ({
		revision: this.#revision,
		generatedAt: this.#generatedAt,
		sessions: [...this.#sessions.values()]
			.map((session) => ({
				...session,
				activity: session.activity ? { ...session.activity } : undefined,
				exit: session.exit ? { ...session.exit } : undefined,
			}))
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
	});

	subscribe = (listener: (update: SessionRuntimeUpdate) => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	isTrailVisible = (trailFile: string): boolean => !this.#invalidTrails.has(trailFile);

	#publish(event: SessionRuntimeEvent, session: SessionRuntimeView): void {
		const update = { event, session, snapshot: this.snapshot() };
		for (const listener of this.#listeners) {
			try {
				listener(update);
			} catch (error) {
				// Observation delivery is downstream of the durable state change. A
				// broken browser/SSE listener must never reverse control decisions.
				console.error(`session runtime listener failed: ${(error as Error).message}`);
			}
		}
	}

	#rememberAudit(trailFile: string, audit: TrailAuditState): void {
		this.#audits.set(trailFile, {
			ids: new Set(audit.ids),
			sequence: audit.sequence,
			lastHash: audit.lastHash,
		});
	}

	#restore(session: SessionRuntimeView): void {
		const restored: SessionRuntimeView = {
			...session,
			activity: undefined,
			exit: session.exit ? { ...session.exit } : undefined,
		};
		this.#sessions.set(restored.trailFile, restored);
		if ((restored.attachmentSequence ?? 0) >= this.#attachmentSequence) {
			this.#attachmentSequence = restored.attachmentSequence ?? this.#attachmentSequence;
			if (restored.attachmentSequence !== undefined) this.#lastAttachedTrailFile = restored.trailFile;
		}
		this.#revision += 1;
		this.#generatedAt = restored.updatedAt;
	}

	#apply(observed: ObservedSessionRuntimeEvent): SessionRuntimeView {
		const { event } = observed;
		const previous = this.#sessions.get(observed.trailFile);
		if (previous && event.kind !== "executor_started" && previous.executorId !== event.executorId) return previous;
		if (previous?.exit && !POST_EXIT_EVENTS.has(event.kind)) {
			// `exit` is the terminal fact for this executor attachment. stdout can
			// still flush buffered frames after Node emits `exit`; those frames may
			// describe the old turn but cannot revive its dead process.
			return previous;
		}
		const identity = authorityIdentity(observed.authority);
		let next: SessionRuntimeView = previous
			? { ...previous, ...identity, updatedAt: event.at }
			: {
					trailFile: observed.trailFile,
					sessionId: observed.sessionId,
					...identity,
					status: "starting",
					live: false,
					kernelInstanceId: event.kernelInstanceId,
					executorId: event.executorId,
					updatedAt: event.at,
				};

		switch (event.kind) {
			case "executor_started":
				if (event.attachmentSequence !== undefined) {
					if (event.attachmentSequence >= this.#attachmentSequence) {
						this.#attachmentSequence = event.attachmentSequence;
						this.#lastAttachedTrailFile = observed.trailFile;
					}
				} else if (this.#attachmentSequence === 0) {
					this.#lastAttachedTrailFile = observed.trailFile;
				}
				next = {
					...next,
					status: "starting",
					kernelInstanceId: event.kernelInstanceId,
					executorId: event.executorId,
					attachmentSequence: event.attachmentSequence,
					activity: { kind: "starting" },
					turnStartedAt: undefined,
					reconnectAttempt: undefined,
					exit: undefined,
				};
				break;
			case "executor_ready":
				if (next.status === "starting") next = { ...next, status: "idle", activity: undefined };
				break;
			case "turn_started":
				next = {
					...next,
					status: "running",
					turnStartedAt: event.at,
					turnInterrupted: undefined,
					activity: { kind: "starting" },
				};
				break;
			case "activity":
				next = { ...next, status: "running", activity: event.activity };
				break;
			case "turn_settled":
				next = {
					...next,
					// Autonomous work still owns a live executor while checkpoint and
					// shutdown complete. It becomes terminal only on executor_exited.
					status: next.autonomous ? "finishing" : "idle",
					activity: undefined,
					turnStartedAt: undefined,
					turnInterrupted: undefined,
				};
				break;
			case "turn_interrupted":
				next = {
					...next,
					status: "interrupted",
					activity: undefined,
					turnStartedAt: undefined,
					turnInterrupted: true,
				};
				break;
			case "executor_exited":
				next = {
					...next,
					status: event.expected
						? next.autonomous
							? next.status === "finishing"
								? "settled"
								: "interrupted"
							: event.busy
								? "interrupted"
								: "detached"
						: next.autonomous
							? "interrupted"
							: "reconnecting",
					activity: undefined,
					turnInterrupted: event.busy ? true : next.turnInterrupted,
					exit: {
						code: event.code,
						signal: event.signal,
						busy: event.busy,
						expected: event.expected,
					},
				};
				break;
			case "reconnect_scheduled":
				next = {
					...next,
					status: "reconnecting",
					reconnectAttempt: event.attempt,
					activity: undefined,
				};
				break;
			case "reconnect_failed":
				next = {
					...next,
					status: "interrupted",
					reconnectAttempt: event.attempt,
					activity: undefined,
				};
				break;
			case "persistence_failed":
				next = {
					...next,
					status: "interrupted",
					activity: undefined,
					turnInterrupted: next.status === "running" ? true : next.turnInterrupted,
				};
				break;
		}
		next.live = event.kernelInstanceId === this.#kernelInstanceId && ACTIVE_STATUSES.has(next.status);
		this.#sessions.set(observed.trailFile, next);
		this.#revision += 1;
		this.#generatedAt = event.at;
		return next;
	}

	#reconcilePreviousKernel(): void {
		for (const [file, session] of this.#sessions) {
			if (!ACTIVE_STATUSES.has(session.status)) continue;
			// Constructing a control plane is an ownership-generation boundary,
			// even when a company is closed and reopened inside one Electron
			// process. No replayed executor is attached to this new plane yet.
			const status: SessionRuntimeStatus =
				session.autonomous || session.status === "running" || session.status === "reconnecting"
					? "interrupted"
					: "detached";
			this.#sessions.set(file, {
				...session,
				status,
				live: false,
				activity: undefined,
				turnInterrupted:
					session.status === "running" || session.status === "reconnecting" ? true : session.turnInterrupted,
			});
			this.#revision += 1;
		}
	}
}
