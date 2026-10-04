import { readBoundedCloudResponse } from "@qorpera/cloud-client/cloud-request";
import {
	type CloudNativeToolBinding,
	type CloudNativeToolIdentity,
	type CloudNativeToolRun,
	cloudToolRequest,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";
import type { CloudNativeTool } from "./cloud-native-tool-boundary.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";

export const CLOUD_WAKE_SCHEMA = "qorpera.wake-envelope/v1";
export const CLOUD_WAKE_POLICY_SCHEMA = "qorpera.wake-policy/v1";
export type CloudWakeKind = "human" | "first-run" | "routine" | "agent" | "room";
export interface CloudWakePolicy {
	readonly schema: typeof CLOUD_WAKE_POLICY_SCHEMA;
	readonly kind: CloudWakeKind | null;
	readonly initial: "required" | "optional" | "forbidden";
	readonly final: "required" | "optional" | "forbidden";
	readonly silenceAllowed: boolean;
	/** 0 when the wake may not speak publicly at all; null means no limit (founder, 2026-09-24). */
	readonly maxPublicSends: 0 | null;
}

export const REQUIRED_CLOUD_WAKE_POLICY: CloudWakePolicy = Object.freeze({
	schema: CLOUD_WAKE_POLICY_SCHEMA,
	kind: null,
	initial: "required",
	final: "required",
	silenceAllowed: false,
	maxPublicSends: null,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid cloud wake");
	const object = value as Record<string, unknown>;
	if (Object.keys(object).length !== keys.length || keys.some((key) => !Object.hasOwn(object, key)))
		throw new Error("Invalid cloud wake");
	return object;
}

/** A closed object whose optional keys may be absent, never extra. */
function closedWithOptional(
	value: unknown,
	required: readonly string[],
	optional: readonly string[],
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid cloud wake");
	const object = value as Record<string, unknown>;
	const keys = Object.keys(object);
	if (
		required.some((key) => !Object.hasOwn(object, key)) ||
		keys.some((key) => !required.includes(key) && !optional.includes(key))
	)
		throw new Error("Invalid cloud wake");
	return object;
}

/** The coding scope the executor admitted the turn with: harness, repository,
 * branch and the same sequence. Other keys (vm, session ref) pass through. */
function codingScope(value: unknown, sequence: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const scope = value as Record<string, unknown>;
	const repository = scope.repository as Record<string, unknown> | null | undefined;
	return (
		(scope.harness === "codex" || scope.harness === "claude-code") &&
		!!repository &&
		typeof repository === "object" &&
		repository.host === "github.com" &&
		typeof repository.owner === "string" &&
		typeof repository.name === "string" &&
		typeof repository.baseBranch === "string" &&
		typeof scope.branch === "string" &&
		/^qorpera\/coding\/[0-9a-f-]{36}$/.test(scope.branch) &&
		scope.sequence === sequence
	);
}

function uuid(value: unknown): string {
	if (typeof value !== "string" || !UUID.test(value)) throw new Error("Invalid cloud wake identity");
	return value;
}

function nullableUuid(value: unknown): string | null {
	return value === null ? null : uuid(value);
}

/** UUID accepts either case, so a check that two ids differ (or none repeats) compares these. */
function uuidKey(value: unknown): string {
	return uuid(value).toLowerCase();
}

/** A validator for cloud-derived immutable policy, never a job/prompt flag resolver. */
export function parseCloudWakePolicy(value: unknown): CloudWakePolicy {
	try {
		const policy = closed(value, ["schema", "kind", "initial", "final", "silenceAllowed", "maxPublicSends"]);
		if (policy.schema !== CLOUD_WAKE_POLICY_SCHEMA) return REQUIRED_CLOUD_WAKE_POLICY;
		let initial: CloudWakePolicy["initial"] = "required";
		let final: CloudWakePolicy["final"] = "required";
		let maxPublicSends: CloudWakePolicy["maxPublicSends"] = null;
		switch (policy.kind) {
			case "human":
			case "first-run":
				break;
			case "routine":
				if (policy.final === "forbidden") {
					initial = "forbidden";
					final = "forbidden";
					maxPublicSends = 0;
				} else {
					initial = "optional";
					final = policy.final === "required" ? "required" : "optional";
				}
				break;
			case "agent":
				// A coworker's message delivered into the agent's own thread (the kernel
				// says pair: initial forbidden, final optional) lets the agent tell its
				// thread something when the member should know; it answers the coworker
				// through the peer channel. A worker completion continues the agent's own
				// work in its conversation (final optional). Neither counts sends. Every
				// other agent wake, a worker included, has no public mouth.
				if (policy.final === "optional" && policy.initial === "forbidden") {
					initial = "forbidden";
					final = "optional";
				} else if (policy.final === "optional") {
					initial = "optional";
					final = "optional";
				} else {
					initial = "forbidden";
					final = "forbidden";
					maxPublicSends = 0;
				}
				break;
			case "room":
				// A team room may stay silent; an agent's shared thread (the kernel
				// says final required) answers every post. Neither counts sends.
				initial = "optional";
				final = policy.final === "required" ? "required" : "optional";
				break;
			default:
				return REQUIRED_CLOUD_WAKE_POLICY;
		}
		if (
			policy.initial !== initial ||
			policy.final !== final ||
			policy.silenceAllowed !== (final !== "required") ||
			policy.maxPublicSends !== maxPublicSends
		)
			return REQUIRED_CLOUD_WAKE_POLICY;
		return Object.freeze({
			schema: CLOUD_WAKE_POLICY_SCHEMA,
			kind: policy.kind,
			initial,
			final,
			silenceAllowed: final !== "required",
			maxPublicSends,
		});
	} catch {
		return REQUIRED_CLOUD_WAKE_POLICY;
	}
}

/**
 * A room wake in the agent's own shared thread (contract 19), from the admitted
 * policy alone: the kernel reports a required final for a room wake only when
 * the room is bound to the woken agent (qorpera_runtime_wake_policy_internal,
 * 20260918000000); a group chat's is optional. Never from model input.
 */
export function cloudWakeIsOwnThread(wake: Pick<CloudWakeEnvelope, "kind" | "policy">): boolean {
	return wake.kind === "room" && wake.policy.kind === "room" && wake.policy.final === "required";
}

export interface CloudWakeEnvelope {
	readonly schema: typeof CLOUD_WAKE_SCHEMA;
	readonly id: string;
	readonly runId: string;
	readonly kind: CloudWakeKind;
	readonly companyId: string;
	readonly environmentId: string;
	readonly staffAgentId: string;
	readonly requesterUserId: string;
	readonly actorStaffId: string | null;
	readonly actorUserId: string | null;
	readonly audience: Readonly<{ kind: "company" | "member_private"; userId: string | null; sessionId: string | null }>;
	readonly source: Readonly<{
		kind:
			| "input"
			| "schedule"
			| "company-file"
			| "coworker"
			| "room"
			| "office-activation"
			| "worker-dispatch"
			| "worker-completion"
			| "machine-event"
			| "event";
		id: string;
		occurrenceKey: string;
	}>;
	readonly policy: CloudWakePolicy;
	readonly time: Readonly<{ utc: string; local: string; timeZone: string }>;
	readonly pins: Readonly<{
		/** Null for a folder-v2 run, which pins no Company File snapshot (folder core C3, P23). */
		companySnapshotId: string | null;
		/** A folder-v2 run's pin instead: the folder clock's last_seq when it was materialized, so it was composed as of
		 * at least that commit (folder core C4, P28). Absent until the database sends it, and then a number: the database
		 * leaves the key out rather than send null. Never beside a snapshot. */
		companySeq?: number;
		staffVersion: number;
		wakeSchema: typeof CLOUD_WAKE_SCHEMA;
		runtimeBundleVersion: null;
	}>;
	/** dynamic: the routine has no cadence; this run decides its next run or concludes it.
	 * routineKey names it, so the run's own routine tool can point at the decision. */
	readonly routine: Readonly<{
		id: string;
		version: number;
		intent: string;
		dynamic?: true;
		routineKey?: string;
	}> | null;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly parentRunId: string | null;
	readonly causal: Readonly<{ rootId: string; agentIds: readonly string[] }>;
}

function freezeJson(value: unknown): void {
	if (!value || typeof value !== "object") return;
	for (const child of Object.values(value)) freezeJson(child);
	Object.freeze(value);
}

/** Called only on qorpera_read_native_wake output, after its current path/audience checks. */
export function parseCloudWakeEnvelope(value: unknown, identity: CloudNativeToolIdentity): CloudWakeEnvelope {
	const serialized = JSON.stringify(value);
	if (!serialized || Buffer.byteLength(serialized) > 96 * 1024) throw new Error("Cloud wake exceeds its bound");
	const wake = closed(JSON.parse(serialized), [
		"schema",
		"id",
		"runId",
		"kind",
		"companyId",
		"environmentId",
		"staffAgentId",
		"requesterUserId",
		"actorStaffId",
		"actorUserId",
		"audience",
		"source",
		"policy",
		"time",
		"pins",
		"routine",
		"payload",
		"parentRunId",
		"causal",
	]);
	// The component-era envelope omits userId for a company audience; a
	// member-private audience always carries its member.
	const audienceValue =
		wake.audience &&
		typeof wake.audience === "object" &&
		!Array.isArray(wake.audience) &&
		!("userId" in wake.audience)
			? { ...(wake.audience as Record<string, unknown>), userId: null }
			: wake.audience;
	const audience = closed(audienceValue, ["kind", "userId", "sessionId"]);
	const source = closed(wake.source, ["kind", "id", "occurrenceKey"]);
	const time = closed(wake.time, ["utc", "local", "timeZone"]);
	const pins = closedWithOptional(
		wake.pins,
		["companySnapshotId", "staffVersion", "wakeSchema", "runtimeBundleVersion"],
		["companySeq"],
	);
	const causal = closed(wake.causal, ["rootId", "agentIds"]);
	const policy = parseCloudWakePolicy(wake.policy);
	if (
		wake.schema !== CLOUD_WAKE_SCHEMA ||
		policy.kind === null ||
		policy.kind !== wake.kind ||
		(["runId", "companyId", "environmentId", "staffAgentId", "requesterUserId"] as const).some(
			(key) => uuid(wake[key]) !== identity[key],
		) ||
		audience.kind !== identity.audienceKind ||
		nullableUuid(audience.userId) !== identity.audienceUserId ||
		nullableUuid(audience.sessionId) !== identity.sessionId ||
		pins.staffVersion !== identity.staffVersion ||
		pins.wakeSchema !== CLOUD_WAKE_SCHEMA ||
		pins.runtimeBundleVersion !== null ||
		(pins.companySeq !== undefined &&
			(!Number.isSafeInteger(pins.companySeq) ||
				(pins.companySeq as number) < 0 ||
				pins.companySnapshotId !== null)) ||
		typeof source.occurrenceKey !== "string" ||
		!source.occurrenceKey ||
		Buffer.byteLength(source.occurrenceKey) > 256 ||
		typeof time.utc !== "string" ||
		!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(time.utc) ||
		!Number.isFinite(Date.parse(time.utc)) ||
		typeof time.local !== "string" ||
		!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}$/.test(time.local) ||
		typeof time.timeZone !== "string" ||
		!time.timeZone ||
		time.timeZone.length > 128 ||
		!Array.isArray(causal.agentIds) ||
		causal.agentIds.length < 1 ||
		new Set(causal.agentIds.map(uuidKey)).size !== causal.agentIds.length ||
		causal.agentIds.at(-1) !== identity.staffAgentId
	)
		throw new Error("Cloud wake does not match its admitted run");
	const id = uuid(wake.id);
	const actorStaffId = nullableUuid(wake.actorStaffId);
	const actorUserId = nullableUuid(wake.actorUserId);
	const parentRunId = nullableUuid(wake.parentRunId);
	uuid(source.id);
	nullableUuid(pins.companySnapshotId);
	uuid(causal.rootId);
	// Messages coworkers left for this agent with priority false since it last
	// ran ride on any wake as data; the per-kind payload rules see the rest.
	const { heldMessages, ...payloadBody } = (
		wake.payload && typeof wake.payload === "object" && !Array.isArray(wake.payload) ? wake.payload : {}
	) as Record<string, unknown>;
	if (heldMessages !== undefined) {
		if (!Array.isArray(heldMessages) || heldMessages.length < 1 || heldMessages.length > 12)
			throw new Error("Invalid held coworker messages");
		for (const item of heldMessages) {
			const line = closed(item, ["eventId", "staffAgentId", "text", "at", "pairSessionId"]);
			if (
				typeof line.text !== "string" ||
				!line.text.trim() ||
				Buffer.byteLength(line.text) > 4096 ||
				typeof line.at !== "string" ||
				!Number.isFinite(Date.parse(line.at)) ||
				uuidKey(line.staffAgentId) === uuidKey(identity.staffAgentId)
			)
				throw new Error("Invalid held coworker messages");
			uuid(line.eventId);
			uuid(line.pairSessionId);
		}
	}
	let routine: CloudWakeEnvelope["routine"] = null;
	if (wake.kind === "routine") {
		const stored = closedWithOptional(wake.routine, ["id", "version", "intent"], ["dynamic", "routineKey"]);
		if (
			(Object.hasOwn(stored, "dynamic") && stored.dynamic !== true) ||
			Object.hasOwn(stored, "routineKey") !== (stored.dynamic === true) ||
			(Object.hasOwn(stored, "routineKey") &&
				(typeof stored.routineKey !== "string" || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(stored.routineKey))) ||
			!Number.isSafeInteger(stored.version) ||
			(stored.version as number) < 1 ||
			typeof stored.intent !== "string" ||
			!stored.intent.trim() ||
			Buffer.byteLength(stored.intent) > 32768
		)
			throw new Error("Invalid stored routine");
		routine = Object.freeze({
			id: uuid(stored.id),
			version: stored.version as number,
			intent: stored.intent,
			...(stored.dynamic === true ? { dynamic: true as const, routineKey: stored.routineKey as string } : {}),
		});
		if (source.kind === "schedule") {
			if (source.id !== routine.id || parentRunId !== null || actorStaffId !== null)
				throw new Error("Invalid schedule identity");
		} else if (source.kind === "company-file") {
			const event = closed(payloadBody, [
				"eventId",
				"path",
				"previousVersion",
				"version",
				"operation",
				"receiptId",
				"proposalId",
			]);
			if (
				uuid(event.eventId) !== source.id ||
				typeof event.path !== "string" ||
				!event.path ||
				Buffer.byteLength(event.path) > 4096 ||
				(event.operation !== "upsert" && event.operation !== "delete")
			)
				throw new Error("Invalid file wake metadata");
			uuid(event.version);
			nullableUuid(event.previousVersion);
			nullableUuid(event.receiptId);
			nullableUuid(event.proposalId);
		} else if (source.kind === "event") {
			// Events from one of the company's hooks (W2): outside content, at most 20 a wake.
			const batch = closed(payloadBody, ["hookId", "firstDeliveryId", "hook", "events", "more"]);
			const hook = closed(batch.hook, ["id", "name", "purpose"]);
			if (
				uuidKey(batch.hookId) !== uuidKey(source.id) ||
				uuidKey(hook.id) !== uuidKey(source.id) ||
				typeof hook.name !== "string" ||
				!/^[a-z][a-z0-9-]{0,63}$/.test(hook.name) ||
				typeof hook.purpose !== "string" ||
				Buffer.byteLength(hook.purpose) > 2048 ||
				!Array.isArray(batch.events) ||
				batch.events.length > 20 ||
				!Number.isSafeInteger(batch.more) ||
				(batch.more as number) < 0 ||
				parentRunId !== null ||
				actorStaffId !== null
			)
				throw new Error("Invalid event wake");
			uuid(batch.firstDeliveryId);
			const seen = new Set<string>();
			for (const item of batch.events) {
				const event = closedWithOptional(
					item,
					["deliveryId", "type", "receivedAt", "contentType", "bytes"],
					["encoding", "text", "data", "truncated", "bodyCleared"],
				);
				const id = uuidKey(event.deliveryId);
				const body = event.encoding === "utf8" ? event.text : event.encoding === "base64" ? event.data : undefined;
				if (
					seen.has(id) ||
					(event.type !== null && (typeof event.type !== "string" || !/^[\x21-\x7e]{1,128}$/.test(event.type))) ||
					typeof event.receivedAt !== "string" ||
					!Number.isFinite(Date.parse(event.receivedAt)) ||
					(event.contentType !== null &&
						(typeof event.contentType !== "string" || event.contentType.length > 256)) ||
					!Number.isSafeInteger(event.bytes) ||
					(event.bytes as number) < 0 ||
					(event.encoding !== undefined && event.encoding !== "utf8" && event.encoding !== "base64") ||
					// The payload's own bound (below) bounds each body.
					(event.encoding !== undefined && (typeof body !== "string" || typeof event.truncated !== "boolean")) ||
					(event.encoding === "utf8" && event.data !== undefined) ||
					(event.encoding === "base64" && event.text !== undefined) ||
					(event.encoding === undefined && (event.text !== undefined || event.data !== undefined)) ||
					(event.truncated !== undefined && typeof event.truncated !== "boolean") ||
					(event.bodyCleared !== undefined && (event.bodyCleared !== true || event.encoding !== undefined))
				)
					throw new Error("Invalid event wake");
				seen.add(id);
			}
		} else throw new Error("Invalid routine source");
	} else if (wake.kind === "room") {
		const post = closed(payloadBody, ["roomId", "inputIds", "recipientStaffId"]);
		if (
			source.kind !== "room" ||
			!Array.isArray(post.inputIds) ||
			post.inputIds.length !== 1 ||
			uuid(post.inputIds[0]) !== source.id ||
			uuid(post.recipientStaffId) !== identity.staffAgentId ||
			parentRunId !== null ||
			actorStaffId !== null ||
			actorUserId === null ||
			wake.routine !== null ||
			audience.sessionId === null
		)
			throw new Error("Invalid room wake");
		uuid(post.roomId);
	} else if (wake.kind === "agent" && source.kind === "office-activation") {
		const activation = closed(payloadBody, [
			"schema",
			"intentId",
			"activationId",
			"companyComputerId",
			"computerGeneration",
			"receiptId",
		]);
		if (
			activation.schema !== "qorpera.office-start-continuation/v1" ||
			policy.final !== "forbidden" ||
			parentRunId === null ||
			uuidKey(parentRunId) === uuidKey(identity.runId) ||
			actorStaffId !== null ||
			actorUserId !== null ||
			audience.kind !== "company" ||
			audience.userId !== null ||
			audience.sessionId !== null ||
			wake.routine !== null ||
			!Number.isSafeInteger(activation.computerGeneration) ||
			(activation.computerGeneration as number) < 1 ||
			source.occurrenceKey !== `office-activation:${uuid(activation.intentId)}:${parentRunId}`
		)
			throw new Error("Invalid office activation wake");
		uuid(activation.activationId);
		uuid(activation.companyComputerId);
		uuid(activation.receiptId);
	} else if (wake.kind === "agent" && source.kind === "worker-dispatch") {
		// Contract 13: a blank child with a complete dispatch, no conversation and no sender.
		// A coding session (13.1) carries its scope under "coding"; an in-house child never does.
		const coding = (payloadBody as { species?: unknown } | null)?.species === "coding";
		const work = closed(payloadBody, [
			"schema",
			"workerId",
			"workerKey",
			"sequence",
			"species",
			"title",
			"todo",
			"parentRunId",
			"access",
			"outputFolder",
			"dispatch",
			...(coding ? ["coding"] : []),
		]);
		const dispatch = closed(work.dispatch, [
			"goal",
			"definitionOfDone",
			"context",
			"sources",
			"followUp",
			"authority",
			"output",
			"cancellation",
			"completion",
		]);
		closed(work.todo, ["todoKey", "title", "path"]);
		if (
			work.schema !== "qorpera.worker-dispatch/v1" ||
			uuid(work.workerId) !== source.id ||
			(work.species !== "in-house" && work.species !== "coding") ||
			(work.access !== "read" && work.access !== "write") ||
			(coding && (work.access !== "read" || !codingScope(work.coding, work.sequence))) ||
			!Number.isSafeInteger(work.sequence) ||
			(work.sequence as number) < 1 ||
			source.occurrenceKey !== `worker-dispatch:${source.id}:${work.sequence}` ||
			parentRunId === null ||
			uuidKey(parentRunId) === uuidKey(identity.runId) ||
			uuid(work.parentRunId) !== parentRunId ||
			actorStaffId !== null ||
			actorUserId !== null ||
			audience.kind !== "company" ||
			audience.sessionId !== null ||
			wake.routine !== null ||
			policy.final !== "forbidden" ||
			[dispatch.goal, dispatch.definitionOfDone, dispatch.authority, dispatch.output].some(
				(part) => typeof part !== "string" || !part.trim(),
			) ||
			!Array.isArray(dispatch.sources) ||
			dispatch.sources.some((path) => typeof path !== "string" || !path) ||
			(dispatch.followUp !== null && typeof dispatch.followUp !== "string") ||
			(work.sequence as number) > 1 !== (dispatch.followUp !== null)
		)
			throw new Error("Invalid worker dispatch wake");
	} else if (wake.kind === "agent" && source.kind === "worker-completion") {
		// A typed internal continuation of the agent's own run; never a human or coworker message.
		const done = closed(payloadBody, ["schema", "parentRunId", "completions", "stillActive"]);
		if (
			done.schema !== "qorpera.worker-completion/v1" ||
			parentRunId === null ||
			uuidKey(parentRunId) === uuidKey(identity.runId) ||
			uuid(done.parentRunId) !== parentRunId ||
			actorStaffId !== null ||
			actorUserId !== null ||
			audience.kind !== "company" ||
			wake.routine !== null ||
			// Without a conversation there is no mouth; a silent parent's revival stays silent even with one.
			(audience.sessionId === null && policy.final !== "forbidden") ||
			!Number.isSafeInteger(done.stillActive) ||
			(done.stillActive as number) < 0 ||
			!Array.isArray(done.completions) ||
			done.completions.length < 1 ||
			done.completions.length > 4
		)
			throw new Error("Invalid worker completion wake");
		for (const item of done.completions) {
			const completion = closed(item, [
				"workerKey",
				"todoKey",
				"title",
				"sequence",
				"outcome",
				"summary",
				"summaryTruncated",
				"needs",
				"outputs",
			]);
			if (
				!["succeeded", "blocked", "failed"].includes(completion.outcome as string) ||
				typeof completion.summary !== "string" ||
				!Array.isArray(completion.outputs)
			)
				throw new Error("Invalid worker completion wake");
		}
	} else if (wake.kind === "agent" && source.kind === "machine-event") {
		// A typed internal continuation of the agent's own run: a machine it asked
		// for is running, or a command it started with notify ended.
		const events = closed(payloadBody, ["schema", "parentRunId", "events", "stillWaiting"]);
		if (
			events.schema !== "qorpera.machine-event/v1" ||
			parentRunId === null ||
			uuidKey(parentRunId) === uuidKey(identity.runId) ||
			uuid(events.parentRunId) !== parentRunId ||
			actorStaffId !== null ||
			actorUserId !== null ||
			audience.kind !== "company" ||
			wake.routine !== null ||
			(audience.sessionId === null && policy.final !== "forbidden") ||
			!Number.isSafeInteger(events.stillWaiting) ||
			(events.stillWaiting as number) < 0 ||
			!Array.isArray(events.events) ||
			events.events.length < 1 ||
			events.events.length > 8
		)
			throw new Error("Invalid machine event wake");
		for (const item of events.events) {
			const event = closed(item, [
				"machine",
				"machineId",
				"kind",
				"at",
				"machineState",
				"command",
				"commandId",
				"commandState",
				"exitCode",
				"outputTail",
			]);
			if (
				typeof event.machine !== "string" ||
				(event.kind !== "running" && event.kind !== "stopped" && event.kind !== "command") ||
				(event.kind === "command" && (typeof event.command !== "string" || uuid(event.commandId) === null)) ||
				(event.outputTail !== null && typeof event.outputTail !== "string")
			)
				throw new Error("Invalid machine event wake");
			uuid(event.machineId);
		}
	} else if (wake.kind === "agent") {
		// A coworker message. Delivered into the agent's own shared thread (the
		// session is the agent's thread and the policy is the pair policy) since
		// runtime bundle v70; an occurrence admitted before that has no session and
		// no mouth. The kernel decides which; the two shapes never mix.
		const message = closedWithOptional(
			payloadBody,
			["text", "senderStaffId", "receiptId"],
			["pairSessionId", "pairEventId", "transcript"],
		);
		if (
			source.kind !== "coworker" ||
			source.id !== id ||
			parentRunId === null ||
			actorStaffId === null ||
			uuid(message.senderStaffId) !== actorStaffId ||
			typeof message.text !== "string" ||
			!message.text.trim() ||
			Buffer.byteLength(message.text) > 4096 ||
			wake.routine !== null ||
			(audience.sessionId === null) !== (policy.final === "forbidden") ||
			(audience.sessionId !== null && policy.initial !== "forbidden") ||
			(audience.sessionId === null) !== (message.pairSessionId === undefined) ||
			(message.pairEventId === undefined) !== (message.pairSessionId === undefined)
		)
			throw new Error("Invalid coworker wake");
		uuid(message.receiptId);
		if (message.pairSessionId !== undefined) uuid(message.pairSessionId);
		if (message.pairEventId !== undefined) uuid(message.pairEventId);
		if (message.transcript !== undefined) {
			if (!Array.isArray(message.transcript) || message.transcript.length > 24)
				throw new Error("Invalid coworker transcript");
			for (const item of message.transcript) {
				const line = closed(item, ["eventId", "staffAgentId", "text", "at"]);
				if (
					typeof line.text !== "string" ||
					Buffer.byteLength(line.text) > 4096 ||
					typeof line.at !== "string" ||
					!Number.isFinite(Date.parse(line.at))
				)
					throw new Error("Invalid coworker transcript");
				uuid(line.eventId);
				uuid(line.staffAgentId);
			}
		}
	} else {
		const input = closed(payloadBody, ["inputIds"]);
		if (
			source.kind !== "input" ||
			!Array.isArray(input.inputIds) ||
			input.inputIds.length < 1 ||
			input.inputIds.length > 32 ||
			new Set(input.inputIds.map(uuidKey)).size !== input.inputIds.length ||
			!input.inputIds.includes(source.id) ||
			(wake.kind === "first-run" && input.inputIds.length !== 1) ||
			parentRunId !== null ||
			actorStaffId !== null ||
			wake.routine !== null ||
			audience.sessionId === null
		)
			throw new Error("Invalid input wake");
	}
	if (
		!wake.payload ||
		typeof wake.payload !== "object" ||
		Array.isArray(wake.payload) ||
		// The kernel bounds the whole envelope at 49152 bytes; the payload may carry
		// a pair transcript and held coworker messages (twelve lines of 400 characters each).
		Buffer.byteLength(JSON.stringify(wake.payload)) > 49152
	)
		throw new Error("Invalid wake payload");
	const result = {
		...wake,
		id,
		actorStaffId,
		actorUserId,
		parentRunId,
		policy,
		routine,
	} as unknown as CloudWakeEnvelope;
	freezeJson(result);
	return result;
}

export interface CloudCoworkerMessage {
	readonly recipientStaffId: string;
	readonly operationKey: string;
	readonly text: string;
	/** false: written and shown, but delivered at the coworker's next wake instead of waking it. */
	readonly priority: boolean;
}

function parseCoworkerMessage(value: unknown): CloudCoworkerMessage {
	const message = closedWithOptional(value, ["recipientStaffId", "operationKey", "text"], ["priority"]);
	const recipientStaffId = uuid(message.recipientStaffId).toLowerCase();
	if (
		typeof message.operationKey !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(message.operationKey) ||
		typeof message.text !== "string" ||
		!message.text.trim() ||
		message.text.includes("\0") ||
		Buffer.byteLength(message.text) > 4096 ||
		(message.priority !== undefined && typeof message.priority !== "boolean")
	)
		throw new Error("Invalid coworker message");
	return Object.freeze({
		recipientStaffId,
		operationKey: message.operationKey,
		text: message.text,
		priority: message.priority !== false,
	});
}

export interface CloudCoworkerReceipt {
	readonly schema: "qorpera.coworker-send/v1";
	readonly runId: string;
	readonly receiptId: string;
	readonly occurrenceId: string | null;
	readonly recipientStaffId: string;
	readonly status: "queued" | "held" | "causal-fence";
}

export type CloudWakeRpc =
	| "qorpera_read_native_wake"
	| "qorpera_send_coworker_message"
	| "qorpera_runtime_wake_policy"
	| "qorpera_assert_wake_work_allowed"
	| "qorpera_assert_wake_completion"
	| "qorpera_assert_company_path_reads";
export interface CloudWakeControl {
	call(method: CloudWakeRpc, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

async function callCoworkerMessage(
	binding: CloudNativeToolBinding,
	control: CloudWakeControl,
	message: CloudCoworkerMessage,
	signal: AbortSignal,
): Promise<CloudCoworkerReceipt> {
	const value = await cloudToolRequest(
		(requestSignal) =>
			control.call(
				"qorpera_send_coworker_message",
				{
					p_binding: binding,
					p_recipient_staff_id: message.recipientStaffId,
					p_operation_key: message.operationKey,
					p_text: message.text,
					...(message.priority ? {} : { p_priority: false }),
				},
				requestSignal,
			),
		signal,
	);
	const receipt = closed(value, ["schema", "runId", "receiptId", "occurrenceId", "recipientStaffId", "status"]);
	if (
		receipt.schema !== "qorpera.coworker-send/v1" ||
		receipt.runId !== binding.runId ||
		receipt.recipientStaffId !== message.recipientStaffId ||
		(receipt.status !== "queued" && receipt.status !== "held" && receipt.status !== "causal-fence") ||
		(receipt.status === "queued") !== (nullableUuid(receipt.occurrenceId) !== null)
	)
		throw new Error("Invalid coworker delivery receipt");
	uuid(receipt.receiptId);
	return Object.freeze({ ...receipt }) as unknown as CloudCoworkerReceipt;
}

function makeCoworkerTool(
	expectedIdentity: CloudNativeToolIdentity,
	send: (message: CloudCoworkerMessage, signal: AbortSignal) => Promise<CloudCoworkerReceipt>,
): CloudNativeTool {
	return {
		name: "send_coworker_message" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description:
			"qorpera.coworker-message/v1: send a message to one coworker. It is written into the company's transcript of " +
			"you and that coworker, which members can open from both of your threads, and it wakes the coworker in its own " +
			"thread; the coworker may answer you the same way, and that answer wakes you. Say what you need and what you " +
			"already know, in a few sentences. Do not thank, confirm receipt or acknowledge an acknowledgement; if there is " +
			"nothing to add, send nothing. The cloud rechecks the live run, recipient, shared-path audience, sponsor and reply " +
			"obligations; message text cannot grant permission. Use one stable operationKey per logical message and reuse it " +
			"only with identical content. Do not create a new key after an unconfirmed result or cancellation; the message may " +
			"already have committed and requires receipt reconciliation. Text must be nonblank and at most 4096 UTF-8 bytes. " +
			"priority false (for status, an FYI or anything that needs no answer now) writes the message the same way but " +
			"does not wake the coworker: it reads it at its next turn, whatever causes that turn; a held receipt confirms " +
			"that. A queued receipt confirms durable delivery, not completed work. A causal-fence receipt means no wake " +
			"was created for this message: say what is still needed in your own thread, or stop. There is " +
			"no room, private-member or cross-company destination. The result is data under the existing tool-result fence.",
		inputSchema: {
			type: "object",
			properties: {
				recipientStaffId: { type: "string", format: "uuid" },
				operationKey: {
					type: "string",
					minLength: 1,
					maxLength: 96,
					pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$",
				},
				text: { type: "string", minLength: 1, maxLength: 4096 },
				priority: { type: "boolean" },
			},
			required: ["recipientStaffId", "operationKey", "text"],
			additionalProperties: false,
		},
		parseArguments(value) {
			return { ...parseCoworkerMessage(value) };
		},
		execute: async (value, context) => {
			const identity = context.identity;
			if (
				context.companyId !== expectedIdentity.companyId ||
				context.runId !== expectedIdentity.runId ||
				!identity ||
				Object.entries(expectedIdentity).some(
					([key, expected]) => identity[key as keyof CloudNativeToolIdentity] !== expected,
				)
			)
				throw new Error("Coworker tool does not match its native run");
			const receipt = await send(parseCoworkerMessage(value), context.signal);
			return { kind: "json", value: { ...receipt } };
		},
	};
}

/**
 * Fits the existing native session's tools(identity, operations) callback.
 * The host closes over its binding and registers this only in that session's
 * boundary, which rechecks run/context authority before and after dispatch.
 * The RPC independently checks live effect authority; identity is not a grant.
 */
export function cloudCoworkerMessageTool(
	binding: CloudNativeToolBinding,
	identity: CloudNativeToolIdentity,
	control: CloudWakeControl,
): CloudNativeTool {
	const admittedBinding = parseCloudNativeToolBinding(binding);
	const admittedIdentity = Object.freeze({ ...identity });
	if (
		(
			[
				"leaseId",
				"runId",
				"jobId",
				"runnerId",
				"assignmentId",
				"computeIdentityId",
				"provider",
				"nativeHarness",
				"model",
			] as const
		).some((key) => admittedBinding[key] !== admittedIdentity[key])
	)
		throw new Error("Coworker tool binding does not match its native run");
	return makeCoworkerTool(admittedIdentity, (message, signal) =>
		callCoworkerMessage(admittedBinding, control, message, signal),
	);
}

/** Lives in the cloud host. Neither bindings nor requester/audience selectors are model input. */
export class CloudNativeWakeBus {
	readonly #run: CloudNativeToolRun;
	readonly #control: CloudWakeControl;
	constructor(run: CloudNativeToolRun, control: CloudWakeControl) {
		this.#run = run;
		this.#control = control;
	}
	async read(signal: AbortSignal): Promise<CloudWakeEnvelope> {
		await this.#run.assertActive(signal);
		const value = await cloudToolRequest(
			(requestSignal) =>
				this.#control.call("qorpera_read_native_wake", { p_binding: this.#run.binding }, requestSignal),
			AbortSignal.any([signal, this.#run.signal]),
		);
		await this.#run.assertActive(signal);
		// The SQL reader registered inherited/event paths in the existing run
		// read set. Recheck it after I/O before releasing any context bytes.
		await cloudToolRequest(
			(requestSignal) =>
				this.#control.call(
					"qorpera_assert_company_path_reads",
					{
						p_environment_id: this.#run.identity.environmentId,
						p_binding: this.#run.binding,
						p_paths: [],
					},
					requestSignal,
				),
			AbortSignal.any([signal, this.#run.signal]),
		);
		return parseCloudWakeEnvelope(value, this.#run.identity);
	}
	async sendCoworker(value: CloudCoworkerMessage, signal: AbortSignal): Promise<CloudCoworkerReceipt> {
		const message = parseCoworkerMessage(value);
		await this.#run.assertActive(signal);
		const receipt = await callCoworkerMessage(
			this.#run.binding,
			this.#control,
			message,
			AbortSignal.any([signal, this.#run.signal]),
		);
		await this.#run.assertActive(signal);
		return receipt;
	}

	/** Register with the existing native boundary; no host, transport or queue is created here. */
	coworkerTool(): CloudNativeTool {
		return makeCoworkerTool(this.#run.identity, (message, signal) => this.sendCoworker(message, signal));
	}
}

/** Finite service-only RPC transport; no local fallback, automatic replay or extra queue. */
export class HttpCloudWakeControl implements CloudWakeControl {
	readonly #origin: string;
	readonly #serviceKey: string;
	readonly #fetch: typeof fetch;
	constructor(options: { supabaseUrl: string; serviceRoleKey: string; fetch?: typeof fetch }) {
		const url = new URL(options.supabaseUrl);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== "/" ||
			!options.serviceRoleKey ||
			/[\r\n\0]/.test(options.serviceRoleKey)
		)
			throw new Error("Invalid wake control configuration");
		this.#origin = url.origin;
		this.#serviceKey = options.serviceRoleKey;
		this.#fetch = options.fetch ?? fetch;
	}
	call(method: CloudWakeRpc, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		if (
			![
				"qorpera_read_native_wake",
				"qorpera_send_coworker_message",
				"qorpera_runtime_wake_policy",
				"qorpera_assert_wake_work_allowed",
				"qorpera_assert_wake_completion",
				"qorpera_assert_company_path_reads",
			].includes(method)
		)
			throw new Error("Unknown wake operation");
		const body = JSON.stringify(args);
		if (Buffer.byteLength(body) > 16384) throw new Error("Wake request exceeds its bound");
		return cloudToolRequest(async (requestSignal) => {
			const headers: Record<string, string> = { apikey: this.#serviceKey, "content-type": "application/json" };
			if (this.#serviceKey.startsWith("eyJ") && this.#serviceKey.split(".").length === 3)
				headers.authorization = `Bearer ${this.#serviceKey}`;
			const response = await this.#fetch(`${this.#origin}/rest/v1/rpc/${method}`, {
				method: "POST",
				redirect: "error",
				headers,
				body,
				signal: requestSignal,
			});
			const bytes = await readBoundedCloudResponse(response, response.ok ? 96 * 1024 : 4096, requestSignal);
			if (!response.ok) throw new Error("Wake authority unavailable");
			try {
				return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
			} catch {
				throw new Error("Invalid wake control response");
			}
		}, signal);
	}
}
