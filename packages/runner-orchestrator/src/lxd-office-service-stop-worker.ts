import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type CompanyComputerLifecycleRequest,
	type CompanyComputerServiceStopAcknowledgement,
	parseCompanyComputerLifecycleRequest,
	parseCompanyComputerLifecycleTransition,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerServiceStopCompletion,
	parseCompanyComputerServiceStopRequest,
} from "@qorpera/contracts";
import { type LxdOfficeServiceStopClient, LxdUnixClient } from "./lxd-client.ts";
import { assertOfficeAdoptionKernelLock } from "./lxd-office-adoption-files.ts";
import type { LxdOfficeBootActivationHistoryClient } from "./lxd-office-boot-activation-history.ts";
import { openLxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import { inspectLxdOfficeGuestBoot, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeCanonical, officeDigest, officeRecord } from "./lxd-office-image-provenance.ts";
import { code, publish, readRecord } from "./lxd-office-journal-files.ts";
import { LxdOfficeLifecycleControl, type LxdOfficeLifecycleControlRegistry } from "./lxd-office-lifecycle-control.ts";
import type { LxdOfficePhysicalGate } from "./lxd-office-physical-gate.ts";
import { parseLxdOfficePhysicalPolicy } from "./lxd-office-physical-policy.ts";
import { LxdOfficeServiceStopJournal } from "./lxd-office-service-stop-journal.ts";
import { LxdOfficeStopControl, type LxdOfficeStopRegistry } from "./lxd-office-stop-control.ts";
import { officeStopDecode, officeStopHash, readLxdOfficeStopEvidence } from "./lxd-office-stop-evidence.ts";
import { inspectAndAcknowledgeLxdOfficeStop } from "./lxd-office-stop-inspection.ts";

type Client = LxdOfficeBootActivationHistoryClient & LxdOfficeServiceStopClient;
export interface LxdOfficeServiceStopRegistry {
	call(
		method: Parameters<LxdOfficeLifecycleControlRegistry["call"]>[0] | Parameters<LxdOfficeStopRegistry["call"]>[0],
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}
type Registry = LxdOfficeServiceStopRegistry;
interface Ports {
	client?: Client;
	kernelLock?: typeof assertOfficeAdoptionKernelLock;
}
export interface LxdOfficeServiceStopResult {
	state: "stopped" | "pending" | "unknown" | "failed";
	intentId: string;
	allocationId: string;
	transitionId: string;
	commandId: string;
	acknowledgedAtMs?: number;
}
const pending = new Set<string>();

/** Explicit recovery only, under the lifecycle supervisor's kernel lock.
 * Retain intent before revocation, one command before dispatch, and a fresh
 * SQL challenge before root inspection. Unknown stop submission is observation
 * only. A stopped result is an immutable acknowledgement, not current runtime
 * admission, successor permission or machine-capacity release. */
export class LxdOfficeServiceStopWorker {
	readonly #gate: Pick<LxdOfficePhysicalGate, "policy" | "check">;
	readonly #policy;
	readonly #registry: Registry;
	readonly #client: Client;
	readonly #kernelLock;
	constructor(gate: Pick<LxdOfficePhysicalGate, "policy" | "check">, registry: Registry, ports: Ports = {}) {
		this.#gate = gate;
		this.#policy = parseLxdOfficePhysicalPolicy(gate.policy);
		this.#registry = registry;
		this.#client = ports.client ?? new LxdUnixClient(this.#policy.host.socketPath);
		this.#kernelLock = ports.kernelLock ?? assertOfficeAdoptionKernelLock;
	}
	reconcile(intentId: string, request: CompanyComputerLifecycleRequest, caller: AbortSignal) {
		return this.#reconcile(intentId, request, caller, false);
	}
	reconcileSettled(intentId: string, request: CompanyComputerLifecycleRequest, caller: AbortSignal) {
		return this.#reconcile(intentId, request, caller, true);
	}
	async #reconcile(intentId: string, value: CompanyComputerLifecycleRequest, caller: AbortSignal, settle: boolean) {
		caller.throwIfAborted();
		const request = parseCompanyComputerLifecycleRequest(value),
			root = this.#policy.journal.path;
		if (pending.has(root)) throw new Error("OFFICE_STOP_RECONCILIATION_PENDING");
		pending.add(root);
		const signal = AbortSignal.any([caller, AbortSignal.timeout(30000)]);
		let abort = () => {};
		const stopped = new Promise<never>((_, reject) => {
			abort = () => reject(new Error("OFFICE_STOP_RECONCILIATION_ABORTED"));
			signal.addEventListener("abort", abort, { once: true });
		});
		// Control adapters bound caller latency. Keep ownership until even a
		// non-cooperative registry's underlying request has actually settled.
		const io = new Set<Promise<unknown>>();
		const registry: Registry = {
			call: (method, args, checked) => {
				const operation = Promise.resolve().then(() => {
					checked.throwIfAborted();
					return this.#registry.call(method, args, checked);
				});
				io.add(operation);
				void operation.then(
					() => io.delete(operation),
					() => io.delete(operation),
				);
				return operation;
			},
		};
		const operation = this.#run(intentId, request, registry, signal)
			.catch(() => {
				throw new Error("OFFICE_STOP_UNCONFIRMED");
			})
			.finally(async () => {
				await Promise.allSettled([...io]);
				pending.delete(root);
			});
		try {
			return await Promise.race([operation, stopped]);
		} finally {
			signal.removeEventListener("abort", abort);
			if (settle) await operation.catch(() => {});
		}
	}
	async #run(
		intentId: string,
		recovery: CompanyComputerLifecycleRequest,
		registry: Registry,
		signal: AbortSignal,
	): Promise<LxdOfficeServiceStopResult> {
		const root = this.#policy.journal.path;
		await this.#kernelLock(root);
		const creation = await openLxdOfficeCreationIdentity(this.#policy, intentId, true, this.#client, signal);
		const { binding } = creation,
			{ allocationId } = binding,
			{ transitionId } = recovery;
		const evidence = await readLxdOfficeStopEvidence(root, intentId, binding, recovery, this.#client, signal);
		const physical = async (caller: AbortSignal) => {
			caller.throwIfAborted();
			await this.#kernelLock(root);
			if (
				!isDeepStrictEqual(
					await openLxdOfficeCreationIdentity(this.#policy, intentId, true, this.#client, caller),
					creation,
				) ||
				!isDeepStrictEqual(
					await readLxdOfficeStopEvidence(root, intentId, binding, recovery, this.#client, caller),
					evidence,
				)
			)
				throw new Error("stop evidence changed");
			const gate = await this.#gate.check(binding, caller);
			if (gate.hostBootId !== evidence.hostBootId) throw new Error("stop host changed");
			const checked = AbortSignal.any([caller, gate.signal]);
			const boot = await inspectLxdOfficeGuestBoot(this.#client, binding, checked);
			if (boot.bootId !== recovery.startup.bootId || boot.instanceSha256 !== recovery.startup.instanceSha256)
				throw new Error("stop guest changed");
			checked.throwIfAborted();
			return checked;
		};
		const optional = async (name: string) => {
			try {
				return (await readRecord(join(root, name), 65536)).value;
			} catch (error) {
				if (!code(error, "ENOENT")) throw error;
				return undefined;
			}
		};
		const absent = async (names: string[]) => {
			for (const name of names) {
				try {
					await lstat(join(root, name));
					throw new Error("lost recovery prefix");
				} catch (error) {
					if (!code(error, "ENOENT")) throw error;
				}
			}
		};
		const retain = async (name: string, value: unknown) => {
			signal.throwIfAborted();
			await publish(root, name, Buffer.from(officeCanonical(value)));
			if (!isDeepStrictEqual(await optional(name), value)) throw new Error("recovery record changed");
		};
		const recoverySuffix = evidence.initial ? allocationId : `${allocationId}-${recovery.activationId}`;
		const seedName = `recovery-request-${recoverySuffix}.json`,
			revocationName = `recovery-revocation-${recoverySuffix}.json`;
		const suffix = `${allocationId}-${transitionId}`,
			stopName = `service-stop-request-${suffix}.json`,
			indexName = `service-stop-intent-${suffix}.json`,
			journalName = `service-stop-${suffix}`,
			doneName = `service-stop-completed-${suffix}.json`;
		const seed = {
			schema: "qorpera.lxd-office-recovery-request/v1",
			intentId,
			binding,
			request: recovery,
			startObservationSha256: evidence.startObservationSha256,
			startCompletionSha256: evidence.startCompletionSha256,
		};
		if ((await optional(seedName)) === undefined) {
			await absent([revocationName, stopName, indexName, journalName, doneName]);
			await physical(signal);
			await retain(seedName, seed);
		}
		if (!isDeepStrictEqual(await optional(seedName), seed)) throw new Error("recovery identity changed");
		const control = new LxdOfficeLifecycleControl(recovery, registry);
		let revocationValue = await optional(revocationName);
		if (revocationValue === undefined) {
			await absent([stopName, indexName, journalName, doneName]);
			const checked = await physical(signal);
			// begin is an idempotent recovery of this retained identity. SQL keeps
			// the original revocation immutable after a lost committed reply.
			revocationValue = await control.begin(checked);
			await retain(revocationName, revocationValue);
		}
		const revocation = parseCompanyComputerLifecycleTransition(revocationValue, recovery);
		const request = parseCompanyComputerServiceStopRequest({
			schema: "qorpera.office-service-stop-request/v1",
			revocation,
			startCompletionSha256: evidence.startCompletionSha256,
		});
		const authorize = async (caller: AbortSignal) => {
			const checked = await physical(caller);
			if (
				!isDeepStrictEqual(await optional(seedName), seed) ||
				!isDeepStrictEqual(await optional(revocationName), revocation) ||
				!isDeepStrictEqual(await control.status(checked), revocation)
			)
				throw new Error("revocation changed");
			checked.throwIfAborted();
			return checked;
		};
		const bytes = Buffer.from(officeCanonical(request));
		let stopValue = await optional(stopName);
		if (stopValue === undefined) {
			await absent([indexName, journalName, doneName]);
			await authorize(signal);
			stopValue = {
				schema: "qorpera.lxd-office-stop-request/v1",
				request,
				command: parseCompanyComputerPreparationCommand({
					commandId: randomUUID(),
					bootId: recovery.startup.bootId,
					requestSha256: officeStopHash(bytes),
				}),
			};
			await retain(stopName, stopValue);
		}
		const stop = officeRecord(stopValue, ["schema", "request", "command"]),
			command = parseCompanyComputerPreparationCommand(stop.command);
		if (
			stop.schema !== "qorpera.lxd-office-stop-request/v1" ||
			!isDeepStrictEqual(stop.request, request) ||
			command.requestSha256 !== officeStopHash(bytes) ||
			command.bootId !== recovery.startup.bootId ||
			evidence.forbiddenCommandIds.includes(command.commandId)
		)
			throw new Error("stop request changed");
		const identity = {
			intentId,
			binding,
			bootObservationSha256: evidence.bootObservationSha256,
			command,
			transitionId,
			revocationSha256: officeDigest(revocation),
			startObservationSha256: evidence.startObservationSha256,
		};
		const index = { schema: "qorpera.lxd-office-stop-intent/v1", requestSha256: officeDigest(stop), identity };
		if ((await optional(indexName)) === undefined) {
			await absent([doneName]);
			let exists = true;
			try {
				await lstat(join(root, journalName));
			} catch (error) {
				if (!code(error, "ENOENT")) throw error;
				exists = false;
			}
			const initial = await LxdOfficeServiceStopJournal.open(root, identity, this.#client, exists);
			if ((await initial.observe(signal)).state !== "not_dispatched") throw new Error("stop index lost");
			await retain(indexName, index);
		}
		if (!isDeepStrictEqual(await optional(indexName), index)) throw new Error("stop index changed");
		const checkedStop = async (caller: AbortSignal) => {
			const checked = await authorize(caller);
			if (!isDeepStrictEqual(await optional(stopName), stop) || !isDeepStrictEqual(await optional(indexName), index))
				throw new Error("stop identity changed");
			checked.throwIfAborted();
			return checked;
		};
		const journal = await LxdOfficeServiceStopJournal.open(root, identity, this.#client);
		let operation = await journal.observe(await checkedStop(signal));
		const stopControl = new LxdOfficeStopControl(request, command, registry);
		const result = { intentId, allocationId, transitionId, commandId: command.commandId };
		const finish = async (
			receipt: CompanyComputerServiceStopAcknowledgement,
		): Promise<LxdOfficeServiceStopResult> => {
			if (operation.state === "not_dispatched") throw new Error("unclaimed stop acknowledgement");
			await retain(doneName, { schema: "qorpera.lxd-office-stop-completion/v1", ...result, receipt });
			return { ...result, state: "stopped", acknowledgedAtMs: receipt.acknowledgedAtMs };
		};
		const recovered = await stopControl.status(await checkedStop(signal));
		if (recovered) return finish(recovered);
		await absent([doneName]);
		const name = lxdOfficeGuestPlan(binding).request.name;
		if (operation.state === "not_dispatched") {
			await this.#client.pushOfficeServiceStopRequest(
				binding.project,
				name,
				command.requestSha256,
				bytes,
				await checkedStop(signal),
			);
			const staged = await this.#client.readOfficeServiceStopRequest(
				binding.project,
				name,
				command.requestSha256,
				bytes.length,
				await checkedStop(signal),
			);
			if (staged.uid !== 0 || staged.gid !== 0 || staged.mode !== 0o400 || !staged.content.equals(bytes))
				throw new Error("stop staging changed");
			operation = await journal.reconcile(await checkedStop(signal));
		}
		const checked = await checkedStop(signal);
		let file: Awaited<ReturnType<Client["readInstanceFile"]>>;
		try {
			file = await this.#client.readInstanceFile(
				binding.project,
				name,
				evidence.initial
					? "/run/qorpera-office-preparation/service-stop-completion.json"
					: `/run/qorpera-office-preparation/service-stop-completion-${recovery.activationId}.json`,
				65536,
				checked,
			);
		} catch {
			checked.throwIfAborted();
			return {
				...result,
				state:
					operation.state === "succeeded" || operation.state === "not_dispatched" ? "unknown" : operation.state,
			};
		}
		if (file.uid !== 0 || file.gid !== 0 || file.mode !== 0o600 || file.content.length > 65536)
			throw new Error("stop completion custody");
		const completion = parseCompanyComputerServiceStopCompletion(officeStopDecode(file.content), command, request);
		const receipt = await inspectAndAcknowledgeLxdOfficeStop(
			root,
			binding,
			command,
			request,
			completion,
			this.#client,
			stopControl,
			checkedStop,
			signal,
		);
		return finish(receipt);
	}
}
