import {
	isUuid,
	parseClosedRecord,
	parseSha256Hex,
	parseTimestamp,
	parseUuid,
	SHA256_HEX_PATTERN,
} from "@qorpera/contracts";

/**
 * The records of a member's repository snapshots on this node (5h-2; deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md,
 * "Setup file and snapshots"; migration 20260930435000). SQL decides at attach whether this node's snapshot is current,
 * whether a build runs elsewhere, whether the last one failed, or whether the caller builds; it keeps the build's lease
 * and log, and names the images the node may keep. The builder VMs and the setup at attach are 5h-3's.
 */
export const CODING_SNAPSHOT_RPCS = [
	"qorpera_begin_coding_snapshot_build",
	"qorpera_renew_coding_snapshot_build",
	"qorpera_finish_coding_snapshot_build",
	"qorpera_list_coding_snapshots",
	"qorpera_record_coding_snapshot_removed",
] as const;

/** The most of a build's log SQL keeps, in UTF-8 bytes. */
export const CODING_SNAPSHOT_LOG_BYTES = 65536;
const LOG_CUT = "[earlier output cut]\n";

const COMMIT = /^[0-9a-f]{40}$/;
const OWNER = /^[A-Za-z0-9_.:-]{1,120}$/;
const FAILURE_CODE = /^[A-Z][A-Z0-9_:]{0,119}$/;
// U+FFFD, the replacement character.
const REPLACEMENT = String.fromCharCode(0xfffd);

/** The snapshot a new machine on this node starts from. */
export type CodingSnapshot = {
	snapshotId: string;
	setupDigest: string;
	commitSha: string;
	imageFingerprint: string;
	builtAt: string;
};

/** A build this executor runs: renew the lease before `leaseUntil`, then finish it with the same token. */
export type CodingSnapshotBuild = { buildId: string; leaseToken: string; leaseUntil: string };

/** This node's last build of the setup digest and commit, which failed. Its log is told to the member and the agent. */
export type CodingSnapshotFailure = { buildId: string; code: string; log: string | null; finishedAt: string };

/** At attach. Every answer but `current` carries the snapshot a new machine starts from meanwhile, if the node has one. */
export type CodingSnapshotPlan =
	| { state: "current"; snapshot: CodingSnapshot }
	| { state: "started"; snapshot: CodingSnapshot | null; build: CodingSnapshotBuild }
	| { state: "waiting"; snapshot: CodingSnapshot | null; waitingUntil: string }
	| { state: "failed"; snapshot: CodingSnapshot | null; failure: CodingSnapshotFailure };

/** How a build ended. `abandoned` is tried again at the next attach; `failed` only after a new commit or setup. The log is
 * already masked (5j); it is cut to its last `CODING_SNAPSHOT_LOG_BYTES` here. */
export type CodingSnapshotOutcome =
	| { kind: "ready"; imageFingerprint: string; log?: string }
	| { kind: "failed" | "abandoned"; code: string; log?: string };

/** A snapshot whose image may be on this node. One due for removal is removed, then recorded with `removed`. */
export type CodingSnapshotState = {
	snapshotId: string;
	state: "building" | "ready" | "retired";
	imageFingerprint: string | null;
	setupDigest: string;
	commitSha: string;
	startedAt: string;
	builtAt: string | null;
	leaseUntil: string | null;
	removeDue: boolean;
};

export interface CodingSnapshotRecordsOptions {
	control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> };
	/** The executor's owner and node, as for its machines. */
	owner: string;
	machineIdSha256: string;
}

/**
 * A build log SQL can keep: lone surrogates and NUL (which PostgreSQL text cannot hold) become U+FFFD, and a log over
 * `CODING_SNAPSHOT_LOG_BYTES` keeps its end, cut at a character, after a line saying earlier output was cut.
 */
export function codingSnapshotLog(text: string): string {
	const clean = text.replace(
		/\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
		REPLACEMENT,
	);
	const bytes = Buffer.from(clean, "utf8");
	if (bytes.length <= CODING_SNAPSHOT_LOG_BYTES) return clean;
	let start = bytes.length - (CODING_SNAPSHOT_LOG_BYTES - Buffer.byteLength(LOG_CUT));
	// Past a character's continuation bytes, to its next first byte.
	while (((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
	return LOG_CUT + bytes.subarray(start).toString("utf8");
}

export class CodingSnapshotRecords {
	readonly #options: CodingSnapshotRecordsOptions;

	constructor(options: CodingSnapshotRecordsOptions) {
		if (
			typeof options?.control?.call !== "function" ||
			typeof options.owner !== "string" ||
			!OWNER.test(options.owner) ||
			typeof options.machineIdSha256 !== "string" ||
			!SHA256_HEX_PATTERN.test(options.machineIdSha256)
		) {
			throw new Error("CODING_SNAPSHOT_CONFIGURATION_INVALID");
		}
		this.#options = { ...options };
	}

	/** At a session's attach, under its lease: this node's snapshot of the session's repository, and whether to build. */
	async begin(
		session: { workerId: string; leaseToken: string },
		setup: { setupDigest: string; commitSha: string },
		signal: AbortSignal,
	): Promise<CodingSnapshotPlan> {
		if (
			!isUuid(session.workerId) ||
			!isUuid(session.leaseToken) ||
			!SHA256_HEX_PATTERN.test(setup.setupDigest) ||
			!COMMIT.test(setup.commitSha)
		) {
			throw new Error("CODING_SNAPSHOT_INPUT_INVALID");
		}
		const answer = await this.#call(
			"qorpera_begin_coding_snapshot_build",
			{
				p_worker_id: session.workerId,
				p_lease_token: session.leaseToken,
				p_machine_id_sha256: this.#options.machineIdSha256,
				p_setup_digest: setup.setupDigest,
				p_commit_sha: setup.commitSha,
			},
			signal,
		);
		return parsed("CODING_SNAPSHOT_PLAN_INVALID", () => parsePlan(answer, setup));
	}

	/** Keeps the build's lease; the new end of it. A refusal means the build may not finish: stop it. */
	async renew(build: CodingSnapshotBuild, signal: AbortSignal): Promise<string> {
		if (!isUuid(build.buildId) || !isUuid(build.leaseToken)) throw new Error("CODING_SNAPSHOT_INPUT_INVALID");
		const answer = await this.#call(
			"qorpera_renew_coding_snapshot_build",
			{ p_build_id: build.buildId, p_lease_token: build.leaseToken },
			signal,
		);
		return parsed("CODING_SNAPSHOT_LEASE_INVALID", () => parseTimestamp(answer, "leaseUntil").text);
	}

	/** Records how the build ended; sent again, the same answer. Ready retires this node's older snapshot (`retired` when a
	 * replay finds it already retired in turn). */
	async finish(
		build: CodingSnapshotBuild,
		outcome: CodingSnapshotOutcome,
		signal: AbortSignal,
	): Promise<"ready" | "retired" | "failed" | "abandoned"> {
		if (
			!isUuid(build.buildId) ||
			!isUuid(build.leaseToken) ||
			(outcome.kind === "ready"
				? !SHA256_HEX_PATTERN.test(outcome.imageFingerprint)
				: !["failed", "abandoned"].includes(outcome.kind) || !FAILURE_CODE.test(outcome.code)) ||
			(outcome.log !== undefined && typeof outcome.log !== "string")
		) {
			throw new Error("CODING_SNAPSHOT_INPUT_INVALID");
		}
		const answer = await this.#call(
			"qorpera_finish_coding_snapshot_build",
			{
				p_build_id: build.buildId,
				p_lease_token: build.leaseToken,
				p_outcome: outcome.kind,
				p_image_fingerprint: outcome.kind === "ready" ? outcome.imageFingerprint : null,
				p_failure: outcome.kind === "ready" ? null : outcome.code,
				p_log: outcome.log === undefined ? null : codingSnapshotLog(outcome.log),
			},
			signal,
		);
		return parsed("CODING_SNAPSHOT_FINISH_INVALID", () => {
			const value = parseClosedRecord(answer, "finish", ["schema", "buildId", "state"]);
			const state = value.state;
			if (
				value.schema !== "qorpera.coding-snapshot-build/v1" ||
				parseUuid(value.buildId, "buildId") !== build.buildId ||
				!(outcome.kind === "ready" ? state === "ready" || state === "retired" : state === outcome.kind)
			) {
				throw new Error("finish");
			}
			return state as "ready" | "retired" | "failed" | "abandoned";
		});
	}

	/** The snapshots whose images may be on this node. An image not listed is not kept. */
	async list(signal: AbortSignal): Promise<CodingSnapshotState[]> {
		const answer = await this.#call(
			"qorpera_list_coding_snapshots",
			{ p_owner: this.#options.owner, p_machine_id_sha256: this.#options.machineIdSha256 },
			signal,
		);
		return parsed("CODING_SNAPSHOT_LIST_INVALID", () => {
			if (!Array.isArray(answer)) throw new Error("list");
			const states = answer.map(parseState);
			if (new Set(states.map((state) => state.snapshotId)).size !== states.length) throw new Error("list");
			return states;
		});
	}

	/** After the image of a snapshot due for removal is gone from the node; sent again, the same answer. */
	async removed(snapshotId: string, signal: AbortSignal): Promise<void> {
		if (!isUuid(snapshotId)) throw new Error("CODING_SNAPSHOT_INPUT_INVALID");
		const answer = await this.#call(
			"qorpera_record_coding_snapshot_removed",
			{
				p_snapshot_id: snapshotId,
				p_owner: this.#options.owner,
				p_machine_id_sha256: this.#options.machineIdSha256,
			},
			signal,
		);
		parsed("CODING_SNAPSHOT_REMOVAL_INVALID", () => {
			const value = parseClosedRecord(answer, "removed", ["schema", "snapshotId", "removedAt"]);
			parseTimestamp(value.removedAt, "removedAt");
			if (
				value.schema !== "qorpera.coding-snapshot-removed/v1" ||
				parseUuid(value.snapshotId, "snapshotId") !== snapshotId
			) {
				throw new Error("removed");
			}
		});
	}

	#call(
		method: (typeof CODING_SNAPSHOT_RPCS)[number],
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		return this.#options.control.call(method, args, AbortSignal.any([signal, AbortSignal.timeout(30000)]));
	}
}

/** Any problem in an answer is the one code; the value never reaches a message. */
function parsed<T>(code: string, read: () => T): T {
	try {
		return read();
	} catch {
		throw new Error(code);
	}
}

function parsePlan(answer: unknown, setup: { setupDigest: string; commitSha: string }): CodingSnapshotPlan {
	const value = parseClosedRecord(answer, "plan", ["schema", "state", "snapshot", "build", "waitingUntil", "failure"]);
	if (value.schema !== "qorpera.coding-snapshot-plan/v1") throw new Error("plan");
	const snapshot = value.snapshot === null ? null : parseSnapshot(value.snapshot);
	const absent = (keys: string[]) => {
		if (keys.some((key) => value[key] !== null)) throw new Error("plan");
	};
	switch (value.state) {
		case "current":
			absent(["build", "waitingUntil", "failure"]);
			// SQL answers current only for this digest and commit.
			if (
				snapshot === null ||
				snapshot.setupDigest !== setup.setupDigest ||
				snapshot.commitSha !== setup.commitSha
			) {
				throw new Error("plan");
			}
			return { state: "current", snapshot };
		case "started": {
			absent(["waitingUntil", "failure"]);
			const build = parseClosedRecord(value.build, "build", ["buildId", "leaseToken", "leaseUntil"]);
			return {
				state: "started",
				snapshot,
				build: {
					buildId: parseUuid(build.buildId, "buildId"),
					leaseToken: parseUuid(build.leaseToken, "leaseToken"),
					leaseUntil: parseTimestamp(build.leaseUntil, "leaseUntil").text,
				},
			};
		}
		case "waiting":
			absent(["build", "failure"]);
			return { state: "waiting", snapshot, waitingUntil: parseTimestamp(value.waitingUntil, "waitingUntil").text };
		case "failed": {
			absent(["build", "waitingUntil"]);
			const failure = parseClosedRecord(value.failure, "failure", ["buildId", "code", "log", "finishedAt"]);
			if (typeof failure.code !== "string" || !FAILURE_CODE.test(failure.code)) throw new Error("plan");
			if (failure.log !== null && typeof failure.log !== "string") throw new Error("plan");
			return {
				state: "failed",
				snapshot,
				failure: {
					buildId: parseUuid(failure.buildId, "buildId"),
					code: failure.code,
					log: failure.log,
					finishedAt: parseTimestamp(failure.finishedAt, "finishedAt").text,
				},
			};
		}
		default:
			throw new Error("plan");
	}
}

function parseSnapshot(input: unknown): CodingSnapshot {
	const value = parseClosedRecord(input, "snapshot", [
		"snapshotId",
		"setupDigest",
		"commitSha",
		"imageFingerprint",
		"builtAt",
	]);
	if (typeof value.commitSha !== "string" || !COMMIT.test(value.commitSha)) throw new Error("snapshot");
	return {
		snapshotId: parseUuid(value.snapshotId, "snapshotId"),
		setupDigest: parseSha256Hex(value.setupDigest, "setupDigest"),
		commitSha: value.commitSha,
		imageFingerprint: parseSha256Hex(value.imageFingerprint, "imageFingerprint"),
		builtAt: parseTimestamp(value.builtAt, "builtAt").text,
	};
}

function parseState(input: unknown): CodingSnapshotState {
	const value = parseClosedRecord(input, "state", [
		"schema",
		"snapshotId",
		"state",
		"imageFingerprint",
		"setupDigest",
		"commitSha",
		"startedAt",
		"builtAt",
		"leaseUntil",
		"removeDue",
	]);
	const state = value.state;
	if (
		value.schema !== "qorpera.coding-snapshot-state/v1" ||
		(state !== "building" && state !== "ready" && state !== "retired") ||
		typeof value.commitSha !== "string" ||
		!COMMIT.test(value.commitSha) ||
		typeof value.removeDue !== "boolean" ||
		// A running build has a lease and no image yet; a built one has an image and no lease. A retired one is always due.
		(state === "building") !== (value.leaseUntil !== null) ||
		(state === "building") !== (value.builtAt === null) ||
		(state === "building") !== (value.imageFingerprint === null) ||
		(state === "building" && value.removeDue) ||
		(state === "retired" && !value.removeDue)
	) {
		throw new Error("state");
	}
	return {
		snapshotId: parseUuid(value.snapshotId, "snapshotId"),
		state,
		imageFingerprint:
			value.imageFingerprint === null ? null : parseSha256Hex(value.imageFingerprint, "imageFingerprint"),
		setupDigest: parseSha256Hex(value.setupDigest, "setupDigest"),
		commitSha: value.commitSha,
		startedAt: parseTimestamp(value.startedAt, "startedAt").text,
		builtAt: value.builtAt === null ? null : parseTimestamp(value.builtAt, "builtAt").text,
		leaseUntil: value.leaseUntil === null ? null : parseTimestamp(value.leaseUntil, "leaseUntil").text,
		removeDue: value.removeDue,
	};
}
