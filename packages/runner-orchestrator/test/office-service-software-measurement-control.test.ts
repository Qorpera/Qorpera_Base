import { createHash, randomUUID } from "node:crypto";
import {
	COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH,
	companyComputerServiceSoftwareMeasurementText,
	parseCompanyComputerServiceSoftwareInvocationChallenge,
	parseCompanyComputerServiceSoftwareInvocationEvidence,
} from "@qorpera/contracts";
import { describe, expect, it, vi } from "vitest";
import {
	measureOfficeSoftwareWithinClaim,
	OFFICE_SOFTWARE_MEASUREMENT_CLAIM_SCHEMA,
	OFFICE_SOFTWARE_MEASUREMENT_RECEIPT_SCHEMA,
	type OfficeSoftwareMeasurementPorts,
	officeSoftwareMeasurementPaths,
	parseOfficeSoftwareMeasurementArgs,
} from "../../../deploy/lxd-company-computer-guest/office-service-software-measurement-control.ts";
import { officeSoftwareFixture } from "./fixtures/office-software.ts";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const missing = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
function fixture() {
	const f = officeSoftwareFixture();
	const startup = { ...f.plan.predecessor.startup, serviceInvocationId: "d".repeat(32) };
	const challenge = parseCompanyComputerServiceSoftwareInvocationChallenge({
		schema: "qorpera.office-software-invocation-challenge/v1",
		challengeId: randomUUID(),
		activationId: f.plan.successorActivationId,
		startup,
		revision: 1,
		capabilityRevision: 2,
		service: { ...f.statement.next.service, path: COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH },
		validForMs: 4000,
	});
	const requestText = companyComputerServiceSoftwareMeasurementText(challenge);
	const command = { commandId: randomUUID(), requestSha256: sha(requestText), bootId: startup.bootId };
	const input = { command, toolSha256: sha("measurement tool") };
	const { validForMs: _remaining, ...binding } = challenge;
	const evidence = parseCompanyComputerServiceSoftwareInvocationEvidence(
		{
			...binding,
			schema: "qorpera.office-software-invocation-evidence/v1",
			mainPid: 700,
			controlGroup: "/system.slice/qorpera-company-computer.service",
			configurationCompletionSha256: "a".repeat(64),
			serviceStartCompletionSha256: "b".repeat(64),
		},
		challenge,
	);
	const evidenceSha256 = sha(companyComputerServiceSoftwareMeasurementText(evidence));
	const files = new Map<string, { bytes: Buffer; mode: number }>();
	files.set(officeSoftwareMeasurementPaths.incoming(command.requestSha256), {
		bytes: Buffer.from(requestText),
		mode: 0o400,
	});
	const trace: string[] = [];
	const ports = {
		lockAndBoot: vi.fn<OfficeSoftwareMeasurementPorts["lockAndBoot"]>(async (value) => {
			trace.push("lock");
			expect(value).toEqual(command);
		}),
		read: vi.fn<OfficeSoftwareMeasurementPorts["read"]>(async (path, limit, mode) => {
			const file = files.get(path);
			if (!file) throw missing();
			if (file.mode !== mode || file.bytes.length > limit) throw new Error("unprotected");
			return Buffer.from(file.bytes);
		}),
		publish: vi.fn<OfficeSoftwareMeasurementPorts["publish"]>(async (path, bytes, mode) => {
			trace.push(`publish:${path.split("/").at(-1)?.split("-").slice(0, 3).join("-")}`);
			const existing = files.get(path);
			if (existing) {
				if (!existing.bytes.equals(bytes)) throw new Error("conflict");
				return false;
			}
			files.set(path, { bytes: Buffer.from(bytes), mode });
			return true;
		}),
		measure: vi.fn<OfficeSoftwareMeasurementPorts["measure"]>(async (value, parsed, signal) => {
			trace.push("measure");
			signal.throwIfAborted();
			expect(value).toEqual(command);
			expect(parsed).toEqual(challenge);
			return { evidence, evidenceSha256 };
		}),
	};
	const run = (signal = new AbortController().signal) => measureOfficeSoftwareWithinClaim(input, ports, signal);
	return { f, challenge, command, input, requestText, evidence, evidenceSha256, files, ports, trace, run };
}
describe("temporary root software measurement control", () => {
	it("accepts only a closed command and one independent tool digest", () => {
		const args = [randomUUID(), sha("request"), randomUUID(), sha("tool")];
		expect(parseOfficeSoftwareMeasurementArgs(args).locked).toBe(false);
		expect(parseOfficeSoftwareMeasurementArgs(["--locked", ...args])).toMatchObject({
			locked: true,
			toolSha256: sha("tool"),
		});
		for (const change of [args.slice(1), [...args, sha("trust")], [...args.slice(0, 3), "/tool"], ["--locked"]])
			expect(() => parseOfficeSoftwareMeasurementArgs(change)).toThrow();
	});
	it("claims the nonce under the lock before measuring and publishes a closed receipt without stdout", async () => {
		const f = fixture();
		const receipt = await f.run();
		expect(receipt).toEqual({
			schema: OFFICE_SOFTWARE_MEASUREMENT_RECEIPT_SCHEMA,
			challengeId: f.challenge.challengeId,
			evidence: f.evidence,
			evidenceSha256: f.evidenceSha256,
		});
		expect(f.trace).toEqual([
			"lock",
			"lock",
			"publish:software-measurement-claim",
			"measure",
			"lock",
			`publish:software-measurement-${f.challenge.challengeId.split("-")[0]}`,
		]);
		const claim = JSON.parse(
			f.files.get(officeSoftwareMeasurementPaths.claim(f.challenge.challengeId))!.bytes.toString(),
		);
		expect(claim).toEqual({
			schema: OFFICE_SOFTWARE_MEASUREMENT_CLAIM_SCHEMA,
			activationId: f.challenge.activationId,
			challengeId: f.challenge.challengeId,
			command: f.command,
			toolSha256: f.input.toolSha256,
		});
		for (const file of f.files.values()) expect(file.mode).toBe(0o400);
		const published = f.files.get(officeSoftwareMeasurementPaths.receipt(f.challenge.challengeId))!.bytes.toString();
		expect(published.endsWith("\n")).toBe(true);
		expect(JSON.parse(published)).toEqual({ ...receipt });
		expect(published).not.toContain("providerCapability");
	});
	it("returns only the retained receipt on exact replay without measuring again", async () => {
		const f = fixture();
		const first = await f.run();
		f.trace.length = 0;
		await expect(f.run()).resolves.toEqual(first);
		expect(f.ports.measure).toHaveBeenCalledTimes(1);
		expect(f.ports.publish).toHaveBeenCalledTimes(2);
		expect(f.trace).toEqual(["lock"]);
	});
	it("holds an incomplete identical claim instead of rerunning measurement", async () => {
		const f = fixture();
		f.ports.measure.mockRejectedValueOnce(new Error("OFFICE_SOFTWARE_INVOCATION_UNCONFIRMED"));
		await expect(f.run()).rejects.toThrow("OFFICE_SOFTWARE_INVOCATION_UNCONFIRMED");
		expect(f.files.has(officeSoftwareMeasurementPaths.claim(f.challenge.challengeId))).toBe(true);
		await expect(f.run()).rejects.toThrow("OFFICE_SOFTWARE_MEASUREMENT_CLAIM_INCOMPLETE");
		expect(f.ports.measure).toHaveBeenCalledTimes(1);
		expect(f.files.size).toBe(2);
	});
	it("holds a conflicting claim, a receipt without claim, and a receipt bound elsewhere", async () => {
		const conflicting = fixture();
		conflicting.files.set(officeSoftwareMeasurementPaths.claim(conflicting.challenge.challengeId), {
			bytes: Buffer.from(
				`${JSON.stringify({ schema: OFFICE_SOFTWARE_MEASUREMENT_CLAIM_SCHEMA, challengeId: conflicting.challenge.challengeId, activationId: conflicting.challenge.activationId, command: { ...conflicting.command, commandId: randomUUID() }, toolSha256: conflicting.input.toolSha256 })}\n`,
			),
			mode: 0o400,
		});
		await expect(conflicting.run()).rejects.toThrow("OFFICE_SOFTWARE_MEASUREMENT_CLAIM_CONFLICT");
		expect(conflicting.ports.measure).not.toHaveBeenCalled();
		const unclaimed = fixture();
		const _done = await unclaimed.run();
		unclaimed.files.delete(officeSoftwareMeasurementPaths.claim(unclaimed.challenge.challengeId));
		await expect(unclaimed.run()).rejects.toThrow("OFFICE_SOFTWARE_MEASUREMENT_RECEIPT_UNCLAIMED");
		const rebound = fixture();
		const other = fixture();
		const own = await rebound.run();
		rebound.files.set(officeSoftwareMeasurementPaths.receipt(rebound.challenge.challengeId), {
			bytes: Buffer.from(
				`${JSON.stringify({ ...own, evidence: other.evidence, evidenceSha256: other.evidenceSha256 })}\n`,
			),
			mode: 0o400,
		});
		await expect(rebound.run()).rejects.toThrow("INVALID_OFFICE_SOFTWARE_INVOCATION_EVIDENCE");
		expect(rebound.ports.measure).toHaveBeenCalledTimes(1);
	});
	it.each([
		[
			"digest",
			(f: ReturnType<typeof fixture>) => ({ ...f.input, command: { ...f.command, requestSha256: sha("other") } }),
		],
		["boot", (f: ReturnType<typeof fixture>) => ({ ...f.input, command: { ...f.command, bootId: randomUUID() } })],
		[
			"nonce",
			(f: ReturnType<typeof fixture>) => ({
				...f.input,
				command: { ...f.command, commandId: f.challenge.challengeId },
			}),
		],
	])("refuses a request whose %s does not bind the staged canonical challenge", async (_name, change) => {
		const f = fixture();
		const input = change(f);
		if (input.command.requestSha256 !== f.command.requestSha256)
			f.files.set(officeSoftwareMeasurementPaths.incoming(input.command.requestSha256), {
				bytes: Buffer.from(f.requestText),
				mode: 0o400,
			});
		await expect(measureOfficeSoftwareWithinClaim(input, f.ports, new AbortController().signal)).rejects.toThrow();
		expect(f.ports.publish).not.toHaveBeenCalled();
		expect(f.ports.measure).not.toHaveBeenCalled();
	});
	it.each([
		["non-canonical bytes", (text: string) => JSON.stringify(JSON.parse(text))],
		["unknown field", (text: string) => `${JSON.stringify({ ...JSON.parse(text), extra: true })}\n`],
		["invalid utf-8", () => Buffer.from([0xff, 0xfe])],
	])("refuses a staged packet with %s even when its digest matches", async (_name, change) => {
		const f = fixture();
		const bytes = Buffer.from(change(f.requestText) as string | Buffer);
		const command = { ...f.command, requestSha256: sha(bytes) };
		f.files.set(officeSoftwareMeasurementPaths.incoming(command.requestSha256), { bytes, mode: 0o400 });
		await expect(
			measureOfficeSoftwareWithinClaim({ ...f.input, command }, f.ports, new AbortController().signal),
		).rejects.toThrow();
		expect(f.ports.publish).not.toHaveBeenCalled();
	});
	it("refuses evidence whose digest or binding differs and leaves the claim retained", async () => {
		const f = fixture();
		f.ports.measure.mockResolvedValueOnce({ evidence: f.evidence, evidenceSha256: sha("other") });
		await expect(f.run()).rejects.toThrow("OFFICE_SOFTWARE_MEASUREMENT_EVIDENCE");
		expect(f.files.has(officeSoftwareMeasurementPaths.receipt(f.challenge.challengeId))).toBe(false);
		const changed = fixture();
		changed.ports.measure.mockResolvedValueOnce({
			evidence: { ...changed.evidence, mainPid: 701 },
			evidenceSha256: changed.evidenceSha256,
		});
		await expect(changed.run()).rejects.toThrow();
		expect(changed.files.has(officeSoftwareMeasurementPaths.receipt(changed.challenge.challengeId))).toBe(false);
	});
	it("stops before durable work when cancelled and does not measure after a lost lock", async () => {
		const cancelled = fixture();
		const controller = new AbortController();
		controller.abort();
		await expect(cancelled.run(controller.signal)).rejects.toThrow();
		expect(cancelled.ports.publish).not.toHaveBeenCalled();
		const lost = fixture();
		lost.ports.lockAndBoot
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("OFFICE_PREPARATION_KERNEL_LOCK_REQUIRED"));
		await expect(lost.run()).rejects.toThrow("OFFICE_PREPARATION_KERNEL_LOCK_REQUIRED");
		expect(lost.ports.publish).not.toHaveBeenCalled();
		expect(lost.ports.measure).not.toHaveBeenCalled();
	});
});
