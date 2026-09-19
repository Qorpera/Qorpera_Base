import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
	type CloudCodingCommandScope,
	type CloudCodingNasPolicy,
	type CloudCodingRepository,
	type CloudCodingWorker,
	createCloudCodingStorageBinding,
	parseCloudCodingNasPolicy,
	parseCloudCodingWorker,
} from "@qorpera/contracts";
import { LxdCodingCommandTransport } from "./coding-command-transport.ts";
import { reconcileCodingEmergencyStop } from "./coding-emergency-stop.ts";
import type { CodingExecutorClaim, CodingExecutorHost, CodingExecutorPublication } from "./coding-executor.ts";
import { type CodingBrokerGitRunner, pushCloudCodingBundle } from "./coding-git.ts";
import { fetchCloudCodingSeed, resolveCloudCodingBase } from "./coding-git-seed.ts";
import { LxdCodingGitTransfer } from "./coding-git-transfer.ts";
import { LxdCodingLeaseTransport } from "./coding-lease-transport.ts";
import {
	type CodingNativeDispatchOptions,
	type CodingNativeTurnResult,
	runCodingNativeTurn,
} from "./coding-native-dispatch.ts";
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
import type { CloudRunnerProviderAdapter } from "./orchestrator.ts";

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
	providerAdapter: CloudRunnerProviderAdapter;
	orchestratorId: string;
	controlPlaneConfig: CodingNativeDispatchOptions["controlPlaneConfig"];
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
	repositoryCredentials: {
		withRepositoryToken<T>(
			repository: CloudCodingRepository,
			use: (token: string) => Promise<T>,
			signal: AbortSignal,
		): Promise<T>;
	};
	fetch?: typeof fetch;
	runGit?: CodingBrokerGitRunner;
}
interface Prepared {
	claim: CodingExecutorClaim;
	vm: LxdCodingVmBinding;
	scope: CloudCodingCommandScope;
	bootId: string;
	guestConfigSha256: string;
	baseSha: string;
	finish?: CodingNativeTurnResult["finish"];
}
const SHA = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function digest(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}
function id(label: string, source: string): string {
	const hash = digest(`qorpera.coding-host/${label}/${source}`);
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
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
			options.controlPlaneConfig.controlStatePath !== join(options.journalRoot, "control.json") ||
			options.guest.uid === process.geteuid?.() ||
			!UUID.test(options.orchestratorId) ||
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
	#call(
		method: string,
		claim: CodingExecutorClaim,
		extra: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		signal.throwIfAborted();
		return this.#options.control.call(
			method,
			{ p_request_id: claim.requestId, p_lease_token: claim.leaseToken, ...extra },
			AbortSignal.any([signal, AbortSignal.timeout(30000)]),
		);
	}
	#vm(claim: CodingExecutorClaim): LxdCodingVmBinding {
		return lxdCodingVmPlan({
			...this.#options.vmPolicy,
			schema: "qorpera.lxd-coding-vm/v2",
			storage: createCloudCodingStorageBinding(this.#options.storagePolicy, {
				workerId: claim.worker.id,
				companyId: claim.worker.companyId,
				environmentId: claim.environmentId,
				machineIdSha256: this.#options.machineIdSha256,
				writerGeneration: 1,
			}),
			workerId: claim.worker.id,
			allocationId: claim.worker.vmId ?? id("allocation", claim.worker.id),
			companyId: claim.worker.companyId,
			environmentId: claim.environmentId,
			repository: claim.worker.repository,
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
	async #authorize(
		claim: CodingExecutorClaim,
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
				claim,
				{
					p_binding_text: JSON.stringify(plan.binding),
					p_machine_id_sha256: this.#options.machineIdSha256,
					...(intent === "run" ? { p_intent: "run" } : { p_owner: this.#options.owner }),
				},
				signal,
			),
		);
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
		claim: CodingExecutorClaim,
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
		const checked = AbortSignal.any([
			signal,
			cancel.signal,
			AbortSignal.timeout(desiredState === "stopped" ? 5000 : 300000),
		]);
		// The caller deadline includes journal reads and writes. Keep custody of
		// the actual promise after timeout so a hard-NFS syscall cannot overlap a
		// retry. SQL emergency stop remains independent of this filesystem work.
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
		claim: CodingExecutorClaim,
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
	#active(claim: CodingExecutorClaim): Prepared {
		const ready = this.#prepared.get(claim.requestId);
		if (
			!ready ||
			ready.claim.leaseToken !== claim.leaseToken ||
			ready.scope.workerId !== claim.worker.id ||
			ready.scope.turn !== claim.worker.turn ||
			ready.scope.vmId !== claim.worker.vmId
		)
			throw new Error("CODING_HOST_REQUEST_NOT_PREPARED");
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
	async prepareWorkspace(claim: CodingExecutorClaim, signal: AbortSignal): Promise<CloudCodingWorker> {
		await this.#call("qorpera_prepare_coding_execution", claim, {}, signal);
		for (;;) {
			const descriptor = record(await this.#call("qorpera_describe_coding_execution", claim, {}, signal));
			if (descriptor.requestId !== claim.requestId || descriptor.workerId !== claim.worker.id)
				throw new Error("CODING_HOST_ADMISSION_CHANGED");
			if (
				["materialized", "completed"].includes(String(descriptor.admissionState)) &&
				typeof descriptor.runId === "string" &&
				UUID.test(descriptor.runId)
			)
				break;
			if (descriptor.admissionState !== "queued") throw new Error("CODING_HOST_ADMISSION_NOT_RUNNABLE");
			await this.#options.control.call("qorpera_materialize_wake_execution_runs", { p_limit: 32 }, signal);
			await setTimeout(500, undefined, { signal });
		}
		const vm = this.#vm(claim);
		await this.#authorize(claim, vm, "run", signal, true);
		await this.#reconcile(claim, vm, "running", signal);
		const descriptor = record(await this.#call("qorpera_describe_coding_execution", claim, {}, signal));
		const worker = parseCloudCodingWorker(descriptor.worker);
		if (
			worker.id !== vm.workerId ||
			worker.vmId !== vm.allocationId ||
			worker.turn !== claim.worker.turn ||
			worker.companyId !== claim.worker.companyId ||
			worker.parentAgentId !== claim.worker.parentAgentId ||
			worker.parentRunId !== claim.worker.parentRunId ||
			worker.branch !== claim.worker.branch ||
			!isDeepStrictEqual(worker.repository, vm.repository)
		)
			throw new Error("CODING_HOST_WORKER_CHANGED");
		claim.worker = worker;
		const guest = await this.#guest(claim, vm, signal),
			root = await this.#directory("git");
		const baseName = `${worker.id}.base.json`;
		let baseSha: string;
		try {
			baseSha = String(record((await readRecord(join(root, baseName))).value).baseSha);
		} catch (error) {
			if (!code(error, "ENOENT")) throw error;
			const sha = await resolveCloudCodingBase(worker.repository, {
				journalRoot: root,
				signal,
				assertAuthorized: async () => {
					await this.#authorize(claim, vm, "run", signal);
				},
				withRepositoryToken: this.#options.repositoryCredentials.withRepositoryToken.bind(
					this.#options.repositoryCredentials,
				),
				runGit: this.#options.runGit,
			});
			await publish(
				root,
				baseName,
				Buffer.from(JSON.stringify({ workerId: worker.id, repository: worker.repository, baseSha: sha })),
			);
			baseSha = String(record((await readRecord(join(root, baseName))).value).baseSha);
		}
		const pinned = record((await readRecord(join(root, baseName))).value);
		if (
			pinned.workerId !== worker.id ||
			!isDeepStrictEqual(pinned.repository, worker.repository) ||
			!/^[0-9a-f]{40}$/.test(baseSha)
		)
			throw new Error("CODING_HOST_BASE_CHANGED");
		const ready: Prepared = {
			claim,
			vm,
			scope: { workerId: worker.id, vmId: vm.allocationId, requestId: claim.requestId, turn: worker.turn },
			...guest,
			baseSha,
		};
		const seededName = `${worker.id}.seeded.json`;
		try {
			const seeded = record((await readRecord(join(root, seededName))).value);
			if (seeded.workerId !== worker.id || seeded.vmId !== vm.allocationId || seeded.headSha !== baseSha)
				throw new Error("CODING_HOST_SEED_CHANGED");
		} catch (error) {
			if (!code(error, "ENOENT")) throw error;
			const seed = await fetchCloudCodingSeed(
				{ repository: worker.repository, workerId: worker.id, baseSha },
				{
					journalRoot: root,
					signal,
					assertAuthorized: async () => {
						await this.#authorize(claim, vm, "run", signal);
					},
					withRepositoryToken: this.#options.repositoryCredentials.withRepositoryToken.bind(
						this.#options.repositoryCredentials,
					),
					runGit: this.#options.runGit,
				},
			);
			await this.#transfer(ready).seed(id("seed", worker.id), baseSha, seed.bundle, signal);
			await publish(
				root,
				seededName,
				Buffer.from(JSON.stringify({ workerId: worker.id, vmId: vm.allocationId, headSha: baseSha })),
			);
		}
		this.#prepared.set(claim.requestId, ready);
		return worker;
	}
	async refreshLease(claim: CodingExecutorClaim, signal: AbortSignal): Promise<void> {
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
	async runNative(claim: CodingExecutorClaim, signal: AbortSignal): Promise<void> {
		const ready = this.#active(claim);
		const result = await runCodingNativeTurn({
			requestId: claim.requestId,
			leaseToken: claim.leaseToken,
			orchestratorId: this.#options.orchestratorId,
			controlPlaneConfig: this.#options.controlPlaneConfig,
			providerAdapter: this.#options.providerAdapter,
			codingControl: this.#options.control,
			signal,
		});
		if (
			result.worker.id !== ready.vm.workerId ||
			result.worker.vmId !== ready.vm.allocationId ||
			result.worker.turn !== ready.scope.turn
		)
			throw new Error("CODING_HOST_NATIVE_RESULT_CHANGED");
		claim.worker = result.worker;
		ready.finish = result.finish;
	}
	async publish(claim: CodingExecutorClaim, signal: AbortSignal): Promise<CodingExecutorPublication> {
		const ready = this.#active(claim),
			finish = ready.finish;
		if (!finish) throw new Error("CODING_HOST_SUBMISSION_MISSING");
		const exported = await this.#transfer(ready).export(id("export", claim.requestId), finish.headSha, signal);
		if (finish.headSha === ready.baseSha && !claim.worker.pullRequest)
			return { summary: finish.summary, pullRequest: null, noChange: true };
		const root = await this.#directory("git"),
			token = this.#options.repositoryCredentials.withRepositoryToken.bind(this.#options.repositoryCredentials);
		const authorize = async (): Promise<void> => {
			await this.#authorize(claim, ready.vm, "run", signal);
		};
		await pushCloudCodingBundle(
			{
				repository: claim.worker.repository,
				workerId: claim.worker.id,
				headSha: finish.headSha,
				baseSha: ready.baseSha,
				expectedRemoteHeadSha: claim.worker.pullRequest?.headSha ?? null,
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
				repository: claim.worker.repository,
				workerId: claim.worker.id,
				headSha: finish.headSha,
				title: `Qorpera coding ${claim.worker.id}`,
				body: finish.summary,
			},
			{
				journalRoot: root,
				signal,
				assertAuthorized: authorize,
				withRepositoryToken: token,
				fetch: this.#options.fetch,
			},
		);
		return { summary: finish.summary, pullRequest, noChange: false };
	}
	async stopWorkspace(claim: CodingExecutorClaim, signal: AbortSignal): Promise<void> {
		const retained = record(
			await this.#call(
				"qorpera_describe_coding_cleanup",
				claim,
				{
					p_owner: this.#options.owner,
					p_machine_id_sha256: this.#options.machineIdSha256,
				},
				signal,
			),
		);
		if (retained.schema === "qorpera.coding-cleanup-absent/v1") {
			// Only the current cancellation may use SQL's proof that no physical
			// allocation or intent ever existed. Missing retained data alone is
			// never evidence of absence, and cannot authorize this fast path.
			if (
				claim.kind !== "cancel" ||
				claim.worker.vmId !== null ||
				this.#vmWork.has(claim.worker.id) ||
				[...this.#prepared.values()].some((ready) => ready.vm.workerId === claim.worker.id) ||
				!isDeepStrictEqual(retained, {
					schema: "qorpera.coding-cleanup-absent/v1",
					requestId: claim.requestId,
					workerId: claim.worker.id,
					allocationId: null,
				})
			)
				throw new Error("CODING_HOST_CLEANUP_ABSENCE_UNCONFIRMED");
			return;
		}
		if (retained.schema !== "qorpera.coding-cleanup/v1") throw new Error("CODING_HOST_CLEANUP_DESCRIPTOR_INVALID");
		const vm = lxdCodingVmPlan(retained.binding as LxdCodingVmBinding).binding;
		if (
			vm.workerId !== claim.worker.id ||
			vm.companyId !== claim.worker.companyId ||
			vm.environmentId !== claim.environmentId ||
			(claim.worker.vmId !== null && vm.allocationId !== claim.worker.vmId)
		)
			throw new Error("CODING_HOST_CLEANUP_SCOPE_CHANGED");
		try {
			await this.#reconcile(claim, vm, "stopped", signal);
		} catch {
			// Independent SQL custody is usable even while a hard-NFS operation is
			// still pending. Its permanent fence prevents ordinary resume afterward.
			const cleanup = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
			for (;;) {
				const result = await reconcileCodingEmergencyStop({
					requestId: claim.requestId,
					leaseToken: claim.leaseToken,
					owner: this.#options.owner,
					machineIdSha256: this.#options.machineIdSha256,
					control: this.#options.control,
					client: this.#options.client,
					signal: cleanup,
				});
				if (result.state === "stopped") break;
				if (result.state !== "pending") throw new Error("CODING_HOST_EMERGENCY_STOP_UNCONFIRMED");
				await setTimeout(500, undefined, { signal: cleanup });
			}
		}
		this.#prepared.delete(claim.requestId);
	}
	async commandTransport(
		scope: CloudCodingCommandScope,
		authorize: ConstructorParameters<typeof LxdCodingCommandTransport>[0]["authorize"],
		signal: AbortSignal,
	): Promise<LxdCodingCommandTransport> {
		const ready = this.#prepared.get(scope.requestId);
		if (!ready || !isDeepStrictEqual(scope, ready.scope)) throw new Error("CODING_HOST_REQUEST_NOT_PREPARED");
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
