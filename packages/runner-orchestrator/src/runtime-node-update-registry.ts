import { officeCanonical, officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import {
	NODE_UPDATE_PHASES,
	type NodeUpdateDrain,
	type NodeUpdateEnrollment,
	type NodeUpdateIntent,
	type NodeUpdateReceipt,
	parseNodeUpdateObservation,
	parseNodeUpdateReceipt,
	parseNodeUpdateRelease,
	verifyNodeUpdateRelease,
} from "./runtime-node-update.ts";

export interface NodeUpdateRegistryConfig {
	/** Root-owned project origin, never supplied by the signed target or backend response. */
	origin: string;
	/** Publishable project key, or a legacy JWT whose role is exactly anon. */
	publicApiKey: string;
	capability: string;
	capabilityRevision: number;
	enrollment: Readonly<NodeUpdateEnrollment>;
}
const version = (value: unknown): number => {
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) >= Number.MAX_SAFE_INTEGER)
		throw new Error("NODE_UPDATE_REGISTRY_VERSION_INVALID");
	return value as number;
};
function parseDrain(value: unknown): NodeUpdateDrain | null {
	if (value === null) return null;
	const d = officeRecord(value, [
		"policySha256",
		"disabledPolicySha256",
		"previousVersion",
		"disabledVersion",
		"previousEnabled",
	]);
	if (typeof d.previousEnabled !== "boolean") throw new Error("NODE_UPDATE_REGISTRY_DRAIN_INVALID");
	const drain = {
		policySha256: officeSha(d.policySha256),
		disabledPolicySha256: officeSha(d.disabledPolicySha256),
		previousVersion: version(d.previousVersion),
		disabledVersion: version(d.disabledVersion),
		previousEnabled: d.previousEnabled,
	};
	if (drain.disabledVersion !== drain.previousVersion + 1) throw new Error("NODE_UPDATE_REGISTRY_DRAIN_INVALID");
	return drain;
}

/** A bounded transport for the node-scoped SQL authority. It has no operator RPC,
 * generic RPC escape hatch, artifact URL, shell command or service-role key.
 * Every invocation makes one request; journal owners reconcile uncertain writes
 * through read(), never by implicitly repeating a physical effect. */
export class RuntimeNodeUpdateRegistry {
	readonly #config: Readonly<NodeUpdateRegistryConfig>;
	readonly #headers: Readonly<Record<string, string>>;
	readonly #fetch: typeof fetch;
	#pending = false;
	constructor(config: NodeUpdateRegistryConfig, transport: typeof fetch = fetch) {
		const url = new URL(config.origin);
		if (url.protocol !== "https:" || url.username || url.password || url.origin !== config.origin)
			throw new Error("NODE_UPDATE_REGISTRY_ORIGIN_INVALID");
		officeSha(config.capability);
		version(config.capabilityRevision);
		const headers: Record<string, string> = { apikey: config.publicApiKey, "content-type": "application/json" };
		if (!/^sb_publishable_[A-Za-z0-9_-]{16,256}$/.test(config.publicApiKey)) {
			try {
				const parts = config.publicApiKey.split(".");
				if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
				const claims: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
				if (typeof claims !== "object" || claims === null || !("role" in claims) || claims.role !== "anon")
					throw new Error();
				headers.authorization = `Bearer ${config.publicApiKey}`;
			} catch {
				throw new Error("NODE_UPDATE_PUBLIC_PROJECT_KEY_REQUIRED");
			}
		}
		this.#config = Object.freeze({ ...config, enrollment: Object.freeze({ ...config.enrollment }) });
		this.#headers = Object.freeze(headers);
		this.#fetch = transport;
	}
	async desired(signal: AbortSignal) {
		const value = await this.#request("desired", {}, signal);
		if (value !== null) {
			const state = officeRecord(value, [
					"schema",
					"envelope",
					"observation",
					"drain",
					"resumedVersion",
					"intents",
					"receipts",
				]),
				envelope = officeRecord(state.envelope, ["release", "signature"]),
				release = parseNodeUpdateRelease(envelope.release);
			// SQL retains its most recent completed target. Ignore only the exact
			// release already vouched for by the caller's local completion chain;
			// never derive a new predecessor from remote enrollment or observations.
			if (
				state.resumedVersion !== null &&
				officeDigest(release) === this.#config.enrollment.previousReleaseSha256 &&
				release.revision === this.#config.enrollment.previousRevision &&
				release.artifact.sha256 === this.#config.enrollment.previousArtifactSha256
			)
				return null;
		}
		return value === null ? null : this.#state(value);
	}
	async read(releaseSha256: string, signal: AbortSignal) {
		const state = this.#state(await this.#request("read", { p_release_sha256: officeSha(releaseSha256) }, signal));
		if (officeDigest(state.envelope.release) !== releaseSha256)
			throw new Error("NODE_UPDATE_REGISTRY_TARGET_DIFFERS");
		return state;
	}
	async prepare(intent: NodeUpdateIntent, signal: AbortSignal): Promise<void> {
		const result = officeRecord(
			await this.#request(
				"prepare",
				{ p_release_sha256: officeSha(intent.releaseSha256), p_intent_text: officeCanonical(intent) },
				signal,
			),
			["phase", "intentSha256"],
		);
		if (result.phase !== intent.phase || result.intentSha256 !== officeDigest(intent))
			throw new Error("NODE_UPDATE_REGISTRY_INTENT_DIFFERS");
	}
	async drain(intent: NodeUpdateIntent, signal: AbortSignal): Promise<NodeUpdateDrain> {
		if (intent.phase !== "drain") throw new Error("NODE_UPDATE_REGISTRY_PHASE_INVALID");
		const value = parseDrain(
			await this.#request(
				"drain",
				{
					p_release_sha256: officeSha(intent.releaseSha256),
					p_expected_version: version(intent.observation.policyVersion),
					p_expected_policy_sha256: officeSha(intent.observation.policySha256),
				},
				signal,
			),
		);
		if (
			!value ||
			value.previousVersion !== intent.observation.policyVersion ||
			value.policySha256 !== intent.observation.policySha256 ||
			value.previousEnabled !== intent.observation.enabled
		)
			throw new Error("NODE_UPDATE_REGISTRY_DRAIN_DIFFERS");
		return value;
	}
	async check(intent: NodeUpdateIntent, drain: NodeUpdateDrain, signal: AbortSignal) {
		const releaseSha256 = intent.releaseSha256;
		const result = officeRecord(
			await this.#request(
				"check",
				{ p_release_sha256: officeSha(releaseSha256), p_intent_sha256: officeDigest(intent) },
				signal,
			),
			["nodeId", "releaseSha256", "disabledVersion", "drainAuthorizationSha256"],
		);
		if (
			result.nodeId !== this.#config.enrollment.nodeId ||
			result.releaseSha256 !== releaseSha256 ||
			result.disabledVersion !== drain.disabledVersion
		)
			throw new Error("NODE_UPDATE_REGISTRY_HOLD_DIFFERS");
		return {
			nodeId: this.#config.enrollment.nodeId,
			releaseSha256,
			disabledVersion: drain.disabledVersion,
			drainAuthorizationSha256: officeSha(result.drainAuthorizationSha256),
		};
	}
	async record(intent: NodeUpdateIntent, receipt: NodeUpdateReceipt, signal: AbortSignal): Promise<void> {
		if (receipt.intentSha256 !== officeDigest(intent)) throw new Error("NODE_UPDATE_REGISTRY_RECEIPT_DIFFERS");
		const result = officeRecord(
			await this.#request(
				"record",
				{
					p_release_sha256: officeSha(intent.releaseSha256),
					p_intent_text: officeCanonical(intent),
					p_receipt_text: officeCanonical(receipt),
				},
				signal,
			),
			["phase", "receiptSha256"],
		);
		if (result.phase !== intent.phase || result.receiptSha256 !== officeDigest(receipt))
			throw new Error("NODE_UPDATE_REGISTRY_RECEIPT_DIFFERS");
	}
	async resume(intent: NodeUpdateIntent, drain: NodeUpdateDrain, signal: AbortSignal) {
		if (intent.phase !== "resume") throw new Error("NODE_UPDATE_REGISTRY_PHASE_INVALID");
		const result = officeRecord(
			await this.#request("resume", { p_release_sha256: officeSha(intent.releaseSha256) }, signal),
			["nodeId", "releaseSha256", "version", "enabled"],
		);
		if (
			result.nodeId !== this.#config.enrollment.nodeId ||
			result.releaseSha256 !== intent.releaseSha256 ||
			result.version !== drain.disabledVersion + 1 ||
			result.enabled !== drain.previousEnabled
		)
			throw new Error("NODE_UPDATE_REGISTRY_RESUME_DIFFERS");
		return {
			nodeId: this.#config.enrollment.nodeId,
			releaseSha256: intent.releaseSha256,
			version: drain.disabledVersion + 1,
			enabled: drain.previousEnabled,
		};
	}
	#state(value: unknown) {
		const state = officeRecord(value, [
			"schema",
			"envelope",
			"observation",
			"drain",
			"resumedVersion",
			"intents",
			"receipts",
		]);
		if (
			state.schema !== "qorpera.node-update-state/v1" ||
			!Array.isArray(state.receipts) ||
			state.receipts.length > NODE_UPDATE_PHASES.length ||
			!Array.isArray(state.intents) ||
			state.intents.length > NODE_UPDATE_PHASES.length ||
			state.intents.length < state.receipts.length ||
			state.intents.length > state.receipts.length + 1
		)
			throw new Error("NODE_UPDATE_REGISTRY_STATE_INVALID");
		const release = verifyNodeUpdateRelease(state.envelope, this.#config.enrollment),
			envelope = officeRecord(state.envelope, ["release", "signature"]),
			observation = parseNodeUpdateObservation(state.observation),
			releaseSha256 = officeDigest(release);
		if (
			observation.nodeId !== release.nodeId ||
			observation.machineIdSha256 !== release.machineIdSha256 ||
			observation.desiredReleaseSha256 !== releaseSha256 ||
			(observation.admissionReleaseSha256 !== null && observation.admissionReleaseSha256 !== releaseSha256) ||
			(observation.admissionReleaseSha256 === null) !== (observation.admissionEvidenceSha256 === null)
		)
			throw new Error("NODE_UPDATE_REGISTRY_OBSERVATION_DIFFERS");
		let previous: string | null = null,
			previousDrain: NodeUpdateDrain | null = null;
		const receipts: { intent: NodeUpdateIntent; receipt: NodeUpdateReceipt }[] = [];
		for (const [index, entry] of state.receipts.entries()) {
			const pair = officeRecord(entry, ["intent", "receipt"]),
				i = officeRecord(pair.intent, ["schema", "releaseSha256", "phase", "previousReceiptSha256", "observation"]);
			if (
				i.schema !== "qorpera.runtime-node-update-intent/v1" ||
				i.releaseSha256 !== releaseSha256 ||
				i.phase !== NODE_UPDATE_PHASES[index] ||
				i.previousReceiptSha256 !== previous ||
				receipts.at(-1)?.receipt.state === "failed"
			)
				throw new Error("NODE_UPDATE_REGISTRY_CHAIN_INVALID");
			const intent: NodeUpdateIntent = {
				schema: "qorpera.runtime-node-update-intent/v1",
				releaseSha256,
				phase: NODE_UPDATE_PHASES[index],
				previousReceiptSha256: previous,
				observation: parseNodeUpdateObservation(i.observation),
			};
			if (
				intent.observation.nodeId !== release.nodeId ||
				intent.observation.machineIdSha256 !== release.machineIdSha256 ||
				intent.observation.desiredReleaseSha256 !== releaseSha256
			)
				throw new Error("NODE_UPDATE_REGISTRY_INTENT_DIFFERS");
			const receipt = parseNodeUpdateReceipt(pair.receipt, intent, previousDrain);
			receipts.push({ intent, receipt });
			previous = officeDigest(receipt);
			previousDrain = receipt.drain;
		}
		const intents: NodeUpdateIntent[] = [];
		for (const [index, entry] of state.intents.entries()) {
			const i = officeRecord(entry, ["schema", "releaseSha256", "phase", "previousReceiptSha256", "observation"]),
				prior = index === 0 ? null : receipts[index - 1];
			if (
				i.schema !== "qorpera.runtime-node-update-intent/v1" ||
				i.releaseSha256 !== releaseSha256 ||
				i.phase !== NODE_UPDATE_PHASES[index] ||
				i.previousReceiptSha256 !== (prior ? officeDigest(prior.receipt) : null) ||
				prior?.receipt.state === "failed"
			)
				throw new Error("NODE_UPDATE_REGISTRY_CHAIN_INVALID");
			const intent: NodeUpdateIntent = {
				schema: "qorpera.runtime-node-update-intent/v1",
				releaseSha256,
				phase: NODE_UPDATE_PHASES[index],
				previousReceiptSha256: prior ? officeDigest(prior.receipt) : null,
				observation: parseNodeUpdateObservation(i.observation),
			};
			if (
				intent.observation.nodeId !== release.nodeId ||
				intent.observation.machineIdSha256 !== release.machineIdSha256 ||
				intent.observation.desiredReleaseSha256 !== releaseSha256 ||
				(receipts[index] && officeCanonical(receipts[index].intent) !== officeCanonical(intent))
			)
				throw new Error("NODE_UPDATE_REGISTRY_INTENT_DIFFERS");
			intents.push(intent);
		}
		const drain = parseDrain(state.drain),
			resumedVersion = state.resumedVersion === null ? null : version(state.resumedVersion);
		if (previousDrain !== null && officeCanonical(previousDrain) !== officeCanonical(drain))
			throw new Error("NODE_UPDATE_REGISTRY_DRAIN_DIFFERS");
		if (resumedVersion !== null && (!drain || resumedVersion !== drain.disabledVersion + 1))
			throw new Error("NODE_UPDATE_REGISTRY_RESUME_DIFFERS");
		return {
			envelope: { release, signature: envelope.signature as string },
			observation,
			drain,
			resumedVersion,
			intents,
			receipts,
		};
	}
	async #request(
		operation: "desired" | "read" | "prepare" | "drain" | "check" | "record" | "resume",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		signal.throwIfAborted();
		if (this.#pending) throw new Error("NODE_UPDATE_REGISTRY_REQUEST_PENDING");
		this.#pending = true;
		const rpc =
			operation === "record" || operation === "prepare"
				? `qorpera_${operation}_node_update_phase`
				: `qorpera_${operation}_node_update`;
		try {
			const body = JSON.stringify({
				...args,
				p_node_id: this.#config.enrollment.nodeId,
				p_capability_revision: this.#config.capabilityRevision,
				p_capability: this.#config.capability,
			});
			if (Buffer.byteLength(body) > 65536) throw new Error();
			const response = await this.#fetch(`${this.#config.origin}/rest/v1/rpc/${rpc}`, {
				method: "POST",
				headers: this.#headers,
				body,
				redirect: "error",
				credentials: "omit",
				signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
			});
			if (
				response.status !== 200 ||
				!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") ||
				!response.body
			) {
				await response.body?.cancel();
				throw new Error();
			}
			const reader = response.body.getReader(),
				chunks: Uint8Array[] = [];
			let size = 0;
			try {
				while (true) {
					const item = await reader.read();
					if (item.done) break;
					size += item.value.byteLength;
					if (size > 1024 * 1024) throw new Error();
					chunks.push(item.value);
				}
				return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
			} finally {
				await reader.cancel();
				reader.releaseLock();
			}
		} catch {
			// The backend, proxy and transport may echo credentials in their errors.
			throw new Error("NODE_UPDATE_REGISTRY_REQUEST_UNCONFIRMED");
		} finally {
			this.#pending = false;
		}
	}
}
