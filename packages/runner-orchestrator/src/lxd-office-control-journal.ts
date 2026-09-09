import { createHash } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type LxdOfficePreparationCommand,
	type LxdOperationReference,
	type LxdOperationState,
	lxdOfficePreparationCommand,
} from "./lxd-client.ts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { checkDirectory, publish, readRecord, syncDirectory } from "./lxd-office-journal-files.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
export interface LxdOfficeControlClient {
	submit(
		project: string,
		name: string,
		command: LxdOfficePreparationCommand,
		signal: AbortSignal,
	): Promise<LxdOperationReference>;
	inspect(reference: LxdOperationReference, signal: AbortSignal): Promise<LxdOperationState>;
}
type Purpose =
	| "preparation"
	| "configuration"
	| "boot-configuration"
	| "boot-service-restart"
	| "boot-service-start"
	| "service-start"
	| "service-stop"
	| "service-restart";
export interface LxdOfficeControlIdentity {
	intentId: string;
	binding: LxdOfficeGuestBinding;
	bootObservationSha256: string;
	command: LxdOfficePreparationCommand;
	preparationObservationSha256?: string;
	configurationObservationSha256?: string;
	transitionId?: string;
	revocationSha256?: string;
	startObservationSha256?: string;
	activationId?: string;
	stopObservationSha256?: string;
	bootIntentId?: string;
	originActivationId?: string;
	originPreparationSha256?: string;
}
interface Event {
	schema: `qorpera.lxd-office-${Purpose}-event/v1`;
	sequence: number;
	previousSha256: string;
	kind: "dispatch" | "accepted" | "settled";
	operationId: string | null;
	state: "succeeded" | "failed" | null;
}
export interface LxdOfficeControlOperationResult {
	state: LxdOperationState | "unknown" | "not_dispatched";
	operationId?: string;
}

/** Shared engine for closed office control phases. Each phase retains its
 * own authority/event schema and allocation directory. One fixed command is
 * bound to the original allocation and observed boot; configuration also binds
 * the completed preparation observation; service start binds acknowledged configuration.
 * Stop binds the retained revocation and original start observation, with its
 * own transition directory so later lifecycle transitions cannot reuse it.
 * Durable records survive provider restarts; an unknown submission is never
 * retried, even after a reboot, a missing operation or an apparent report.
 * The supervisor must hold the kernel lifecycle lock, serialize all phases,
 * retain the identity before effects, and check the phase's current physical
 * and cloud authority before reconciliation. This journal does none of those
 * checks. Stop never depends on mutable workbench copy verification, and a
 * successful command is NOT preparation evidence, activation, stop evidence
 * or capacity release. */
export class LxdOfficeControlJournal {
	readonly #root: string;
	readonly #identity: LxdOfficeControlIdentity;
	readonly #client: LxdOfficeControlClient;
	readonly #purpose: Purpose;
	private constructor(
		root: string,
		identity: LxdOfficeControlIdentity,
		client: LxdOfficeControlClient,
		purpose: Purpose,
	) {
		this.#purpose = purpose;
		this.#root = root;
		this.#identity = identity;
		this.#client = client;
	}

	static async open(
		stateRoot: string,
		value: LxdOfficeControlIdentity,
		client: LxdOfficeControlClient,
		existing: boolean,
		purpose: Purpose,
	): Promise<LxdOfficeControlJournal> {
		if (
			![
				"preparation",
				"configuration",
				"boot-configuration",
				"boot-service-restart",
				"boot-service-start",
				"service-start",
				"service-stop",
				"service-restart",
			].includes(purpose)
		)
			throw new Error("INVALID_OFFICE_CONTROL_PURPOSE");
		if (
			resolve(stateRoot) !== stateRoot ||
			!value ||
			Object.keys(value).sort().join() !==
				(purpose === "boot-service-restart"
					? "activationId,binding,bootIntentId,bootObservationSha256,command,configurationObservationSha256,intentId,originActivationId,stopObservationSha256,transitionId"
					: purpose === "boot-service-start"
						? "activationId,binding,bootIntentId,bootObservationSha256,command,configurationObservationSha256,intentId"
						: purpose === "boot-configuration"
							? "activationId,binding,bootIntentId,bootObservationSha256,command,intentId,originPreparationSha256"
							: purpose === "preparation"
								? "binding,bootObservationSha256,command,intentId"
								: purpose === "configuration"
									? "binding,bootObservationSha256,command,intentId,preparationObservationSha256"
									: purpose === "service-start"
										? "binding,bootObservationSha256,command,configurationObservationSha256,intentId"
										: purpose === "service-stop"
											? "binding,bootObservationSha256,command,intentId,revocationSha256,startObservationSha256,transitionId"
											: "activationId,binding,bootObservationSha256,command,configurationObservationSha256,intentId,stopObservationSha256,transitionId") ||
			(purpose === "configuration" &&
				(typeof value.preparationObservationSha256 !== "string" ||
					!/^[0-9a-f]{64}$/.test(value.preparationObservationSha256))) ||
			(purpose === "boot-configuration" &&
				(![value.activationId, value.bootIntentId].every(
					(value) => typeof value === "string" && UUID.test(value),
				) ||
					typeof value.originPreparationSha256 !== "string" ||
					!/^[0-9a-f]{64}$/.test(value.originPreparationSha256))) ||
			(purpose === "boot-service-start" &&
				![value.activationId, value.bootIntentId].every(
					(value) => typeof value === "string" && UUID.test(value),
				)) ||
			((purpose === "service-start" || purpose === "boot-service-start") &&
				(typeof value.configurationObservationSha256 !== "string" ||
					!/^[0-9a-f]{64}$/.test(value.configurationObservationSha256))) ||
			(purpose === "service-stop" &&
				(typeof value.transitionId !== "string" ||
					!UUID.test(value.transitionId) ||
					![value.revocationSha256, value.startObservationSha256].every(
						(value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value),
					))) ||
			((purpose === "service-restart" || purpose === "boot-service-restart") &&
				(![value.activationId, value.transitionId].every(
					(value) => typeof value === "string" && UUID.test(value),
				) ||
					![value.configurationObservationSha256, value.stopObservationSha256].every(
						(value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value),
					))) ||
			(purpose === "boot-service-restart" &&
				(![value.bootIntentId, value.originActivationId].every(
					(value) => typeof value === "string" && UUID.test(value),
				) ||
					value.originActivationId === value.activationId)) ||
			typeof value.intentId !== "string" ||
			!UUID.test(value.intentId) ||
			typeof value.bootObservationSha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(value.bootObservationSha256)
		)
			throw new Error(`INVALID_OFFICE_${purpose.replaceAll("-", "_").toUpperCase()}_IDENTITY`);
		lxdOfficePreparationCommand(value.command);
		const identity = {
			intentId: value.intentId,
			binding: lxdOfficeGuestPlan(value.binding).binding,
			bootObservationSha256: value.bootObservationSha256,
			command: Object.freeze({ ...value.command }),
			...(purpose === "boot-configuration"
				? {
						activationId: value.activationId,
						bootIntentId: value.bootIntentId,
						originPreparationSha256: value.originPreparationSha256,
					}
				: {}),
			...(purpose === "configuration" ? { preparationObservationSha256: value.preparationObservationSha256 } : {}),
			...(purpose === "boot-service-start"
				? { activationId: value.activationId, bootIntentId: value.bootIntentId }
				: {}),
			...(purpose === "service-start" || purpose === "boot-service-start"
				? { configurationObservationSha256: value.configurationObservationSha256 }
				: {}),
			...(purpose === "service-stop"
				? {
						transitionId: value.transitionId,
						revocationSha256: value.revocationSha256,
						startObservationSha256: value.startObservationSha256,
					}
				: {}),
			...(purpose === "boot-service-restart"
				? { bootIntentId: value.bootIntentId, originActivationId: value.originActivationId }
				: {}),
			...(purpose === "service-restart" || purpose === "boot-service-restart"
				? {
						activationId: value.activationId,
						transitionId: value.transitionId,
						configurationObservationSha256: value.configurationObservationSha256,
						stopObservationSha256: value.stopObservationSha256,
					}
				: {}),
		};
		await checkDirectory(stateRoot);
		const root = join(
			stateRoot,
			`${purpose}-${identity.binding.allocationId}${purpose === "service-stop" ? `-${identity.transitionId}` : purpose === "service-restart" || purpose === "boot-service-restart" || purpose === "boot-configuration" || purpose === "boot-service-start" ? `-${identity.activationId}` : ""}`,
		);
		const journal = new LxdOfficeControlJournal(root, identity, client, purpose);
		if (!existing) {
			// Creation is explicit and exclusive. A surviving directory with lost
			// authority is never silently initialized, even if it looks empty.
			await mkdir(root, { mode: 0o700 });
			await syncDirectory(stateRoot);
			await publish(root, "authority.json", encode(journal.#authority()));
		}
		await journal.#read();
		return journal;
	}

	#authority() {
		return { schema: `qorpera.lxd-office-${this.#purpose}-journal/v1`, ...this.#identity };
	}

	async #read(): Promise<{ events: Event[]; previousSha256: string }> {
		try {
			await checkDirectory(this.#root);
			const authority = await readRecord(join(this.#root, "authority.json"));
			if (!isDeepStrictEqual(authority.value, this.#authority())) throw new Error("identity changed");
			const names = (await readdir(this.#root))
				.filter((name) => name !== "authority.json" && !/^\.write-[0-9a-f-]{36}$/.test(name))
				.sort();
			if (names.length > 3) throw new Error("unexpected preparation command");
			let previousSha256 = sha(authority.bytes);
			const events: Event[] = [];
			for (const [index, name] of names.entries()) {
				if (name !== `${String(index).padStart(6, "0")}.json`) throw new Error("missing sequence");
				const { value, bytes } = await readRecord(join(this.#root, name));
				if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid event");
				const event = value as Event;
				if (
					Object.keys(event).sort().join() !== "kind,operationId,previousSha256,schema,sequence,state" ||
					event.schema !== `qorpera.lxd-office-${this.#purpose}-event/v1` ||
					event.sequence !== index ||
					event.previousSha256 !== previousSha256 ||
					event.kind !== ["dispatch", "accepted", "settled"][index] ||
					(index === 0
						? event.operationId !== null
						: typeof event.operationId !== "string" || !UUID.test(event.operationId)) ||
					(index < 2
						? event.state !== null
						: (event.state !== "succeeded" && event.state !== "failed") ||
							event.operationId !== events[1].operationId)
				)
					throw new Error("invalid event chain");
				events.push(event);
				previousSha256 = sha(bytes);
			}
			return { events, previousSha256 };
		} catch {
			throw new Error(`OFFICE_${this.#purpose.replaceAll("-", "_").toUpperCase()}_JOURNAL_UNCONFIRMED`);
		}
	}

	async #append(
		current: { events: Event[]; previousSha256: string },
		kind: Event["kind"],
		operationId: string | null,
		state: Event["state"],
	): Promise<boolean> {
		return publish(
			this.#root,
			`${String(current.events.length).padStart(6, "0")}.json`,
			encode({
				schema: `qorpera.lxd-office-${this.#purpose}-event/v1`,
				sequence: current.events.length,
				previousSha256: current.previousSha256,
				kind,
				operationId,
				state,
			}),
		);
	}

	async reconcile(signal: AbortSignal): Promise<LxdOfficeControlOperationResult> {
		signal.throwIfAborted();
		let current = await this.#read();
		if (current.events.length) return this.observe(signal);
		signal.throwIfAborted();
		if (!(await this.#append(current, "dispatch", null, null))) return this.observe(signal);
		const { binding, command } = this.#identity;
		const name = lxdOfficeGuestPlan(binding).request.name;
		let reference: LxdOperationReference;
		try {
			signal.throwIfAborted();
			reference = await this.#client.submit(binding.project, name, command, signal);
			if (
				reference.project !== binding.project ||
				reference.instanceName !== name ||
				typeof reference.operationId !== "string" ||
				!UUID.test(reference.operationId)
			)
				throw new Error("unbound submission");
		} catch {
			return { state: "unknown" };
		}
		// Acceptance survives cancellation after the reply. No polling is needed
		// to retain the only operation identity for the next provider process.
		current = await this.#read();
		if (current.events.length !== 1)
			throw new Error(`OFFICE_${this.#purpose.replaceAll("-", "_").toUpperCase()}_COMMAND_CONFLICT`);
		if (!(await this.#append(current, "accepted", reference.operationId, null)))
			throw new Error(`OFFICE_${this.#purpose.replaceAll("-", "_").toUpperCase()}_COMMAND_CONFLICT`);
		return this.observe(signal);
	}

	async observe(signal: AbortSignal): Promise<LxdOfficeControlOperationResult> {
		const current = await this.#read();
		const last = current.events.at(-1);
		if (!last) return { state: "not_dispatched" };
		if (last.kind === "dispatch") return { state: "unknown" };
		const operationId = last.operationId as string;
		if (last.kind === "settled") return { state: last.state as "succeeded" | "failed", operationId };
		try {
			signal.throwIfAborted();
			const state = await this.#client.inspect(
				{
					project: this.#identity.binding.project,
					instanceName: lxdOfficeGuestPlan(this.#identity.binding).request.name,
					operationId,
				},
				signal,
			);
			if (state === "pending") return { state, operationId };
			if (state !== "succeeded" && state !== "failed") throw new Error("invalid operation status");
			const latest = await this.#read();
			if (latest.events.length === 3) {
				if (latest.events[2].state !== state) throw new Error("conflicting completion");
			} else {
				if (latest.events.length !== 2 || latest.events[1].operationId !== operationId)
					throw new Error("changed acceptance");
				await this.#append(latest, "settled", operationId, state);
				const retained = await this.#read();
				if (retained.events.length !== 3 || retained.events[2].state !== state)
					throw new Error("conflicting completion");
			}
			return { state, operationId };
		} catch {
			return { state: "unknown", operationId };
		}
	}
}
