import { verify } from "node:crypto";
import { join } from "node:path";
import {
	officeCanonical,
	officeDigest,
	officeImagePublicKey,
	officeRecord,
	officeSha,
} from "./lxd-office-image-provenance.ts";
import { checkDirectory, code, publish, readRecord } from "./lxd-office-journal-files.ts";

/** Host updates have a separate signing domain from guest-image provenance.
 * This engine supplies no credential, release feed, or privileged installer. */
export const NODE_UPDATE_PHASES = [
	"stage",
	"drain",
	"stop",
	"install",
	"start",
	"verify",
	"acknowledge",
	"resume",
] as const;
export type NodeUpdatePhase = (typeof NODE_UPDATE_PHASES)[number];
const integer = (value: unknown, minimum: number): number => {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) >= Number.MAX_SAFE_INTEGER)
		throw new Error("NODE_UPDATE_INTEGER_INVALID");
	return value as number;
};
const uuid = (value: unknown): string => {
	if (
		typeof value !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
	)
		throw new Error("NODE_UPDATE_ID_INVALID");
	return value;
};

export function parseNodeUpdateRelease(value: unknown) {
	const r = officeRecord(value, [
		"schema",
		"nodeId",
		"machineIdSha256",
		"revision",
		"previous",
		"artifact",
		"runtimeBundleSha256",
		"sourceCommit",
		"acceptanceEvidenceSha256",
	]);
	const previous = officeRecord(r.previous, ["revision", "releaseSha256", "artifactSha256"]);
	const artifact = officeRecord(r.artifact, ["bytes", "sha256"]);
	if (
		r.schema !== "qorpera.runtime-node-update-release/v1" ||
		typeof r.sourceCommit !== "string" ||
		!/^[0-9a-f]{40}$/.test(r.sourceCommit)
	)
		throw new Error("NODE_UPDATE_RELEASE_INVALID");
	const revision = integer(r.revision, 1),
		previousRevision = integer(previous.revision, 0),
		bytes = integer(artifact.bytes, 1);
	if (revision !== previousRevision + 1 || bytes > 64 * 1024 ** 2) throw new Error("NODE_UPDATE_RELEASE_INVALID");
	return Object.freeze({
		schema: "qorpera.runtime-node-update-release/v1" as const,
		nodeId: uuid(r.nodeId),
		machineIdSha256: officeSha(r.machineIdSha256),
		revision,
		previous: Object.freeze({
			revision: previousRevision,
			releaseSha256: officeSha(previous.releaseSha256),
			artifactSha256: officeSha(previous.artifactSha256),
		}),
		artifact: Object.freeze({ bytes, sha256: officeSha(artifact.sha256) }),
		runtimeBundleSha256: officeSha(r.runtimeBundleSha256),
		sourceCommit: r.sourceCommit,
		acceptanceEvidenceSha256: officeSha(r.acceptanceEvidenceSha256),
	});
}
export type NodeUpdateRelease = ReturnType<typeof parseNodeUpdateRelease>;

export interface NodeUpdateEnrollment {
	nodeId: string;
	machineIdSha256: string;
	/** Root-enrolled Ed25519 SPKI, never selected by the downloaded envelope. */
	publicKey: string;
	previousRevision: number;
	previousReleaseSha256: string;
	previousArtifactSha256: string;
}
export function verifyNodeUpdateRelease(value: unknown, enrollment: Readonly<NodeUpdateEnrollment>): NodeUpdateRelease {
	const envelope = officeRecord(value, ["release", "signature"]),
		release = parseNodeUpdateRelease(envelope.release);
	if (typeof envelope.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature))
		throw new Error("NODE_UPDATE_SIGNATURE_INVALID");
	const signature = Buffer.from(envelope.signature, "base64");
	if (
		signature.length !== 64 ||
		signature.toString("base64") !== envelope.signature ||
		!verify(null, Buffer.from(officeCanonical(release)), officeImagePublicKey(enrollment.publicKey), signature)
	)
		throw new Error("NODE_UPDATE_SIGNATURE_INVALID");
	if (
		release.nodeId !== enrollment.nodeId ||
		release.machineIdSha256 !== enrollment.machineIdSha256 ||
		release.previous.revision !== enrollment.previousRevision ||
		release.previous.releaseSha256 !== enrollment.previousReleaseSha256 ||
		release.previous.artifactSha256 !== enrollment.previousArtifactSha256
	)
		throw new Error("NODE_UPDATE_ENROLLMENT_DIFFERS");
	return release;
}

export interface NodeUpdateDrain {
	/** Exact original public policy; restoring it must not overwrite another operator. */
	policySha256: string;
	disabledPolicySha256: string;
	previousVersion: number;
	disabledVersion: number;
	previousEnabled: boolean;
}
export interface NodeUpdateObservation {
	nodeId: string;
	machineIdSha256: string;
	desiredReleaseSha256: string;
	activeRuntimeBundleSha256: string;
	/** Separate coordinator grant issued after the whole cut is verified. */
	admissionReleaseSha256: string | null;
	admissionEvidenceSha256: string | null;
	policyVersion: number;
	policySha256: string;
	enabled: boolean;
}
export interface NodeUpdateIntent {
	schema: "qorpera.runtime-node-update-intent/v1";
	releaseSha256: string;
	phase: NodeUpdatePhase;
	previousReceiptSha256: string | null;
	/** Snapshot bound to the sole effect attempt, including exact admission CAS. */
	observation: NodeUpdateObservation;
}
export interface NodeUpdateReceipt {
	schema: "qorpera.runtime-node-update-receipt/v1";
	intentSha256: string;
	state: "succeeded" | "failed";
	/** Digest of retained physical/backend evidence, not a prose success flag. */
	evidenceSha256: string;
	drain: NodeUpdateDrain | null;
}
export interface NodeUpdatePorts {
	/** Fresh read of authenticated desired revision and exact public node policy. */
	observe(release: NodeUpdateRelease, signal: AbortSignal): Promise<NodeUpdateObservation>;
	/** Durable backend preparation and receipt publication are exact-body,
	 * idempotent registry operations. Reconcile their lost replies by reading the
	 * retained row, and submit only that same immutable body if absent. They must
	 * never invoke a physical effect. */
	prepare(intent: NodeUpdateIntent, signal: AbortSignal): Promise<void>;
	publish(intent: NodeUpdateIntent, receipt: NodeUpdateReceipt, signal: AbortSignal): Promise<void>;
	/** Concrete adapter validates physical custody, compatibility and phase proof.
	 * It must check current authority at effect time; observation is not a lease. */
	execute(
		release: NodeUpdateRelease,
		intent: NodeUpdateIntent,
		drain: NodeUpdateDrain | null,
		signal: AbortSignal,
	): Promise<NodeUpdateReceipt>;
	/** Read-only exact-intent reconciliation. Absence/timeouts never prove failure
	 * or success. This must never repeat the effect, even after process restart. */
	inspect(
		release: NodeUpdateRelease,
		intent: NodeUpdateIntent,
		signal: AbortSignal,
	): Promise<NodeUpdateReceipt | null>;
}

export function parseNodeUpdateObservation(value: unknown): NodeUpdateObservation {
	const o = officeRecord(value, [
		"nodeId",
		"machineIdSha256",
		"desiredReleaseSha256",
		"activeRuntimeBundleSha256",
		"admissionReleaseSha256",
		"admissionEvidenceSha256",
		"policyVersion",
		"policySha256",
		"enabled",
	]);
	if (typeof o.enabled !== "boolean") throw new Error("NODE_UPDATE_OBSERVATION_INVALID");
	return {
		nodeId: uuid(o.nodeId),
		machineIdSha256: officeSha(o.machineIdSha256),
		desiredReleaseSha256: officeSha(o.desiredReleaseSha256),
		activeRuntimeBundleSha256: officeSha(o.activeRuntimeBundleSha256),
		admissionReleaseSha256: o.admissionReleaseSha256 === null ? null : officeSha(o.admissionReleaseSha256),
		admissionEvidenceSha256: o.admissionEvidenceSha256 === null ? null : officeSha(o.admissionEvidenceSha256),
		policyVersion: integer(o.policyVersion, 0),
		policySha256: officeSha(o.policySha256),
		enabled: o.enabled,
	};
}
export function parseNodeUpdateReceipt(
	value: unknown,
	intent: NodeUpdateIntent,
	previousDrain: NodeUpdateDrain | null,
): NodeUpdateReceipt {
	const r = officeRecord(value, ["schema", "intentSha256", "state", "evidenceSha256", "drain"]);
	if (
		r.schema !== "qorpera.runtime-node-update-receipt/v1" ||
		r.intentSha256 !== officeDigest(intent) ||
		(r.state !== "succeeded" && r.state !== "failed")
	)
		throw new Error("NODE_UPDATE_RECEIPT_INVALID");
	let drain: NodeUpdateDrain | null = null;
	if (r.drain !== null) {
		const d = officeRecord(r.drain, [
			"policySha256",
			"disabledPolicySha256",
			"previousVersion",
			"disabledVersion",
			"previousEnabled",
		]);
		if (typeof d.previousEnabled !== "boolean") throw new Error("NODE_UPDATE_DRAIN_INVALID");
		drain = {
			policySha256: officeSha(d.policySha256),
			disabledPolicySha256: officeSha(d.disabledPolicySha256),
			previousVersion: integer(d.previousVersion, 0),
			disabledVersion: integer(d.disabledVersion, 1),
			previousEnabled: d.previousEnabled,
		};
		if (drain.disabledVersion !== drain.previousVersion + 1) throw new Error("NODE_UPDATE_DRAIN_INVALID");
	}
	if (intent.phase === "drain" && r.state === "succeeded") {
		if (
			!drain ||
			drain.previousVersion !== intent.observation.policyVersion ||
			drain.policySha256 !== intent.observation.policySha256 ||
			drain.previousEnabled !== intent.observation.enabled
		)
			throw new Error("NODE_UPDATE_DRAIN_INVALID");
	} else if (officeCanonical(drain) !== officeCanonical(previousDrain)) throw new Error("NODE_UPDATE_DRAIN_CHANGED");
	return {
		schema: "qorpera.runtime-node-update-receipt/v1",
		intentSha256: r.intentSha256,
		state: r.state,
		evidenceSha256: officeSha(r.evidenceSha256),
		drain,
	};
}

/** One registry or physical step per reconciliation. A phase intent first binds
 * backend preparation; a separate atomic effect claim permanently fences a
 * second physical submission, including a crash before dispatch. Immutable SQL
 * preparation/publication reconcile independently through exact retained rows. */
export class RuntimeNodeUpdateController {
	readonly #root: string;
	readonly #release: NodeUpdateRelease;
	readonly #ports: NodeUpdatePorts;
	constructor(root: string, envelope: unknown, enrollment: Readonly<NodeUpdateEnrollment>, ports: NodeUpdatePorts) {
		this.#root = root;
		this.#release = verifyNodeUpdateRelease(envelope, enrollment);
		this.#ports = ports;
	}
	async reconcile(
		signal: AbortSignal,
	): Promise<
		| { phase: NodeUpdatePhase; state: "prepared" | "published" | "succeeded" | "failed" | "unconfirmed" }
		| { state: "completed" }
	> {
		await checkDirectory(this.#root);
		const releaseSha256 = officeDigest(this.#release);
		const releaseBytes = Buffer.from(`${officeCanonical(this.#release)}\n`);
		await publish(this.#root, "release.json", releaseBytes);
		if (!(await readRecord(join(this.#root, "release.json"))).bytes.equals(releaseBytes))
			throw new Error("NODE_UPDATE_JOURNAL_RELEASE_DIFFERS");
		let previousReceiptSha256: string | null = null,
			drain: NodeUpdateDrain | null = null;
		for (const phase of NODE_UPDATE_PHASES) {
			signal.throwIfAborted();
			const intentPath = join(this.#root, `${phase}-intent.json`),
				resultPath = join(this.#root, `${phase}-result.json`);
			const retained = await readRecord(intentPath).catch((error) => {
				if (code(error, "ENOENT")) return null;
				throw error;
			});
			const retainedResult = await readRecord(resultPath).catch((error) => {
				if (code(error, "ENOENT")) return null;
				throw error;
			});
			if (!retained && retainedResult) throw new Error("NODE_UPDATE_RESULT_WITHOUT_INTENT");
			let intent: NodeUpdateIntent;
			if (retained) {
				const i = officeRecord(retained.value, [
					"schema",
					"releaseSha256",
					"phase",
					"previousReceiptSha256",
					"observation",
				]);
				if (
					i.schema !== "qorpera.runtime-node-update-intent/v1" ||
					i.releaseSha256 !== releaseSha256 ||
					i.phase !== phase ||
					i.previousReceiptSha256 !== previousReceiptSha256
				)
					throw new Error("NODE_UPDATE_JOURNAL_CHAIN_DIFFERS");
				intent = {
					schema: "qorpera.runtime-node-update-intent/v1",
					releaseSha256,
					phase,
					previousReceiptSha256,
					observation: parseNodeUpdateObservation(i.observation),
				};
				const intentMarker = { intentSha256: officeDigest(intent) },
					prepared = await this.#marker(`${phase}-prepared.json`, intentMarker),
					effect = await this.#marker(`${phase}-effect.json`, intentMarker);
				if ((!prepared && (effect || retainedResult)) || (retainedResult && !effect))
					throw new Error("NODE_UPDATE_EFFECT_WITHOUT_PREPARATION");
				if (!prepared) {
					await this.#ports.prepare(intent, signal);
					await this.#retainMarker(`${phase}-prepared.json`, intentMarker);
					return { phase, state: "prepared" };
				}
				const result = retainedResult;
				if (result) {
					const checked = parseNodeUpdateReceipt(result.value, intent, drain);
					const publication = { ...intentMarker, receiptSha256: officeDigest(checked) };
					if (!(await this.#marker(`${phase}-published.json`, publication))) {
						await this.#ports.publish(intent, checked, signal);
						await this.#retainMarker(`${phase}-published.json`, publication);
						return { phase, state: "published" };
					}
					if (checked.state === "failed") return { phase, state: "failed" };
					previousReceiptSha256 = officeDigest(checked);
					drain = checked.drain;
					continue;
				}
				if (!effect) {
					const current = parseNodeUpdateObservation(await this.#ports.observe(this.#release, signal));
					if (
						current.nodeId !== intent.observation.nodeId ||
						current.machineIdSha256 !== intent.observation.machineIdSha256 ||
						current.desiredReleaseSha256 !== intent.releaseSha256 ||
						current.policyVersion !== intent.observation.policyVersion ||
						current.policySha256 !== intent.observation.policySha256 ||
						current.enabled !== intent.observation.enabled
					)
						throw new Error("NODE_UPDATE_PREPARED_AUTHORITY_CHANGED");
					if (
						phase === "resume" &&
						(current.activeRuntimeBundleSha256 !== this.#release.runtimeBundleSha256 ||
							current.admissionReleaseSha256 !== intent.releaseSha256 ||
							current.admissionEvidenceSha256 !== intent.observation.admissionEvidenceSha256)
					)
						throw new Error("NODE_UPDATE_COORDINATOR_RELEASE_REQUIRED");
					if (
						!(await publish(
							this.#root,
							`${phase}-effect.json`,
							Buffer.from(`${officeCanonical(intentMarker)}\n`),
						))
					)
						return { phase, state: "unconfirmed" };
					// Only this claim fences physical dispatch. Registry preparation and
					// publication reconcile independently with exact immutable bodies.
					const executed = parseNodeUpdateReceipt(
						await this.#ports.execute(this.#release, intent, drain, signal),
						intent,
						drain,
					);
					await this.#retainReceipt(phase, executed);
					return { phase, state: executed.state };
				}
				const inspected = await this.#ports.inspect(this.#release, intent, signal);
				if (inspected === null) return { phase, state: "unconfirmed" };
				await this.#retainReceipt(phase, parseNodeUpdateReceipt(inspected, intent, drain));
				return { phase, state: inspected.state };
			}
			const observed = parseNodeUpdateObservation(await this.#ports.observe(this.#release, signal));
			if (
				observed.nodeId !== this.#release.nodeId ||
				observed.machineIdSha256 !== this.#release.machineIdSha256 ||
				observed.desiredReleaseSha256 !== releaseSha256
			)
				throw new Error("NODE_UPDATE_DESIRED_AUTHORITY_CHANGED");
			if (
				drain &&
				(observed.policyVersion !== drain.disabledVersion ||
					observed.enabled ||
					observed.policySha256 !== drain.disabledPolicySha256)
			)
				throw new Error("NODE_UPDATE_DRAIN_OWNERSHIP_LOST");
			if (phase === "resume" && observed.activeRuntimeBundleSha256 !== this.#release.runtimeBundleSha256)
				throw new Error("NODE_UPDATE_RUNTIME_NOT_ACTIVATED");
			if (
				phase === "resume" &&
				(observed.admissionReleaseSha256 !== releaseSha256 || observed.admissionEvidenceSha256 === null)
			)
				throw new Error("NODE_UPDATE_COORDINATOR_RELEASE_REQUIRED");
			intent = {
				schema: "qorpera.runtime-node-update-intent/v1",
				releaseSha256,
				phase,
				previousReceiptSha256,
				observation: observed,
			};
			if (!(await publish(this.#root, `${phase}-intent.json`, Buffer.from(`${officeCanonical(intent)}\n`))))
				return { phase, state: "unconfirmed" };
			await this.#ports.prepare(intent, signal);
			await this.#retainMarker(`${phase}-prepared.json`, { intentSha256: officeDigest(intent) });
			return { phase, state: "prepared" };
		}
		return { state: "completed" };
	}
	async #marker(name: string, value: unknown): Promise<boolean> {
		const retained = await readRecord(join(this.#root, name)).catch((error) => {
			if (code(error, "ENOENT")) return null;
			throw error;
		});
		if (!retained) return false;
		if (officeCanonical(retained.value) !== officeCanonical(value)) throw new Error("NODE_UPDATE_MARKER_CONFLICT");
		return true;
	}
	async #retainMarker(name: string, value: unknown): Promise<void> {
		await publish(this.#root, name, Buffer.from(`${officeCanonical(value)}\n`));
		await this.#marker(name, value);
	}
	async #retainReceipt(phase: NodeUpdatePhase, result: NodeUpdateReceipt): Promise<void> {
		const bytes = Buffer.from(`${officeCanonical(result)}\n`),
			name = `${phase}-result.json`;
		await publish(this.#root, name, bytes);
		if (!(await readRecord(join(this.#root, name))).bytes.equals(bytes))
			throw new Error("NODE_UPDATE_RECEIPT_CONFLICT");
	}
}
