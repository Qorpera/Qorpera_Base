import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
	type CloudCodingCommandScope,
	type CloudCodingNasPolicy,
	type CloudCodingRepository,
	createCloudCodingStorageBinding,
	parseCloudCodingNasPolicy,
} from "@qorpera/contracts";
import { LxdCodingCommandTransport } from "./coding-command-transport.ts";
import type {
	CodingExecutorHost,
	CodingExecutorPublication,
	CodingSessionClaim,
	CodingSubmission,
	CodingTurnState,
	CodingWorkspace,
} from "./coding-executor.ts";
import { type CodingBrokerGitRunner, pushCloudCodingBundle } from "./coding-git.ts";
import { fetchCloudCodingSeed, resolveCloudCodingBase } from "./coding-git-seed.ts";
import { LxdCodingGitTransfer } from "./coding-git-transfer.ts";
import { LxdCodingLeaseTransport } from "./coding-lease-transport.ts";
import { type CodingNasStorage, createCodingNasStorage } from "./coding-storage.ts";
import {
	assertLxdCodingVmInstance,
	type CodingVmAdmissionReceipt,
	type LxdCodingVmBinding,
	lxdCodingVmPlan,
	reconcileLxdCodingVm,
} from "./coding-vm.ts";
import { publishCloudCodingDraftPullRequest } from "./coding-workspace.ts";
import type { LxdInspectableClient, LxdTrackedClient } from "./lxd-client.ts";
import { checkDirectory, code, publish, readRecord } from "./lxd-office-journal-files.ts";

export const CODING_HOST_RPCS = [
	"qorpera_authorize_coding_machine",
	"qorpera_authorize_coding_cleanup",
	"qorpera_describe_coding_cleanup",
] as const;

/** The leased session a repository token is asked for (bundle v88): the
 * company whose secret broker holds its GitHub connection, and the worker and
 * lease the kernel checks before the broker releases anything. */
export interface CodingRepositoryCredentialScope {
	readonly companyId: string;
	readonly workerId: string;
	readonly leaseToken: string;
}

export interface CodingRepositoryCredentials {
	/** Lends the repository token to `use` for the length of one Git broker or
	 * GitHub API step. The token never leaves the executor's own processes. */
	withRepositoryToken<T>(
		scope: CodingRepositoryCredentialScope,
		repository: CloudCodingRepository,
		use: (token: string) => Promise<T>,
		signal: AbortSignal,
	): Promise<T>;
}

type RepositoryTokenLender = <T>(
	repository: CloudCodingRepository,
	use: (token: string) => Promise<T>,
	signal: AbortSignal,
) => Promise<T>;

export type CodingExecutorVmPolicy = Omit<
	LxdCodingVmBinding,
	"schema" | "workerId" | "allocationId" | "companyId" | "environmentId" | "repository" | "storage"
>;
export interface LxdCodingExecutorHostOptions {
	control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> };
	owner: string;
	machineIdSha256: string;
	vmPolicy: CodingExecutorVmPolicy;
	storagePolicy: CloudCodingNasPolicy;
	client: Pick<LxdTrackedClient, "getInstance" | "submitInstanceOperation" | "inspectInstanceOperation"> &
		Pick<LxdInspectableClient, "readInstanceFile" | "pushInstanceFile" | "execInstance">;
	journalRoot: string;
	guest: {
		uid: number;
		gid: number;
		workspacePath: string;
		homePath: string;
		cachePath: string;
		outputRoot: string;
		resourceProfile: {
			maxTimeoutMs: number;
			memoryBytes: number;
			tasksMax: number;
			cpuQuotaPercent: number;
			maxLogBytes: number;
		};
		storageHelperSha256: string;
		commandHelperSha256: string;
		gitHelperSha256: string;
		watchdogHelperSha256: string;
	};
	repositoryCredentials: CodingRepositoryCredentials;
	fetch?: typeof fetch;
	runGit?: CodingBrokerGitRunner;
	/** How long a freshly started guest may take to bring up its agent and
	 * watchdog timer (default 120 s). */
	guestReadyTimeoutMs?: number;
}
interface Prepared {
	claim: CodingSessionClaim;
	vm: LxdCodingVmBinding;
	scope: CloudCodingCommandScope;
	bootId: string;
	guestConfigSha256: string;
	baseSha: string;
}
const SHA = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Budget for one physical VM stop: the guest's graceful quiesce plus the
 * forced power-off, journal I/O included. Callers that bound the whole
 * cleanup (lookup + stop) allow more than this. */
export const CODING_VM_STOP_BUDGET_MS = 30_000;
/** Part of the stop budget for stopping the command slice and syncing the
 * NAS workspace before the VM is powered off. */
const CODING_VM_QUIESCE_MS = 8_000;
/** A starting guest: its lxd-agent is not up yet, or systemd answered that
 * the timer is not active. Anything else (the VM gone, a refused or malformed
 * operation) fails the wait at once with its own cause. */
function guestStarting(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message === "LXD instance agent not running" || error.message === "LXD instance command failed")
	);
}
function digest(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}
/** A stable identifier derived from a label and a source; the kernel derives
 * the turn id ("turn", `${workerId}:${sequence}`) the same way. */
export function codingHostId(label: string, source: string): string {
	const hash = digest(`qorpera.coding-host/${label}/${source}`);
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export function codingTurnScope(workerId: string, vmId: string, sequence: number): CloudCodingCommandScope {
	return Object.freeze({ workerId, vmId, requestId: codingHostId("turn", `${workerId}:${sequence}`), turn: sequence });
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CODING_HOST_RECEIPT_INVALID");
	return value as Record<string, unknown>;
}

/** Concrete trusted composition. Only LXD fixed helpers touch the untrusted
 * checkout; repository credentials stay in the separate Git broker processes.
 * No effect is inferred from a label, a model statement or an assigned runner. */
export class LxdCodingExecutorHost implements CodingExecutorHost {
	readonly #options: LxdCodingExecutorHostOptions;
	readonly #storage: CodingNasStorage;
	#storageWork: Promise<unknown> = Promise.resolve();
	readonly #vmWork = new Map<string, { work: Promise<void>; cancel: AbortController }>();
	readonly #prepared = new Map<string, Prepared>();
	constructor(options: LxdCodingExecutorHostOptions) {
		if (
			!/^[A-Za-z0-9_.:-]{1,120}$/.test(options.owner) ||
			!SHA.test(options.machineIdSha256) ||
			resolve(options.journalRoot) !== options.journalRoot ||
			options.guest.uid === process.geteuid?.() ||
			![
				options.guest.commandHelperSha256,
				options.guest.gitHelperSha256,
				options.guest.watchdogHelperSha256,
				options.guest.storageHelperSha256,
			].every((hash) => SHA.test(hash)) ||
			![options.guest.uid, options.guest.gid].every((value) => Number.isSafeInteger(value) && value >= 1000) ||
			resolve(options.guest.workspacePath) !== options.guest.workspacePath ||
			options.guest.workspacePath !== "/workspace/repository" ||
			options.guest.homePath !== "/workspace/home" ||
			options.guest.cachePath !== "/workspace/cache" ||
			options.guest.outputRoot !== "/var/lib/qorpera-coding/logs" ||
			options.guest.resourceProfile.memoryBytes > options.vmPolicy.memoryBytes ||
			options.guest.resourceProfile.cpuQuotaPercent > options.vmPolicy.cpus * 100 ||
			/[\s\0]/.test(options.guest.workspacePath)
		)
			throw new Error("CODING_HOST_CONFIGURATION_INVALID");
		const storagePolicy = parseCloudCodingNasPolicy(options.storagePolicy);
		this.#storage = createCodingNasStorage(storagePolicy);
		if (options.journalRoot !== this.#storage.controlPath) throw new Error("CODING_HOST_JOURNAL_NOT_ON_NAS");
		this.#options = {
			...options,
			storagePolicy,
			vmPolicy: Object.freeze({ ...options.vmPolicy }),
			guest: Object.freeze({
				...options.guest,
				resourceProfile: Object.freeze({ ...options.guest.resourceProfile }),
			}),
		};
	}
	#call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		signal.throwIfAborted();
		return this.#options.control.call(method, args, AbortSignal.any([signal, AbortSignal.timeout(30000)]));
	}
	#vm(claim: CodingSessionClaim, allocationId: string | null): LxdCodingVmBinding {
		return lxdCodingVmPlan({
			...this.#options.vmPolicy,
			schema: "qorpera.lxd-coding-vm/v2",
			storage: createCloudCodingStorageBinding(this.#options.storagePolicy, {
				workerId: claim.workerId,
				companyId: claim.profileId,
				environmentId: claim.environmentId,
				machineIdSha256: this.#options.machineIdSha256,
				writerGeneration: 1,
			}),
			workerId: claim.workerId,
			allocationId: allocationId ?? codingHostId("allocation", claim.workerId),
			companyId: claim.profileId,
			environmentId: claim.environmentId,
			repository: claim.repository,
		}).binding;
	}
	async #storageTask<T>(use: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		const checked = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(5000)]);
		// Keep the real promise as custody even after the caller's timeout. Normal
		// heartbeat/command overlap queues; unresolved hard-NFS IO never overlaps.
		const work = this.#storageWork
			.catch(() => undefined)
			.then(() => {
				checked.throwIfAborted();
				return use(checked);
			});
		this.#storageWork = work;
		let abort: (() => void) | undefined;
		try {
			return await Promise.race([
				work,
				new Promise<never>((_resolve, reject) => {
					abort = () => reject(checked.reason);
					checked.addEventListener("abort", abort, { once: true });
					if (checked.aborted) abort();
				}),
			]);
		} finally {
			if (abort) checked.removeEventListener("abort", abort);
		}
	}
	async #directory(name: string, callerSignal?: AbortSignal): Promise<string> {
		return this.#storageTask(async (signal) => {
			await this.#storage.assertControl(signal);
			await checkDirectory(this.#options.journalRoot);
			const path = join(this.#options.journalRoot, name);
			signal.throwIfAborted();
			await mkdir(path, { mode: 0o700 }).catch((error) => {
				if (!code(error, "EEXIST")) throw error;
			});
			await checkDirectory(path);
			await this.#storage.assertControl(signal);
			return path;
		}, callerSignal);
	}
	/** Machine authority for a run effect (needs the live session lease) or a stop
	 * effect (needs plan custody: this owner, this node). Valid for seconds. */
	async #authorize(
		claim: CodingSessionClaim,
		vm: LxdCodingVmBinding,
		intent: "run" | "stop",
		signal: AbortSignal,
		prepareStorage = false,
	): Promise<CodingVmAdmissionReceipt> {
		const started = performance.now();
		const plan = lxdCodingVmPlan(vm);
		const value = record(
			await this.#call(
				intent === "run" ? "qorpera_authorize_coding_machine" : "qorpera_authorize_coding_cleanup",
				intent === "run"
					? {
							p_worker_id: claim.workerId,
							p_lease_token: claim.leaseToken,
							p_binding_text: JSON.stringify(plan.binding),
							p_machine_id_sha256: this.#options.machineIdSha256,
							p_intent: "run",
						}
					: {
							p_worker_id: claim.workerId,
							p_owner: this.#options.owner,
							p_binding_text: JSON.stringify(plan.binding),
							p_machine_id_sha256: this.#options.machineIdSha256,
						},
				signal,
			),
		);
		if (value.state === "refused") throw new Error(`CODING_HOST_MACHINE_REFUSED:${String(value.reason ?? "")}`);
		if (
			!isDeepStrictEqual(value, {
				schema: "qorpera.coding-vm-admission/v1",
				workerId: vm.workerId,
				allocationId: vm.allocationId,
				instanceSha256: plan.instanceSha256,
				intent,
				validForMs: value.validForMs,
				nodeId: value.nodeId,
				nodeVersion: value.nodeVersion,
			}) ||
			!Number.isSafeInteger(value.validForMs) ||
			Number(value.validForMs) < 1 ||
			Number(value.validForMs) > 5000 ||
			typeof value.nodeId !== "string" ||
			!UUID.test(value.nodeId) ||
			!Number.isSafeInteger(value.nodeVersion) ||
			Number(value.nodeVersion) < 1 ||
			performance.now() - started >= Number(value.validForMs)
		)
			throw new Error("CODING_HOST_MACHINE_AUTHORITY_UNCONFIRMED");
		if (intent === "run") {
			await this.#storageTask(async (checked) => {
				if (prepareStorage) {
					await this.#storage.prepareControl(checked);
					await this.#storage.prepare(vm.storage, checked);
				} else {
					await this.#storage.assertControl(checked);
					await this.#storage.assert(vm.storage, checked);
				}
			}, signal);
		}
		if (performance.now() - started >= Number(value.validForMs))
			throw new Error("CODING_HOST_MACHINE_AUTHORITY_EXPIRED");
		signal.throwIfAborted();
		return value as unknown as CodingVmAdmissionReceipt;
	}
	async #reconcile(
		claim: CodingSessionClaim,
		vm: LxdCodingVmBinding,
		desiredState: "running" | "stopped",
		signal: AbortSignal,
	): Promise<void> {
		const pending = this.#vmWork.get(vm.workerId);
		if (pending) {
			if (desiredState === "stopped") pending.cancel.abort(new Error("CODING_HOST_VM_STOP_REQUESTED"));
			throw new Error("CODING_HOST_VM_IO_PENDING");
		}
		const cancel = new AbortController();
		// A stop polls the forced power-off to its settlement (and re-issues it if
		// LXD reports the VM still running); 5 s ended ordinary stops as
		// recovery-required.
		const checked = AbortSignal.any([
			signal,
			cancel.signal,
			AbortSignal.timeout(desiredState === "stopped" ? CODING_VM_STOP_BUDGET_MS : 300000),
		]);
		// The caller deadline includes journal reads and writes. Keep custody of
		// the actual promise after timeout so a hard-NFS syscall cannot overlap a
		// retry.
		const work = (async () => {
			for (;;) {
				checked.throwIfAborted();
				const journalRoot = await this.#directory("machines", checked);
				checked.throwIfAborted();
				const result = await reconcileLxdCodingVm({
					binding: vm,
					journalRoot,
					desiredState,
					client: this.#options.client,
					admission: { authorize: (binding, intent, s) => this.#authorize(claim, binding, intent, s) },
					signal: checked,
				});
				checked.throwIfAborted();
				if (result.state === desiredState || (desiredState === "stopped" && result.state === "absent")) return;
				if (result.state !== "pending") throw new Error("CODING_HOST_VM_RECOVERY_REQUIRED");
				await setTimeout(500, undefined, { signal: checked });
			}
		})();
		this.#vmWork.set(vm.workerId, { work, cancel });
		void work
			.finally(() => {
				if (this.#vmWork.get(vm.workerId)?.work === work) this.#vmWork.delete(vm.workerId);
			})
			.catch(() => undefined);
		let abort: (() => void) | undefined;
		try {
			await Promise.race([
				work,
				new Promise<never>((_resolve, reject) => {
					abort = () => reject(checked.reason);
					checked.addEventListener("abort", abort, { once: true });
					if (checked.aborted) abort();
				}),
			]);
		} finally {
			if (abort) checked.removeEventListener("abort", abort);
		}
	}
	async #guest(
		claim: CodingSessionClaim,
		vm: LxdCodingVmBinding,
		signal: AbortSignal,
	): Promise<{ bootId: string; guestConfigSha256: string }> {
		const { request } = lxdCodingVmPlan(vm),
			client = this.#options.client;
		await this.#authorize(claim, vm, "run", signal);
		const instance = await client.getInstance(vm.project, request.name, signal);
		if (!instance || instance.status !== "Running" || instance.statusCode !== 103)
			throw new Error("CODING_HOST_VM_NOT_RUNNING");
		assertLxdCodingVmInstance(vm, instance);
		// A VM that has just started answers before its agent and systemd are up:
		// the watchdog timer turns active a few seconds after the agent. Wait,
		// bounded, for both before trusting the boot; anything else still fails.
		const ready = AbortSignal.any([signal, AbortSignal.timeout(this.#options.guestReadyTimeoutMs ?? 120_000)]);
		for (let round = 0; ; round++) {
			try {
				// Every retry re-reads the VM: one deleted or stopped elsewhere
				// fails now instead of after the whole readiness window.
				if (round > 0) {
					const current = await client.getInstance(vm.project, request.name, ready);
					if (!current || current.status !== "Running" || current.statusCode !== 103)
						throw new Error("CODING_HOST_VM_NOT_RUNNING");
					assertLxdCodingVmInstance(vm, current);
				}
				await client.execInstance(
					vm.project,
					request.name,
					["/usr/bin/systemctl", "is-active", "--quiet", "qorpera-coding-watchdog.timer"],
					ready,
				);
				break;
			} catch (error) {
				signal.throwIfAborted();
				if (ready.aborted) throw new Error("CODING_HOST_GUEST_NOT_READY", { cause: error });
				if (!guestStarting(error)) throw error;
				if (error instanceof Error && error.message === "LXD instance command failed") {
					// systemd answered: the timer is not active. A failed or disabled
					// timer never becomes active by waiting; one still starting does.
					try {
						await this.#watchdogStarting(vm, request.name, ready);
					} catch (probeError) {
						signal.throwIfAborted();
						if (ready.aborted) throw new Error("CODING_HOST_GUEST_NOT_READY", { cause: probeError });
						if (!guestStarting(probeError)) throw probeError;
					}
				}
				await setTimeout(1000, undefined, { signal: ready }).catch(() => undefined);
				// The caller's own abort wins over the readiness deadline.
				signal.throwIfAborted();
				if (ready.aborted) throw new Error("CODING_HOST_GUEST_NOT_READY", { cause: error });
			}
		}
		const boot = await client.readInstanceFile(
			vm.project,
			request.name,
			"/proc/sys/kernel/random/boot_id",
			64,
			signal,
		);
		const bootId = boot.content.toString("utf8").trim();
		if (boot.uid !== 0 || boot.gid !== 0 || boot.mode !== 0o444 || !UUID.test(bootId))
			throw new Error("CODING_HOST_BOOT_UNCONFIRMED");
		for (const [file, hash] of [
			["cloud-coding-command-guest.mjs", this.#options.guest.commandHelperSha256],
			["cloud-coding-git-guest.mjs", this.#options.guest.gitHelperSha256],
			["cloud-coding-watchdog.mjs", this.#options.guest.watchdogHelperSha256],
			["cloud-coding-storage-guest.mjs", this.#options.guest.storageHelperSha256],
		]) {
			const content = await client.readInstanceFile(
				vm.project,
				request.name,
				`/opt/qorpera-coding/${file}`,
				65536,
				signal,
			);
			if (content.uid !== 0 || content.gid !== 0 || content.mode !== 0o444 || digest(content.content) !== hash)
				throw new Error("CODING_HOST_GUEST_ARTIFACT_CHANGED");
		}
		// An image that can upgrade itself restarts the session's units under it,
		// then its shutdown inhibitor refuses the stop and the VM keeps its node
		// slot. The pinned storage helper refuses unless the apt units are masked.
		try {
			await client.execInstance(
				vm.project,
				request.name,
				["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-storage-guest.mjs", "image"],
				signal,
			);
		} catch (error) {
			if (error instanceof Error && error.message === "LXD instance command failed")
				throw new Error("RUNNER_IMAGE_SELF_UPDATE_ENABLED", { cause: error });
			throw error;
		}
		await client.execInstance(
			vm.project,
			request.name,
			["/usr/bin/systemctl", "is-active", "--quiet", "qorpera-coding-watchdog.timer"],
			signal,
		);
		const configuration = {
			schema: "qorpera.coding-command-guest/v2",
			workerId: vm.workerId,
			vmId: vm.allocationId,
			bootId,
			uid: this.#options.guest.uid,
			gid: this.#options.guest.gid,
			workspacePath: this.#options.guest.workspacePath,
			homePath: this.#options.guest.homePath,
			cachePath: this.#options.guest.cachePath,
			outputRoot: this.#options.guest.outputRoot,
			resourceProfile: this.#options.guest.resourceProfile,
		};
		const root = await this.#directory("guests"),
			name = `${vm.workerId}.${bootId}.json`;
		const encoded = JSON.stringify(configuration);
		await publish(root, name, Buffer.from(encoded));
		if (!isDeepStrictEqual((await readRecord(join(root, name))).value, configuration))
			throw new Error("CODING_HOST_GUEST_BINDING_CHANGED");
		// The host journal is an immutable intent, not proof of guest delivery.
		// Stage it on every retry; only the fixed installer may publish active
		// configuration, resume partial delivery, or advance an exact old boot.
		const packet = JSON.stringify({
			schema: "qorpera.coding-configuration-install/v1",
			guest: configuration,
			storage: vm.storage,
		});
		if (Buffer.byteLength(packet) > 16384) throw new Error("CODING_HOST_GUEST_CONFIGURATION_TOO_LARGE");
		await this.#authorize(claim, vm, "run", signal);
		await client.pushInstanceFile(
			vm.project,
			request.name,
			"/etc/qorpera-coding/configuration-inbox.json",
			packet,
			0o444,
			signal,
		);
		await this.#authorize(claim, vm, "run", signal);
		await client.execInstance(
			vm.project,
			request.name,
			["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-storage-guest.mjs", "install"],
			signal,
		);
		const storageEncoded = JSON.stringify(vm.storage);
		const actualStorage = await client.readInstanceFile(
			vm.project,
			request.name,
			"/etc/qorpera-coding/storage.json",
			8192,
			signal,
		);
		if (
			actualStorage.uid !== 0 ||
			actualStorage.gid !== 0 ||
			actualStorage.mode !== 0o444 ||
			actualStorage.content.toString("utf8") !== storageEncoded
		)
			throw new Error("CODING_HOST_GUEST_STORAGE_UNCONFIRMED");
		const actual = await client.readInstanceFile(
			vm.project,
			request.name,
			"/etc/qorpera-coding/guest.json",
			8192,
			signal,
		);
		if (actual.uid !== 0 || actual.gid !== 0 || actual.mode !== 0o444 || actual.content.toString("utf8") !== encoded)
			throw new Error("CODING_HOST_GUEST_CONFIGURATION_UNCONFIRMED");
		await this.#authorize(claim, vm, "run", signal);
		await client.execInstance(
			vm.project,
			request.name,
			["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-storage-guest.mjs", "initialize"],
			signal,
		);
		return { bootId, guestConfigSha256: digest(encoded) };
	}
	/** The repository token for this claim's session only. */
	#repositoryToken(claim: CodingSessionClaim): RepositoryTokenLender {
		const scope: CodingRepositoryCredentialScope = Object.freeze({
			companyId: claim.profileId,
			workerId: claim.workerId,
			leaseToken: claim.leaseToken,
		});
		const credentials = this.#options.repositoryCredentials;
		return (repository, use, signal) => credentials.withRepositoryToken(scope, repository, use, signal);
	}
	#active(claim: CodingSessionClaim): Prepared {
		const ready = this.#prepared.get(claim.workerId);
		if (!ready || ready.claim.leaseToken !== claim.leaseToken || ready.scope.turn !== claim.sequence)
			throw new Error("CODING_HOST_TURN_NOT_PREPARED");
		return ready;
	}
	#transfer(ready: Prepared): LxdCodingGitTransfer {
		return new LxdCodingGitTransfer({
			vm: ready.vm,
			scope: ready.scope,
			bootId: ready.bootId,
			guestConfigSha256: ready.guestConfigSha256,
			helperSha256: this.#options.guest.gitHelperSha256,
			client: this.#options.client,
			authorize: async (_action, scope, _transfer, _digest, signal) => {
				if (!isDeepStrictEqual(scope, ready.scope)) throw new Error("CODING_HOST_TRANSFER_SCOPE_CHANGED");
				await this.#authorize(ready.claim, ready.vm, "run", signal);
			},
		});
	}
	async prepareWorkspace(
		claim: CodingSessionClaim,
		turn: CodingTurnState,
		signal: AbortSignal,
	): Promise<CodingWorkspace> {
		if (turn.workerId !== claim.workerId || turn.sequence !== claim.sequence)
			throw new Error("CODING_HOST_TURN_CHANGED");
		const vm = this.#vm(claim, turn.vmAllocationId);
		await this.#authorize(claim, vm, "run", signal, true);
		await this.#reconcile(claim, vm, "running", signal);
		const guest = await this.#guest(claim, vm, signal),
			root = await this.#directory("git");
		const baseName = `${claim.workerId}.base.json`;
		let baseSha: string;
		try {
			baseSha = String(record((await readRecord(join(root, baseName))).value).baseSha);
		} catch (error) {
			if (!code(error, "ENOENT")) throw error;
			const sha = await resolveCloudCodingBase(claim.repository, {
				journalRoot: root,
				signal,
				assertAuthorized: async () => {
					await this.#authorize(claim, vm, "run", signal);
				},
				withRepositoryToken: this.#repositoryToken(claim),
				runGit: this.#options.runGit,
			});
			await publish(
				root,
				baseName,
				Buffer.from(JSON.stringify({ workerId: claim.workerId, repository: claim.repository, baseSha: sha })),
			);
			baseSha = String(record((await readRecord(join(root, baseName))).value).baseSha);
		}
		const pinned = record((await readRecord(join(root, baseName))).value);
		if (
			pinned.workerId !== claim.workerId ||
			!isDeepStrictEqual(pinned.repository, claim.repository) ||
			!/^[0-9a-f]{40}$/.test(baseSha) ||
			(turn.baseSha !== null && turn.baseSha !== baseSha) ||
			(claim.baseSha !== null && claim.baseSha !== baseSha)
		)
			throw new Error("CODING_HOST_BASE_CHANGED");
		const ready: Prepared = {
			claim,
			vm,
			scope: codingTurnScope(claim.workerId, vm.allocationId, claim.sequence),
			...guest,
			baseSha,
		};
		if (ready.scope.requestId !== turn.turnId) throw new Error("CODING_HOST_TURN_ID_DIFFERS");
		const seededName = `${claim.workerId}.seeded.json`;
		try {
			const seeded = record((await readRecord(join(root, seededName))).value);
			if (seeded.workerId !== claim.workerId || seeded.vmId !== vm.allocationId || seeded.headSha !== baseSha)
				throw new Error("CODING_HOST_SEED_CHANGED");
		} catch (error) {
			if (!code(error, "ENOENT")) throw error;
			const seed = await fetchCloudCodingSeed(
				{ repository: claim.repository, workerId: claim.workerId, baseSha },
				{
					journalRoot: root,
					signal,
					assertAuthorized: async () => {
						await this.#authorize(claim, vm, "run", signal);
					},
					withRepositoryToken: this.#repositoryToken(claim),
					runGit: this.#options.runGit,
				},
			);
			await this.#transfer(ready).seed(codingHostId("seed", claim.workerId), baseSha, seed.bundle, signal);
			await publish(
				root,
				seededName,
				Buffer.from(JSON.stringify({ workerId: claim.workerId, vmId: vm.allocationId, headSha: baseSha })),
			);
		}
		this.#prepared.set(claim.workerId, ready);
		return { vmId: vm.allocationId, baseSha };
	}
	async refreshLease(claim: CodingSessionClaim, signal: AbortSignal): Promise<void> {
		const ready = this.#active(claim),
			leaseHash = digest(claim.leaseToken);
		const watchdog = await this.#options.client.readInstanceFile(
			ready.vm.project,
			lxdCodingVmPlan(ready.vm).request.name,
			"/opt/qorpera-coding/cloud-coding-watchdog.mjs",
			65536,
			signal,
		);
		if (
			watchdog.uid !== 0 ||
			watchdog.gid !== 0 ||
			watchdog.mode !== 0o444 ||
			digest(watchdog.content) !== this.#options.guest.watchdogHelperSha256
		)
			throw new Error("CODING_HOST_WATCHDOG_CHANGED");
		const transport = new LxdCodingLeaseTransport({
			vm: ready.vm,
			scope: ready.scope,
			bootId: ready.bootId,
			guestConfigSha256: ready.guestConfigSha256,
			helperSha256: this.#options.guest.commandHelperSha256,
			client: this.#options.client,
			authorize: async (scope, hash, ttl, checked) => {
				if (
					!isDeepStrictEqual(scope, ready.scope) ||
					hash !== leaseHash ||
					ttl > Date.parse(claim.leaseUntil) - Date.now()
				)
					throw new Error("CODING_HOST_LEASE_REFRESH_EXPIRED");
				await this.#authorize(claim, ready.vm, "run", checked);
			},
		});
		const ttl = Math.min(45000, Date.parse(claim.leaseUntil) - Date.now() - 5000);
		if (ttl < 1000) throw new Error("CODING_HOST_LEASE_REFRESH_EXPIRED");
		await transport.refresh(ready.scope, leaseHash, ttl, signal);
	}
	async publish(
		claim: CodingSessionClaim,
		submission: Extract<CodingSubmission, { kind: "finish" }>,
		signal: AbortSignal,
	): Promise<CodingExecutorPublication> {
		const ready = this.#active(claim);
		const exported = await this.#transfer(ready).export(
			codingHostId("export", `${claim.workerId}:${claim.sequence}`),
			submission.headSha,
			signal,
		);
		if (submission.headSha === ready.baseSha && !claim.pullRequest) return { pullRequest: null, noChange: true };
		const root = await this.#directory("git"),
			token = this.#repositoryToken(claim);
		const authorize = async (): Promise<void> => {
			await this.#authorize(claim, ready.vm, "run", signal);
		};
		await pushCloudCodingBundle(
			{
				repository: claim.repository,
				workerId: claim.workerId,
				headSha: submission.headSha,
				baseSha: ready.baseSha,
				expectedRemoteHeadSha: claim.pullRequest?.headSha ?? null,
			},
			exported.bundle,
			{
				journalRoot: root,
				signal,
				assertAuthorized: authorize,
				withRepositoryToken: token,
				runGit: this.#options.runGit,
			},
		);
		const pullRequest = await publishCloudCodingDraftPullRequest(
			{
				repository: claim.repository,
				workerId: claim.workerId,
				headSha: submission.headSha,
				title: claim.title.slice(0, 200),
				body: submission.summary,
			},
			{
				journalRoot: root,
				signal,
				assertAuthorized: authorize,
				withRepositoryToken: token,
				fetch: this.#options.fetch,
			},
		);
		return { pullRequest, noChange: false };
	}
	async stopWorkspace(claim: CodingSessionClaim, signal: AbortSignal): Promise<void> {
		const retained = record(
			await this.#call(
				"qorpera_describe_coding_cleanup",
				{
					p_worker_id: claim.workerId,
					p_owner: this.#options.owner,
					p_machine_id_sha256: this.#options.machineIdSha256,
				},
				signal,
			),
		);
		if (retained.schema === "qorpera.coding-cleanup-absent/v1") {
			// Only SQL's proof that no plan was ever pinned lets a stop end here.
			// Missing retained data alone is never evidence of absence.
			if (
				this.#vmWork.has(claim.workerId) ||
				this.#prepared.has(claim.workerId) ||
				!isDeepStrictEqual(retained, {
					schema: "qorpera.coding-cleanup-absent/v1",
					workerId: claim.workerId,
					allocationId: null,
				})
			)
				throw new Error("CODING_HOST_CLEANUP_ABSENCE_UNCONFIRMED");
			return;
		}
		if (retained.schema !== "qorpera.coding-cleanup/v1") throw new Error("CODING_HOST_CLEANUP_DESCRIPTOR_INVALID");
		const vm = lxdCodingVmPlan(retained.binding as LxdCodingVmBinding).binding;
		if (
			vm.workerId !== claim.workerId ||
			vm.companyId !== claim.profileId ||
			vm.environmentId !== claim.environmentId
		)
			throw new Error("CODING_HOST_CLEANUP_SCOPE_CHANGED");
		const budget = AbortSignal.any([signal, AbortSignal.timeout(CODING_VM_STOP_BUDGET_MS)]);
		await this.#quiesce(claim, vm, AbortSignal.any([budget, AbortSignal.timeout(CODING_VM_QUIESCE_MS)]));
		await this.#reconcile(claim, vm, "stopped", budget);
		this.#prepared.delete(claim.workerId);
	}
	/** Best effort before the forced power-off: stop the command slice (its
	 * units get SIGTERM, then SIGKILL after their own 5 s), so Git can drop its
	 * lock files, then flush the guest's writes to the NAS workspace. Only for a
	 * running VM with no lifecycle work in flight, under the same stop-only
	 * authority as the power-off. A failure here never blocks the stop. */
	/** Throws CODING_HOST_GUEST_WATCHDOG_FAILED or _DISABLED for a timer that
	 * cannot become active; returns while it may still be starting. */
	async #watchdogStarting(vm: LxdCodingVmBinding, name: string, signal: AbortSignal): Promise<void> {
		// Only asked once systemd has answered; a probe that finds the agent
		// gone again returns to waiting instead of judging the timer.
		const holds = async (verb: "is-failed" | "is-enabled") => {
			try {
				await this.#options.client.execInstance(
					vm.project,
					name,
					["/usr/bin/systemctl", verb, "--quiet", "qorpera-coding-watchdog.timer"],
					signal,
				);
				return true;
			} catch (error) {
				if (error instanceof Error && error.message === "LXD instance command failed") return false;
				throw error;
			}
		};
		try {
			if (await holds("is-failed")) throw new Error("CODING_HOST_GUEST_WATCHDOG_FAILED");
			if (!(await holds("is-enabled"))) throw new Error("CODING_HOST_GUEST_WATCHDOG_DISABLED");
		} catch (error) {
			if (error instanceof Error && error.message === "LXD instance agent not running") return;
			throw error;
		}
	}
	async #quiesce(claim: CodingSessionClaim, vm: LxdCodingVmBinding, signal: AbortSignal): Promise<void> {
		if (this.#vmWork.has(vm.workerId)) return;
		const { request } = lxdCodingVmPlan(vm),
			client = this.#options.client;
		try {
			const instance = await client.getInstance(vm.project, request.name, signal);
			if (!instance || instance.status !== "Running" || instance.statusCode !== 103) return;
			assertLxdCodingVmInstance(vm, instance);
			await this.#authorize(claim, vm, "stop", signal);
		} catch {
			return; /* The forced stop follows regardless. */
		}
		for (const command of [["/usr/bin/systemctl", "stop", "qorpera-coding.slice"], ["/usr/bin/sync"]]) {
			try {
				await client.execInstance(vm.project, request.name, command, signal);
			} catch (error) {
				// No agent: nothing inside the guest can be reached; power off.
				if (signal.aborted || (error instanceof Error && error.message === "LXD instance agent not running"))
					return;
			}
		}
	}
	async commandTransport(
		scope: CloudCodingCommandScope,
		authorize: ConstructorParameters<typeof LxdCodingCommandTransport>[0]["authorize"],
		signal: AbortSignal,
	): Promise<LxdCodingCommandTransport> {
		const ready = this.#prepared.get(scope.workerId);
		if (!ready || !isDeepStrictEqual(scope, ready.scope)) throw new Error("CODING_HOST_TURN_NOT_PREPARED");
		await this.#authorize(ready.claim, ready.vm, "run", signal);
		return new LxdCodingCommandTransport({
			vm: ready.vm,
			scope: ready.scope,
			bootId: ready.bootId,
			guestConfigSha256: ready.guestConfigSha256,
			helperSha256: this.#options.guest.commandHelperSha256,
			client: this.#options.client,
			authorize: async (action, checkedScope, commandId, inputSha256, checked) => {
				await this.#authorize(ready.claim, ready.vm, "run", checked);
				await authorize(action, checkedScope, commandId, inputSha256, checked);
			},
		});
	}
}
