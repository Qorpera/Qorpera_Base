import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { companyComputerStopHistoryDirectory } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { officePowerOffWorkerFixture } from "./fixtures/office-power-off-worker.ts";
import { serviceStartId as id } from "./fixtures/office-service-start.ts";

const roots: string[] = [],
	signal = () => new AbortController().signal;
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fixture = () => officePowerOffWorkerFixture(roots);
describe("serialized VM power-off", () => {
	it.each(["missing", "claim", "blob", "ownership", "source", "changed", "legacy"])(
		"refuses %s stop history before shutdown",
		async (fault) => {
			const f = await fixture(),
				root = companyComputerStopHistoryDirectory(f.request.startup.bootId, f.request.activationId),
				path = `${root}/manifest.json`,
				file = f.guest.get(path)!;
			const manifest = JSON.parse(file.content.toString());
			if (fault === "missing") f.guest.delete(path);
			if (fault === "claim") f.guest.get(`${root}/claim.json`)!.content = Buffer.from("{}");
			if (fault === "blob") f.guest.get(`${root}/${manifest.entries[0].sha256}.json`)!.content[0] ^= 1;
			if (fault === "ownership") file.uid = 1000;
			if (fault === "source") {
				manifest.entries = manifest.entries.filter(
					(entry: { path: string }) => entry.path !== "/etc/qorpera-office/credentials/config.json",
				);
				file.content = Buffer.from(JSON.stringify(manifest));
				f.guest.get(`${root}/claim.json`)!.content = Buffer.from(file.content);
			}
			if (fault === "changed") {
				const read = f.file.getMockImplementation()!;
				let n = 0;
				f.file.mockImplementation(async (...args) => {
					if (args[2] === path && ++n === 2) file.content = Buffer.from("{}");
					return read(...args);
				});
			}
			if (fault === "legacy")
				await writeFile(f.paths.seed, JSON.stringify({ schema: "qorpera.lxd-office-power-off-request/v1" }), {
					mode: 0o600,
				});
			await expect(f.run()).rejects.toThrow("OFFICE_POWER_OFF_UNCONFIRMED");
			expect(f.submit).not.toHaveBeenCalled();
		},
	);
	it("stops once after acknowledged service shutdown and preserves history across recovery", async () => {
		const f = await fixture(),
			original = await readFile(f.activation.names.completion);
		const result = await f.run();
		expect(result.state).toBe("powered_off");
		f.file.mockRejectedValue(new Error("stopped guest has no file API"));
		await expect(f.run()).resolves.toEqual(result);
		expect(f.submit).toHaveBeenCalledOnce();
		expect(f.exec).toHaveBeenCalledOnce();
		expect(await readFile(f.activation.names.completion)).toEqual(original);
		expect(
			f.registry.mock.calls.every(([method]) =>
				["qorpera_runtime_office_stop_status", "qorpera_suspend_runtime_node_machine"].includes(method as string),
			),
		).toBe(true);
	});
	it("gives the node slot back after the confirmed stop, and a new process repeats the same suspension", async () => {
		const f = await fixture();
		await expect(f.run()).resolves.toMatchObject({ state: "powered_off" });
		const [call] = f.suspensions();
		expect(call![1]).toEqual({
			p_allocation_id: f.binding.allocationId,
			p_provider_id: f.binding.providerId,
			p_policy_sha256: f.binding.providerPolicySha256,
			p_instance_sha256: f.request.startup.instanceSha256,
			p_machine_id_sha256: f.policy.host.machineIdSha256,
			p_transition_id: f.request.transitionId,
		});
		expect(f.submit.mock.invocationCallOrder[0]!).toBeLessThan(f.registry.mock.invocationCallOrder.at(-1)!);
		f.file.mockRejectedValue(new Error("stopped guest has no file API"));
		await expect(f.run()).resolves.toMatchObject({ state: "powered_off" });
		expect(f.suspensions()).toHaveLength(2);
		expect(f.suspensions()[1]![1]).toEqual(call![1]);
		expect(f.submit).toHaveBeenCalledOnce();
	});
	// 2026-09-28: the lifecycle replays a stopped computer every pass; each suspend
	// call locked the node row although the demand was suspended 42 hours earlier.
	it.each([
		["suspends", "2026-09-23T15:00:00.000000+00:00"],
		["was already suspended", "2026-09-20T01:03:57.405869+00:00"],
		["kept the slot for a resume", undefined],
	])("asks SQL once per transition while the same process replays (%s)", async (_, suspendedAt) => {
		const f = await fixture(),
			worker = f.create(),
			replay = () => worker.reconcile(f.activation.request.intentId, f.request, signal());
		f.suspension.value =
			suspendedAt === undefined
				? { state: "kept", reason: "RESUME_PENDING" }
				: {
						state: "suspended",
						allocationId: f.binding.allocationId,
						nodeId: "36000000-0000-4000-8000-000000000010",
						suspendedAt,
					};
		const result = await replay();
		expect(result.state).toBe("powered_off");
		f.file.mockRejectedValue(new Error("stopped guest has no file API"));
		for (let n = 0; n < 3; n++) await expect(replay()).resolves.toEqual(result);
		expect(f.suspensions()).toHaveLength(1);
		expect(f.submit).toHaveBeenCalledOnce();
		// Replays still recheck the stopped VM and SQL stop authority.
		expect(
			f.registry.mock.calls.filter(([method]) => method === "qorpera_runtime_office_stop_status").length,
		).toBeGreaterThanOrEqual(4);
	});
	it("asks again in the same process until SQL answers, then stops asking", async () => {
		const f = await fixture(),
			worker = f.create(),
			replay = () => worker.reconcile(f.activation.request.intentId, f.request, signal());
		f.suspension.value = new Error("suspension reply lost");
		await expect(replay()).rejects.toThrow("OFFICE_POWER_OFF_UNCONFIRMED");
		f.file.mockRejectedValue(new Error("stopped guest has no file API"));
		await expect(replay()).rejects.toThrow("OFFICE_POWER_OFF_UNCONFIRMED");
		f.suspension.value = {
			state: "suspended",
			allocationId: f.binding.allocationId,
			nodeId: "36000000-0000-4000-8000-000000000010",
			suspendedAt: "2026-09-23T15:00:00Z",
		};
		await expect(replay()).resolves.toMatchObject({ state: "powered_off" });
		await expect(replay()).resolves.toMatchObject({ state: "powered_off" });
		expect(f.suspensions()).toHaveLength(3);
		expect(f.submit).toHaveBeenCalledOnce();
	});
	it("keeps the slot through a reboot", async () => {
		const f = await officePowerOffWorkerFixture(roots, "reboot");
		await expect(f.run()).resolves.toMatchObject({ state: "powered_off" });
		expect(f.suspensions()).toHaveLength(0);
	});
	it("keeps the slot when a resume was already requested", async () => {
		const f = await fixture();
		f.suspension.value = { state: "kept", reason: "RESUME_PENDING" };
		await expect(f.run()).resolves.toMatchObject({ state: "powered_off" });
		expect(f.suspensions()).toHaveLength(1);
	});
	it.each([
		["lost reply", new Error("suspension reply lost")],
		[
			"foreign receipt",
			{
				state: "suspended",
				allocationId: "36000000-0000-4000-8000-000000000099",
				nodeId: "36000000-0000-4000-8000-000000000010",
				suspendedAt: "2026-09-23T15:00:00Z",
			},
		],
		["unknown reason", { state: "kept", reason: "SOMETHING_ELSE" }],
	])(
		"does not report powered off without a suspension receipt (%s), and completes on the next pass",
		async (_, value) => {
			const f = await fixture();
			f.suspension.value = value;
			await expect(f.run()).rejects.toThrow("OFFICE_POWER_OFF_UNCONFIRMED");
			expect(await readFile(f.paths.done, "utf8")).toContain("power-off-completion");
			f.suspension.value = {
				state: "suspended",
				allocationId: f.binding.allocationId,
				nodeId: "36000000-0000-4000-8000-000000000010",
				suspendedAt: "2026-09-23T15:00:00Z",
			};
			await expect(f.run()).resolves.toMatchObject({ state: "powered_off" });
			expect(f.submit).toHaveBeenCalledOnce();
		},
	);
	it.each([true, false])("never retries an unknown VM dispatch (stopped: %s)", async (physical) => {
		const f = await fixture();
		f.state.physical = physical;
		const original = f.submit.getMockImplementation()!;
		f.submit.mockImplementationOnce(async (...args) => {
			await original(...args);
			throw new Error("lost reply");
		});
		for (let n = 0; n < 2; n++) await expect(f.run()).resolves.toMatchObject({ state: "unknown" });
		expect(f.submit).toHaveBeenCalledOnce();
		expect(f.poll).not.toHaveBeenCalled();
		await expect(readFile(f.paths.done)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("recovers accepted polling failure without guest reads or another shutdown", async () => {
		const f = await fixture();
		f.poll.mockRejectedValueOnce(new Error("operation reply lost"));
		await expect(f.run()).resolves.toMatchObject({ state: "unknown" });
		f.file.mockRejectedValue(new Error("guest offline"));
		await expect(f.run()).resolves.toMatchObject({ state: "powered_off" });
		expect(f.submit).toHaveBeenCalledOnce();
	});
	it.each(["missing", "running", "state", "drift"])(
		"refuses successful operation with %s physical evidence",
		async (fault) => {
			const f = await fixture(),
				original = f.poll.getMockImplementation()!;
			f.poll.mockImplementationOnce(async (...args) => {
				if (fault === "missing") f.state.absent = true;
				if (fault === "running") {
					f.state.status = "Running";
					f.state.statusCode = 103;
				}
				if (fault === "state") f.vmState.mockResolvedValue({ status: "Running", statusCode: 103, network: {} });
				if (fault === "drift") {
					const instance = f.instance.getMockImplementation()!;
					f.instance.mockImplementation(async (...args) => ({
						...(await instance(...args))!,
						profiles: ["foreign"],
					}));
				}
				return original(...args);
			});
			await expect(f.run()).rejects.toThrow("OFFICE_POWER_OFF_UNCONFIRMED");
			expect(f.submit).toHaveBeenCalledOnce();
			await expect(readFile(f.paths.done)).rejects.toMatchObject({ code: "ENOENT" });
		},
	);
	it.each(["kernel", "host", "boot", "root-stop", "receipt", "authority", "action"])(
		"refuses changed %s before dispatch",
		async (fault) => {
			const f = await fixture();
			if (fault === "kernel") f.kernelLock.mockRejectedValue(new Error("lock missing"));
			if (fault === "host") f.check.mockResolvedValue({ signal: signal(), validForMs: 5000, hostBootId: id(99) });
			if (fault === "boot") f.guest.get("/proc/sys/kernel/random/boot_id")!.content = Buffer.from(id(99));
			if (fault === "root-stop") f.guest.delete(f.completionPath);
			if (fault === "receipt") await rm(f.names.done);
			if (fault === "authority") f.registry.mockResolvedValue(null);
			const request = fault === "action" ? { ...f.request, action: "reboot" as const } : f.request;
			await expect(f.create().reconcile(f.activation.request.intentId, request, signal())).rejects.toThrow();
			expect(f.submit).not.toHaveBeenCalled();
		},
	);
	it.each(["seed", "history", "journal", "command"])("refuses missing or changed %s after dispatch", async (fault) => {
		const f = await fixture();
		await f.run();
		if (fault === "seed") await rm(f.paths.seed);
		if (fault === "history") await writeFile(f.names.done, "{}");
		if (fault === "journal") await rm(join(f.paths.journal, "000006.json"));
		if (fault === "command") {
			const seed = JSON.parse(await readFile(f.paths.seed, "utf8"));
			seed.commandId = id(97);
			await writeFile(f.paths.seed, JSON.stringify(seed));
		}
		await expect(f.run()).rejects.toThrow("OFFICE_POWER_OFF_UNCONFIRMED");
		expect(f.submit).toHaveBeenCalledOnce();
	});
	it("does not stop a new external boot while recovering historical completion", async () => {
		const f = await fixture();
		await f.run();
		f.state.status = "Running";
		f.state.statusCode = 103;
		await expect(f.run()).rejects.toThrow("OFFICE_POWER_OFF_UNCONFIRMED");
		expect(f.submit).toHaveBeenCalledOnce();
	});
	it("keeps cancellation ownership until a non-cooperative authority request settles", async () => {
		const f = await fixture();
		let entered!: () => void, release!: () => void;
		const ready = new Promise<void>((r) => {
				entered = r;
			}),
			blocked = new Promise<void>((r) => {
				release = r;
			});
		const original = f.registry.getMockImplementation()!;
		f.registry.mockImplementationOnce(async (...args) => {
			entered();
			await blocked;
			return original(...args);
		});
		const cancel = new AbortController(),
			work = f.run(cancel.signal);
		const rejected = expect(work).rejects.toThrow();
		await ready;
		cancel.abort();
		await rejected;
		await expect(f.run()).rejects.toThrow("OFFICE_POWER_OFF_PENDING");
		expect(f.submit).not.toHaveBeenCalled();
		release();
		await new Promise((r) => setTimeout(r, 20));
		await expect(f.run()).resolves.toMatchObject({ state: "powered_off" });
		expect(f.submit).toHaveBeenCalledOnce();
	});
});
