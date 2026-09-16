import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
	type CompanyComputerLifecycleRequest,
	parseCompanyComputerBootIntentRequest,
	parseCompanyComputerLifecycleRequest,
} from "@qorpera/contracts";
import type { LxdInstanceRecord, LxdUnixClient } from "./lxd-client.ts";
import { assertLxdOfficeGuestInstance, type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeCanonical, officeRecord } from "./lxd-office-image-provenance.ts";
import { code, publish, readRecord, syncDirectory } from "./lxd-office-journal-files.ts";
import { parseLxdOfficeLifecycleServiceConfig } from "./lxd-office-lifecycle-service.ts";
import type { LxdOfficePhysicalGate } from "./lxd-office-physical-gate.ts";
import { LxdOfficePhysicalGate as PhysicalGate } from "./lxd-office-physical-gate.ts";
import { readLxdOfficeCredentialFile, readLxdOfficeProtectedFile } from "./lxd-office-physical-host.ts";
import { lxdOfficePhysicalPolicySha256, officePhysicalPath } from "./lxd-office-physical-policy.ts";
import { LxdOfficeProviderHttpRegistry } from "./lxd-office-provider-registry.ts";

/** 2026-09-17 amendment: a host reboot is an orderly `reboot` transition whose
 * resume happens in a different host boot. The lineage stays anchored to the
 * host boot in which the VM chain was last observed; a receipt maps the
 * resumed host boot back to that anchor for every later physical check. The
 * guest-facing boot adoption chain keeps the anchor (a guest cannot observe a
 * host boot); the receipt and the backend row carry the resumed host boot. */
export interface LxdOfficeHostRebootReceipt {
	readonly schema: "qorpera.lxd-office-host-reboot/v1";
	readonly intentId: string;
	readonly allocationId: string;
	readonly transitionId: string;
	readonly shutdownHostBootId: string;
	readonly resumedHostBootId: string;
	readonly recordedAtMs: number;
}
/** Guard-authored marker inside the protected recovery plan envelope. */
export interface LxdOfficeHostRebootPlan {
	readonly shutdownHostBootId: string;
	readonly requestedAtMs: number;
}
export interface LxdOfficeHostRebootRegistry {
	call(
		method:
			| "qorpera_runtime_office_provider_activation"
			| "qorpera_begin_runtime_office_host_reboot"
			| "qorpera_record_runtime_office_host_reboot_resume"
			| "qorpera_runtime_office_provider_status",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECEIPT = /^host-reboot-([0-9a-f-]{36})-([0-9a-f-]{36})\.json$/;
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const decode = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
function uuid(value: unknown, error: string): string {
	if (typeof value !== "string" || !UUID.test(value)) throw new Error(error);
	return value;
}
function ms(value: unknown, error: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(error);
	return value as number;
}

export function parseLxdOfficeHostRebootPlan(value: unknown): LxdOfficeHostRebootPlan {
	const r = officeRecord(value, ["shutdownHostBootId", "requestedAtMs"]);
	return Object.freeze({
		shutdownHostBootId: uuid(r.shutdownHostBootId, "INVALID_OFFICE_HOST_REBOOT_PLAN"),
		requestedAtMs: ms(r.requestedAtMs, "INVALID_OFFICE_HOST_REBOOT_PLAN"),
	});
}

/** The protected recovery plan: the lifecycle request, optionally marked as a
 * host reboot by the node guard. Any other envelope key is refused. */
export function parseLxdOfficeRecoveryPlan(value: unknown): {
	request: CompanyComputerLifecycleRequest;
	hostReboot?: LxdOfficeHostRebootPlan;
} {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("recovery plan");
	const keys = Object.keys(value).sort().join();
	if (keys !== "request,schema" && keys !== "hostReboot,request,schema") throw new Error("recovery plan");
	const envelope = value as Record<string, unknown>;
	if (envelope.schema !== "qorpera.lxd-office-recovery-plan/v1") throw new Error("recovery plan");
	const request = parseCompanyComputerLifecycleRequest(envelope.request);
	if (!("hostReboot" in envelope)) return { request };
	const hostReboot = parseLxdOfficeHostRebootPlan(envelope.hostReboot);
	if (request.action !== "reboot") throw new Error("host reboot plan action");
	return { request, hostReboot };
}

export function parseLxdOfficeHostRebootReceipt(value: unknown): LxdOfficeHostRebootReceipt {
	let r: Record<string, unknown>;
	try {
		r = officeRecord(value, [
			"schema",
			"intentId",
			"allocationId",
			"transitionId",
			"shutdownHostBootId",
			"resumedHostBootId",
			"recordedAtMs",
		]);
	} catch {
		throw new Error("INVALID_OFFICE_HOST_REBOOT_RECEIPT");
	}
	if (r.schema !== "qorpera.lxd-office-host-reboot/v1") throw new Error("INVALID_OFFICE_HOST_REBOOT_RECEIPT");
	const receipt = Object.freeze({
		schema: r.schema,
		intentId: uuid(r.intentId, "INVALID_OFFICE_HOST_REBOOT_RECEIPT"),
		allocationId: uuid(r.allocationId, "INVALID_OFFICE_HOST_REBOOT_RECEIPT"),
		transitionId: uuid(r.transitionId, "INVALID_OFFICE_HOST_REBOOT_RECEIPT"),
		shutdownHostBootId: uuid(r.shutdownHostBootId, "INVALID_OFFICE_HOST_REBOOT_RECEIPT"),
		resumedHostBootId: uuid(r.resumedHostBootId, "INVALID_OFFICE_HOST_REBOOT_RECEIPT"),
		recordedAtMs: ms(r.recordedAtMs, "INVALID_OFFICE_HOST_REBOOT_RECEIPT"),
	});
	if (receipt.shutdownHostBootId === receipt.resumedHostBootId) throw new Error("INVALID_OFFICE_HOST_REBOOT_RECEIPT");
	return receipt;
}

export function lxdOfficeHostRebootReceiptName(allocationId: string, transitionId: string): string {
	return `host-reboot-${allocationId}-${transitionId}.json`;
}

/** Every retained receipt in the journal root, keyed by the resumed host boot. */
export type LxdOfficeJournalReader = (path: string, limit?: number) => Promise<{ value: unknown; bytes: Buffer }>;
export async function readLxdOfficeHostRebootReceipts(
	root: string,
	read: LxdOfficeJournalReader = readRecord,
): Promise<Map<string, LxdOfficeHostRebootReceipt>> {
	const receipts = new Map<string, LxdOfficeHostRebootReceipt>();
	let names: string[];
	try {
		names = await readdir(root);
	} catch (error) {
		if (code(error, "ENOENT")) return receipts;
		throw error;
	}
	for (const name of names.sort()) {
		const match = RECEIPT.exec(name);
		if (!match) continue;
		const receipt = parseLxdOfficeHostRebootReceipt((await read(join(root, name), 4096)).value);
		if (
			receipt.allocationId !== match[1] ||
			receipt.transitionId !== match[2] ||
			receipts.has(receipt.resumedHostBootId)
		)
			throw new Error("INVALID_OFFICE_HOST_REBOOT_RECEIPT");
		receipts.set(receipt.resumedHostBootId, receipt);
	}
	return receipts;
}

/** The lineage anchor for a physical host boot: follow receipts back until a
 * host boot no receipt resumed. Bounded; a cycle is a corrupt journal. */
export function lxdOfficeHostRebootAnchor(
	receipts: ReadonlyMap<string, LxdOfficeHostRebootReceipt>,
	hostBootId: string,
): string {
	let anchor = hostBootId;
	for (let hop = 0; hop < 256; hop++) {
		const receipt = receipts.get(anchor);
		if (!receipt) return anchor;
		anchor = receipt.shutdownHostBootId;
	}
	throw new Error("INVALID_OFFICE_HOST_REBOOT_RECEIPT");
}

/** The physical gate every worker sees: identical to the plain gate except
 * that a resumed host boot answers as its lineage anchor. */
export class LxdOfficeHostRebootGate {
	readonly #inner: Pick<LxdOfficePhysicalGate, "policy" | "check" | "inspect">;
	readonly #root: string;
	constructor(inner: Pick<LxdOfficePhysicalGate, "policy" | "check" | "inspect">, root: string) {
		this.#inner = inner;
		this.#root = root;
	}
	get policy(): LxdOfficePhysicalGate["policy"] {
		return this.#inner.policy;
	}
	async #anchor<T extends { hostBootId: string }>(result: T): Promise<T> {
		const receipts = await readLxdOfficeHostRebootReceipts(this.#root);
		return { ...result, hostBootId: lxdOfficeHostRebootAnchor(receipts, result.hostBootId) };
	}
	async check(binding: LxdOfficeGuestBinding, signal: AbortSignal) {
		return this.#anchor(await this.#inner.check(binding, signal));
	}
	async inspect(signal: AbortSignal) {
		return this.#anchor(await this.#inner.inspect(signal));
	}
	/** The physical host boot, unmapped. */
	async physical(signal: AbortSignal): Promise<string> {
		return (await this.#inner.inspect(signal)).hostBootId;
	}
}

/** Before the resume of a guard-marked host reboot: verify the stopped guest
 * and the recorded power-off, publish the receipt once, and record the resumed
 * host boot in the backend. Returns the receipt, or undefined when the host
 * boot did not change (an ordinary reboot transition on the same host). */
export async function ensureLxdOfficeHostRebootReceipt(
	input: {
		root: string;
		intentId: string;
		binding: LxdOfficeGuestBinding;
		request: CompanyComputerLifecycleRequest;
		plan: LxdOfficeHostRebootPlan;
		physicalHostBootId: string;
		client: Pick<LxdUnixClient, "getInstance">;
		registry: LxdOfficeHostRebootRegistry;
	},
	signal: AbortSignal,
): Promise<LxdOfficeHostRebootReceipt | undefined> {
	const { root, binding, request, plan } = input,
		{ allocationId } = binding,
		{ transitionId } = request;
	if (request.action !== "reboot" || request.startup.allocationId !== allocationId)
		throw new Error("host reboot request");
	const receipts = await readLxdOfficeHostRebootReceipts(root);
	const anchor = plan.shutdownHostBootId,
		mapped = lxdOfficeHostRebootAnchor(receipts, input.physicalHostBootId);
	// Same host boot as the shutdown: an ordinary reboot transition, no receipt.
	if (input.physicalHostBootId === anchor) return undefined;
	// A host boot that already resumes another lineage anchor is not this one.
	if (mapped !== input.physicalHostBootId && mapped !== anchor) throw new Error("host reboot anchor differs");
	const name = lxdOfficeHostRebootReceiptName(allocationId, transitionId);
	const suffix = `${allocationId}-${transitionId}`;
	const completion = officeRecord((await readRecord(join(root, `power-off-completed-${suffix}.json`), 65536)).value, [
		"schema",
		"intentId",
		"allocationId",
		"transitionId",
		"commandId",
		"requestSha256",
		"operationId",
		"instanceSha256",
		"hostBootId",
	]);
	if (
		completion.schema !== "qorpera.lxd-office-power-off-completion/v1" ||
		completion.intentId !== input.intentId ||
		completion.allocationId !== allocationId ||
		completion.transitionId !== transitionId ||
		completion.hostBootId !== anchor
	)
		throw new Error("host reboot power-off differs");
	signal.throwIfAborted();
	const instance: LxdInstanceRecord | undefined = await input.client.getInstance(
		binding.project,
		lxdOfficeGuestPlan(binding).request.name,
		signal,
	);
	if (!instance) throw new Error("host reboot VM missing");
	assertLxdOfficeGuestInstance(binding, instance);
	if (instance.status !== "Stopped") throw new Error("host reboot VM not stopped");
	const expected: LxdOfficeHostRebootReceipt = {
		schema: "qorpera.lxd-office-host-reboot/v1",
		intentId: input.intentId,
		allocationId,
		transitionId,
		shutdownHostBootId: anchor,
		resumedHostBootId: input.physicalHostBootId,
		recordedAtMs: Date.now(),
	};
	let receipt: LxdOfficeHostRebootReceipt;
	try {
		receipt = parseLxdOfficeHostRebootReceipt((await readRecord(join(root, name), 4096)).value);
		if (!isDeepStrictEqual({ ...receipt, recordedAtMs: 0 }, { ...expected, recordedAtMs: 0 }))
			throw new Error("host reboot receipt differs");
	} catch (error) {
		if (!code(error, "ENOENT")) throw error;
		signal.throwIfAborted();
		await publish(root, name, Buffer.from(officeCanonical(expected)));
		receipt = parseLxdOfficeHostRebootReceipt((await readRecord(join(root, name), 4096)).value);
		if (!isDeepStrictEqual(receipt, expected)) throw new Error("host reboot receipt differs");
	}
	// Idempotent for the same resumed host boot; the backend refuses any other.
	const recorded = officeRecordLoose(
		await input.registry.call(
			"qorpera_record_runtime_office_host_reboot_resume",
			{ p_request: request, p_resumed_host_boot_id: receipt.resumedHostBootId },
			signal,
		),
	);
	if (
		recorded.schema !== "qorpera.office-host-reboot/v1" ||
		recorded.transitionId !== transitionId ||
		recorded.resumedHostBootId !== receipt.resumedHostBootId
	)
		throw new Error("host reboot record differs");
	return receipt;
}
function officeRecordLoose(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("host reboot record");
	return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Node guard: runs as root next to the provider service. `hostShutdown` opens
// the transition before the host goes down; `hostResume` authors the resume
// plan after the host is back. Neither holds the provider's adoption lock or
// dispatches any VM operation: the running provider does the work.

export type LxdOfficeHostGuardResult =
	| { state: "skipped"; reason: string }
	| { state: "refused"; reason: string }
	| { state: "opened"; transitionId: string; allocationId: string; stopped: boolean; waitedMs: number }
	| { state: "resumable"; transitionId: string; bootIntentId: string; activationId: string };

/** The guard runs as root next to the provider's journal (owned by the service
 * account): same bounded, immutable-record reading, without the owner pin. */
async function readJournalRecordAsRoot(path: string, limit = 16384): Promise<{ value: unknown; bytes: Buffer }> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await file.stat();
		if (
			!before.isFile() ||
			(before.mode & 0o7777) !== 0o600 ||
			before.nlink !== 1 ||
			before.size < 1 ||
			before.size > limit
		)
			throw new Error("invalid journal record");
		const buffer = Buffer.alloc(before.size + 1);
		let size = 0;
		while (size < buffer.length) {
			const result = await file.read(buffer, size, buffer.length - size, size);
			if (result.bytesRead === 0) break;
			size += result.bytesRead;
		}
		const after = await file.stat();
		if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
			throw new Error("journal record changed");
		const bytes = buffer.subarray(0, size);
		return { bytes, value: JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)) as unknown };
	} finally {
		await file.close();
	}
}

async function writeProtectedPlan(path: string, bytes: Buffer): Promise<void> {
	const temporary = `${path}.new`;
	const handle = await open(temporary, "wx", 0o444);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temporary, path);
	await syncDirectory(dirname(path));
	if (!(await readFile(path)).equals(bytes)) throw new Error("plan differs");
}
async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (code(error, "ENOENT")) return false;
		throw error;
	}
}

async function openGuard(configPath: string, signal: AbortSignal) {
	const config = parseLxdOfficeLifecycleServiceConfig(decode(await readLxdOfficeProtectedFile(configPath, 16384)));
	const credential = await readLxdOfficeCredentialFile(config.registryCredential.path, 4096);
	if (
		credential.byteLength !== config.registryCredential.bytes ||
		sha(credential) !== config.registryCredential.sha256
	)
		throw new Error("credential differs");
	const registry = new LxdOfficeProviderHttpRegistry(
		config.registryUrl,
		new TextDecoder("utf8", { fatal: true }).decode(credential),
	);
	credential.fill(0);
	const gate = await PhysicalGate.open(config.policyPath, config.provenancePath, signal);
	const policy = gate.policy,
		g = policy.guest;
	const identity = {
		p_scope: {
			companyId: g.companyId,
			environmentId: g.environmentId,
			companyComputerId: g.companyComputerId,
			logicalComputerId: g.logicalComputerId,
		},
		p_computer_generation: g.computerGeneration,
		p_provider_id: g.providerId,
		p_provider_policy_sha256: lxdOfficePhysicalPolicySha256(policy),
	};
	return {
		config,
		registry,
		gate,
		policy,
		identity,
		root: policy.journal.path,
		planPath: officePhysicalPath(config.planPath),
	};
}

/** Opens the host reboot transition for the active office and waits for the
 * provider's power-off record (bounded). Idle offices are skipped. */
export async function runLxdOfficeHostShutdown(
	configPath: string,
	signal: AbortSignal,
	options: { waitMs?: number; pollMs?: number; now?: () => number } = {},
): Promise<LxdOfficeHostGuardResult> {
	const waitMs = options.waitMs ?? 240000,
		pollMs = options.pollMs ?? 2000,
		now = options.now ?? Date.now;
	const guard = await openGuard(configPath, signal);
	const physical = (await guard.gate.inspect(signal)).hostBootId;
	const anchor = lxdOfficeHostRebootAnchor(
		await readLxdOfficeHostRebootReceipts(guard.root, readJournalRecordAsRoot),
		physical,
	);
	const status = officeRecordLoose(
		await guard.registry.call("qorpera_runtime_office_provider_status", guard.identity, signal),
	);
	if (status.officeState !== "active") return { state: "skipped", reason: `office ${String(status.officeState)}` };
	const recoveryPath = `${guard.planPath}.recovery`,
		resumePath = `${guard.planPath}.resume`;
	if (await exists(recoveryPath)) {
		// A completed earlier transition is archived like the operator does; a
		// pending one is left alone (the host must not open a second transition).
		const previous = parseLxdOfficeRecoveryPlan(decode(await readLxdOfficeProtectedFile(recoveryPath, 65536)));
		const suffix = `${previous.request.startup.allocationId}-${previous.request.transitionId}`;
		const completed = ["power_off", "reboot"].includes(previous.request.action)
			? await exists(join(guard.root, `resume-completed-${suffix}.json`))
			: (await exists(
					join(
						guard.root,
						`successor-completed-${previous.request.startup.allocationId}-${previous.request.activationId}.json`,
					),
				)) ||
				(await exists(
					join(
						guard.root,
						`service-restart-request-${previous.request.startup.allocationId}-${previous.request.activationId}.json`,
					),
				));
		const activation = officeRecordLoose(
			await guard.registry.call("qorpera_runtime_office_provider_activation", guard.identity, signal),
		);
		const current = activation.activation as Record<string, unknown> | null;
		if (!completed || !current || current.activationId === previous.request.activationId)
			return { state: "refused", reason: "previous transition pending" };
		const stamp = new Date(now())
			.toISOString()
			.replaceAll(/[-:]/g, "")
			.replace(/\.\d+Z$/, "Z");
		const archive = join(
			dirname(guard.planPath),
			`archive-lifecycle-${previous.request.transitionId.slice(0, 8)}-${stamp}`,
		);
		await mkdir(archive, { mode: 0o700 });
		for (const path of [recoveryPath, resumePath])
			if (await exists(path)) await rename(path, join(archive, path.slice(path.lastIndexOf("/") + 1)));
		await syncDirectory(dirname(guard.planPath));
	}
	if (await exists(resumePath)) return { state: "refused", reason: "stale resume plan" };
	const activation = officeRecordLoose(
		await guard.registry.call("qorpera_runtime_office_provider_activation", guard.identity, signal),
	);
	if (activation.schema !== "qorpera.office-provider-activation/v1" || !activation.activation)
		return { state: "skipped", reason: "no active activation" };
	const active = officeRecord(activation.activation, [
		"activationId",
		"providerId",
		"providerPolicySha256",
		"startup",
	]);
	const request = parseCompanyComputerLifecycleRequest({
		schema: "qorpera.office-lifecycle-request/v1",
		transitionId: randomUUID(),
		action: "reboot",
		activationId: active.activationId,
		providerId: active.providerId,
		providerPolicySha256: active.providerPolicySha256,
		startup: active.startup,
	});
	if (
		request.providerId !== guard.identity.p_provider_id ||
		request.providerPolicySha256 !== guard.identity.p_provider_policy_sha256
	)
		throw new Error("activation provider differs");
	const opened = officeRecordLoose(
		await guard.registry.call(
			"qorpera_begin_runtime_office_host_reboot",
			{ p_request: request, p_host_boot_id: anchor },
			signal,
		),
	);
	if (opened.schema !== "qorpera.office-host-reboot/v1" || opened.transitionId !== request.transitionId)
		throw new Error("host reboot begin differs");
	const plan = {
		schema: "qorpera.lxd-office-recovery-plan/v1",
		request,
		hostReboot: { shutdownHostBootId: anchor, requestedAtMs: now() },
	};
	parseLxdOfficeRecoveryPlan(plan);
	await writeProtectedPlan(recoveryPath, Buffer.from(officeCanonical(plan)));
	const started = now(),
		done = join(guard.root, `power-off-completed-${request.startup.allocationId}-${request.transitionId}.json`);
	let stopped = false;
	while (!signal.aborted) {
		if (await exists(done)) {
			stopped = true;
			break;
		}
		if (now() - started >= waitMs) break;
		await delay(pollMs, undefined, { signal });
	}
	return {
		state: "opened",
		transitionId: request.transitionId,
		allocationId: request.startup.allocationId,
		stopped,
		waitedMs: now() - started,
	};
}

/** After the host is back: author the resume plan for a guard-opened host
 * reboot from the provider's sealed stop history and power-off completion. */
export async function runLxdOfficeHostResume(
	configPath: string,
	signal: AbortSignal,
): Promise<LxdOfficeHostGuardResult> {
	const guard = await openGuard(configPath, signal);
	const recoveryPath = `${guard.planPath}.recovery`,
		resumePath = `${guard.planPath}.resume`;
	if (!(await exists(recoveryPath))) return { state: "skipped", reason: "no recovery plan" };
	const plan = parseLxdOfficeRecoveryPlan(decode(await readLxdOfficeProtectedFile(recoveryPath, 65536)));
	if (!plan.hostReboot) return { state: "skipped", reason: "not a host reboot" };
	if (await exists(resumePath)) return { state: "skipped", reason: "resume plan present" };
	const { request } = plan,
		suffix = `${request.startup.allocationId}-${request.transitionId}`;
	const read = async (name: string, limit: number) => {
		try {
			return (await readJournalRecordAsRoot(join(guard.root, name), limit)).bytes;
		} catch (error) {
			if (code(error, "ENOENT")) return undefined;
			throw error;
		}
	};
	const history = await read(`power-off-history-${suffix}.json`, 16 * 1024 ** 2),
		completion = await read(`power-off-completed-${suffix}.json`, 65536),
		seed = await read(`power-off-request-${suffix}.json`, 65536);
	if (!history || !completion || !seed) return { state: "refused", reason: "power-off incomplete" };
	const done = officeRecordLoose(decode(completion)),
		request0 = officeRecordLoose(decode(seed));
	if (
		done.schema !== "qorpera.lxd-office-power-off-completion/v1" ||
		done.transitionId !== request.transitionId ||
		done.hostBootId !== plan.hostReboot.shutdownHostBootId ||
		![
			"qorpera.lxd-office-power-off-request/v2",
			"qorpera.lxd-office-power-off-request/v3",
			"qorpera.lxd-office-power-off-request/v4",
		].includes(String(request0.schema)) ||
		request0.stopHistorySha256 !== sha(history)
	)
		return { state: "refused", reason: "power-off records differ" };
	const resume = parseCompanyComputerBootIntentRequest({
		schema: "qorpera.office-boot-intent-request/v1",
		bootIntentId: randomUUID(),
		activationId: randomUUID(),
		predecessor: request,
		stopHistorySha256: sha(history),
		powerOffCompletionSha256: sha(completion),
	});
	await writeProtectedPlan(
		resumePath,
		Buffer.from(officeCanonical({ schema: "qorpera.lxd-office-resume-plan/v1", request: resume })),
	);
	return {
		state: "resumable",
		transitionId: request.transitionId,
		bootIntentId: resume.bootIntentId,
		activationId: resume.activationId,
	};
}
