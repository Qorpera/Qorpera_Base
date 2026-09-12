import {
	type CompanyComputerActivationAttestation,
	parseCompanyComputerActivationAttestation,
} from "./company-computer-activation.ts";
import {
	type CompanyComputerLifecycleRequest,
	parseCompanyComputerLifecycleRequest,
} from "./company-computer-lifecycle.ts";
import {
	COMPANY_COMPUTER_RESET_OUTBOX_MAX_BYTES,
	COMPANY_COMPUTER_RESET_OUTBOX_MAX_FILE_BYTES,
	COMPANY_COMPUTER_RESET_OUTBOX_MAX_RECORDS,
} from "./company-computer-reset-custody.ts";

/** Same-allocation, same-node, pinned-image root replacement. The phases are
 * ordered; SQL and the provider journal advance them one at a time. A
 * `requested` plan has no SQL row yet; `fenced` is the first recorded phase. */
export const COMPANY_COMPUTER_RESET_PHASES = [
	"fenced",
	"stopped",
	"custodied",
	"powered_off",
	"root_deleted",
	"root_created",
	"restored",
	"prepared",
	"active",
] as const;
export type CompanyComputerResetPhase = (typeof COMPANY_COMPUTER_RESET_PHASES)[number];
/** Phases acknowledged through a bounded provider challenge. `fenced` is
 * recorded by begin; `prepared`/`active` come from the successor RPCs. */
export const COMPANY_COMPUTER_RESET_CHALLENGE_PHASES = [
	"stopped",
	"custodied",
	"powered_off",
	"root_deleted",
	"root_created",
	"restored",
] as const;
export type CompanyComputerResetChallengePhase = (typeof COMPANY_COMPUTER_RESET_CHALLENGE_PHASES)[number];
export const COMPANY_COMPUTER_RESET_MAX_BYTES = 65536;
export const COMPANY_COMPUTER_RESET_HISTORY_MAX_FILES = 1024;
export const COMPANY_COMPUTER_RESET_HISTORY_MAX_FILE_BYTES = 65536;
export const COMPANY_COMPUTER_RESET_HISTORY_MAX_BYTES = 8 * 1024 ** 2;
export const COMPANY_COMPUTER_RESET_OUTBOX_ROOT = "/var/lib/qorpera-office-events";

/** Operator-authored protected plan. Retains every logical identity and names
 * the fresh physical identities before any dispatch. It grants no dispatch:
 * SQL begin/phase challenges and current physical checks remain mandatory. */
export interface CompanyComputerResetPlan {
	readonly schema: "qorpera.lxd-office-reset-plan/v1";
	readonly resetId: string;
	readonly intentId: string;
	readonly predecessor: CompanyComputerLifecycleRequest;
	readonly preparationObservationSha256: string;
	readonly providerBindingSha256: string;
	readonly nodeId: string | null;
	readonly predecessorRootIncarnationId: string | null;
	readonly rootIncarnationId: string;
	readonly successorActivationId: string;
	readonly commands: {
		readonly stopCommandId: string;
		readonly deleteCommandId: string;
		readonly createCommandId: string;
		readonly startCommandId: string;
	};
	readonly custody: { readonly archiveRoot: string };
}
export interface CompanyComputerResetHistoryFile {
	readonly path: string;
	readonly bytes: number;
	readonly sha256: string;
	readonly mode: 0o400 | 0o444 | 0o600;
}
/** Provider-validated external archive identity. SQL records the digests; the
 * provider independently verifies the durable archive before publishing. */
export interface CompanyComputerResetCustodyManifest {
	readonly schema: "qorpera.office-reset-custody/v1";
	readonly resetId: string;
	readonly rootIncarnationId: string;
	readonly predecessorActivationId: string;
	readonly outbox: { readonly manifestSha256: string; readonly recordCount: number; readonly totalBytes: number };
	readonly history: {
		readonly manifestSha256: string;
		readonly files: readonly CompanyComputerResetHistoryFile[];
		readonly totalBytes: number;
	};
	readonly journalHeadSha256: string;
	readonly nas: { readonly workbenchSource: string; readonly adoptionId: string; readonly layoutSha256: string };
}
export interface CompanyComputerResetRestoreReceipt {
	readonly schema: "qorpera.office-reset-restore/v1";
	readonly resetId: string;
	readonly rootIncarnationId: string;
	readonly custodySha256: string;
	readonly bootId: string;
	readonly outbox: { readonly manifestSha256: string; readonly fileCount: number; readonly totalBytes: number };
	readonly history: { readonly fileCount: number; readonly totalBytes: number };
	readonly nas: { readonly reattached: true; readonly layoutSha256: string };
	readonly state: "restored";
}
export interface CompanyComputerResetPhaseRecord {
	readonly schema: "qorpera.office-reset-phase/v1";
	readonly resetId: string;
	readonly phase: CompanyComputerResetPhase;
	readonly sequence: number;
	readonly previousSha256: string | null;
	readonly evidenceSha256: string;
}
export interface CompanyComputerResetPhaseEvidence {
	readonly schema: "qorpera.office-reset-phase-evidence/v1";
	readonly resetId: string;
	readonly phase: CompanyComputerResetChallengePhase;
	readonly observation: Readonly<Record<string, unknown>>;
}
export interface CompanyComputerResetPhaseChallenge {
	readonly schema: "qorpera.office-reset-phase-challenge/v1";
	readonly challengeId: string;
	readonly resetId: string;
	readonly phase: CompanyComputerResetChallengePhase;
	readonly revision: number;
	readonly officeRevision: number;
	readonly privacyVersion: number;
	readonly evidenceSha256: string;
	readonly validForMs: number;
}
/** Historical SQL metadata. Status is never dispatch permission. */
export interface CompanyComputerResetStatus {
	readonly schema: "qorpera.office-reset/v1";
	readonly resetId: string;
	readonly phase: CompanyComputerResetPhase;
	readonly revision: number;
	readonly rootIncarnationId: string;
	readonly successorActivationId: string;
	readonly custodySha256: string | null;
	readonly restoreSha256: string | null;
	readonly stopAcknowledgedAtMs: number | null;
	readonly officeRevision: number;
	readonly privacyVersion: number;
	readonly validForMs: 5000;
}
export interface CompanyComputerResetSuccessorRequest {
	readonly schema: "qorpera.office-reset-successor-request/v1";
	readonly resetId: string;
	readonly rootIncarnationId: string;
	readonly predecessor: CompanyComputerLifecycleRequest;
	readonly attestation: CompanyComputerActivationAttestation;
	readonly custodySha256: string;
	readonly restoreSha256: string;
}
export interface CompanyComputerResetSuccessor {
	readonly schema: "qorpera.office-reset-successor/v1";
	readonly request: CompanyComputerResetSuccessorRequest;
	readonly state: "prepared" | "ready" | "active";
	readonly serviceInvocationId: string | null;
	readonly readinessFresh: boolean;
	readonly stopAcknowledgedAtMs: number;
	readonly officeRevision: number;
	readonly privacyVersion: number;
	readonly validForMs: 5000;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const HISTORY_PATHS = [
	/^\/etc\/qorpera-office\/history\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(?:manifest|claim|[0-9a-f]{64})\.json$/,
	/^\/etc\/qorpera-office\/adoption\.json$/,
	/^\/etc\/qorpera-office\/credentials\/config\.json$/,
	/^\/etc\/qorpera-office\/boots\/[0-9a-f]{32}\/(?:adoption|configuration-claim|configuration-completion)\.json$/,
	/^\/etc\/qorpera-office\/boots\/[0-9a-f]{32}\/credentials\/config\.json$/,
];
/** Public evidence that may be restored onto a fresh root. Configuration
 * files are history only; they are never written back to a credentials path. */
export function companyComputerResetRestorablePath(path: string): boolean {
	return HISTORY_PATHS[0].test(path) || HISTORY_PATHS[1].test(path);
}
function record(value: unknown, keys: string): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		Object.keys(value).sort().join() !== keys
	)
		throw new Error("record");
	return value as Record<string, unknown>;
}
function uuid(value: unknown): string {
	if (typeof value !== "string" || !UUID.test(value)) throw new Error("identity");
	return value;
}
function sha(value: unknown): string {
	if (typeof value !== "string" || !SHA.test(value)) throw new Error("digest");
	return value;
}
function integer(value: unknown, min: number, max: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error("number");
	return value as number;
}
function bounded(value: unknown): void {
	if (new TextEncoder().encode(JSON.stringify(value)).length > COMPANY_COMPUTER_RESET_MAX_BYTES)
		throw new Error("size");
}
function absolutePath(value: unknown): string {
	if (
		typeof value !== "string" ||
		value === "/" ||
		!value.startsWith("/") ||
		value.length > 4096 ||
		value.endsWith("/") ||
		/[\x00-\x20\x7f\\]/.test(value) ||
		value.split("/").some((part, index) => (index > 0 && !part) || part === "." || part === "..")
	)
		throw new Error("path");
	return value;
}
function equal(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
	const left = a as Record<string, unknown>,
		right = b as Record<string, unknown>;
	return (
		Object.keys(left).sort().join() === Object.keys(right).sort().join() &&
		Object.keys(left).every((key) => equal(left[key], right[key]))
	);
}
function distinct(ids: readonly string[]): void {
	if (new Set(ids).size !== ids.length) throw new Error("identity reuse");
}
export function parseCompanyComputerResetPlan(value: unknown): Readonly<CompanyComputerResetPlan> {
	try {
		bounded(value);
		const r = record(
			value,
			"commands,custody,intentId,nodeId,predecessor,predecessorRootIncarnationId,preparationObservationSha256,providerBindingSha256,resetId,rootIncarnationId,schema,successorActivationId",
		);
		if (r.schema !== "qorpera.lxd-office-reset-plan/v1") throw new Error("schema");
		const predecessor = parseCompanyComputerLifecycleRequest(r.predecessor);
		if (predecessor.action !== "replace") throw new Error("action");
		const commands = record(r.commands, "createCommandId,deleteCommandId,startCommandId,stopCommandId"),
			custody = record(r.custody, "archiveRoot");
		const fresh = [
			uuid(r.resetId),
			uuid(r.rootIncarnationId),
			uuid(r.successorActivationId),
			uuid(commands.stopCommandId),
			uuid(commands.deleteCommandId),
			uuid(commands.createCommandId),
			uuid(commands.startCommandId),
			...(r.predecessorRootIncarnationId === null ? [] : [uuid(r.predecessorRootIncarnationId)]),
		];
		const retained = [
			uuid(r.intentId),
			predecessor.transitionId,
			predecessor.activationId,
			predecessor.startup.bootId,
			predecessor.startup.allocationId,
			...(r.nodeId === null ? [] : [uuid(r.nodeId)]),
		];
		distinct(fresh);
		if (fresh.some((id) => retained.includes(id))) throw new Error("identity reuse");
		return Object.freeze({
			schema: "qorpera.lxd-office-reset-plan/v1",
			resetId: r.resetId as string,
			intentId: r.intentId as string,
			predecessor,
			preparationObservationSha256: sha(r.preparationObservationSha256),
			providerBindingSha256: sha(r.providerBindingSha256),
			nodeId: r.nodeId as string | null,
			predecessorRootIncarnationId: r.predecessorRootIncarnationId as string | null,
			rootIncarnationId: r.rootIncarnationId as string,
			successorActivationId: r.successorActivationId as string,
			commands: Object.freeze({
				stopCommandId: commands.stopCommandId as string,
				deleteCommandId: commands.deleteCommandId as string,
				createCommandId: commands.createCommandId as string,
				startCommandId: commands.startCommandId as string,
			}),
			custody: Object.freeze({ archiveRoot: absolutePath(custody.archiveRoot) }),
		});
	} catch {
		throw new Error("INVALID_OFFICE_RESET_PLAN");
	}
}
export function parseCompanyComputerResetCustodyManifest(
	value: unknown,
	planValue: CompanyComputerResetPlan,
): Readonly<CompanyComputerResetCustodyManifest> {
	try {
		bounded(value);
		const plan = parseCompanyComputerResetPlan(planValue);
		const r = record(
			value,
			"history,journalHeadSha256,nas,outbox,predecessorActivationId,resetId,rootIncarnationId,schema",
		);
		if (
			r.schema !== "qorpera.office-reset-custody/v1" ||
			r.resetId !== plan.resetId ||
			r.rootIncarnationId !== plan.rootIncarnationId ||
			r.predecessorActivationId !== plan.predecessor.activationId
		)
			throw new Error("binding");
		const outbox = record(r.outbox, "manifestSha256,recordCount,totalBytes"),
			recordCount = integer(outbox.recordCount, 0, COMPANY_COMPUTER_RESET_OUTBOX_MAX_RECORDS),
			outboxBytes = integer(
				outbox.totalBytes,
				1,
				COMPANY_COMPUTER_RESET_OUTBOX_MAX_BYTES + COMPANY_COMPUTER_RESET_OUTBOX_MAX_FILE_BYTES,
			);
		const history = record(r.history, "files,manifestSha256,totalBytes");
		if (
			!Array.isArray(history.files) ||
			history.files.length < 2 ||
			history.files.length > COMPANY_COMPUTER_RESET_HISTORY_MAX_FILES
		)
			throw new Error("history");
		const historyRoot = `/etc/qorpera-office/history/${plan.predecessor.startup.bootId}/${plan.predecessor.activationId}`;
		let previous = "",
			total = 0;
		const files = history.files.map((item) => {
			const f = record(item, "bytes,mode,path,sha256");
			if (
				typeof f.path !== "string" ||
				f.path.length > 512 ||
				!HISTORY_PATHS.some((pattern) => pattern.test(f.path as string)) ||
				f.path <= previous ||
				![0o400, 0o444, 0o600].includes(f.mode as number)
			)
				throw new Error("history file");
			previous = f.path;
			const bytes = integer(f.bytes, 1, COMPANY_COMPUTER_RESET_HISTORY_MAX_FILE_BYTES);
			total += bytes;
			return Object.freeze({
				path: f.path,
				bytes,
				sha256: sha(f.sha256),
				mode: f.mode,
			}) as unknown as CompanyComputerResetHistoryFile;
		});
		if (
			total > COMPANY_COMPUTER_RESET_HISTORY_MAX_BYTES ||
			history.totalBytes !== total ||
			!["manifest.json", "claim.json"].every((name) =>
				files.some((file) => file.path === `${historyRoot}/${name}` && file.sha256 === history.manifestSha256),
			)
		)
			throw new Error("history totals");
		const nas = record(r.nas, "adoptionId,layoutSha256,workbenchSource");
		return Object.freeze({
			schema: "qorpera.office-reset-custody/v1",
			resetId: plan.resetId,
			rootIncarnationId: plan.rootIncarnationId,
			predecessorActivationId: plan.predecessor.activationId,
			outbox: Object.freeze({ manifestSha256: sha(outbox.manifestSha256), recordCount, totalBytes: outboxBytes }),
			history: Object.freeze({
				manifestSha256: sha(history.manifestSha256),
				files: Object.freeze(files),
				totalBytes: total,
			}),
			journalHeadSha256: sha(r.journalHeadSha256),
			nas: Object.freeze({
				workbenchSource: absolutePath(nas.workbenchSource),
				adoptionId: uuid(nas.adoptionId),
				layoutSha256: sha(nas.layoutSha256),
			}),
		});
	} catch {
		throw new Error("INVALID_OFFICE_RESET_CUSTODY_MANIFEST");
	}
}
export function parseCompanyComputerResetRestoreReceipt(
	value: unknown,
	custodyValue: CompanyComputerResetCustodyManifest,
	plan: CompanyComputerResetPlan,
	custodySha256: string,
): Readonly<CompanyComputerResetRestoreReceipt> {
	try {
		bounded(value);
		const custody = parseCompanyComputerResetCustodyManifest(custodyValue, plan);
		const r = record(value, "bootId,custodySha256,history,nas,outbox,resetId,rootIncarnationId,schema,state");
		const outbox = record(r.outbox, "fileCount,manifestSha256,totalBytes"),
			history = record(r.history, "fileCount,totalBytes"),
			nas = record(r.nas, "layoutSha256,reattached");
		const restorable = custody.history.files.filter((file) => companyComputerResetRestorablePath(file.path));
		if (
			r.schema !== "qorpera.office-reset-restore/v1" ||
			r.state !== "restored" ||
			r.resetId !== custody.resetId ||
			r.rootIncarnationId !== custody.rootIncarnationId ||
			r.custodySha256 !== sha(custodySha256) ||
			uuid(r.bootId) === plan.predecessor.startup.bootId ||
			outbox.manifestSha256 !== custody.outbox.manifestSha256 ||
			outbox.fileCount !== custody.outbox.recordCount + 1 ||
			outbox.totalBytes !== custody.outbox.totalBytes ||
			history.fileCount !== restorable.length ||
			history.totalBytes !== restorable.reduce((sum, file) => sum + file.bytes, 0) ||
			nas.reattached !== true ||
			nas.layoutSha256 !== custody.nas.layoutSha256
		)
			throw new Error("receipt");
		return Object.freeze({
			schema: "qorpera.office-reset-restore/v1",
			resetId: custody.resetId,
			rootIncarnationId: custody.rootIncarnationId,
			custodySha256,
			bootId: r.bootId as string,
			outbox: Object.freeze({
				manifestSha256: custody.outbox.manifestSha256,
				fileCount: custody.outbox.recordCount + 1,
				totalBytes: custody.outbox.totalBytes,
			}),
			history: Object.freeze({ fileCount: restorable.length, totalBytes: history.totalBytes as number }),
			nas: Object.freeze({ reattached: true, layoutSha256: custody.nas.layoutSha256 }),
			state: "restored",
		});
	} catch {
		throw new Error("INVALID_OFFICE_RESET_RESTORE_RECEIPT");
	}
}
export function parseCompanyComputerResetPhaseRecord(
	value: unknown,
	plan: CompanyComputerResetPlan,
): Readonly<CompanyComputerResetPhaseRecord> {
	try {
		const r = record(value, "evidenceSha256,phase,previousSha256,resetId,schema,sequence");
		const index = COMPANY_COMPUTER_RESET_PHASES.indexOf(r.phase as CompanyComputerResetPhase);
		if (
			r.schema !== "qorpera.office-reset-phase/v1" ||
			r.resetId !== parseCompanyComputerResetPlan(plan).resetId ||
			index < 0 ||
			r.sequence !== index + 1 ||
			(index === 0 ? r.previousSha256 !== null : sha(r.previousSha256) !== r.previousSha256)
		)
			throw new Error("phase");
		return Object.freeze({
			schema: "qorpera.office-reset-phase/v1",
			resetId: plan.resetId,
			phase: r.phase as CompanyComputerResetPhase,
			sequence: index + 1,
			previousSha256: r.previousSha256 as string | null,
			evidenceSha256: sha(r.evidenceSha256),
		});
	} catch {
		throw new Error("INVALID_OFFICE_RESET_PHASE_RECORD");
	}
}
export function parseCompanyComputerResetPhaseEvidence(
	value: unknown,
	plan: CompanyComputerResetPlan,
	phase: CompanyComputerResetChallengePhase,
): Readonly<CompanyComputerResetPhaseEvidence> {
	try {
		bounded(value);
		const r = record(value, "observation,phase,resetId,schema");
		if (
			r.schema !== "qorpera.office-reset-phase-evidence/v1" ||
			r.resetId !== parseCompanyComputerResetPlan(plan).resetId ||
			!COMPANY_COMPUTER_RESET_CHALLENGE_PHASES.includes(phase) ||
			r.phase !== phase ||
			!r.observation ||
			typeof r.observation !== "object" ||
			Array.isArray(r.observation) ||
			Object.getPrototypeOf(r.observation) !== Object.prototype ||
			Object.keys(r.observation).length < 1
		)
			throw new Error("evidence");
		return Object.freeze({
			schema: "qorpera.office-reset-phase-evidence/v1",
			resetId: plan.resetId,
			phase,
			observation: Object.freeze(structuredClone(r.observation)) as Readonly<Record<string, unknown>>,
		});
	} catch {
		throw new Error("INVALID_OFFICE_RESET_PHASE_EVIDENCE");
	}
}
export function parseCompanyComputerResetPhaseChallenge(
	value: unknown,
	plan: CompanyComputerResetPlan,
	phase: CompanyComputerResetChallengePhase,
	challengeId: string,
	evidenceSha256: string,
): Readonly<CompanyComputerResetPhaseChallenge> {
	try {
		const r = record(
			value,
			"challengeId,evidenceSha256,officeRevision,phase,privacyVersion,resetId,revision,schema,validForMs",
		);
		if (
			r.schema !== "qorpera.office-reset-phase-challenge/v1" ||
			r.challengeId !== uuid(challengeId) ||
			r.resetId !== parseCompanyComputerResetPlan(plan).resetId ||
			!COMPANY_COMPUTER_RESET_CHALLENGE_PHASES.includes(phase) ||
			r.phase !== phase ||
			r.evidenceSha256 !== sha(evidenceSha256)
		)
			throw new Error("challenge");
		return Object.freeze({
			schema: "qorpera.office-reset-phase-challenge/v1",
			challengeId,
			resetId: plan.resetId,
			phase,
			revision: integer(r.revision, 1, Number.MAX_SAFE_INTEGER),
			officeRevision: integer(r.officeRevision, 1, Number.MAX_SAFE_INTEGER),
			privacyVersion: integer(r.privacyVersion, 0, Number.MAX_SAFE_INTEGER),
			evidenceSha256,
			validForMs: integer(r.validForMs, 1, 5000),
		});
	} catch {
		throw new Error("OFFICE_RESET_CHALLENGE_UNCONFIRMED");
	}
}
export function parseCompanyComputerResetStatus(
	value: unknown,
	plan: CompanyComputerResetPlan,
): Readonly<CompanyComputerResetStatus> {
	try {
		const r = record(
			value,
			"custodySha256,officeRevision,phase,privacyVersion,resetId,restoreSha256,revision,rootIncarnationId,schema,stopAcknowledgedAtMs,successorActivationId,validForMs",
		);
		const p = parseCompanyComputerResetPlan(plan),
			index = COMPANY_COMPUTER_RESET_PHASES.indexOf(r.phase as CompanyComputerResetPhase);
		if (
			r.schema !== "qorpera.office-reset/v1" ||
			r.resetId !== p.resetId ||
			r.rootIncarnationId !== p.rootIncarnationId ||
			r.successorActivationId !== p.successorActivationId ||
			index < 0 ||
			r.validForMs !== 5000 ||
			(r.custodySha256 === null ? index >= 2 : sha(r.custodySha256) !== r.custodySha256) ||
			(r.restoreSha256 === null ? index >= 6 : sha(r.restoreSha256) !== r.restoreSha256) ||
			(r.stopAcknowledgedAtMs === null
				? index >= 1
				: integer(r.stopAcknowledgedAtMs, 1, Number.MAX_SAFE_INTEGER) !== r.stopAcknowledgedAtMs)
		)
			throw new Error("status");
		return Object.freeze({
			schema: "qorpera.office-reset/v1",
			resetId: p.resetId,
			phase: r.phase as CompanyComputerResetPhase,
			revision: integer(r.revision, 1, Number.MAX_SAFE_INTEGER),
			rootIncarnationId: p.rootIncarnationId,
			successorActivationId: p.successorActivationId,
			custodySha256: r.custodySha256 as string | null,
			restoreSha256: r.restoreSha256 as string | null,
			stopAcknowledgedAtMs: r.stopAcknowledgedAtMs as number | null,
			officeRevision: integer(r.officeRevision, 1, Number.MAX_SAFE_INTEGER),
			privacyVersion: integer(r.privacyVersion, 0, Number.MAX_SAFE_INTEGER),
			validForMs: 5000,
		});
	} catch {
		throw new Error("OFFICE_RESET_STATUS_UNCONFIRMED");
	}
}
export function parseCompanyComputerResetSuccessorRequest(
	value: unknown,
): Readonly<CompanyComputerResetSuccessorRequest> {
	try {
		bounded(value);
		const r = record(value, "attestation,custodySha256,predecessor,resetId,restoreSha256,rootIncarnationId,schema");
		const predecessor = parseCompanyComputerLifecycleRequest(r.predecessor),
			attestation = parseCompanyComputerActivationAttestation(r.attestation);
		if (
			r.schema !== "qorpera.office-reset-successor-request/v1" ||
			predecessor.action !== "replace" ||
			attestation.activationId === predecessor.activationId ||
			attestation.bootId === predecessor.startup.bootId ||
			attestation.configurationSha256 === predecessor.startup.configurationSha256
		)
			throw new Error("binding");
		distinct([uuid(r.resetId), uuid(r.rootIncarnationId), attestation.activationId, attestation.bootId]);
		return Object.freeze({
			schema: "qorpera.office-reset-successor-request/v1",
			resetId: r.resetId as string,
			rootIncarnationId: r.rootIncarnationId as string,
			predecessor,
			attestation,
			custodySha256: sha(r.custodySha256),
			restoreSha256: sha(r.restoreSha256),
		});
	} catch {
		throw new Error("INVALID_OFFICE_RESET_SUCCESSOR_REQUEST");
	}
}
export function parseCompanyComputerResetSuccessor(
	value: unknown,
	expected: CompanyComputerResetSuccessorRequest,
): Readonly<CompanyComputerResetSuccessor> {
	try {
		const r = record(
			value,
			"officeRevision,privacyVersion,readinessFresh,request,schema,serviceInvocationId,state,stopAcknowledgedAtMs,validForMs",
		);
		const request = parseCompanyComputerResetSuccessorRequest(r.request),
			target = parseCompanyComputerResetSuccessorRequest(expected);
		if (
			r.schema !== "qorpera.office-reset-successor/v1" ||
			!equal(request, target) ||
			!["prepared", "ready", "active"].includes(r.state as string) ||
			typeof r.readinessFresh !== "boolean" ||
			r.validForMs !== 5000 ||
			(r.state === "prepared"
				? r.serviceInvocationId !== null || r.readinessFresh
				: typeof r.serviceInvocationId !== "string" ||
					!/^(?!0{32}$)[0-9a-f]{32}$/.test(r.serviceInvocationId) ||
					r.serviceInvocationId === request.predecessor.startup.serviceInvocationId)
		)
			throw new Error("state");
		return Object.freeze({
			schema: "qorpera.office-reset-successor/v1",
			request,
			state: r.state as CompanyComputerResetSuccessor["state"],
			serviceInvocationId: r.serviceInvocationId as string | null,
			readinessFresh: r.readinessFresh,
			stopAcknowledgedAtMs: integer(r.stopAcknowledgedAtMs, 1, Number.MAX_SAFE_INTEGER),
			officeRevision: integer(r.officeRevision, 1, Number.MAX_SAFE_INTEGER),
			privacyVersion: integer(r.privacyVersion, 0, Number.MAX_SAFE_INTEGER),
			validForMs: 5000,
		});
	} catch {
		throw new Error("OFFICE_RESET_SUCCESSOR_UNCONFIRMED");
	}
}
