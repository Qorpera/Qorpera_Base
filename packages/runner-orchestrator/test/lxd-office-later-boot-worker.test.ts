import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { companyComputerBootDirectory } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLxdOfficeBootVmEvidence } from "../src/lxd-office-boot-vm-evidence.ts";
import { openLxdOfficeCreationIdentity } from "../src/lxd-office-creation-journal.ts";
import { officeBootSuccessorWorkerFixture } from "./fixtures/office-boot-successor-worker.ts";
import { officeFixtureLayout } from "./fixtures/office-boot-worker.ts";
import { officeLaterBootWorkerFixture } from "./fixtures/office-later-boot-worker.ts";
import { createOfficePowerOffWorkerFixture } from "./fixtures/office-power-off-worker.ts";
import { createOfficeResumeWorkerFixture } from "./fixtures/office-resume-worker.ts";
import { serviceStartId as id } from "./fixtures/office-service-start.ts";
import { createOfficeStopWorkerFixture } from "./fixtures/office-stop-worker.ts";

const roots: string[] = [];
const signal = () => new AbortController().signal;
afterEach(async () => {
	officeFixtureLayout.version = 1;
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("provider repeated VM boot lineage", () => {
	it("powers off and resumes a boot whose current activation is a service successor", async () => {
		const f = await officeBootSuccessorWorkerFixture(roots);
		await f.worker.reconcile(f.intentId, f.request, signal());
		const attestation = f.state.current!.request.attestation;
		const stopped = await createOfficeStopWorkerFixture(
			{
				...f,
				request: { intentId: f.intentId },
				completionPath: `/run/qorpera-office-preparation/boot-service-restart-completion-${attestation.activationId}.json`,
			},
			"reboot",
			`${companyComputerBootDirectory(attestation.bootId)}/credentials/config.json`,
			false,
			id(151),
		);
		await stopped.create().reconcile(f.intentId, stopped.request, signal());
		const original = f.activation.configuration.resume.powerOff;
		const power = await createOfficePowerOffWorkerFixture({
			...original,
			...stopped,
			activation: original.activation,
		});
		await expect(power.run()).resolves.toMatchObject({ state: "powered_off" });
		const resumed = await createOfficeResumeWorkerFixture(power, {
			bootIntentId: id(201),
			activationId: id(202),
			bootId: id(203),
			operationId: id(204),
		});
		await expect(resumed.run()).resolves.toMatchObject({ state: "awaiting_configuration" });
		expect(resumed.submit).toHaveBeenCalledOnce();
	});
	it.each([1, 2] as const)(
		"layout version %i: composes two later shutdown/configuration/activation cycles without replacing original preparation",
		async (layoutVersion) => {
			officeFixtureLayout.version = layoutVersion;
			const f = await officeLaterBootWorkerFixture(roots);
			const old = new Map(
				await Promise.all(
					(await readdir(f.first.root))
						.filter((name) => name.endsWith(".json"))
						.map(async (name) => [name, await readFile(join(f.first.root, name))] as const),
				),
			);
			const recordCounts: number[] = [];
			for (let cycle = 0; cycle < 2; cycle++) {
				const power = await f.stop();
				expect((await power.run()).state).toBe("powered_off");
				const seed = JSON.parse(await readFile(power.paths.seed, "utf8"));
				expect(seed.schema).toBe("qorpera.lxd-office-power-off-request/v3");
				recordCounts.push(Object.keys(seed.records).length);
				const completed = await f.resume(power);
				expect(completed.activation.state.activations).toBe(1);
				const creation = await openLxdOfficeCreationIdentity(
					f.first.policy,
					f.first.input.intentId,
					true,
					f.first.client,
					signal(),
				);
				const evidence = await readLxdOfficeBootVmEvidence(
					f.first.root,
					creation,
					completed.resumed.request,
					signal(),
				);
				expect(evidence.commands.map((command) => command.action)).toEqual([
					"create",
					"start",
					"stop",
					"start",
					...Array.from({ length: cycle + 1 }, () => ["stop", "start"]).flat(),
				]);
				await expect(power.run()).rejects.toThrow("OFFICE_POWER_OFF_UNCONFIRMED");
			}
			expect(recordCounts[1]).toBe(recordCounts[0]);
			for (const [name, bytes] of old) expect(await readFile(join(f.first.root, name))).toEqual(bytes);
			await expect(f.first.run()).rejects.toThrow("OFFICE_BOOT_ACTIVATION_UNCONFIRMED");
		},
		60000,
	);
	it.each(["missing", "changed"])("refuses %s previous resume evidence before a later VM stop", async (fault) => {
		const f = await officeLaterBootWorkerFixture(roots),
			power = await f.stop();
		const previous = f.first.configuration.resume.names.done;
		if (fault === "missing") await rm(previous);
		else await writeFile(previous, "{}");
		await expect(power.run()).rejects.toThrow("OFFICE_POWER_OFF_UNCONFIRMED");
		expect(power.submit).not.toHaveBeenCalled();
	});
	it("recovers a later accepted VM stop without accessing the stopped guest", async () => {
		const f = await officeLaterBootWorkerFixture(roots),
			power = await f.stop();
		power.poll.mockRejectedValueOnce(new Error("lost operation reply"));
		await expect(power.run()).resolves.toMatchObject({ state: "unknown" });
		power.file.mockRejectedValue(new Error("guest stopped"));
		await expect(power.run()).resolves.toMatchObject({ state: "powered_off" });
		expect(power.submit).toHaveBeenCalledOnce();
	});
	it("never resubmits a later VM stop with a lost acceptance", async () => {
		const f = await officeLaterBootWorkerFixture(roots),
			power = await f.stop();
		const submit = power.submit.getMockImplementation()!;
		power.submit.mockImplementationOnce(async (...args) => {
			await submit(...args);
			throw new Error("lost acceptance");
		});
		for (let n = 0; n < 2; n++) await expect(power.run()).resolves.toMatchObject({ state: "unknown" });
		expect(power.submit).toHaveBeenCalledOnce();
	});
	it.each(["seed", "resume", "ancestor", "archive"])("refuses changed %s before a later resume", async (fault) => {
		const f = await officeLaterBootWorkerFixture(roots),
			power = await f.stop();
		await power.run();
		const resumed = await f.prepareResume(power);
		const paths = {
			seed: power.paths.seed,
			resume: f.first.configuration.resume.names.observation,
			ancestor: f.original.paths.seed,
			archive: join(
				f.first.root,
				`power-off-history-${f.first.binding.allocationId}-${power.request.transitionId}.json`,
			),
		};
		await writeFile(paths[fault as keyof typeof paths], "{}");
		await expect(resumed.run()).rejects.toThrow("OFFICE_RESUME_UNCONFIRMED");
		expect(resumed.submit).not.toHaveBeenCalled();
		expect(resumed.registry).not.toHaveBeenCalled();
	});
	it("recovers an accepted later resume and refuses to submit it twice", async () => {
		const f = await officeLaterBootWorkerFixture(roots),
			power = await f.stop();
		await power.run();
		const resumed = await f.prepareResume(power);
		resumed.poll.mockRejectedValueOnce(new Error("lost operation response"));
		await expect(resumed.run()).resolves.toMatchObject({ state: "unknown" });
		await expect(resumed.run()).resolves.toMatchObject({ state: "awaiting_configuration" });
		expect(resumed.submit).toHaveBeenCalledOnce();
	});
	it("keeps a later resume unknown after its submission response is lost", async () => {
		const f = await officeLaterBootWorkerFixture(roots),
			power = await f.stop();
		await power.run();
		const resumed = await f.prepareResume(power),
			submit = resumed.submit.getMockImplementation()!;
		resumed.submit.mockImplementationOnce(async (...args) => {
			await submit(...args);
			throw new Error("lost acceptance");
		});
		for (let n = 0; n < 2; n++) await expect(resumed.run()).resolves.toMatchObject({ state: "unknown" });
		expect(resumed.submit).toHaveBeenCalledOnce();
		await expect(readFile(resumed.names.done)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("rejects reuse of the original boot even when it differs from the immediately preceding boot", async () => {
		const f = await officeLaterBootWorkerFixture(roots),
			power = await f.stop();
		await power.run();
		const resumed = await f.prepareResume(power),
			submit = resumed.submit.getMockImplementation()!;
		resumed.submit.mockImplementationOnce(async (...args) => {
			const result = await submit(...args);
			resumed.guest.get("/proc/sys/kernel/random/boot_id")!.content = Buffer.from(f.original.request.startup.bootId);
			return result;
		});
		await expect(resumed.run()).rejects.toThrow("OFFICE_RESUME_UNCONFIRMED");
		await expect(readFile(resumed.names.done)).rejects.toMatchObject({ code: "ENOENT" });
		expect(resumed.submit).toHaveBeenCalledOnce();
	});
});
