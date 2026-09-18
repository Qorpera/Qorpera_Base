import { describe, expect, it } from "vitest";
import type { CompanyComputerLifecycleRequest } from "../src/company-computer-lifecycle.ts";
import {
	COMPANY_COMPUTER_RESET_PHASES,
	type CompanyComputerResetCustodyManifest,
	type CompanyComputerResetPlan,
	type CompanyComputerResetSuccessorRequest,
	companyComputerResetRestorablePath,
	parseCompanyComputerResetCustodyManifest,
	parseCompanyComputerResetPhaseChallenge,
	parseCompanyComputerResetPhaseEvidence,
	parseCompanyComputerResetPhaseRecord,
	parseCompanyComputerResetPlan,
	parseCompanyComputerResetRestoreReceipt,
	parseCompanyComputerResetStatus,
	parseCompanyComputerResetSuccessor,
	parseCompanyComputerResetSuccessorRequest,
} from "../src/company-computer-reset.ts";

const id = (n: number) => `12345678-1234-4234-8234-${String(n).padStart(12, "0")}`;
const sha = (c: string) => c.repeat(64);
const startup = () => ({
	scope: { companyId: id(6), environmentId: id(7), companyComputerId: id(8), logicalComputerId: id(9) },
	computerGeneration: 1,
	allocationId: id(10),
	instanceSha256: sha("a"),
	imageSha256: sha("b"),
	bootstrapSha256: sha("c"),
	bootId: id(11),
	configurationSha256: sha("d"),
	serviceInvocationId: "e".repeat(32),
});
const predecessor = (): CompanyComputerLifecycleRequest => ({
	schema: "qorpera.office-lifecycle-request/v1",
	transitionId: id(2),
	action: "replace",
	activationId: id(3),
	providerId: id(12),
	providerPolicySha256: sha("f"),
	startup: startup(),
});
const plan = (): CompanyComputerResetPlan => ({
	schema: "qorpera.lxd-office-reset-plan/v1",
	resetId: id(1),
	intentId: id(13),
	predecessor: predecessor(),
	preparationObservationSha256: sha("1"),
	providerBindingSha256: sha("2"),
	nodeId: id(14),
	predecessorRootIncarnationId: null,
	rootIncarnationId: id(5),
	successorActivationId: id(4),
	commands: { stopCommandId: id(20), deleteCommandId: id(21), createCommandId: id(22), startCommandId: id(23) },
	custody: { archiveRoot: "/var/lib/qorpera-office-provider/reset-custody" },
});
const historyRoot = `/etc/qorpera-office/history/${id(11)}/${id(3)}`;
const custody = (): CompanyComputerResetCustodyManifest => ({
	schema: "qorpera.office-reset-custody/v1",
	resetId: id(1),
	rootIncarnationId: id(5),
	predecessorActivationId: id(3),
	outbox: { manifestSha256: sha("3"), recordCount: 2, totalBytes: 900 },
	history: {
		manifestSha256: sha("4"),
		files: [
			{ path: "/etc/qorpera-office/adoption.json", bytes: 100, sha256: sha("5"), mode: 0o444 },
			{ path: "/etc/qorpera-office/credentials/config.json", bytes: 200, sha256: sha("6"), mode: 0o400 },
			{ path: `${historyRoot}/${sha("5")}.json`, bytes: 100, sha256: sha("5"), mode: 0o600 },
			{ path: `${historyRoot}/claim.json`, bytes: 300, sha256: sha("4"), mode: 0o600 },
			{ path: `${historyRoot}/manifest.json`, bytes: 300, sha256: sha("4"), mode: 0o600 },
		],
		totalBytes: 1000,
	},
	journalHeadSha256: sha("7"),
	nas: { workbenchSource: "/mnt/office-workbench", adoptionId: id(15), layoutSha256: sha("8") },
});
const restore = () => ({
	schema: "qorpera.office-reset-restore/v1",
	resetId: id(1),
	rootIncarnationId: id(5),
	custodySha256: sha("9"),
	bootId: id(16),
	outbox: { manifestSha256: sha("3"), fileCount: 3, totalBytes: 900 },
	history: { fileCount: 4, totalBytes: 800 },
	nas: { reattached: true, layoutSha256: sha("8") },
	state: "restored",
});
const successorRequest = (): CompanyComputerResetSuccessorRequest => ({
	schema: "qorpera.office-reset-successor-request/v1",
	resetId: id(1),
	rootIncarnationId: id(5),
	predecessor: predecessor(),
	attestation: {
		schema: "qorpera.office-activation-attestation/v1",
		activationId: id(4),
		bootId: id(16),
		preparationObservationSha256: sha("1"),
		configurationObservationSha256: sha("a"),
		configurationSha256: sha("b"),
		adoptionReceiptSha256: sha("5"),
		nativePort: 9443,
		viewerPort: 9444,
	},
	custodySha256: sha("9"),
	restoreSha256: sha("0"),
});
describe("office reset plan contract", () => {
	it("retains logical identity and freezes fresh physical identities", () => {
		const parsed = parseCompanyComputerResetPlan(plan());
		expect(parsed.predecessor.action).toBe("replace");
		expect(Object.isFrozen(parsed.commands)).toBe(true);
		expect(parsed.custody.archiveRoot).toBe("/var/lib/qorpera-office-provider/reset-custody");
		expect(
			parseCompanyComputerResetPlan({ ...plan(), nodeId: null, predecessorRootIncarnationId: id(30) }).nodeId,
		).toBe(null);
	});
	it.each([
		["extra field", { extra: true }],
		["schema", { schema: "qorpera.lxd-office-reset-plan/v2" }],
		["non-replace predecessor", { predecessor: { ...predecessor(), action: "reboot" } }],
		["successor aliasing predecessor", { successorActivationId: id(3) }],
		["root incarnation aliasing boot", { rootIncarnationId: id(11) }],
		["reset aliasing transition", { resetId: id(2) }],
		["reset aliasing intent", { resetId: id(13) }],
		["command aliasing another command", { commands: { ...plan().commands, deleteCommandId: id(20) } }],
		["command aliasing allocation", { commands: { ...plan().commands, createCommandId: id(10) } }],
		["predecessor incarnation aliasing target", { predecessorRootIncarnationId: id(5) }],
		["node aliasing reset", { nodeId: id(1) }],
		["relative custody root", { custody: { archiveRoot: "reset-custody" } }],
		["traversing custody root", { custody: { archiveRoot: "/var/lib/../custody" } }],
		["filesystem root custody", { custody: { archiveRoot: "/" } }],
		["trailing slash custody", { custody: { archiveRoot: "/var/custody/" } }],
		["control character custody", { custody: { archiveRoot: "/var/cus\ntody" } }],
		["digest", { providerBindingSha256: "G".repeat(64) }],
	])("rejects %s", (_name, change) => {
		expect(() => parseCompanyComputerResetPlan({ ...plan(), ...change })).toThrow("INVALID_OFFICE_RESET_PLAN");
	});
	it("bounds the plan size", () => {
		expect(() =>
			parseCompanyComputerResetPlan({ ...plan(), custody: { archiveRoot: `/${"a".repeat(70000)}` } }),
		).toThrow("INVALID_OFFICE_RESET_PLAN");
	});
});
describe("office reset custody manifest contract", () => {
	it("binds the archive to the exact reset and predecessor history", () => {
		const parsed = parseCompanyComputerResetCustodyManifest(custody(), plan());
		expect(parsed.history.files).toHaveLength(5);
		expect(parsed.outbox.recordCount).toBe(2);
		expect(Object.isFrozen(parsed.history.files)).toBe(true);
		expect(companyComputerResetRestorablePath("/etc/qorpera-office/credentials/config.json")).toBe(false);
		expect(companyComputerResetRestorablePath(`${historyRoot}/claim.json`)).toBe(true);
		expect(companyComputerResetRestorablePath("/etc/qorpera-office/adoption.json")).toBe(true);
	});
	it.each([
		["foreign reset", { resetId: id(2) }],
		["foreign incarnation", { rootIncarnationId: id(4) }],
		["foreign predecessor", { predecessorActivationId: id(4) }],
		["outbox overflow", { outbox: { ...custody().outbox, recordCount: 8193 } }],
		["history totals", { history: { ...custody().history, totalBytes: 999 } }],
		["extra", { extra: 1 }],
		["nas identity", { nas: { ...custody().nas, adoptionId: "x" } }],
	])("rejects %s", (_name, change) => {
		expect(() => parseCompanyComputerResetCustodyManifest({ ...custody(), ...change }, plan())).toThrow(
			"INVALID_OFFICE_RESET_CUSTODY_MANIFEST",
		);
	});
	it("allows only sorted allowlisted public history paths with bounded sizes", () => {
		const base = custody();
		for (const files of [
			[...base.history.files].reverse(),
			[
				{ path: "/etc/qorpera-office/credentials/registry", bytes: 1, sha256: sha("5"), mode: 0o400 },
				...base.history.files,
			],
			[
				{ path: "/etc/qorpera-office/adoption.json", bytes: 100, sha256: sha("5"), mode: 0o644 },
				...base.history.files.slice(1),
			],
			[
				{ path: "/etc/qorpera-office/adoption.json", bytes: 65537, sha256: sha("5"), mode: 0o444 },
				...base.history.files.slice(1),
			],
			base.history.files.filter((file) => !file.path.endsWith("claim.json")),
			[...base.history.files, { path: `${historyRoot}/../manifest.json`, bytes: 1, sha256: sha("5"), mode: 0o600 }],
		])
			expect(() =>
				parseCompanyComputerResetCustodyManifest(
					{
						...base,
						history: {
							...base.history,
							files,
							totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
						},
					},
					plan(),
				),
			).toThrow("INVALID_OFFICE_RESET_CUSTODY_MANIFEST");
		expect(() =>
			parseCompanyComputerResetCustodyManifest({ ...base, history: { ...base.history, files: [] } }, plan()),
		).toThrow();
	});
});
describe("office reset restore receipt contract", () => {
	it("binds the restore to the sealed custody digests and a fresh boot", () => {
		const parsed = parseCompanyComputerResetRestoreReceipt(restore(), custody(), plan(), sha("9"));
		expect(parsed.history).toEqual({ fileCount: 4, totalBytes: 800 });
		expect(parsed.outbox.fileCount).toBe(3);
	});
	it.each([
		["custody digest", { custodySha256: sha("1") }],
		["predecessor boot", { bootId: id(11) }],
		["outbox count", { outbox: { ...restore().outbox, fileCount: 2 } }],
		["history count including credentials", { history: { fileCount: 5, totalBytes: 1000 } }],
		["detached nas", { nas: { reattached: false, layoutSha256: sha("8") } }],
		["state", { state: "active" }],
	])("rejects %s", (_name, change) => {
		expect(() =>
			parseCompanyComputerResetRestoreReceipt({ ...restore(), ...change }, custody(), plan(), sha("9")),
		).toThrow("INVALID_OFFICE_RESET_RESTORE_RECEIPT");
	});
});
describe("office reset phase records, evidence, challenges and status", () => {
	it("orders phase records by the fixed sequence", () => {
		for (const [index, phase] of COMPANY_COMPUTER_RESET_PHASES.entries()) {
			const value = {
				schema: "qorpera.office-reset-phase/v1",
				resetId: id(1),
				phase,
				sequence: index + 1,
				previousSha256: index === 0 ? null : sha("a"),
				evidenceSha256: sha("b"),
			};
			expect(parseCompanyComputerResetPhaseRecord(value, plan()).sequence).toBe(index + 1);
			expect(() => parseCompanyComputerResetPhaseRecord({ ...value, sequence: index + 2 }, plan())).toThrow();
			expect(() =>
				parseCompanyComputerResetPhaseRecord({ ...value, previousSha256: index === 0 ? sha("a") : null }, plan()),
			).toThrow();
		}
		expect(() =>
			parseCompanyComputerResetPhaseRecord(
				{
					schema: "qorpera.office-reset-phase/v1",
					resetId: id(1),
					phase: "requested",
					sequence: 0,
					previousSha256: null,
					evidenceSha256: sha("b"),
				},
				plan(),
			),
		).toThrow("INVALID_OFFICE_RESET_PHASE_RECORD");
	});
	it("accepts closed evidence and challenges only for challenge phases", () => {
		const evidence = {
			schema: "qorpera.office-reset-phase-evidence/v1",
			resetId: id(1),
			phase: "powered_off",
			observation: { operationId: id(40) },
		};
		expect(parseCompanyComputerResetPhaseEvidence(evidence, plan(), "powered_off").observation).toEqual({
			operationId: id(40),
		});
		expect(() => parseCompanyComputerResetPhaseEvidence(evidence, plan(), "custodied")).toThrow();
		expect(() =>
			parseCompanyComputerResetPhaseEvidence({ ...evidence, phase: "prepared" }, plan(), "prepared" as never),
		).toThrow("INVALID_OFFICE_RESET_PHASE_EVIDENCE");
		expect(() =>
			parseCompanyComputerResetPhaseEvidence({ ...evidence, observation: {} }, plan(), "powered_off"),
		).toThrow();
		const challenge = {
			schema: "qorpera.office-reset-phase-challenge/v1",
			challengeId: id(50),
			resetId: id(1),
			phase: "powered_off",
			revision: 4,
			officeRevision: 13,
			privacyVersion: 2,
			evidenceSha256: sha("c"),
			validForMs: 4000,
		};
		expect(parseCompanyComputerResetPhaseChallenge(challenge, plan(), "powered_off", id(50), sha("c")).revision).toBe(
			4,
		);
		for (const change of [
			{ validForMs: 5001 },
			{ validForMs: 0 },
			{ phase: "custodied" },
			{ evidenceSha256: sha("d") },
			{ challengeId: id(51) },
			{ extra: true },
		])
			expect(() =>
				parseCompanyComputerResetPhaseChallenge(
					{ ...challenge, ...change },
					plan(),
					"powered_off",
					id(50),
					sha("c"),
				),
			).toThrow("OFFICE_RESET_CHALLENGE_UNCONFIRMED");
	});
	it("requires status fields consistent with the recorded phase", () => {
		const status = {
			schema: "qorpera.office-reset/v1",
			resetId: id(1),
			phase: "custodied",
			revision: 3,
			rootIncarnationId: id(5),
			successorActivationId: id(4),
			custodySha256: sha("9"),
			restoreSha256: null,
			stopAcknowledgedAtMs: 2000,
			officeRevision: 13,
			privacyVersion: 2,
			validForMs: 5000,
		};
		expect(parseCompanyComputerResetStatus(status, plan()).phase).toBe("custodied");
		expect(
			parseCompanyComputerResetStatus(
				{ ...status, phase: "fenced", custodySha256: null, stopAcknowledgedAtMs: null },
				plan(),
			).phase,
		).toBe("fenced");
		for (const change of [
			{ custodySha256: null },
			{ phase: "restored" },
			{ phase: "requested" },
			{ successorActivationId: id(3) },
			{ validForMs: 4000 },
		])
			expect(() => parseCompanyComputerResetStatus({ ...status, ...change }, plan())).toThrow(
				"OFFICE_RESET_STATUS_UNCONFIRMED",
			);
	});
});
describe("office reset successor contract", () => {
	it("requires a distinct activation, boot and configuration on the replace predecessor", () => {
		const request = parseCompanyComputerResetSuccessorRequest(successorRequest());
		expect(request.attestation.bootId).toBe(id(16));
		for (const change of [
			{ predecessor: { ...predecessor(), action: "reboot" } },
			{ attestation: { ...successorRequest().attestation, activationId: id(3) } },
			{ attestation: { ...successorRequest().attestation, bootId: id(11) } },
			{ attestation: { ...successorRequest().attestation, configurationSha256: sha("d") } },
			{ attestation: { ...successorRequest().attestation, bootId: id(1) } },
			{ custodySha256: "x" },
			{ extra: 1 },
		])
			expect(() => parseCompanyComputerResetSuccessorRequest({ ...successorRequest(), ...change })).toThrow(
				"INVALID_OFFICE_RESET_SUCCESSOR_REQUEST",
			);
	});
	it("parses successor metadata bound to the exact request", () => {
		const value = {
			schema: "qorpera.office-reset-successor/v1",
			request: successorRequest(),
			state: "prepared",
			serviceInvocationId: null,
			readinessFresh: false,
			stopAcknowledgedAtMs: 2000,
			officeRevision: 14,
			privacyVersion: 2,
			validForMs: 5000,
		};
		expect(parseCompanyComputerResetSuccessor(value, successorRequest()).state).toBe("prepared");
		expect(
			parseCompanyComputerResetSuccessor(
				{ ...value, state: "active", serviceInvocationId: "f".repeat(32), readinessFresh: true },
				successorRequest(),
			).serviceInvocationId,
		).toBe("f".repeat(32));
		for (const change of [
			{ state: "prepared", serviceInvocationId: "f".repeat(32) },
			{ state: "active", serviceInvocationId: "e".repeat(32) },
			{ state: "active", serviceInvocationId: null },
			{ request: { ...successorRequest(), resetId: id(2) } },
			{ schema: "qorpera.office-service-successor/v1" },
		])
			expect(() => parseCompanyComputerResetSuccessor({ ...value, ...change }, successorRequest())).toThrow(
				"OFFICE_RESET_SUCCESSOR_UNCONFIRMED",
			);
	});
});

describe("repeated reset public configuration custody", () => {
	it.each(["reset-configuration-claim.json", "reset-configuration-completion.json"])(
		"archives %s as history without restoring it as authority",
		(file) => {
			const value = custody(),
				path = `/etc/qorpera-office/boots/${id(11).replaceAll("-", "")}/${file}`;
			const extended = {
				...value,
				history: {
					...value.history,
					totalBytes: value.history.totalBytes + 10,
					files: [...value.history.files, { path, bytes: 10, sha256: sha("a"), mode: 0o600 as const }].sort(
						(a, b) => (a.path < b.path ? -1 : 1),
					),
				},
			};
			expect(parseCompanyComputerResetCustodyManifest(extended, plan())).toEqual(extended);
			expect(companyComputerResetRestorablePath(path)).toBe(false);
		},
	);
});
