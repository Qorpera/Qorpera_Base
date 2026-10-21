import { parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";
import { osRelative, parseCompanyStateFile } from "@qorpera/cloud-client/company-state-files";
import { parseMemoryRunToml } from "@qorpera/cloud-client/memory-run-files";
import { isUuid, parseClosedRecord, POSTGRES_UUID_PATTERN as UUID, WireValueError } from "@qorpera/contracts";
import type { CloudCompanyFolderClient, CloudCompanyFolderUnit } from "./cloud-company-folder-client.ts";
import type { CloudCompanyPathControl } from "./cloud-company-path-gateway.ts";
import { cloudToolRequest } from "./cloud-native-tool-authority.ts";
import {
	CLOUD_RUN_LOG_BLOCK_BYTES,
	type CloudRunLogFolder,
	CloudRunLogGone,
	type CloudRunLogOrigin,
	type CloudRunLogPlace,
	type CloudRunLogPreconditions,
	CloudRunLogUnavailable,
} from "./cloud-run-log.ts";

const BLOCK = /^(?:log|t(?:[0-9]|1[0-4]))\/[0-9]{8}\.jsonl$/;

function invalid(): never {
	throw new CloudRunLogUnavailable("folder_response_invalid");
}

function counter(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) invalid();
	return value as number;
}

function originOf(value: unknown): CloudRunLogOrigin {
	const origin = parseClosedRecord(value, "Run log origin", ["conversation", "parent", "step", "continues", "narrow"]);
	if (
		typeof origin.conversation !== "string" ||
		!UUID.test(origin.conversation) ||
		(origin.parent !== null && (typeof origin.parent !== "string" || !UUID.test(origin.parent))) ||
		(origin.continues !== null && (typeof origin.continues !== "string" || !UUID.test(origin.continues))) ||
		(origin.parent === null) !== (origin.step === null) ||
		typeof origin.narrow !== "boolean"
	)
		invalid();
	return {
		conversation: origin.conversation,
		parent: origin.parent as string | null,
		step: origin.step === null ? null : counter(origin.step, 999_999_999),
		continues: origin.continues as string | null,
		narrow: origin.narrow,
	};
}

/** W1c-3's persistence port. Location/origin comes from the platform; bytes and structured parses use the ordinary
 * run-actor folder client. No direct object-store access, service-actor read, or parser bypass. `locate` throws
 * CloudRunLogUnavailable("off") for a run in Agent notebooks (its recorded memory mode, 20260930508000), or one that
 * has no conversation tree: `openCloudRunLog` then makes none. CloudRunLogGone is only a log made once and no
 * longer there. */
export class CloudRunLogCompanyFolder implements CloudRunLogFolder {
	readonly #environmentId: string;
	readonly #runId: string;
	readonly #folder: CloudCompanyFolderClient;
	readonly #control: CloudCompanyPathControl;
	/** Previously located roots remain valid request targets: SQL refuses a stale location atomically at commit. */
	readonly #roots = new Map<string, readonly string[]>();

	constructor(options: {
		environmentId: string;
		runId: string;
		folder: CloudCompanyFolderClient;
		control: CloudCompanyPathControl;
	}) {
		if (!isUuid(options.environmentId) || !isUuid(options.runId) || options.folder.actor.runId !== options.runId)
			throw new Error("Invalid run log folder binding");
		this.#environmentId = options.environmentId;
		this.#runId = options.runId;
		this.#folder = options.folder;
		this.#control = options.control;
	}

	async locate(runId: string, signal: AbortSignal): Promise<CloudRunLogPlace> {
		try {
			return await this.#locate(runId, signal);
		} catch (error) {
			if (error instanceof WireValueError) invalid();
			throw error;
		}
	}

	async #locate(runId: string, signal: AbortSignal): Promise<CloudRunLogPlace> {
		if (runId !== this.#runId) throw new CloudRunLogUnavailable("folder_run_mismatch");
		const value = await cloudToolRequest(
			(requestSignal) =>
				this.#control.call(
					"qorpera_memory_run_log_place",
					{
						p_environment_id: this.#environmentId,
						p_run_id: this.#runId,
					},
					requestSignal,
				),
			signal,
		);
		if ((value as { gone?: unknown } | null)?.gone === true) {
			parseClosedRecord(value, "Run log place", ["gone"]);
			throw new CloudRunLogGone();
		}
		// The run is in Agent notebooks (its recorded memory mode, 20260930508000), or it has no conversation tree: the run
		// makes none.
		if ((value as { off?: unknown } | null)?.off === true) {
			parseClosedRecord(value, "Run log place", ["off"]);
			throw new CloudRunLogUnavailable("off");
		}
		const exists = (value as { exists?: unknown } | null)?.exists;
		const place = parseClosedRecord(value, "Run log place", [
			"path",
			"exists",
			"missing",
			"last",
			"generation",
			"gone",
			...(!exists ? ["origin"] : []),
		]);
		if (
			typeof exists !== "boolean" ||
			place.gone !== false ||
			typeof place.path !== "string" ||
			!Array.isArray(place.missing)
		)
			invalid();
		let path: string;
		try {
			path = parseCloudCompanyPath(place.path);
		} catch {
			invalid();
		}
		// The place is a key (qorperaos/agents/...): the position checks are on the part below the root, and the folders on
		// the way keep the root as the path spells it.
		const below = osRelative(path);
		if (below === null) invalid();
		const top = path.slice(0, path.length - below.length);
		const parts = below.split("/");
		const group =
			parts[0] === "agents" &&
			parts[1] === "groups" &&
			parts[3] === "memory" &&
			parts[4] === "runs" &&
			parts.length === 6;
		const thread =
			parts[0] === "agents" &&
			parts[1] !== "groups" &&
			parts[2] === "memory" &&
			parts[3] === "thread" &&
			parts[4] === "runs" &&
			parts.length === 6;
		if ((!group && !thread) || parts[5] !== this.#runId) invalid();
		const ancestors = (thread ? [3, 4, 5] : [4, 5]).map((length) => `${top}${parts.slice(0, length).join("/")}`);
		const missing = place.missing;
		let previous = -1;
		for (const folder of missing) {
			const index = typeof folder === "string" ? ancestors.indexOf(folder) : -1;
			if (index <= previous) invalid();
			previous = index;
		}
		if ((exists && missing.length !== 0) || (!exists && place.last !== null)) invalid();
		const last = place.last === null ? null : counter(place.last, 99_999_999);
		const generation = counter(place.generation);
		let origin: CloudRunLogOrigin;
		if (exists) {
			// Existing place replies deliberately omit origin. A missing or unreadable run.toml is not guessed from a
			// previous process's context: ordinary run-actor read authority still applies here.
			const file = await this.#folder.readText(`${path}/run.toml`, CLOUD_RUN_LOG_BLOCK_BYTES, signal);
			const parsed = file && parseMemoryRunToml(file.text);
			if (!parsed || parsed.run !== this.#runId) throw new CloudRunLogUnavailable("origin_unavailable");
			const { run: _run, ...storedOrigin } = parsed;
			origin = originOf(storedOrigin);
		} else origin = originOf(place.origin);
		signal.throwIfAborted();
		this.#roots.set(path, ancestors);
		return { path, exists, missing: [...missing] as string[], last, generation, origin };
	}

	async read(path: string, signal: AbortSignal): Promise<{ readonly version: string; readonly text: string } | null> {
		const root = [...this.#roots.keys()].find((candidate) => path.startsWith(`${candidate}/`));
		if (!root || !BLOCK.test(path.slice(root.length + 1))) throw new CloudRunLogUnavailable("folder_path_invalid");
		const file = await this.#folder.readText(path, CLOUD_RUN_LOG_BLOCK_BYTES, signal);
		if (!file) return null;
		if (!parseCompanyStateFile(path, file.text)?.ok) invalid();
		return { version: file.entry.version, text: file.text };
	}

	async commit(
		operationKey: string,
		units: readonly CloudCompanyFolderUnit[],
		preconditions: CloudRunLogPreconditions,
		signal: AbortSignal,
	) {
		const root = preconditions.runLog.path;
		const ancestors = this.#roots.get(root);
		if (preconditions.runLog.run !== this.#runId || !ancestors)
			throw new CloudRunLogUnavailable("folder_run_mismatch");
		const checked: CloudRunLogPreconditions = {
			runLog: { run: this.#runId, path: root },
			...(preconditions.runGenerations === undefined
				? {}
				: {
						runGenerations: preconditions.runGenerations.map(({ runId, generation }) => {
							if (runId !== this.#runId || !Number.isSafeInteger(generation) || generation < 0)
								throw new CloudRunLogUnavailable("folder_generation_invalid");
							return { runId, generation };
						}),
					}),
		};
		// A programming error must not stage arbitrary company content through this platform-only port.
		for (const unit of units) {
			if (unit.op !== "write" && unit.op !== "mkdir" && unit.op !== "new_folder")
				throw new CloudRunLogUnavailable("folder_path_invalid");
			const relative = unit.path.startsWith(`${root}/`) ? unit.path.slice(root.length + 1) : null;
			if (unit.op === "write" && relative !== null && BLOCK.test(relative)) continue;
			if (
				unit.op === "mkdir" &&
				(ancestors.includes(unit.path) || (relative !== null && /^(?:log|t(?:[0-9]|1[0-4]))$/.test(relative)))
			)
				continue;
			if (
				unit.op === "new_folder" &&
				unit.path === root &&
				unit.contents.every(
					(item) =>
						(item.path === "run.toml" && item.kind === "file") || (item.path === "log" && item.kind === "folder"),
				)
			)
				continue;
			throw new CloudRunLogUnavailable("folder_path_invalid");
		}
		const staged = await this.#folder.stage(units, signal);
		return this.#folder.memoryCommitStaged(operationKey, staged, checked, signal);
	}
}
