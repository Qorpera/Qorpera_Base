import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	assertCompanyComputerScope,
	assertCompanyComputerScreenBinding,
	type CompanyComputerScreenBinding,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import {
	type CompanyComputerPrivacyChallenge,
	parseCompanyComputerPrivacyChallenge,
} from "@qorpera/cloud-client/cloud-company-computer-privacy";
import { type CompanyComputerStartupIdentity, parseCompanyComputerStartupIdentity } from "@qorpera/contracts";
import { cloudToolRequest } from "./cloud-native-tool-authority.ts";

export type ScreenClosingReason =
	| "SCREEN_DRAIN_REQUESTED"
	| "OFFICE_SERVICE_STOPPING"
	| "PRIVACY_FENCE"
	| "AUTHORITY_LOST";
export type ScreenFailureReason =
	| "DESKTOP_START_FAILED"
	| "DESKTOP_EXITED"
	| "DESKTOP_DRAIN_UNCONFIRMED"
	| "SERVICE_INTERRUPTED";
export interface CompanyComputerScreenLifetime {
	readonly lifetimeId: string;
	requested(signal: AbortSignal): Promise<void>;
	ready(signal: AbortSignal): Promise<void>;
	heartbeat(signal: AbortSignal): Promise<void>;
	closing(reason: ScreenClosingReason, signal: AbortSignal): Promise<void>;
	failed(reason: ScreenFailureReason, signal: AbortSignal): Promise<void>;
	closed(signal: AbortSignal): Promise<void>;
}
export interface CompanyComputerScreenLifecycle {
	create(
		binding: CompanyComputerScreenBinding,
		privacy: CompanyComputerPrivacyChallenge | null,
	): CompanyComputerScreenLifetime;
}
export interface CompanyComputerScreenLifecycleRegistry {
	call(
		method: "qorpera_record_runtime_screen_event" | "qorpera_retain_runtime_screen_observation",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}
type State = "requested" | "ready" | "closing" | "closed" | "failed";
export type CompanyComputerScreenEvent = {
	lifetimeId: string;
	eventId: string;
	sequence: number;
	observedAt: string;
	state: State;
	reason: string;
};
export interface CompanyComputerScreenObservation {
	schema: "qorpera.runtime-screen-observation/v1";
	startup: Readonly<CompanyComputerStartupIdentity>;
	binding: CompanyComputerScreenBinding;
	privacy: CompanyComputerPrivacyChallenge | null;
	event: CompanyComputerScreenEvent;
}
export interface CompanyComputerScreenEventCustody {
	/** Resolves only after the exact observation is durably retained locally.
	 * This is distinct from a registry receipt; export is a separate operation. */
	retain(observation: CompanyComputerScreenObservation, signal: AbortSignal): Promise<void>;
	/** Back pressure may omit heartbeat sampling, never lifecycle transitions. */
	canHeartbeat?(lifetimeId: string): Promise<boolean>;
}

export function parseCompanyComputerScreenObservation(value: unknown): CompanyComputerScreenObservation {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== "binding,event,privacy,schema,startup"
	)
		throw new Error("INVALID_SCREEN_OBSERVATION");
	const input = structuredClone(value) as CompanyComputerScreenObservation;
	if (input.schema !== "qorpera.runtime-screen-observation/v1") throw new Error("INVALID_SCREEN_OBSERVATION");
	const startup = parseCompanyComputerStartupIdentity(input.startup);
	const binding = input.binding;
	if (
		!binding ||
		typeof binding !== "object" ||
		Array.isArray(binding) ||
		Object.keys(binding).sort().join() !==
			"companyComputerId,companyId,computerGeneration,environmentId,logicalComputerId,screenGeneration,screenId,screenOrdinal,staffAgentId"
	)
		throw new Error("INVALID_SCREEN_OBSERVATION");
	assertCompanyComputerScreenBinding(binding, binding);
	assertCompanyComputerScope(binding, startup.scope);
	const privacy = input.privacy === null ? null : parseCompanyComputerPrivacyChallenge(input.privacy, startup.scope);
	if (
		binding.computerGeneration !== startup.computerGeneration ||
		(privacy &&
			(privacy.computerGeneration !== binding.computerGeneration ||
				privacy.screenId !== binding.screenId ||
				!privacy.drains.some((d) => isDeepStrictEqual(d.binding, binding))))
	)
		throw new Error("INVALID_SCREEN_OBSERVATION");
	const event = input.event;
	const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
	if (
		!event ||
		typeof event !== "object" ||
		Array.isArray(event) ||
		Object.keys(event).sort().join() !== "eventId,lifetimeId,observedAt,reason,sequence,state" ||
		typeof event.lifetimeId !== "string" ||
		!uuid.test(event.lifetimeId) ||
		typeof event.eventId !== "string" ||
		!uuid.test(event.eventId) ||
		!Number.isSafeInteger(event.sequence) ||
		event.sequence < 1 ||
		typeof event.observedAt !== "string" ||
		!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(event.observedAt) ||
		!Number.isFinite(Date.parse(event.observedAt)) ||
		new Date(event.observedAt).toISOString() !== event.observedAt ||
		!(
			(event.state === "requested" && event.reason === "SCREEN_REQUESTED") ||
			(event.state === "ready" && ["DESKTOP_READY", "SCREEN_HEARTBEAT"].includes(event.reason)) ||
			(event.state === "closing" &&
				["SCREEN_DRAIN_REQUESTED", "OFFICE_SERVICE_STOPPING", "PRIVACY_FENCE", "AUTHORITY_LOST"].includes(
					event.reason,
				)) ||
			(event.state === "failed" &&
				["DESKTOP_START_FAILED", "DESKTOP_EXITED", "DESKTOP_DRAIN_UNCONFIRMED", "SERVICE_INTERRUPTED"].includes(
					event.reason,
				)) ||
			(event.state === "closed" && event.reason === "DESKTOP_REAPED")
		)
	)
		throw new Error("INVALID_SCREEN_OBSERVATION");
	if (Buffer.byteLength(JSON.stringify(input)) > 73728) throw new Error("INVALID_SCREEN_OBSERVATION");
	return { schema: input.schema, startup, binding, privacy, event };
}

export function assertCompanyComputerScreenEventReceipt(value: unknown, event: CompanyComputerScreenEvent): void {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== "eventId,lifetimeId,observedAt,recordedAt,schema,sequence,state"
	)
		throw new Error("INVALID_SCREEN_RECEIPT");
	const r = value as Record<string, unknown>;
	if (
		r.schema !== "qorpera.runtime-screen-event-receipt/v1" ||
		r.lifetimeId !== event.lifetimeId ||
		r.eventId !== event.eventId ||
		r.sequence !== event.sequence ||
		r.state !== event.state ||
		r.observedAt !== event.observedAt ||
		typeof r.recordedAt !== "string" ||
		!Number.isFinite(Date.parse(r.recordedAt))
	)
		throw new Error("INVALID_SCREEN_RECEIPT");
}

/** One admitted service invocation owns these producers. The cursor advances
 * only after durable local custody or an exact registry receipt. Neither local
 * custody nor delayed export grants authority or infers physical closure. */
export class CompanyComputerScreenLifecyclePublisher implements CompanyComputerScreenLifecycle {
	readonly #startup: Readonly<CompanyComputerStartupIdentity>;
	readonly #registry: CompanyComputerScreenLifecycleRegistry;
	readonly #custody?: CompanyComputerScreenEventCustody;
	constructor(
		startup: CompanyComputerStartupIdentity,
		registry: CompanyComputerScreenLifecycleRegistry,
		custody?: CompanyComputerScreenEventCustody,
	) {
		this.#startup = parseCompanyComputerStartupIdentity(startup);
		this.#registry = registry;
		this.#custody = custody;
	}
	create(
		value: CompanyComputerScreenBinding,
		privacy: CompanyComputerPrivacyChallenge | null,
	): CompanyComputerScreenLifetime {
		const binding = structuredClone(value);
		assertCompanyComputerScreenBinding(binding, binding);
		assertCompanyComputerScope(binding, this.#startup.scope);
		if (binding.computerGeneration !== this.#startup.computerGeneration)
			throw new Error("SCREEN_LIFECYCLE_BINDING_DIFFERS");
		const challenge =
			privacy === null ? null : parseCompanyComputerPrivacyChallenge(structuredClone(privacy), this.#startup.scope);
		if (
			challenge &&
			(challenge.computerGeneration !== binding.computerGeneration ||
				challenge.screenId !== binding.screenId ||
				!challenge.drains.some((d) => isDeepStrictEqual(d.binding, binding)))
		)
			throw new Error("SCREEN_LIFECYCLE_BINDING_DIFFERS");
		return new ScreenLifetime(this.#startup, binding, challenge, this.#registry, this.#custody);
	}
}

class ScreenLifetime implements CompanyComputerScreenLifetime {
	readonly lifetimeId = randomUUID();
	readonly #startup;
	readonly #binding;
	readonly #privacy;
	readonly #registry: CompanyComputerScreenLifecycleRegistry;
	readonly #custody?: CompanyComputerScreenEventCustody;
	readonly #recorded = new Set<State>();
	#sequence = 0;
	#state: State | undefined;
	#lastObservedAt = 0;
	#pending: CompanyComputerScreenEvent | undefined;
	#queue: Promise<void> = Promise.resolve();
	constructor(
		startup: Readonly<CompanyComputerStartupIdentity>,
		binding: CompanyComputerScreenBinding,
		privacy: CompanyComputerPrivacyChallenge | null,
		registry: CompanyComputerScreenLifecycleRegistry,
		custody?: CompanyComputerScreenEventCustody,
	) {
		this.#startup = startup;
		this.#binding = binding;
		this.#privacy = privacy;
		this.#registry = registry;
		this.#custody = custody;
	}
	async #publish(signal: AbortSignal): Promise<void> {
		const event = this.#pending!;
		try {
			signal.throwIfAborted();
			if (this.#custody) {
				await this.#custody.retain(
					parseCompanyComputerScreenObservation({
						schema: "qorpera.runtime-screen-observation/v1",
						startup: this.#startup,
						binding: this.#binding,
						privacy: this.#privacy,
						event,
					}),
					signal,
				);
			} else {
				const response = await cloudToolRequest(
					(checked) =>
						this.#registry.call(
							"qorpera_record_runtime_screen_event",
							structuredClone({
								p_startup: this.#startup,
								p_binding: this.#binding,
								p_privacy: this.#privacy,
								p_event: event,
							}),
							checked,
						),
					signal,
					3000,
				);
				assertCompanyComputerScreenEventReceipt(response, event);
			}
			// A completed local write owns the event even if cancellation raced
			// its fsync. The direct RPC path rejects late responses itself.
			this.#sequence = event.sequence;
			this.#state = event.state;
			this.#lastObservedAt = Date.parse(event.observedAt);
			this.#recorded.add(event.state);
			this.#pending = undefined;
		} catch {
			throw new Error("SCREEN_LIFECYCLE_UNCONFIRMED");
		}
	}
	#emit(state: State, reason: string, signal: AbortSignal, heartbeat = false): Promise<void> {
		const observedAt = new Date().toISOString();
		const work = this.#queue.then(async () => {
			if (this.#pending) await this.#publish(signal);
			if (this.#state === "closed" && ["closing", "closed", "failed"].includes(state)) return;
			if (!heartbeat && this.#recorded.has(state)) return;
			if (!this.#sequence && state !== "requested") {
				if (["closing", "closed", "failed"].includes(state)) return; // No request and therefore no physical launch.
				throw new Error("SCREEN_LIFECYCLE_NOT_REQUESTED");
			}
			if (heartbeat && (this.#state !== "ready" || Date.parse(observedAt) - this.#lastObservedAt < 5000)) return;
			if (heartbeat && this.#custody?.canHeartbeat && !(await this.#custody.canHeartbeat(this.lifetimeId))) return;
			const allowed =
				(state === "requested" && this.#state === undefined) ||
				(state === "ready" && (heartbeat ? this.#state === "ready" : this.#state === "requested")) ||
				(state === "closing" && ["requested", "ready", "failed"].includes(this.#state!)) ||
				(state === "failed" && ["requested", "ready", "closing"].includes(this.#state!)) ||
				(state === "closed" && ["closing", "failed"].includes(this.#state!));
			if (!allowed) throw new Error("SCREEN_LIFECYCLE_TRANSITION_INVALID");
			signal.throwIfAborted();
			if (!Number.isSafeInteger(this.#sequence + 1)) throw new Error("SCREEN_LIFECYCLE_SEQUENCE_EXHAUSTED");
			this.#pending = {
				lifetimeId: this.lifetimeId,
				eventId: randomUUID(),
				sequence: this.#sequence + 1,
				observedAt,
				state,
				reason,
			};
			await this.#publish(signal);
		});
		this.#queue = work.catch(() => undefined);
		return work;
	}
	requested(signal: AbortSignal) {
		return this.#emit("requested", "SCREEN_REQUESTED", signal);
	}
	ready(signal: AbortSignal) {
		return this.#emit("ready", "DESKTOP_READY", signal);
	}
	heartbeat(signal: AbortSignal) {
		return this.#emit("ready", "SCREEN_HEARTBEAT", signal, true);
	}
	closing(reason: ScreenClosingReason, signal: AbortSignal) {
		return this.#emit("closing", reason, signal);
	}
	failed(reason: ScreenFailureReason, signal: AbortSignal) {
		return this.#emit("failed", reason, signal);
	}
	closed(signal: AbortSignal) {
		return this.#emit("closed", "DESKTOP_REAPED", signal);
	}
}
