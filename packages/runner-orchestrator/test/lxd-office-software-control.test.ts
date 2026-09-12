import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { officeDigest } from "../src/lxd-office-image-provenance.ts";
import { LxdOfficeSoftwareControl, type LxdOfficeSoftwareRegistry } from "../src/lxd-office-software-control.ts";
import { officeSoftwareFixture } from "./fixtures/office-software.ts";

function fixture(override?: LxdOfficeSoftwareRegistry["call"]) {
	const f = officeSoftwareFixture(),
		stop = { fixture: "protected stop acknowledgement" };
	f.plan.stopAcknowledgementSha256 = officeDigest(stop);
	f.trust.planSha256 = officeDigest(f.plan);
	f.receipt.planSha256 = f.trust.planSha256;
	const capability = "1234567890abcdef".repeat(4);
	const calls: string[] = [];
	let installed = false,
		challengeId: string | null = null;
	const evidenceSha256 = "f".repeat(64);
	const registry: LxdOfficeSoftwareRegistry = {
		async call(method, args, signal) {
			calls.push(method);
			expect(args.p_provider_capability).toBe(capability);
			if (override) return override(method, args, signal);
			if (method === "qorpera_enroll_office_software")
				return {
					schema: "qorpera.office-software-baseline/v1",
					allocationId: f.plan.predecessor.startup.allocationId,
					base: f.statement.base,
					revision: 0,
				};
			if (method === "qorpera_begin_office_software") {
				expect(officeDigest(JSON.parse(args.p_plan_text as string))).toBe(f.trust.planSha256);
				expect(officeDigest(JSON.parse(args.p_stop_text as string))).toBe(f.plan.stopAcknowledgementSha256);
				return { updateId: f.plan.updateId, state: "begun", targetRevision: 1 };
			}
			if (method === "qorpera_check_office_software_install") {
				challengeId = args.p_challenge_id as string;
				return {
					schema: "qorpera.office-software-install-challenge/v1",
					challengeId,
					plan: f.plan,
					planSha256: f.trust.planSha256,
					statement: f.statement,
					targetRevision: 1,
					capabilityRevision: 1,
					validForMs: 5000,
				};
			}
			if (method === "qorpera_ack_office_software_install") {
				expect(args.p_challenge_id).toBe(challengeId);
				expect(JSON.parse(args.p_receipt_text as string)).toEqual(f.receipt);
				expect(args.p_measured_service).toEqual(f.statement.next.service);
				installed = true;
				return {
					schema: "qorpera.office-software-installation/v1",
					updateId: f.plan.updateId,
					state: "installed",
					targetRevision: 1,
				};
			}
			return {
				schema: "qorpera.office-software-status/v1",
				plan: f.plan,
				statement: f.statement,
				base: f.statement.base,
				state: installed ? "installed" : "begun",
				currentRevision: installed ? 1 : 0,
				targetRevision: 1,
				receipt: installed ? f.receipt : null,
				installationChallengeId: installed ? challengeId : null,
				installationEvidenceSha256: installed ? evidenceSha256 : null,
			};
		},
	};
	const control = new LxdOfficeSoftwareControl(
		{ ...f, expectedRevision: 0, providerCapability: capability },
		registry,
	);
	const measurement = { receipt: f.receipt, measuredService: f.statement.next.service, evidenceSha256 };
	return { ...f, stop, control, registry, capability, calls, measurement };
}
const signal = () => new AbortController().signal;
afterEach(() => vi.restoreAllMocks());
describe("provider software update SQL control", () => {
	it("binds enrollment, signed documents, physical evidence and metadata-only recovery", async () => {
		const f = fixture();
		await f.control.enroll("a".repeat(64), signal());
		await f.control.begin(f.stop, signal());
		expect((await f.control.status(signal())).state).toBe("begun");
		const result = await f.control.install(async (challenge, deadline, checked) => {
			expect(challenge.plan).toEqual(f.plan);
			expect(Object.isFrozen(challenge.plan.predecessor)).toBe(true);
			expect(deadline - performance.now()).toBeLessThanOrEqual(5000);
			checked.throwIfAborted();
			return f.measurement;
		}, signal());
		expect(result.targetRevision).toBe(1);
		expect((await f.control.status(signal())).state).toBe("installed");
		expect(JSON.stringify(result)).not.toContain(f.capability);
		expect(f.calls.filter((method) => method === "qorpera_ack_office_software_install")).toHaveLength(1);
	});
	it("refuses changed stop evidence before a database call", () => {
		const f = fixture();
		expect(() => f.control.begin({ changed: true }, signal())).toThrow("OFFICE_SOFTWARE_STOP_CHANGED");
		expect(f.calls).toEqual([]);
	});
	it.each(["id", "plan", "statement", "revision", "expiry", "extra"])(
		"refuses rebound %s challenge before physical work",
		async (field) => {
			let f: ReturnType<typeof fixture>;
			f = fixture(async (_method, args) => ({
				schema: "qorpera.office-software-install-challenge/v1",
				challengeId: field === "id" ? randomUUID() : args.p_challenge_id,
				plan: field === "plan" ? { ...f.plan, successorActivationId: randomUUID() } : f.plan,
				planSha256: f.trust.planSha256,
				statement: field === "statement" ? {} : f.statement,
				targetRevision: field === "revision" ? 2 : 1,
				capabilityRevision: 1,
				validForMs: field === "expiry" ? 5001 : 5000,
				...(field === "extra" ? { extra: true } : {}),
			}));
			const physical = vi.fn(async () => f.measurement);
			await expect(f.control.install(physical, signal())).rejects.toThrow("OFFICE_SOFTWARE_CONTROL_UNCONFIRMED");
			expect(physical).not.toHaveBeenCalled();
		},
	);
	it("deducts response latency from the original challenge budget", async () => {
		let now = 1000;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		let f: ReturnType<typeof fixture>;
		f = fixture(async (_method, args) => {
			now += 3000;
			return {
				schema: "qorpera.office-software-install-challenge/v1",
				challengeId: args.p_challenge_id,
				plan: f.plan,
				planSha256: f.trust.planSha256,
				statement: f.statement,
				targetRevision: 1,
				capabilityRevision: 1,
				validForMs: 2000,
			};
		});
		const physical = vi.fn(async () => f.measurement);
		await expect(f.control.install(physical, signal())).rejects.toThrow();
		expect(physical).not.toHaveBeenCalled();
	});
	it("withholds acknowledgement after physical work outlives the challenge", async () => {
		let now = 1000;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const f = fixture();
		await expect(
			f.control.install(async () => {
				now += 5001;
				return f.measurement;
			}, signal()),
		).rejects.toThrow();
		expect(f.calls).toEqual(["qorpera_check_office_software_install"]);
	});
	it("requires separately measured target bytes and a matching retained receipt", async () => {
		for (const changed of ["measurement", "receipt"]) {
			const f = fixture();
			await expect(
				f.control.install(
					async () => ({
						...f.measurement,
						...(changed === "measurement"
							? { measuredService: f.statement.previous.service }
							: { receipt: { ...f.receipt, planSha256: "0".repeat(64) } }),
					}),
					signal(),
				),
			).rejects.toThrow();
			expect(f.calls).toEqual(["qorpera_check_office_software_install"]);
		}
	});
	it("does not repeat an uncertain install and suppresses transport details", async () => {
		const f = fixture(),
			physical = vi.fn(async () => {
				throw new Error(`private ${f.capability}`);
			});
		await expect(f.control.install(physical, signal())).rejects.toThrow(/^OFFICE_SOFTWARE_CONTROL_UNCONFIRMED$/);
		expect(physical).toHaveBeenCalledTimes(1);
		expect(f.calls).toEqual(["qorpera_check_office_software_install"]);
	});
	it("keeps serialization while a cancelled physical operation is still settling", async () => {
		const f = fixture(),
			aborted = new AbortController();
		let finish!: () => void, entered!: () => void;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const pending = f.control.install(async () => {
			entered();
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
			return f.measurement;
		}, aborted.signal);
		await ready;
		aborted.abort();
		await expect(f.control.status(signal())).rejects.toThrow("OFFICE_SOFTWARE_CONTROL_PENDING");
		finish();
		await expect(pending).rejects.toThrow("OFFICE_SOFTWARE_CONTROL_UNCONFIRMED");
		expect(f.calls).toEqual(["qorpera_check_office_software_install"]);
	});
});
