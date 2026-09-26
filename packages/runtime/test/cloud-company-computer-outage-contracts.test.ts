import {
	companyComputerOutageAdoptionReceiptCanonical,
	companyComputerOutageTerminationAcknowledgementCanonical,
	parseCompanyComputerOutageAdoptionReceipt,
	parseCompanyComputerOutageConfigurationAuthority,
	parseCompanyComputerOutageConfigurationCompletion,
	parseCompanyComputerOutageConfigurationRequest,
	parseCompanyComputerOutageRecoveryAuthority,
	parseCompanyComputerOutageServiceStartCompletion,
	parseCompanyComputerOutageServiceStartRequest,
	parseCompanyComputerOutageSuccessorAuthority,
	parseCompanyComputerOutageTerminationAcknowledgement,
} from "@qorpera/contracts";
import { describe, expect, it } from "vitest";
import { bootFixtureHash as hash, bootFixtureId as id } from "./fixtures/company-computer-boot-configuration.ts";

import { companyComputerOutageFixture as fixture } from "./fixtures/company-computer-outage.ts";

describe("outage recovery handoff contracts", () => {
	it("retains identical public adoption bytes across recursively reordered transport objects", () => {
		const f = fixture(),
			reordered = {
				...f.receipt,
				recovery: {
					predecessor: f.receipt.recovery.predecessor,
					request: {
						startCommandId: f.request.startCommandId,
						activationId: f.request.activationId,
						outageRequestId: f.request.outageRequestId,
						recoveryId: f.request.recoveryId,
						schema: f.request.schema,
					},
				},
			};
		expect(companyComputerOutageAdoptionReceiptCanonical(reordered)).toBe(
			companyComputerOutageAdoptionReceiptCanonical(f.receipt),
		);
	});
	it("rejects reuse of the inspection nonce as its command identity", () => {
		const f = fixture(),
			inspection = f.termination.request.inspection;
		expect(() =>
			parseCompanyComputerOutageTerminationAcknowledgement({
				...f.termination,
				request: {
					...f.termination.request,
					inspection: { ...inspection, command: { ...inspection.command, commandId: inspection.inspectionId } },
				},
			}),
		).toThrow();
	});
	it("requires the exact termination acknowledgement for configuration authority", () => {
		const f = fixture(),
			expected = { recovery: f.request, termination: f.termination },
			authority = {
				schema: "qorpera.office-outage-configuration-authority/v1",
				recovery: f.recovery,
				termination: f.termination,
				validForMs: 5000,
			};
		expect(parseCompanyComputerOutageConfigurationAuthority(authority, expected).termination).toEqual(f.termination);
		expect(() =>
			parseCompanyComputerOutageConfigurationAuthority(
				{ ...authority, termination: { ...f.termination, officeRevision: 5 } },
				expected,
			),
		).toThrow();
		expect(() => parseCompanyComputerOutageConfigurationAuthority(f.recovery, expected)).toThrow();
		expect(() =>
			parseCompanyComputerOutageConfigurationAuthority({ ...authority, validForMs: 6000 }, expected),
		).toThrow();
	});
	it("separates persisted metadata from fresh dispatch authority", () => {
		const f = fixture();
		expect(() => parseCompanyComputerOutageRecoveryAuthority(f.recovery, f.request)).toThrow();
		expect(() => parseCompanyComputerOutageSuccessorAuthority(f.successor, f.successorRequest)).toThrow();
		expect(
			parseCompanyComputerOutageRecoveryAuthority(
				{ schema: "qorpera.office-outage-recovery-authority/v1", recovery: f.recovery, validForMs: 5000 },
				f.request,
			).recovery,
		).toEqual(f.recovery);
		expect(() =>
			parseCompanyComputerOutageRecoveryAuthority(
				{ schema: "qorpera.office-outage-recovery-authority/v1", recovery: f.recovery, validForMs: 60000 },
				f.request,
			),
		).toThrow();
	});
	it("binds the same acknowledgement hash regardless of JSON key order", () => {
		const f = fixture();
		const reordered = {
			acknowledgedAtMs: f.termination.acknowledgedAtMs,
			officeRevision: f.termination.officeRevision,
			request: { inspection: f.termination.request.inspection, recovery: f.termination.request.recovery },
			schema: f.termination.schema,
		};
		expect(companyComputerOutageTerminationAcknowledgementCanonical(reordered)).toBe(
			companyComputerOutageTerminationAcknowledgementCanonical(f.termination),
		);
	});
	it("publishes only compact immutable identity and proof hashes", () => {
		const f = fixture(),
			encoded = JSON.stringify(f.receipt);
		expect(encoded).not.toContain("must-remain-protected");
		expect(encoded).not.toContain("privacyChallenge");
		expect(encoded).not.toContain("drains");
		expect(encoded.length).toBeLessThan(16384);
		expect(f.receipt.terminationSha256).toBe(
			hash(companyComputerOutageTerminationAcknowledgementCanonical(f.termination)),
		);
		expect(() => parseCompanyComputerOutageAdoptionReceipt({ ...f.receipt, recovery: f.recovery })).toThrow();
		expect(() =>
			parseCompanyComputerOutageAdoptionReceipt({ ...f.receipt, bootId: f.recovery.predecessor.startup.bootId }),
		).toThrow();
	});
	it.each(["bootId", "hostBootId", "physicalInstanceId", "startCommandId", "recoveryId"])(
		"rejects substituted %s between boot and root inspection",
		(key) => {
			const f = fixture();
			expect(() =>
				parseCompanyComputerOutageConfigurationRequest({
					...f.configuration,
					observation: { ...f.observation, [key]: id(999) },
				}),
			).toThrow();
		},
	);
	it.each(["recoveryId", "activationId", "adoptionReceiptSha256", "bootObservationSha256"])(
		"rejects substituted configuration %s before service dispatch",
		(key) => {
			const f = fixture();
			expect(() =>
				parseCompanyComputerOutageServiceStartRequest({
					...f.start,
					configuration: { ...f.completion, [key]: key.endsWith("Sha256") ? "0".repeat(64) : id(999) },
				}),
			).toThrow();
		},
	);
	it.each([
		"recoveryId",
		"activationId",
		"configurationCompletionSha256",
		"configurationSha256",
		"controlGroup",
		"mainPid",
	])("rejects substituted service completion %s", (key) => {
		const f = fixture();
		expect(() =>
			parseCompanyComputerOutageServiceStartCompletion(
				{ ...f.started, [key]: key === "mainPid" ? 0 : key.endsWith("Sha256") ? "0".repeat(64) : id(999) },
				f.startCommand,
				f.start,
			),
		).toThrow();
	});
	it("rejects a zero invocation, unexpected fields, and partial file manifests", () => {
		const f = fixture();
		expect(() =>
			parseCompanyComputerOutageServiceStartCompletion(
				{ ...f.started, serviceInvocationId: "0".repeat(32) },
				f.startCommand,
				f.start,
			),
		).toThrow();
		expect(() => parseCompanyComputerOutageServiceStartRequest({ ...f.start, validForMs: 5000 })).toThrow();
		expect(() =>
			parseCompanyComputerOutageConfigurationCompletion({
				...f.completion,
				files: { "config.json": f.completion.files["config.json"] },
			}),
		).toThrow();
	});
});
