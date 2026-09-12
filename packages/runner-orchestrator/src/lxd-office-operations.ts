import { createHash } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { LxdOperationState, LxdTrackedClient, LxdTrackedInstanceAction } from "./lxd-client.ts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { checkDirectory, code, publish, readRecord, syncDirectory } from "./lxd-office-journal-files.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_EVENTS = 384;
type Action = LxdTrackedInstanceAction["action"];

interface EventFields {
	sequence: number;
	previousSha256: string;
	commandId: string;
	action: Action;
	kind: "dispatch" | "accepted" | "settled";
	operationId: string | null;
	state: "succeeded" | "failed" | null;
}
type Event = EventFields &
	(
		| { schema: "qorpera.lxd-office-operation-event/v1" }
		| {
				schema: "qorpera.lxd-office-operation-event/v2";
				recordedAt: string | null;
		  }
	);

function timestamp(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
	const instant = new Date(value);
	return Number.isFinite(instant.getTime()) && instant.toISOString() === value;
}

export interface LxdOfficeOperationResult {
	state: LxdOperationState | "unknown";
	operationId?: string;
}

function sha256(value: Buffer | string): string {
	return createHash("sha256").update(value).digest("hex");
}

function encode(value: unknown): Buffer {
	return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function lastCommand(events: readonly Event[], commandId: string): Event | undefined {
	for (let index = events.length - 1; index >= 0; index--) {
		if (events[index].commandId === commandId) return events[index];
	}
	return undefined;
}

/** Durable physical-operation journal for one provider-owned office binding.
 * Opening this journal is NOT cloud authorization, reservation, image/storage
 * acceptance or office readiness. Its caller must establish those first.
 * Unknown submission outcomes never become retryable through time, an absent
 * instance, an empty operation listing, or a missing operation (404). */
export class LxdOfficeOperationJournal {
	readonly #root: string;
	readonly #authority: { schema: string; intentId: string; binding: Readonly<LxdOfficeGuestBinding> };
	readonly #client: Pick<LxdTrackedClient, "submitInstanceOperation" | "inspectInstanceOperation">;
	readonly #now: () => Date;

	private constructor(
		root: string,
		intentId: string,
		binding: LxdOfficeGuestBinding,
		client: Pick<LxdTrackedClient, "submitInstanceOperation" | "inspectInstanceOperation">,
		now: () => Date = () => new Date(),
	) {
		this.#root = root;
		this.#authority = {
			schema: "qorpera.lxd-office-operation-journal/v1",
			intentId,
			binding: lxdOfficeGuestPlan(binding).binding,
		};
		this.#client = client;
		this.#now = now;
	}

	static async open(
		stateRoot: string,
		intentId: string,
		binding: LxdOfficeGuestBinding,
		client: Pick<LxdTrackedClient, "submitInstanceOperation" | "inspectInstanceOperation">,
		existing = false,
		now: () => Date = () => new Date(),
	): Promise<LxdOfficeOperationJournal> {
		if (typeof intentId !== "string" || !UUID.test(intentId) || resolve(stateRoot) !== stateRoot)
			throw new Error("INVALID_LXD_OFFICE_JOURNAL");
		const plan = lxdOfficeGuestPlan(binding);
		await checkDirectory(stateRoot);
		const root = join(stateRoot, plan.binding.allocationId);
		try {
			if (existing) {
				await checkDirectory(root);
			} else {
				await mkdir(root, { mode: 0o700 });
				await syncDirectory(stateRoot);
			}
		} catch (error) {
			if (!code(error, "EEXIST")) throw error;
		}
		await checkDirectory(root);
		const journal = new LxdOfficeOperationJournal(root, intentId, plan.binding, client, now);
		if (!existing) await publish(root, "authority.json", encode(journal.#authority));
		await journal.#read();
		return journal;
	}

	/** Local operator read only: validate the original authority and hash chain,
	 * without creating files, loading credentials or contacting a provider. */
	static async readHistory(stateRoot: string, allocationId: string) {
		if (resolve(stateRoot) !== stateRoot || !UUID.test(allocationId)) throw new Error("INVALID_LXD_OFFICE_HISTORY");
		await checkDirectory(stateRoot);
		const root = join(stateRoot, allocationId);
		await checkDirectory(root);
		const { value } = await readRecord(join(root, "authority.json"));
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("LXD_OFFICE_HISTORY_UNCONFIRMED");
		const authority = value as { schema: unknown; intentId: unknown; binding: LxdOfficeGuestBinding };
		if (
			Object.keys(authority).sort().join() !== "binding,intentId,schema" ||
			authority.schema !== "qorpera.lxd-office-operation-journal/v1" ||
			typeof authority.intentId !== "string" ||
			!UUID.test(authority.intentId)
		)
			throw new Error("LXD_OFFICE_HISTORY_UNCONFIRMED");
		const binding = lxdOfficeGuestPlan(authority.binding).binding;
		if (binding.allocationId !== allocationId) throw new Error("LXD_OFFICE_HISTORY_UNCONFIRMED");
		const denied = async (): Promise<never> => {
			throw new Error("LXD_OFFICE_HISTORY_READ_ONLY");
		};
		const journal = new LxdOfficeOperationJournal(root, authority.intentId, binding, {
			submitInstanceOperation: denied,
			inspectInstanceOperation: denied,
		});
		return journal.history();
	}

	async history() {
		const { events, previousSha256 } = await this.#read();
		const { binding, intentId } = this.#authority;
		return {
			schema: "qorpera.lxd-office-operation-history/v1",
			companyId: binding.companyId,
			environmentId: binding.environmentId,
			companyComputerId: binding.companyComputerId,
			logicalComputerId: binding.logicalComputerId,
			computerGeneration: binding.computerGeneration,
			allocationId: binding.allocationId,
			providerId: binding.providerId,
			providerPolicySha256: binding.providerPolicySha256,
			imageFingerprint: binding.imageFingerprint,
			bootstrapSha256: binding.bootstrapSha256,
			intentId,
			journalHeadSha256: previousSha256,
			source: "local_provider_operation_journal",
			runtimeBundleId: null,
			runtimeBundleSource: "not_recorded_in_vm_operation_journal",
			events: events.map((event) => ({
				sequence: event.sequence,
				commandId: event.commandId,
				action: event.action,
				kind: event.kind,
				operationId: event.operationId,
				state: event.state,
				recordedAt: event.schema === "qorpera.lxd-office-operation-event/v2" ? event.recordedAt : null,
				timeSource:
					event.schema === "qorpera.lxd-office-operation-event/v1"
						? "not_recorded"
						: event.recordedAt === null
							? "clock_unavailable"
							: "provider_journal_clock",
				reason:
					event.kind === "dispatch"
						? "DISPATCH_RECORDED"
						: event.kind === "accepted"
							? "PROVIDER_OPERATION_ACCEPTED"
							: event.state === "failed"
								? "PROVIDER_OPERATION_FAILED"
								: "PROVIDER_OPERATION_SUCCEEDED",
				physicalTransitionAt: null,
			})),
			serviceReadinessInferred: false,
			resourceReleaseInferred: false,
		};
	}

	async #read(): Promise<{ events: Event[]; previousSha256: string }> {
		try {
			await checkDirectory(this.#root);
			const authority = await readRecord(join(this.#root, "authority.json"));
			if (!isDeepStrictEqual(authority.value, this.#authority)) throw new Error("binding changed");
			const names = (await readdir(this.#root))
				.filter((name) => name !== "authority.json" && !/^\.write-[0-9a-f-]{36}$/.test(name))
				.sort();
			if (names.length > MAX_EVENTS) throw new Error("journal full");
			let previousSha256 = sha256(authority.bytes);
			const events: Event[] = [];
			const commands = new Set<string>();
			const operations = new Set<string>();
			for (const [index, name] of names.entries()) {
				if (name !== `${String(index).padStart(6, "0")}.json`) throw new Error("journal sequence missing");
				const { value, bytes } = await readRecord(join(this.#root, name));
				if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid event");
				const event = value as Event;
				if (
					(event.schema !== "qorpera.lxd-office-operation-event/v1" &&
						event.schema !== "qorpera.lxd-office-operation-event/v2") ||
					Object.keys(event).sort().join() !==
						(event.schema === "qorpera.lxd-office-operation-event/v1"
							? "action,commandId,kind,operationId,previousSha256,schema,sequence,state"
							: "action,commandId,kind,operationId,previousSha256,recordedAt,schema,sequence,state") ||
					(event.schema === "qorpera.lxd-office-operation-event/v2" &&
						event.recordedAt !== null &&
						!timestamp(event.recordedAt)) ||
					event.sequence !== index ||
					event.previousSha256 !== previousSha256 ||
					typeof event.commandId !== "string" ||
					!UUID.test(event.commandId) ||
					!["create", "start", "stop", "delete"].includes(event.action)
				)
					throw new Error("invalid event identity");
				const previous = events.at(-1);
				if (event.kind === "dispatch") {
					if (
						(previous && previous.kind !== "settled") ||
						commands.has(event.commandId) ||
						event.operationId !== null ||
						event.state !== null
					)
						throw new Error("conflicting dispatch");
					commands.add(event.commandId);
				} else {
					if (
						!previous ||
						event.commandId !== previous.commandId ||
						event.action !== previous.action ||
						typeof event.operationId !== "string" ||
						!UUID.test(event.operationId)
					)
						throw new Error("unbound operation");
					if (event.kind === "accepted") {
						if (previous.kind !== "dispatch" || operations.has(event.operationId) || event.state !== null)
							throw new Error("conflicting acceptance");
						operations.add(event.operationId);
					} else if (event.kind === "settled") {
						if (
							previous.kind !== "accepted" ||
							event.operationId !== previous.operationId ||
							(event.state !== "succeeded" && event.state !== "failed")
						)
							throw new Error("unconfirmed settlement");
					} else throw new Error("invalid event kind");
				}
				events.push(event);
				previousSha256 = sha256(bytes);
			}
			return { events, previousSha256 };
		} catch {
			throw new Error("LXD_OFFICE_JOURNAL_UNCONFIRMED");
		}
	}

	async #append(
		events: Event[],
		previousSha256: string,
		entry: Omit<EventFields, "sequence" | "previousSha256">,
	): Promise<boolean> {
		if (events.length >= MAX_EVENTS) throw new Error("LXD_OFFICE_JOURNAL_FULL");
		let recordedAt: string | null = null;
		try {
			const value = this.#now().toISOString();
			if (timestamp(value)) recordedAt = value;
		} catch {
			// Optional clock metadata cannot prevent mandatory dispatch custody.
		}
		return publish(
			this.#root,
			`${String(events.length).padStart(6, "0")}.json`,
			encode({
				schema: "qorpera.lxd-office-operation-event/v2",
				recordedAt,
				sequence: events.length,
				previousSha256,
				...entry,
			}),
		);
	}

	/** One bounded reconciliation: submit at most once, then inspect at most
	 * once. Call again with the SAME command ID to resume after a process crash.
	 * The caller separately checks physical postconditions and admission fences. */
	async reconcile(commandId: string, action: Action, signal: AbortSignal): Promise<LxdOfficeOperationResult> {
		if (
			typeof commandId !== "string" ||
			!UUID.test(commandId) ||
			!["create", "start", "stop", "delete"].includes(action)
		)
			throw new Error("INVALID_LXD_OFFICE_COMMAND");
		signal.throwIfAborted();
		let current = await this.#read();
		let command = lastCommand(current.events, commandId);
		if (command && command.action !== action) throw new Error("LXD_OFFICE_COMMAND_CONFLICT");
		if (!command) {
			if (current.events.at(-1) && current.events.at(-1)?.kind !== "settled")
				throw new Error("LXD_OFFICE_OPERATION_UNSETTLED");
			// Reserve room for acceptance and settlement before dispatching.
			if (current.events.length > MAX_EVENTS - 3) throw new Error("LXD_OFFICE_JOURNAL_FULL");
			signal.throwIfAborted();
			const claimed = await this.#append(current.events, current.previousSha256, {
				commandId,
				action,
				kind: "dispatch",
				operationId: null,
				state: null,
			});
			if (!claimed) return this.#observe(commandId, action, signal);
			const { binding, request } = lxdOfficeGuestPlan(this.#authority.binding);
			let operationId: string;
			try {
				signal.throwIfAborted();
				const reference = await this.#client.submitInstanceOperation(
					binding.project,
					action === "create" ? { action, request } : { action, name: request.name },
					signal,
				);
				if (
					reference.project !== binding.project ||
					reference.instanceName !== request.name ||
					!UUID.test(reference.operationId)
				)
					throw new Error("unbound submission");
				operationId = reference.operationId;
			} catch {
				return { state: "unknown" };
			}
			// Persist acceptance even when shutdown arrives after the HTTP reply.
			current = await this.#read();
			command = current.events.at(-1);
			if (command?.kind !== "dispatch" || command.commandId !== commandId)
				throw new Error("LXD_OFFICE_COMMAND_CONFLICT");
			await this.#append(current.events, current.previousSha256, {
				commandId,
				action,
				kind: "accepted",
				operationId,
				state: null,
			});
		}
		return this.#observe(commandId, action, signal);
	}

	/** Inspect an existing command without ever dispatching a missing command.
	 * Settlement records may be persisted; no provider mutation is performed. */
	async observe(
		commandId: string,
		action: Action,
		signal: AbortSignal,
	): Promise<LxdOfficeOperationResult | { state: "not_dispatched" }> {
		if (
			typeof commandId !== "string" ||
			!UUID.test(commandId) ||
			!["create", "start", "stop", "delete"].includes(action)
		)
			throw new Error("INVALID_LXD_OFFICE_COMMAND");
		signal.throwIfAborted();
		const current = await this.#read();
		const command = lastCommand(current.events, commandId);
		if (!command) return { state: "not_dispatched" };
		return this.#observe(commandId, action, signal);
	}

	/** Initial storage review cannot use a historical create after any start,
	 * stop or delete was dispatched, including an operation with unknown outcome.
	 * This journal read is evidence only; it does not acquire a lifecycle lock. */
	async assertInitialCreation(commandId: string, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		const { events } = await this.#read();
		const last = events.at(-1);
		if (
			!last ||
			last.kind !== "settled" ||
			last.state !== "succeeded" ||
			events.some((event) => event.commandId !== commandId || event.action !== "create")
		)
			throw new Error("OFFICE_INITIAL_CREATION_UNCONFIRMED");
		signal.throwIfAborted();
	}

	/** Restricted first boot may follow only the successful initial create and
	 * its one retained start command. A later stop/delete/start, including an
	 * unknown dispatch, prevents historical evidence from authorizing a boot. */
	async assertInitialBootSequence(
		createCommandId: string,
		startCommandId: string,
		signal: AbortSignal,
	): Promise<void> {
		signal.throwIfAborted();
		const { events } = await this.#read();
		if (
			!UUID.test(createCommandId) ||
			!UUID.test(startCommandId) ||
			createCommandId === startCommandId ||
			events.length < 3 ||
			events.length > 6 ||
			events.slice(0, 3).some((event) => event.commandId !== createCommandId || event.action !== "create") ||
			events[2].kind !== "settled" ||
			events[2].state !== "succeeded" ||
			events.slice(3).some((event) => event.commandId !== startCommandId || event.action !== "start")
		)
			throw new Error("OFFICE_INITIAL_BOOT_SEQUENCE_UNCONFIRMED");
		signal.throwIfAborted();
	}

	/** First VM shutdown follows the completed initial create/boot and exactly
	 * one retained stop command. Service restarts do not mutate this journal.
	 * A later start/delete/stop or a lost command identity cannot reuse it. */
	async assertPowerOffSequence(
		createCommandId: string,
		startCommandId: string,
		stopCommandId: string,
		signal: AbortSignal,
	): Promise<void> {
		signal.throwIfAborted();
		const { events } = await this.#read();
		const ids = [createCommandId, startCommandId, stopCommandId];
		if (
			ids.some((id) => !UUID.test(id)) ||
			new Set(ids).size !== 3 ||
			events.length < 6 ||
			events.length > 9 ||
			events.slice(0, 3).some((event) => event.commandId !== createCommandId || event.action !== "create") ||
			events[2].kind !== "settled" ||
			events[2].state !== "succeeded" ||
			events.slice(3, 6).some((event) => event.commandId !== startCommandId || event.action !== "start") ||
			events[5].kind !== "settled" ||
			events[5].state !== "succeeded" ||
			events.slice(6).some((event) => event.commandId !== stopCommandId || event.action !== "stop")
		)
			throw new Error("OFFICE_POWER_OFF_SEQUENCE_UNCONFIRMED");
		signal.throwIfAborted();
	}

	/** Retained create/start/stop lineage. All predecessors must have succeeded;
	 * only the final command may be absent or unresolved. Callers supply exact
	 * identities from their protected history, never infer them from VM state. */
	async assertLifecycleSequence(
		commands: readonly { commandId: string; action: "create" | "start" | "stop" }[],
		signal: AbortSignal,
	): Promise<void> {
		signal.throwIfAborted();
		const { events } = await this.#read();
		if (
			commands.length < 2 ||
			commands.length > MAX_EVENTS / 3 ||
			new Set(commands.map((command) => command.commandId)).size !== commands.length ||
			commands.some(
				(command, index) =>
					!UUID.test(command.commandId) ||
					command.action !== (index === 0 ? "create" : index % 2 ? "start" : "stop"),
			) ||
			events.length < (commands.length - 1) * 3 ||
			events.length > commands.length * 3
		)
			throw new Error("OFFICE_VM_LINEAGE_UNCONFIRMED");
		for (const [index, command] of commands.entries()) {
			if (
				events
					.slice(index * 3, index * 3 + 3)
					.some((event) => event.commandId !== command.commandId || event.action !== command.action)
			)
				throw new Error("OFFICE_VM_LINEAGE_UNCONFIRMED");
			if (
				index < commands.length - 1 &&
				(events[index * 3 + 2]?.kind !== "settled" || events[index * 3 + 2]?.state !== "succeeded")
			)
				throw new Error("OFFICE_VM_LINEAGE_UNCONFIRMED");
		}
		signal.throwIfAborted();
	}

	/** Governed root reset lineage: the retained create/start/stop chain, then
	 * exactly stop -> delete -> create -> start with the planned command IDs.
	 * Every predecessor must have succeeded; only the final present command may
	 * be unresolved. Original create/boot/power-off validators are unchanged,
	 * so historical prefixes cannot be relabelled as a reset. */
	async assertResetLineage(
		prior: readonly { commandId: string; action: "create" | "start" | "stop" }[],
		reset: {
			readonly stopCommandId: string;
			readonly deleteCommandId: string;
			readonly createCommandId: string;
			readonly startCommandId: string;
		},
		signal: AbortSignal,
	): Promise<{ reached: "none" | "stop" | "delete" | "create" | "start"; settled: boolean }> {
		signal.throwIfAborted();
		const { events } = await this.#read();
		const suffix = [
			{ commandId: reset.stopCommandId, action: "stop" as const },
			{ commandId: reset.deleteCommandId, action: "delete" as const },
			{ commandId: reset.createCommandId, action: "create" as const },
			{ commandId: reset.startCommandId, action: "start" as const },
		];
		const commands = [...prior, ...suffix];
		if (
			prior.length < 2 ||
			prior.length % 2 !== 0 ||
			prior.some((command, index) => command.action !== (index === 0 ? "create" : index % 2 ? "start" : "stop")) ||
			commands.some((command) => !UUID.test(command.commandId)) ||
			new Set(commands.map((command) => command.commandId)).size !== commands.length ||
			commands.length > MAX_EVENTS / 3 ||
			events.length < prior.length * 3 ||
			events.length > commands.length * 3
		)
			throw new Error("OFFICE_RESET_LINEAGE_UNCONFIRMED");
		const groups = Math.ceil(events.length / 3);
		for (let index = 0; index < groups; index++) {
			const command = commands[index],
				group = events.slice(index * 3, index * 3 + 3);
			if (
				!command ||
				group.some((event) => event.commandId !== command.commandId || event.action !== command.action)
			)
				throw new Error("OFFICE_RESET_LINEAGE_UNCONFIRMED");
			if (index < groups - 1 && (group[2]?.kind !== "settled" || group[2]?.state !== "succeeded"))
				throw new Error("OFFICE_RESET_LINEAGE_UNCONFIRMED");
		}
		signal.throwIfAborted();
		const reachedIndex = groups - prior.length,
			last = events.at(-1);
		return {
			reached: reachedIndex <= 0 ? "none" : suffix[reachedIndex - 1].action,
			settled: reachedIndex > 0 && last?.kind === "settled" && last.state === "succeeded",
		};
	}

	async #observe(commandId: string, action: Action, signal: AbortSignal): Promise<LxdOfficeOperationResult> {
		const current = await this.#read();
		const command = lastCommand(current.events, commandId);
		if (!command || command.action !== action) throw new Error("LXD_OFFICE_COMMAND_CONFLICT");
		if (command.kind === "settled")
			return { state: command.state as "succeeded" | "failed", operationId: command.operationId as string };
		if (command.kind === "dispatch") return { state: "unknown" };
		const { binding, request } = lxdOfficeGuestPlan(this.#authority.binding);
		const operationId = command.operationId as string;
		let state: LxdOperationState;
		try {
			signal.throwIfAborted();
			state = await this.#client.inspectInstanceOperation(
				{ project: binding.project, instanceName: request.name, operationId },
				signal,
			);
			if (!["pending", "succeeded", "failed"].includes(state)) throw new Error("invalid observation");
		} catch {
			return { state: "unknown", operationId };
		}
		if (state === "pending") return { state, operationId };
		const appended = await this.#append(current.events, current.previousSha256, {
			commandId,
			action,
			kind: "settled",
			operationId,
			state,
		});
		if (!appended) {
			const latest = await this.#read();
			const settled = lastCommand(latest.events, commandId);
			if (settled?.kind !== "settled" || settled.state !== state || settled.operationId !== operationId)
				throw new Error("LXD_OFFICE_OPERATION_CONFLICT");
		}
		return { state, operationId };
	}
}
