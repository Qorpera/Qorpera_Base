import { createHash } from "node:crypto";
import { readFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LxdOfficeIdlePolicy, parseOfficeIdleMs } from "../src/lxd-office-idle-policy.ts";
import { publish } from "../src/lxd-office-journal-files.ts";
import { officePowerOffWorkerFixture } from "./fixtures/office-power-off-worker.ts";

const roots: string[] = [];
const signal = () => new AbortController().signal;
afterEach(async () => {
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
	const f = await officePowerOffWorkerFixture(roots);
	const state = { request: f.request as unknown, wakeRequested: false };
	const registry = { call: vi.fn(async () => ({ schema: "qorpera.office-idle-policy/v1", ...state })) };
	const a = f.binding;
	const assignment = {
		companyId: a.companyId,
		environmentId: a.environmentId,
		companyComputerId: a.companyComputerId,
		logicalComputerId: a.logicalComputerId,
		computerGeneration: a.computerGeneration,
		providerId: a.providerId,
		providerPolicySha256: a.providerPolicySha256,
		imageFingerprint: a.imageFingerprint,
		bootstrapSha256: a.bootstrapSha256,
	};
	const create = () => new LxdOfficeIdlePolicy(f.root, assignment, 300000, registry);
	return { ...f, state, registry, create, intentId: f.activation.request.intentId };
}

describe("server-owned office idle policy", () => {
	it.each([0, 59999, 86400001, NaN, 300000.5, "300000"])("rejects invalid idle window %s", (value) => {
		expect(() => parseOfficeIdleMs(value)).toThrow("INVALID_OFFICE_IDLE_WINDOW");
	});
	it("uses only enrolled scope and policy, and creates no demand from a provider poll", async () => {
		const f = await fixture();
		f.state.request = null;
		expect(await f.create().reconcile(f.intentId, signal())).toBeUndefined();
		expect(f.registry.call).toHaveBeenCalledWith(
			"qorpera_reconcile_runtime_office_idle",
			{
				p_scope: f.request.startup.scope,
				p_computer_generation: f.binding.computerGeneration,
				p_provider_id: f.binding.providerId,
				p_provider_policy_sha256: f.binding.providerPolicySha256,
				p_idle_ms: 300000,
			},
			expect.any(AbortSignal),
		);
		expect(f.submit).not.toHaveBeenCalled();
	});
	it("holds the accepted stop through process replacement and does not invent a resume", async () => {
		const f = await fixture();
		expect(await f.create().reconcile(f.intentId, signal())).toEqual({ request: f.request });
		await f.run();
		expect(await f.create().reconcile(f.intentId, signal())).toEqual({ request: f.request });
		expect(f.submit).toHaveBeenCalledTimes(1);
	});
	it("keeps demand during an unfinished stop, then retains one resume identity across recovery", async () => {
		const f = await fixture();
		f.state.wakeRequested = true;
		expect(await f.create().reconcile(f.intentId, signal())).toEqual({ request: f.request });
		await f.run();
		const first = await f.create().reconcile(f.intentId, signal());
		expect(first?.resume).toMatchObject({ predecessor: f.request });
		expect(first?.resume?.activationId).not.toBe(f.request.activationId);
		expect(await f.create().reconcile(f.intentId, signal())).toEqual(first);
		expect(f.submit).toHaveBeenCalledTimes(1);
	});
	it("refuses changed authority under an accepted transition", async () => {
		const f = await fixture();
		await f.create().reconcile(f.intentId, signal());
		f.state.request = { ...f.request, startup: { ...f.request.startup, serviceInvocationId: "f".repeat(32) } };
		await expect(f.create().reconcile(f.intentId, signal())).rejects.toThrow();
	});
	it("refuses a missing history after physical stop completion", async () => {
		const f = await fixture();
		await f.run();
		f.state.wakeRequested = true;
		await unlink(join(f.root, `power-off-history-${f.binding.allocationId}-${f.request.transitionId}.json`));
		await expect(f.create().reconcile(f.intentId, signal())).rejects.toThrow();
	});
	it("derives evidence digests from exact retained bytes", async () => {
		const f = await fixture();
		await f.run();
		f.state.wakeRequested = true;
		const result = await f.create().reconcile(f.intentId, signal());
		const saved = JSON.parse(
			await readFile(join(f.root, `idle-resume-${f.binding.allocationId}-${f.request.transitionId}.json`), "utf8"),
		);
		expect(saved).toEqual(result?.resume);
		for (const [prefix, key] of [
			["power-off-completed", "powerOffCompletionSha256"],
			["power-off-history", "stopHistorySha256"],
		]) {
			const bytes = await readFile(
				join(f.root, `${prefix}-${f.binding.allocationId}-${f.request.transitionId}.json`),
			);
			expect(saved[key!]).toBe(createHash("sha256").update(bytes).digest("hex"));
		}
	});
	it("fails closed if a dispatched resume loses its retained identity", async () => {
		const f = await fixture();
		await f.run();
		f.state.wakeRequested = true;
		await publish(
			f.root,
			`resume-request-${f.binding.allocationId}-${f.request.transitionId}.json`,
			Buffer.from("{}"),
		);
		await expect(f.create().reconcile(f.intentId, signal())).rejects.toThrow("OFFICE_IDLE_RESUME_IDENTITY_LOST");
	});
	it.each(["reboot", "service_restart", "replace"])("cannot use idle policy to dispatch %s", async (action) => {
		const f = await fixture();
		f.state.request = { ...f.request, action };
		await expect(f.create().reconcile(f.intentId, signal())).rejects.toThrow("OFFICE_IDLE_POLICY_BINDING_DIFFERS");
	});
	it("does not synthesize authority after an uncertain SQL response", async () => {
		const f = await fixture();
		f.registry.call.mockRejectedValueOnce(new Error("lost reply"));
		await expect(f.create().reconcile(f.intentId, signal())).rejects.toThrow("lost reply");
		expect(f.submit).not.toHaveBeenCalled();
		expect(await f.create().reconcile(f.intentId, signal())).toEqual({ request: f.request });
	});
});
