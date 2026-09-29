import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type CompanyComputerLifecycleRequest, parseCompanyComputerLifecycleRequest } from "@qorpera/contracts";
import { type LxdTrackedClient, LxdUnixClient } from "./lxd-client.ts";
import { assertOfficeAdoptionKernelLock } from "./lxd-office-adoption-files.ts";
import { openLxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import { assertLxdOfficeGuestInstance, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeCanonical, officeDigest, officeRecord } from "./lxd-office-image-provenance.ts";
import { code, publish, readRecord } from "./lxd-office-journal-files.ts";
import { LxdOfficeOperationJournal } from "./lxd-office-operations.ts";
import type { LxdOfficePhysicalGate } from "./lxd-office-physical-gate.ts";
import { parseLxdOfficePhysicalPolicy } from "./lxd-office-physical-policy.ts";
import {
	type LxdOfficeRetirement,
	LxdOfficeRetirementControl,
	type LxdOfficeRetirementRegistry,
	OFFICE_RETIRED_MARKER,
	readLxdOfficeRetiredMarker,
} from "./lxd-office-retirement-control.ts";
import type { LxdOfficeVmLineageCommand } from "./lxd-office-vm-lineage.ts";

interface Ports {
	client?: LxdTrackedClient;
	kernelLock?: typeof assertOfficeAdoptionKernelLock;
}
export interface LxdOfficeRetirementResult {
	/** kept: the company lives, the powered-off computer stays. */
	state: "kept" | "retired" | "pending" | "unknown" | "failed";
	intentId: string;
	allocationId: string;
	transitionId: string;
	deleteCommandId?: string;
}
/** The delete SQL issued, pinned before it can be dispatched. One per provider. */
export const OFFICE_RETIREMENT_REQUEST = "office-retirement-request.json";
const pending = new Set<string>();

/** A deleted company's Company Computer, after its confirmed power_off
 * (RUNTIME-COMPANY-DELETE.md D3). SQL answers the delete command id once; it is
 * pinned here before a five-second SQL window admits the one journaled LXD delete
 * of the stopped VM. Only a settled delete and a confirmed absent VM release the
 * machine in SQL, and only SQL's receipt writes the local retired marker. An
 * unknown or failed delete holds the office for an operator. The workbench host
 * directory is not touched. */
export class LxdOfficeRetirementWorker {
	readonly #gate: Pick<LxdOfficePhysicalGate, "policy" | "check">;
	readonly #policy;
	readonly #registry: LxdOfficeRetirementRegistry;
	readonly #client: LxdTrackedClient;
	readonly #kernelLock;
	constructor(
		gate: Pick<LxdOfficePhysicalGate, "policy" | "check">,
		registry: LxdOfficeRetirementRegistry,
		ports: Ports = {},
	) {
		this.#gate = gate;
		this.#policy = parseLxdOfficePhysicalPolicy(gate.policy);
		this.#registry = registry;
		this.#client = ports.client ?? new LxdUnixClient(this.#policy.host.socketPath);
		this.#kernelLock = ports.kernelLock ?? assertOfficeAdoptionKernelLock;
	}
	async reconcileSettled(
		intentId: string,
		value: CompanyComputerLifecycleRequest,
		caller: AbortSignal,
	): Promise<LxdOfficeRetirementResult> {
		caller.throwIfAborted();
		const request = parseCompanyComputerLifecycleRequest(value),
			root = this.#policy.journal.path;
		if (request.action !== "power_off") throw new Error("OFFICE_RETIREMENT_ACTION_REQUIRED");
		if (pending.has(root)) throw new Error("OFFICE_RETIREMENT_PENDING");
		pending.add(root);
		try {
			return await this.#run(intentId, request, AbortSignal.any([caller, AbortSignal.timeout(60000)]));
		} catch (error) {
			throw new Error("OFFICE_RETIREMENT_UNCONFIRMED", { cause: error });
		} finally {
			pending.delete(root);
		}
	}
	async #run(
		intentId: string,
		recovery: CompanyComputerLifecycleRequest,
		signal: AbortSignal,
	): Promise<LxdOfficeRetirementResult> {
		const root = this.#policy.journal.path;
		await this.#kernelLock(root);
		const creation = await openLxdOfficeCreationIdentity(this.#policy, intentId, true, this.#client, signal);
		const { binding } = creation,
			{ allocationId } = binding,
			{ transitionId } = recovery;
		const { request: plan, instanceSha256 } = lxdOfficeGuestPlan(binding);
		if (
			recovery.providerId !== binding.providerId ||
			recovery.providerPolicySha256 !== binding.providerPolicySha256 ||
			recovery.startup.allocationId !== allocationId ||
			recovery.startup.instanceSha256 !== instanceSha256 ||
			recovery.startup.computerGeneration !== binding.computerGeneration ||
			!isDeepStrictEqual(recovery.startup.scope, {
				companyId: binding.companyId,
				environmentId: binding.environmentId,
				companyComputerId: binding.companyComputerId,
				logicalComputerId: binding.logicalComputerId,
			})
		)
			throw new Error("retirement binding differs");
		const identity = { scope: recovery.startup.scope, computerGeneration: binding.computerGeneration };
		if (await readLxdOfficeRetiredMarker(root, identity)) throw new Error("office already retired");
		const optional = async (name: string) => {
			try {
				return (await readRecord(join(root, name), 65536)).value;
			} catch (error) {
				if (!code(error, "ENOENT")) throw error;
				return undefined;
			}
		};
		const retain = async (name: string, value: unknown) => {
			await this.#kernelLock(root);
			signal.throwIfAborted();
			await publish(root, name, Buffer.from(officeCanonical(value)));
			if (!isDeepStrictEqual(await optional(name), value)) throw new Error("retirement record differs");
		};
		// The power-off worker wrote its completion only after it had checked the
		// VM's whole protected history and seen the VM stopped; its seed pins the stop.
		const suffix = `${allocationId}-${transitionId}`;
		const seed = await optional(`power-off-request-${suffix}.json`),
			completion = officeRecord(await optional(`power-off-completed-${suffix}.json`), [
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
		const pinned = seed as { binding?: unknown; request?: unknown; commandId?: unknown } | undefined;
		if (
			completion.schema !== "qorpera.lxd-office-power-off-completion/v1" ||
			completion.intentId !== intentId ||
			completion.allocationId !== allocationId ||
			completion.transitionId !== transitionId ||
			completion.instanceSha256 !== instanceSha256 ||
			!pinned ||
			completion.requestSha256 !== officeDigest(seed) ||
			pinned.commandId !== completion.commandId ||
			!isDeepStrictEqual(pinned.binding, binding) ||
			!isDeepStrictEqual(pinned.request, recovery)
		)
			throw new Error("power-off completion differs");
		const stopCommandId = completion.commandId as string;
		const journal = await LxdOfficeOperationJournal.open(root, intentId, binding, this.#client, true);
		// The journal's own commands, one per three events. The retained lineage
		// ends with the pinned stop, and at most the delete follows it.
		const lineage = async (deleteCommandId: string) => {
			const { events } = await journal.history();
			const commands: LxdOfficeVmLineageCommand[] = [];
			for (let index = 0; index < events.length; index += 3)
				commands.push({ commandId: events[index].commandId, action: events[index].action });
			const stop = commands.findIndex((command) => command.commandId === stopCommandId);
			if (
				commands[0]?.commandId !== creation.createCommandId ||
				stop < 1 ||
				commands[stop].action !== "stop" ||
				commands.length > stop + 2 ||
				(commands.length === stop + 2 && commands[stop + 1].commandId !== deleteCommandId)
			)
				throw new Error("retirement lineage differs");
			const prior = commands.slice(0, stop + 1);
			await journal.assertRetainedLifecycleSequence(
				[...prior, { commandId: deleteCommandId, action: "delete" }],
				signal,
			);
		};
		const physical = async () => {
			const gate = await this.#gate.check(binding, signal);
			const checked = AbortSignal.any([signal, gate.signal]);
			return { checked, instance: await this.#client.getInstance(binding.project, plan.name, checked) };
		};
		const stopped = async () => {
			const { checked, instance } = await physical();
			if (!instance || instance.status !== "Stopped" || instance.statusCode !== 102)
				throw new Error("retirement VM not stopped");
			assertLxdOfficeGuestInstance(binding, instance);
			const state = await this.#client.getInstanceState(binding.project, plan.name, checked);
			if (state.status !== "Stopped" || state.statusCode !== 102) throw new Error("retirement VM state differs");
			checked.throwIfAborted();
		};
		const result = { intentId, allocationId, transitionId };
		const pin = await optional(OFFICE_RETIREMENT_REQUEST);
		if (pin !== undefined) {
			const pinned = officeRecord(pin, ["schema", "intentId", "request", "stopCommandId", "deleteCommandId"]);
			if (
				pinned.schema !== "qorpera.lxd-office-retirement-request/v1" ||
				pinned.intentId !== intentId ||
				!isDeepStrictEqual(pinned.request, recovery) ||
				pinned.stopCommandId !== stopCommandId ||
				typeof pinned.deleteCommandId !== "string"
			)
				throw new Error("retirement request differs");
			// A dispatched delete that has not succeeded is held without asking SQL.
			const held = await journal.observe(pinned.deleteCommandId, "delete", signal);
			if (held.state === "pending" || held.state === "unknown" || held.state === "failed")
				return { ...result, state: held.state, deleteCommandId: pinned.deleteCommandId };
		}
		const control = new LxdOfficeRetirementControl(recovery, this.#registry);
		const answer = await control.retirement(signal);
		if (!answer) {
			if (pin !== undefined) throw new Error("retirement withdrawn");
			return { ...result, state: "kept" };
		}
		// The pin also keeps the request: once it exists the lifecycle drives only
		// this retirement, also after the company's purge, when SQL answers the
		// retirement from its ledger alone.
		const request = {
			schema: "qorpera.lxd-office-retirement-request/v1",
			intentId,
			request: recovery,
			stopCommandId,
			deleteCommandId: answer.deleteCommandId,
		};
		if (pin === undefined) await retain(OFFICE_RETIREMENT_REQUEST, request);
		else if (!isDeepStrictEqual(pin, request)) throw new Error("retirement request differs");
		const { deleteCommandId } = answer;
		await lineage(deleteCommandId);
		let operation = await journal.observe(deleteCommandId, "delete", signal);
		if (operation.state === "not_dispatched") {
			if (answer.state === "retired") throw new Error("retired without a delete");
			await stopped();
			// A durable nonce per requested window (SQL allows 64 per retirement).
			const challengeId = randomUUID();
			await retain(`office-retirement-challenge-${challengeId}.json`, {
				schema: "qorpera.lxd-office-retirement-challenge/v1",
				challengeId,
				deleteCommandId,
			});
			const window = await control.prepare(challengeId, deleteCommandId, signal);
			await this.#kernelLock(root);
			await lineage(deleteCommandId);
			await stopped();
			window.signal.throwIfAborted();
			if (performance.now() >= window.deadline) throw new Error("retirement window expired");
			operation = await journal.reconcile(deleteCommandId, "delete", window.signal);
		}
		if (operation.state !== "succeeded") return { ...result, state: operation.state, deleteCommandId };
		const { instance } = await physical();
		if (instance !== undefined) throw new Error("retirement VM present");
		const receipt: LxdOfficeRetirement =
			answer.state === "retired"
				? answer
				: await control.retire({ deleteCommandId, deleteOperationId: operation.operationId as string }, signal);
		if (receipt.state !== "retired" || receipt.deleteOperationId !== operation.operationId)
			throw new Error("retirement receipt differs");
		await retain(OFFICE_RETIRED_MARKER, {
			schema: "qorpera.lxd-office-retired/v1",
			intentId,
			retirement: receipt,
		});
		return { ...result, state: "retired", deleteCommandId };
	}
}
