import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { officeBootStopWorkerFixture } from "./fixtures/office-boot-stop-worker.ts";
import { officeFixtureLayout } from "./fixtures/office-boot-worker.ts";

const roots: string[] = [];
afterEach(async () => {
	officeFixtureLayout.version = 1;
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe("provider stop after retained boot activation", () => {
	// Stop evidence reparses the retained boot adoption receipt (five roots on version 2).
	it.each([1, 2] as const)(
		"layout version %i: stops and recovers the new boot's invocation using public history without re-entering preparation",
		async (layoutVersion) => {
			officeFixtureLayout.version = layoutVersion;
			const f = await officeBootStopWorkerFixture(roots);
			const priorCalls = f.activation.registry.mock.calls.length,
				priorIntentCalls = f.activation.configuration.registry.mock.calls.length;
			f.readProtected.mockClear().mockRejectedValue(new Error("bootstrap removed"));
			f.readCredential.mockClear().mockRejectedValue(new Error("credential rotated"));
			for (const path of f.guest.keys())
				if (path.startsWith(`${f.directory}/credentials/`) && !path.endsWith("/config.json")) f.guest.delete(path);
			const oldBytes = await readFile(join(f.root, `activation-completed-${f.binding.allocationId}.json`));
			const result = await f.run();
			expect(result).toMatchObject({ state: "stopped", transitionId: f.request.transitionId });
			expect(await f.run()).toEqual(result);
			expect(f.exec).toHaveBeenCalledOnce();
			expect(f.inspect).toHaveBeenCalledOnce();
			expect(f.activation.exec).toHaveBeenCalledOnce();
			expect(f.activation.registry.mock.calls.length).toBe(priorCalls);
			expect(f.activation.configuration.registry.mock.calls.length).toBe(priorIntentCalls);
			expect(f.readProtected).not.toHaveBeenCalled();
			expect(f.readCredential).not.toHaveBeenCalled();
			expect(await readFile(join(f.root, `activation-completed-${f.binding.allocationId}.json`))).toEqual(oldBytes);
			expect(f.state.revocations).toBe(1);
			expect(f.state.acknowledgements).toBe(1);
		},
	);
	it.each(["packet", "prepared", "completion", "index", "journal"] as const)(
		"refuses missing boot %s before revocation",
		async (key) => {
			const f = await officeBootStopWorkerFixture(roots);
			await rm(f.activation.paths[key], { recursive: true });
			await expect(f.run()).rejects.toThrow("OFFICE_STOP_UNCONFIRMED");
			expect(f.registry).not.toHaveBeenCalled();
			expect(f.exec).not.toHaveBeenCalled();
		},
	);
	it.each([
		"receipt",
		"configuration",
		"start-claim",
		"configuration-claim",
		"root-start",
		"resume",
		"vm",
		"bootstrap-hash",
		"host",
		"boot",
	])("refuses changed %s before revocation", async (fault) => {
		const f = await officeBootStopWorkerFixture(roots);
		const root = "/run/qorpera-office-preparation";
		if (fault === "receipt") f.guest.get(`${f.directory}/adoption.json`)!.content.fill(0);
		if (fault === "configuration") f.guest.get(`${f.directory}/credentials/config.json`)!.content.fill(0);
		if (fault === "start-claim") f.guest.delete(`${root}/boot-service-start-claim.json`);
		if (fault === "configuration-claim") f.guest.delete(`${f.directory}/configuration-claim.json`);
		if (fault === "root-start") f.guest.delete(f.activation.completionPath);
		if (fault === "resume")
			await rm(
				join(
					f.root,
					`resume-completed-${f.binding.allocationId}-${f.activation.request.predecessor.transitionId}.json`,
				),
			);
		if (fault === "vm") await rm(join(f.activation.resume.powerOff.paths.journal, "000010.json"));
		if (fault === "bootstrap-hash") {
			const path = f.activation.configuration.names.index,
				value = JSON.parse(await readFile(path, "utf8"));
			value.serviceBootstrapSha256 = "e".repeat(64);
			await writeFile(path, JSON.stringify(value));
		}
		if (fault === "host")
			f.check.mockResolvedValue({
				signal: new AbortController().signal,
				validForMs: 5000,
				hostBootId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
			});
		if (fault === "boot")
			f.guest.get("/proc/sys/kernel/random/boot_id")!.content = Buffer.from(
				"ffffffff-ffff-4fff-8fff-ffffffffffff\n",
			);
		await expect(f.run()).rejects.toThrow("OFFICE_STOP_UNCONFIRMED");
		expect(f.registry).not.toHaveBeenCalled();
		expect(f.exec).not.toHaveBeenCalled();
	});
	it.each([true, false])("does not repeat uncertain dispatch, with physical completion %s", async (physical) => {
		const f = await officeBootStopWorkerFixture(roots),
			original = f.exec.getMockImplementation()!;
		f.state.physical = physical;
		f.exec.mockImplementationOnce(async (...args) => {
			await original(...args);
			throw new Error("lost reply");
		});
		for (let i = 0; i < 2; i++)
			await expect(f.run()).resolves.toMatchObject({ state: physical ? "stopped" : "unknown" });
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.inspect).toHaveBeenCalledTimes(physical ? 1 : 0);
	});
	it.each(["qorpera_begin_runtime_office_lifecycle", "qorpera_ack_runtime_office_stop"] as const)(
		"recovers lost committed %s",
		async (method) => {
			const f = await officeBootStopWorkerFixture(roots),
				original = f.registry.getMockImplementation()!;
			let lost = false;
			f.registry.mockImplementation(async (...args) => {
				const result = await original(...args);
				if (args[0] === method && !lost) {
					lost = true;
					throw new Error("lost committed reply");
				}
				return result;
			});
			await expect(f.run()).rejects.toThrow("OFFICE_STOP_UNCONFIRMED");
			await expect(f.run()).resolves.toMatchObject({ state: "stopped" });
			expect(f.state.revocations).toBe(1);
			expect(f.state.acknowledgements).toBe(1);
			expect(f.exec).toHaveBeenCalledOnce();
		},
	);
});
