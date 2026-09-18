import {
	parseCompanyComputerResetServiceRestartCompletion,
	parseCompanyComputerResetServiceRestartInspection,
	parseCompanyComputerResetServiceRestartRequest,
} from "@qorpera/contracts";
import { describe, expect, it } from "vitest";
import { readCompanyComputerStopInvocation } from "../src/cloud-company-computer-stop-invocation.ts";
import { bootFixtureEncode as encode, bootFixtureId as id } from "./fixtures/company-computer-boot-configuration.ts";
import {
	appendResetServiceRestartFixture,
	resetServiceRestartFixture,
} from "./fixtures/company-computer-reset-service-restart.ts";

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const root = "/run/qorpera-office-preparation";
function fixture() {
	const f = resetServiceRestartFixture(),
		reads: string[] = [];
	const read = async (path: string, limit: number, mode: number) => {
		reads.push(path);
		const file = f.files.get(path);
		if (!file) throw Object.assign(new Error("missing"), { code: "ENOENT" });
		expect(file.mode).toBe(mode);
		expect(file.bytes.length).toBeLessThanOrEqual(limit);
		return Buffer.from(file.bytes);
	};
	return {
		...f,
		reads,
		select: (activation = f.restart.completion.activationId) =>
			readCompanyComputerStopInvocation(activation, f.startCommand.bootId, read),
	};
}
describe("recreated-root service restart contracts and stop selection", () => {
	it("retains the immutable reset receipt across two explicit successors and selects each actual wire completion", async () => {
		const f = fixture(),
			before = encode(f.request),
			receipt = encode(f.receipt),
			second = appendResetServiceRestartFixture(f, f.restart.completion, 2);
		for (const restarted of [f.restart, second]) {
			const selected = await f.select(restarted.completion.activationId);
			expect(selected.kind).toBe("reset_restart");
			expect(selected.start).toEqual(restarted.completion);
			expect(selected.request).toEqual(restarted.request);
			expect(selected.attestation.activationId).toBe(restarted.completion.activationId);
			expect(selected.adoptionPath).toBe("/etc/qorpera-office/adoption.json");
			expect(selected.configurationPath).toBe(`${f.directory}/credentials/config.json`);
			expect(selected.stopPaths.completion).toBe(
				`${root}/service-stop-completion-${restarted.completion.activationId}.json`,
			);
		}
		expect(encode(f.request)).toEqual(before);
		expect(encode(f.receipt)).toEqual(receipt);
		expect(
			f.reads.some((path) => /credentials|workbench|preparation\.json|boot-configuration-incoming/.test(path)),
		).toBe(false);
	});
	it.each(["origin", "successor", "acknowledgement", "stop", "hash", "extra"])(
		"rejects malformed or mismatched request %s",
		(fault) => {
			const f = fixture(),
				r = structuredClone(f.restart.request) as Mutable<typeof f.restart.request>;
			if (fault === "origin") r.origin.request.attestation.configurationObservationSha256 = "e".repeat(64);
			if (fault === "successor") r.successor.request.attestation.configurationObservationSha256 = "e".repeat(64);
			if (fault === "acknowledgement") r.acknowledgement.acknowledgedAtMs++;
			if (fault === "stop") r.stop.revocation.request.activationId = id(902);
			if (fault === "hash") r.stopCompletionSha256 = "secret";
			expect(() =>
				parseCompanyComputerResetServiceRestartRequest(fault === "extra" ? { ...r, extra: true } : r),
			).toThrow("INVALID_OFFICE_RESET_SERVICE_RESTART_REQUEST");
		},
	);
	it.each(["old-invocation", "boot", "origin-activation", "activation", "pid", "command", "schema"])(
		"rejects completion %s",
		(fault) => {
			const f = fixture(),
				r = { ...f.restart.completion };
			if (fault === "old-invocation") r.serviceInvocationId = f.startCompletion.serviceInvocationId;
			if (fault === "boot") r.command = { ...r.command, bootId: id(901) };
			if (fault === "origin-activation") r.originActivationId = id(901);
			if (fault === "activation") r.activationId = f.startCompletion.activationId;
			if (fault === "pid") r.mainPid = 0;
			if (fault === "command") r.command = f.stopCommand;
			expect(() =>
				parseCompanyComputerResetServiceRestartCompletion(
					fault === "schema" ? { ...r, schema: "qorpera.office-service-start-completion/v1" } : r,
					f.restart.command,
					f.restart.request,
				),
			).toThrow();
		},
	);
	it("requires a fresh nonce and the same measured invocation for inspection", () => {
		const f = fixture(),
			nonce = id(970),
			inspection = {
				schema: "qorpera.office-reset-service-restart-inspection/v1",
				inspectionId: nonce,
				start: f.restart.completion,
			};
		expect(
			parseCompanyComputerResetServiceRestartInspection(inspection, nonce, f.restart.completion, f.restart.request),
		).toEqual(inspection);
		for (const bad of [
			{ ...inspection, inspectionId: f.restart.command.commandId },
			{ ...inspection, start: { ...inspection.start, mainPid: 100 } },
			{ ...inspection, start: { ...inspection.start, serviceInvocationId: "e".repeat(32) } },
		])
			expect(() =>
				parseCompanyComputerResetServiceRestartInspection(bad, nonce, f.restart.completion, f.restart.request),
			).toThrow();
	});
	it.each([
		"packet",
		"claim",
		"completion",
		"stop",
		"stop-claim",
		"stop-inspection",
		"origin-packet",
		"origin-completion",
		"receipt",
	])("refuses missing %s", async (fault) => {
		const f = fixture(),
			r = f.restart;
		const paths = {
			packet: r.stagePath,
			claim: r.claimPath,
			completion: r.completionPath,
			stop: r.stopCompletionPath,
			"stop-claim": `${root}/service-stop-claim-${f.startCompletion.activationId}.json`,
			"stop-inspection": `${root}/service-stop-inspection-${r.inspection.inspectionId}.json`,
			"origin-packet": `${root}/reset-service-start-incoming-${f.startCommand.requestSha256}.json`,
			"origin-completion": `${root}/reset-service-start-completion.json`,
			receipt: "/etc/qorpera-office/adoption.json",
		};
		f.files.delete(paths[fault as keyof typeof paths]);
		await expect(f.select()).rejects.toThrow();
	});
	it("rejects a replaced predecessor in a later successor without reading secret material", async () => {
		const f = fixture(),
			second = appendResetServiceRestartFixture(f, f.restart.completion, 2);
		f.files.get(f.restart.claimPath)!.bytes = encode({});
		await expect(f.select(second.completion.activationId)).rejects.toThrow("claim differs");
	});
});
