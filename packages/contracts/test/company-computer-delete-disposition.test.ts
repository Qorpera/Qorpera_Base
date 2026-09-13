import { describe, expect, it } from "vitest";
import {
	type CompanyComputerDeleteAdministrativeDisposition,
	type CompanyComputerDeleteDispositionBinding,
	parseCompanyComputerDeleteAdministrativeDisposition,
} from "../src/company-computer-delete-disposition.ts";

const id = (n: number) => `12345678-1234-4234-8234-${String(n).padStart(12, "0")}`;
const sha = (n: string) => n.repeat(64);
function fixture(): {
	binding: CompanyComputerDeleteDispositionBinding;
	value: CompanyComputerDeleteAdministrativeDisposition;
} {
	const binding: CompanyComputerDeleteDispositionBinding = {
		plan: {
			schema: "qorpera.lxd-office-reset-plan/v1",
			resetId: id(1),
			intentId: id(13),
			predecessor: {
				schema: "qorpera.office-lifecycle-request/v1",
				transitionId: id(2),
				action: "replace",
				activationId: id(3),
				providerId: id(12),
				providerPolicySha256: sha("f"),
				startup: {
					scope: { companyId: id(6), environmentId: id(7), companyComputerId: id(8), logicalComputerId: id(9) },
					computerGeneration: 1,
					allocationId: id(10),
					instanceSha256: sha("a"),
					imageSha256: sha("b"),
					bootstrapSha256: sha("c"),
					bootId: id(11),
					configurationSha256: sha("d"),
					serviceInvocationId: "e".repeat(32),
				},
			},
			preparationObservationSha256: sha("1"),
			providerBindingSha256: sha("2"),
			nodeId: id(14),
			predecessorRootIncarnationId: null,
			rootIncarnationId: id(5),
			successorActivationId: id(4),
			commands: { stopCommandId: id(20), deleteCommandId: id(21), createCommandId: id(22), startCommandId: id(23) },
			custody: { archiveRoot: "/var/lib/qorpera-office-provider/reset-custody" },
		},
		planSha256: sha("3"),
		operationId: id(40),
		journal: { authoritySha256: sha("4"), acceptedHeadSha256: sha("5"), eventCount: 11 },
		custodyEvidenceSha256: sha("6"),
		stopAcknowledgementSha256: sha("7"),
		poweredOffPhaseSha256: sha("8"),
	};
	const value: CompanyComputerDeleteAdministrativeDisposition = {
		schema: "qorpera.office-delete-administrative-disposition/v1",
		auditId: id(41),
		resetId: binding.plan.resetId,
		planSha256: binding.planSha256,
		deleteCommandId: binding.plan.commands.deleteCommandId,
		operationId: binding.operationId,
		nextCreateCommandId: binding.plan.commands.createCommandId,
		originalOutcome: "unknown",
		targetPostcondition: "absent",
		journal: { ...binding.journal },
		custodyEvidenceSha256: binding.custodyEvidenceSha256,
		stopAcknowledgementSha256: binding.stopAcknowledgementSha256,
		poweredOffPhaseSha256: binding.poweredOffPhaseSha256,
		operator: {
			principalId: id(42),
			reasonCode: "accepted_delete_result_unavailable",
			reason: "Accepted delete result was not retained.",
		},
		source: { sourceCommit: "a".repeat(40), artifactSha256: sha("9") },
		executionFence: {
			schema: "qorpera.office-delete-execution-fence/v1",
			mechanism: "lxd-ab8fad2-zfs-ordered-delete/v1",
			sha256: sha("a"),
		},
		physicalEvidence: { schema: "qorpera.office-delete-physical-evidence/v1", sha256: sha("b") },
		observedAt: "2020-01-01T00:00:00.000Z",
	};
	return { binding, value };
}
const parse = (value: unknown, binding = fixture().binding) =>
	parseCompanyComputerDeleteAdministrativeDisposition(value, binding);
const error = "INVALID_OFFICE_DELETE_ADMINISTRATIVE_DISPOSITION";

describe("same-reset administrative delete disposition", () => {
	it("retains unknown and creates an immutable audit without changing the plan or accepted prefix", () => {
		const { value, binding } = fixture(),
			before = structuredClone({ value, binding });
		const parsed = parse(value, binding);
		expect(parsed).toEqual(value);
		expect(parsed.originalOutcome).toBe("unknown");
		expect(parsed).not.toHaveProperty("state");
		for (const part of [
			parsed,
			parsed.journal,
			parsed.operator,
			parsed.source,
			parsed.executionFence,
			parsed.physicalEvidence,
		])
			expect(Object.isFrozen(part)).toBe(true);
		expect({ value, binding }).toEqual(before);
		Object.assign(value.journal, { acceptedHeadSha256: sha("c") });
		expect(parsed.journal.acceptedHeadSha256).toBe(sha("5"));
	});
	it.each([
		"schema",
		"resetId",
		"deleteCommandId",
		"operationId",
		"nextCreateCommandId",
		"planSha256",
		"custodyEvidenceSha256",
		"stopAcknowledgementSha256",
		"poweredOffPhaseSha256",
	])("rejects a changed %s rather than accepting a new operation or evidence reference", (key) => {
		const { value, binding } = fixture();
		expect(() => parse({ ...value, [key]: key.endsWith("Sha256") ? sha("0") : id(99) }, binding)).toThrow(error);
	});
	it.each(["succeeded", "failed", "pending", null])("never upgrades unknown to %s", (originalOutcome) => {
		expect(() => parse({ ...fixture().value, originalOutcome })).toThrow(error);
	});
	it("refuses non-replace or foreign reset contexts and invalid expected digests", () => {
		const { value, binding } = fixture();
		for (const changed of [
			{ ...binding, plan: { ...binding.plan, resetId: id(90) } },
			{ ...binding, plan: { ...binding.plan, predecessor: { ...binding.plan.predecessor, action: "reboot" } } },
			{ ...binding, planSha256: "not-a-digest" },
		])
			expect(() => parse(value, changed as CompanyComputerDeleteDispositionBinding)).toThrow(error);
	});
	it.each(["authoritySha256", "acceptedHeadSha256", "eventCount"])("binds exact journal %s", (key) => {
		const { value } = fixture();
		expect(() =>
			parse({ ...value, journal: { ...value.journal, [key]: key === "eventCount" ? 14 : sha("0") } }),
		).toThrow(error);
	});
	it.each([0, 2, 8, 10, 12, 384, 386, 11.5, Number.MAX_SAFE_INTEGER, "11", null])(
		"rejects prefix count %s even when both supplied counts agree",
		(eventCount) => {
			const { value, binding } = fixture();
			expect(() =>
				parse({ ...value, journal: { ...value.journal, eventCount } }, {
					...binding,
					journal: { ...binding.journal, eventCount },
				} as CompanyComputerDeleteDispositionBinding),
			).toThrow(error);
		},
	);
	it("parses historical valid prefixes without claiming remaining execution capacity", () => {
		const { value, binding } = fixture();
		expect(
			parse(
				{ ...value, journal: { ...value.journal, eventCount: 383 } },
				{ ...binding, journal: { ...binding.journal, eventCount: 383 } },
			).journal.eventCount,
		).toBe(383);
	});
	it("rejects audit or operation identity aliases", () => {
		const { value, binding } = fixture();
		for (const auditId of [
			binding.operationId,
			binding.plan.resetId,
			binding.plan.intentId,
			binding.plan.commands.createCommandId,
			binding.plan.predecessor.startup.allocationId,
		])
			expect(() => parse({ ...value, auditId })).toThrow(error);
		const operationId = binding.plan.commands.deleteCommandId;
		expect(() => parse({ ...value, operationId }, { ...binding, operationId })).toThrow(error);
	});
	it("rejects force, success and credential/session fields at every closed level", () => {
		const { value } = fixture();
		for (const changed of [
			{ ...value, force: true },
			{ ...value, state: "succeeded" },
			{ ...value, operator: { ...value.operator, sessionToken: "private" } },
			{ ...value, executionFence: { ...value.executionFence, safe: true } },
			{ ...value, physicalEvidence: { ...value.physicalEvidence, path: "/arbitrary" } },
			{ ...value, source: { ...value.source, runtimeBundle: 24 } },
			{ ...value, journal: { ...value.journal, extra: true } },
		])
			expect(() => parse(changed)).toThrow(error);
	});
	it("rejects accessors, symbol and non-data records without evaluating an accessor", () => {
		const { value } = fixture();
		let calls = 0;
		const getter = { ...value };
		Object.defineProperty(getter, "auditId", {
			get: () => {
				calls++;
				return value.auditId;
			},
		});
		for (const invalid of [
			getter,
			{ ...value, [Symbol("private")]: true },
			Object.assign(Object.create(null), value),
			[],
		])
			expect(() => parse(invalid)).toThrow(error);
		expect(calls).toBe(0);
	});
	it("requires the named versioned mechanism and public evidence digests, not a generic safety flag", () => {
		const { value } = fixture();
		for (const changed of [
			{ ...value, targetPostcondition: "present" },
			{ ...value, executionFence: { ...value.executionFence, mechanism: "operator-approved" } },
			{ ...value, executionFence: { ...value.executionFence, schema: "qorpera.office-delete-execution-fence/v2" } },
			{ ...value, executionFence: { ...value.executionFence, sha256: true } },
			{ ...value, physicalEvidence: { ...value.physicalEvidence, sha256: "x" } },
			{ ...value, physicalEvidence: { ...value.physicalEvidence, schema: "unknown" } },
			{ ...value, source: { ...value.source, sourceCommit: "HEAD" } },
			{ ...value, source: { ...value.source, artifactSha256: "A".repeat(64) } },
		])
			expect(() => parse(changed)).toThrow(error);
	});
	it("bounds the operator reason and records a principal without requiring a live session", () => {
		const { value } = fixture();
		for (const reason of ["", " padded", "line\nbreak", "x".repeat(513)])
			expect(() => parse({ ...value, operator: { ...value.operator, reason } })).toThrow(error);
		for (const operator of [
			{ ...value.operator, principalId: "operator" },
			{ ...value.operator, reasonCode: "force" },
		])
			expect(() => parse({ ...value, operator })).toThrow(error);
		expect(parse(value).operator.principalId).toBe(value.operator.principalId);
	});
	it("validates original time syntax without converting old or future references into freshness authority", () => {
		const { value } = fixture();
		for (const observedAt of [value.observedAt, "2099-01-01T00:00:00.000Z"])
			expect(parse({ ...value, observedAt }).observedAt).toBe(observedAt);
		for (const observedAt of [
			"2020-02-30T00:00:00.000Z",
			"2020-01-01T00:00:00Z",
			"2020-01-01T00:00:00.000+00:00",
			"yesterday",
		])
			expect(() => parse({ ...value, observedAt })).toThrow(error);
	});
});
