import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { installOfficeLifecycleTiming } from "../../../scripts/acceptance/office-lifecycle-timing.ts";
import { projectOfficeResetTiming } from "../../../scripts/acceptance/office-lifecycle-timing-evidence.mjs";
import { cleanupOfficeCodePackagePipelineFixtures } from "./fixtures/office-code-package-pipeline.ts";
import { officeResetActivationProfile } from "./fixtures/office-reset-activation-profile.ts";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await cleanupOfficeCodePackagePipelineFixtures();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("refuses composed measurement after the original physical lease expires", async () => {
	const f = await officeResetActivationProfile(roots);
	await f.prepare();
	const submits = f.f.submit.mock.calls.length;
	f.arm(async (stage, signal) => {
		// Explicitly stall this negative case past its original five-second
		// physical lease; fixed transport latency alone can finish on a fast host.
		if (stage === "package:exec:invocation") await delay(6000, undefined, { signal });
	});
	try {
		let failure: unknown;
		try {
			await f.run();
		} catch (error) {
			failure = error;
		}
		expect(failure).toMatchObject({ message: "OFFICE_RESET_UNCONFIRMED" });
		const cause = failure instanceof Error ? failure.cause : undefined;
		// Cancellation during an awaited delay wraps its reason; a subsequent
		// throwIfAborted boundary throws that same TimeoutError directly.
		expect(cause instanceof Error && cause.name === "AbortError" ? cause.cause : cause).toMatchObject({
			name: "TimeoutError",
		});
		expect(f.profile()).toMatchObject({ resetState: "prepared", packageMeasured: false, activationCalls: 0 });
		expect(f.profile().stages.find((stage) => stage.stage === "stage:inspection")).toMatchObject({ aborted: false });
		const measurement = f.profile().stages.find((stage) => stage.stage === "stage:measurement");
		expect(measurement).toMatchObject({ aborted: true });
		expect(measurement?.gateRemainingMs).toBeLessThanOrEqual(0);
		const invocation = f.profile().stages.find((stage) => stage.stage === "package:exec:invocation");
		expect(invocation).toMatchObject({ aborted: true });
		expect(invocation?.gateRemainingMs).toBeLessThanOrEqual(0);
		// The lease can expire during I/O or between commands. In either case
		// measurement must have progressed into package work before refusing.
		expect(f.profile().stages.some((stage) => stage.stage === "package:exec:probe" && !stage.aborted)).toBe(true);
		expect(f.f.submit).toHaveBeenCalledTimes(submits);
		expect(f.f.lane.start).toHaveBeenCalledOnce();
		expect(f.pipeline.methods).not.toContain("qorpera_ack_office_package_invocation");
	} finally {
		process.stdout.write(`OFFICE_RESET_ACTIVATION_PROFILE ${JSON.stringify(f.profile())}\n`);
		expect(f.profile().outstanding).toBe(0);
	}
}, 60_000);

it("retains caller cancellation through inspection and package measurement without duplicate effects", async () => {
	const f = await officeResetActivationProfile(roots);
	await f.prepare();
	const submits = f.f.submit.mock.calls.length;
	const caller = new AbortController();
	f.arm((stage) => {
		if (stage === "package:exec:probe") caller.abort(new Error("PROFILE_CALLER_CANCELLED"));
	});
	try {
		await expect(f.run(caller.signal)).rejects.toMatchObject({
			message: "OFFICE_RESET_RECONCILIATION_ABORTED",
		});
		expect(caller.signal.reason).toMatchObject({ message: "PROFILE_CALLER_CANCELLED" });
		const probe = f.profile().stages.find((stage) => stage.stage === "package:exec:probe");
		expect(probe).toMatchObject({ aborted: true });
		expect(probe?.gateRemainingMs).toBeGreaterThan(0);
		expect(f.profile()).toMatchObject({ resetState: "prepared", packageMeasured: false, activationCalls: 0 });
		expect(f.f.submit).toHaveBeenCalledTimes(submits);
		expect(f.f.lane.start).toHaveBeenCalledOnce();
		expect(f.pipeline.methods).not.toContain("qorpera_check_office_package_invocation");
		expect(f.pipeline.methods).not.toContain("qorpera_ack_office_package_invocation");
	} finally {
		process.stdout.write(`OFFICE_RESET_ACTIVATION_CALLER_PROFILE ${JSON.stringify(f.profile())}\n`);
		expect(f.profile().outstanding).toBe(0);
	}
}, 60_000);

it("activates the same composed lanes with shorter disclosed delays and unchanged five-second leases", async () => {
	const f = await officeResetActivationProfile(roots);
	await f.prepare();
	const submits = f.f.submit.mock.calls.length;
	// 25ms ordinary transport/SQL, 50ms physical inspection, 375ms each tool.
	// This is a synthetic positive control, not a physical performance claim.
	f.arm(undefined, 0.25);
	const observed: unknown[] = [];
	const restore = installOfficeLifecycleTiming((row) => {
		observed.push(row);
	});
	try {
		await expect(f.run(undefined, true)).resolves.toMatchObject({ state: "active", phase: "active" });
		expect(f.profile()).toMatchObject({ resetState: "active", packageMeasured: true, activationCalls: 1 });
		expect(f.f.submit).toHaveBeenCalledTimes(submits);
		expect(f.f.lane.start).toHaveBeenCalledOnce();
		expect(f.pipeline.methods.filter((method) => method === "qorpera_ack_office_package_invocation")).toHaveLength(1);
		expect(observed).toHaveLength(1);
		const timing = projectOfficeResetTiming(observed[0]);
		expect(timing).toMatchObject({ outcome: "fulfilled", pendingAtSettlement: 0 });
		for (const stage of [
			"typed_inspection",
			"package_staging",
			"package_measurement",
			"package_challenge",
			"package_ack",
			"successor_activate",
		]) {
			expect(timing?.records.filter((row: { stage: string }) => row.stage === stage)).toMatchObject([
				{ outcome: "fulfilled", operationAborted: false },
			]);
		}
	} finally {
		restore();
		process.stdout.write(`OFFICE_RESET_ACTIVATION_POSITIVE_PROFILE ${JSON.stringify(f.profile())}\n`);
		expect(f.profile().outstanding).toBe(0);
	}
}, 60_000);
