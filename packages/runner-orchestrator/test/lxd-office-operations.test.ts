import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LxdOperationState, LxdTrackedInstanceAction } from "../src/lxd-client.ts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "../src/lxd-office-guest.ts";
import { LxdOfficeOperationJournal } from "../src/lxd-office-operations.ts";

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const roots: string[] = [];
const signal = () => new AbortController().signal;
function binding(): LxdOfficeGuestBinding {
	return {
		schema: "qorpera.lxd-office-guest/v2",
		providerId: id(7),
		providerPolicySha256: "f".repeat(64),
		companyId: id(1),
		environmentId: id(2),
		companyComputerId: id(3),
		logicalComputerId: id(4),
		computerGeneration: 1,
		allocationId: id(5),
		project: "offices",
		imageFingerprint: "a".repeat(64),
		bootstrapSha256: "b".repeat(64),
		storagePool: "office-vms",
		rootDiskBytes: 64 * 1024 ** 3,
		workbenchSource: "/mnt/nas/office",
		network: "office-net",
		cpus: 2,
		memoryBytes: 4 * 1024 ** 3,
	};
}
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(now?: () => Date) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "office-journal-")));
	roots.push(root);
	await chmod(root, 0o700);
	const config = binding();
	const plan = lxdOfficeGuestPlan(config);
	let counter = 100;
	const client = {
		submitInstanceOperation: vi.fn(
			async (project: string, _action: LxdTrackedInstanceAction, _signal: AbortSignal) => ({
				project,
				instanceName: plan.request.name,
				operationId: id(counter++),
			}),
		),
		inspectInstanceOperation: vi.fn(async (): Promise<LxdOperationState> => "pending"),
	};
	const reopen = () => LxdOfficeOperationJournal.open(root, id(6), config, client, false, now);
	const journal = await reopen();
	const path = join(root, config.allocationId);
	const events = async () =>
		Promise.all(
			(await readdir(path))
				.filter((name) => /^\d{6}\.json$/.test(name))
				.sort()
				.map(async (name) => JSON.parse(await readFile(join(path, name), "utf8"))),
		);
	return { root, path, config, plan, client, journal, reopen, events };
}

describe("durable office operation recovery", () => {
	it("retains first observation times across replay and read-only history without provider calls", async () => {
		const times = ["2026-09-09T01:00:00.001Z", "2026-09-09T01:00:00.002Z", "2026-09-09T01:01:00.003Z"];
		let index = 0;
		const f = await fixture(() => new Date(times[index++]));
		await f.journal.reconcile(id(10), "create", signal());
		f.client.inspectInstanceOperation.mockResolvedValue("failed");
		await (await f.reopen()).observe(id(10), "create", signal());
		const before = await f.events();
		expect(before.map((event) => event.recordedAt)).toEqual(times);
		const history = await f.journal.history();
		expect(history.events.map((event) => event.reason)).toEqual([
			"DISPATCH_RECORDED",
			"PROVIDER_OPERATION_ACCEPTED",
			"PROVIDER_OPERATION_FAILED",
		]);
		expect(
			history.events.every(
				(event) => event.timeSource === "provider_journal_clock" && event.physicalTransitionAt === null,
			),
		).toBe(true);
		expect(history).toMatchObject({
			companyId: id(1),
			allocationId: id(5),
			providerId: id(7),
			intentId: id(6),
			serviceReadinessInferred: false,
			resourceReleaseInferred: false,
		});
		expect(JSON.stringify(history)).not.toMatch(/workbenchSource|\/mnt\/nas|network|office-net/);
		await expect((await f.reopen()).reconcile(id(10), "create", signal())).resolves.toMatchObject({
			state: "failed",
		});
		expect(await LxdOfficeOperationJournal.readHistory(f.root, id(5))).toEqual(history);
		expect(await f.events()).toEqual(before);
		expect(index).toBe(3);
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(1);
		expect(f.client.inspectInstanceOperation).toHaveBeenCalledTimes(2);
	});
	it("continues an original v1 hash chain without backfilling or changing historical bytes", async () => {
		const f = await fixture(() => new Date("2026-09-09T02:00:00.000Z"));
		let previousSha256 = createHash("sha256")
			.update(await readFile(join(f.path, "authority.json")))
			.digest("hex");
		const originals: Buffer[] = [];
		// Original format fixture, written before the v2 implementation resumes it.
		for (const [sequence, kind] of (["dispatch", "accepted"] as const).entries()) {
			const bytes = Buffer.from(
				`${JSON.stringify({
					schema: "qorpera.lxd-office-operation-event/v1",
					sequence,
					previousSha256,
					commandId: id(10),
					action: "create",
					kind,
					operationId: kind === "dispatch" ? null : id(100),
					state: null,
				})}\n`,
			);
			await writeFile(join(f.path, `${String(sequence).padStart(6, "0")}.json`), bytes, { flag: "wx", mode: 0o600 });
			originals.push(bytes);
			previousSha256 = createHash("sha256").update(bytes).digest("hex");
		}
		f.client.inspectInstanceOperation.mockResolvedValue("succeeded");
		const resumed = await f.reopen();
		await expect(resumed.reconcile(id(10), "create", signal())).resolves.toMatchObject({ state: "succeeded" });
		const history = await resumed.history();
		expect(history.events.map((e) => e.recordedAt)).toEqual([null, null, "2026-09-09T02:00:00.000Z"]);
		expect(history.events.map((e) => e.timeSource)).toEqual([
			"not_recorded",
			"not_recorded",
			"provider_journal_clock",
		]);
		expect((await f.events())[2]).toMatchObject({ schema: "qorpera.lxd-office-operation-event/v2", previousSha256 });
		for (const [index, bytes] of originals.entries())
			expect(await readFile(join(f.path, `${String(index).padStart(6, "0")}.json`))).toEqual(bytes);
		expect(await LxdOfficeOperationJournal.readHistory(f.root, id(5))).toEqual(history);
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
	});
	it.each(["throw", "invalid date"])("keeps mandatory custody when the optional clock returns %s", async (failure) => {
		let broken = true;
		const f = await fixture(() => {
			if (broken && failure === "throw") throw new Error("PRIVATE_CLOCK_ERROR");
			return new Date(broken ? Number.NaN : "2026-09-09T02:00:00.000Z");
		});
		f.client.inspectInstanceOperation.mockResolvedValue("succeeded");
		await expect(f.journal.reconcile(id(10), "create", signal())).resolves.toMatchObject({ state: "succeeded" });
		expect(
			(await f.journal.history()).events.every((e) => e.recordedAt === null && e.timeSource === "clock_unavailable"),
		).toBe(true);
		broken = false;
		await f.journal.reconcile(id(11), "start", signal());
		const history = await f.journal.history();
		expect(history.events.slice(0, 3).every((e) => e.recordedAt === null)).toBe(true);
		expect(history.events.slice(3).every((e) => e.recordedAt === "2026-09-09T02:00:00.000Z")).toBe(true);
		expect(JSON.stringify(history)).not.toContain("PRIVATE_CLOCK_ERROR");
	});
	it("preserves original clock values and orders history by journal sequence when the clock moves backward", async () => {
		let millis = Date.parse("2026-09-09T02:00:00.000Z");
		const f = await fixture(() => new Date(millis--));
		f.client.inspectInstanceOperation.mockResolvedValue("succeeded");
		await f.journal.reconcile(id(10), "create", signal());
		const history = await f.journal.history();
		expect(history.events.map((e) => e.sequence)).toEqual([0, 1, 2]);
		expect(history.events.map((e) => e.recordedAt)).toEqual([
			"2026-09-09T02:00:00.000Z",
			"2026-09-09T01:59:59.999Z",
			"2026-09-09T01:59:59.998Z",
		]);
	});
	it("rejects malformed timestamp metadata without dispatch, provider reads or historical repair", async () => {
		const f = await fixture();
		await f.journal.reconcile(id(10), "create", signal());
		const event = (await f.events())[1];
		await writeFile(
			join(f.path, "000001.json"),
			JSON.stringify({ ...event, recordedAt: "2026-02-30T00:00:00.000Z" }),
		);
		const before = await readFile(join(f.path, "000001.json"));
		await expect(LxdOfficeOperationJournal.readHistory(f.root, id(5))).rejects.toThrow("JOURNAL_UNCONFIRMED");
		await expect(f.journal.reconcile(id(10), "create", signal())).rejects.toThrow("JOURNAL_UNCONFIRMED");
		expect(await readFile(join(f.path, "000001.json"))).toEqual(before);
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(1);
		expect(f.client.inspectInstanceOperation).toHaveBeenCalledTimes(1);
	});
	it("does not create a missing journal through the history path", async () => {
		const f = await fixture();
		await expect(LxdOfficeOperationJournal.readHistory(f.root, id(99))).rejects.toThrow();
		expect(await readdir(f.root)).toEqual([id(5)]);
		await expect(LxdOfficeOperationJournal.readHistory(f.root, "../escape")).rejects.toThrow(
			"INVALID_LXD_OFFICE_HISTORY",
		);
	});
	it("requires exact successful predecessors across repeated stop/start cycles", async () => {
		const f = await fixture();
		f.client.inspectInstanceOperation.mockResolvedValue("succeeded");
		const commands = (["create", "start", "stop", "start", "stop", "start"] as const).map((action, index) => ({
			action,
			commandId: id(10 + index),
		}));
		for (const [index, command] of commands.entries()) {
			if (index > 0) await f.journal.assertLifecycleSequence(commands.slice(0, index + 1), signal());
			await f.journal.reconcile(command.commandId, command.action, signal());
		}
		await f.journal.assertLifecycleSequence(commands, signal());
		for (const changed of [
			commands.slice(0, 4),
			commands.map((command, i) => (i === 2 ? { ...command, commandId: id(99) } : command)),
			commands.map((command, i) => (i === 2 ? { ...command, action: "start" as const } : command)),
		])
			await expect(f.journal.assertLifecycleSequence(changed, signal())).rejects.toThrow(
				"OFFICE_VM_LINEAGE_UNCONFIRMED",
			);
		await expect(f.journal.assertInitialBootSequence(id(10), id(11), signal())).rejects.toThrow();
		await expect(f.journal.assertPowerOffSequence(id(10), id(11), id(12), signal())).rejects.toThrow();
	});
	it("does not advance a failed or unresolved predecessor in VM lineage", async () => {
		const f = await fixture(),
			commands = [
				{ commandId: id(10), action: "create" as const },
				{ commandId: id(11), action: "start" as const },
			];
		await f.journal.reconcile(id(10), "create", signal());
		await expect(f.journal.assertLifecycleSequence(commands, signal())).rejects.toThrow(
			"OFFICE_VM_LINEAGE_UNCONFIRMED",
		);
		f.client.inspectInstanceOperation.mockResolvedValue("failed");
		await f.journal.observe(id(10), "create", signal());
		await expect(f.journal.assertLifecycleSequence(commands, signal())).rejects.toThrow(
			"OFFICE_VM_LINEAGE_UNCONFIRMED",
		);
	});
	it("persists dispatch before transmission and acceptance before observation; reopened journals resume the same operation", async () => {
		const f = await fixture();
		f.client.submitInstanceOperation.mockImplementationOnce(async (project, action) => {
			expect((await f.events()).map((event) => event.kind)).toEqual(["dispatch"]);
			expect(action).toEqual({ action: "create", request: f.plan.request });
			return { project, instanceName: f.plan.request.name, operationId: id(100) };
		});
		f.client.inspectInstanceOperation.mockImplementationOnce(async () => {
			expect((await f.events()).map((event) => event.kind)).toEqual(["dispatch", "accepted"]);
			return "pending";
		});
		await expect(f.journal.reconcile(id(10), "create", signal())).resolves.toEqual({
			state: "pending",
			operationId: id(100),
		});
		f.client.inspectInstanceOperation.mockResolvedValue("succeeded");
		const resumed = await f.reopen();
		await expect(resumed.reconcile(id(10), "create", signal())).resolves.toEqual({
			state: "succeeded",
			operationId: id(100),
		});
		await expect(resumed.reconcile(id(10), "create", signal())).resolves.toEqual({
			state: "succeeded",
			operationId: id(100),
		});
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(1);
		expect(f.client.inspectInstanceOperation).toHaveBeenCalledTimes(2);
		expect((await f.events()).map((event) => event.kind)).toEqual(["dispatch", "accepted", "settled"]);
	});
	it("never resubmits after a lost acceptance response, including after restart", async () => {
		const f = await fixture();
		f.client.submitInstanceOperation.mockRejectedValueOnce(new Error("connection lost after daemon accepted create"));
		await expect(f.journal.reconcile(id(10), "create", signal())).resolves.toEqual({ state: "unknown" });
		const resumed = await f.reopen();
		await expect(resumed.reconcile(id(10), "create", signal())).resolves.toEqual({ state: "unknown" });
		await expect(resumed.reconcile(id(11), "delete", signal())).rejects.toThrow("LXD_OFFICE_OPERATION_UNSETTLED");
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(1);
		expect(f.client.inspectInstanceOperation).not.toHaveBeenCalled();
	});
	it("keeps a recorded but missing operation unsettled, then recovers when it is observable", async () => {
		const f = await fixture();
		f.client.inspectInstanceOperation.mockRejectedValue(new Error("404"));
		await expect(f.journal.reconcile(id(10), "create", signal())).resolves.toEqual({
			state: "unknown",
			operationId: id(100),
		});
		await expect((await f.reopen()).reconcile(id(11), "delete", signal())).rejects.toThrow("UNSETTLED");
		f.client.inspectInstanceOperation.mockResolvedValue("failed");
		await expect((await f.reopen()).reconcile(id(10), "create", signal())).resolves.toEqual({
			state: "failed",
			operationId: id(100),
		});
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(1);
	});
	it("serializes create/start/stop/delete and makes every completed command replay inert", async () => {
		const f = await fixture();
		f.client.inspectInstanceOperation.mockResolvedValue("succeeded");
		for (const [index, action] of (["create", "start", "stop", "delete"] as const).entries()) {
			await expect((await f.reopen()).reconcile(id(10 + index), action, signal())).resolves.toMatchObject({
				state: "succeeded",
			});
		}
		await f.journal.reconcile(id(10), "create", signal());
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(4);
		expect(f.client.inspectInstanceOperation).toHaveBeenCalledTimes(4);
		expect(await f.events()).toHaveLength(12);
	});
	it("allows only the winner of two concurrent journal claims to submit", async () => {
		const f = await fixture();
		const second = await f.reopen();
		let release: () => void = () => {};
		const gate = new Promise<void>((resolveGate) => {
			release = resolveGate;
		});
		let entered: () => void = () => {};
		const dispatched = new Promise<void>((resolveEntered) => {
			entered = resolveEntered;
		});
		f.client.submitInstanceOperation.mockImplementationOnce(async (project) => {
			entered();
			await gate;
			return { project, instanceName: f.plan.request.name, operationId: id(100) };
		});
		const first = f.journal.reconcile(id(10), "create", signal());
		await dispatched;
		await expect(second.reconcile(id(10), "create", signal())).resolves.toEqual({ state: "unknown" });
		await expect(second.reconcile(id(11), "start", signal())).rejects.toThrow("UNSETTLED");
		release();
		await first;
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(1);
	});
	it("persists accepted identity during shutdown and resumes after process replacement", async () => {
		const f = await fixture();
		const stop = new AbortController();
		f.client.submitInstanceOperation.mockImplementationOnce(async (project) => {
			stop.abort();
			return { project, instanceName: f.plan.request.name, operationId: id(100) };
		});
		await expect(f.journal.reconcile(id(10), "start", stop.signal)).resolves.toEqual({
			state: "unknown",
			operationId: id(100),
		});
		expect((await f.events()).at(-1).kind).toBe("accepted");
		f.client.inspectInstanceOperation.mockResolvedValue("succeeded");
		await expect((await f.reopen()).reconcile(id(10), "start", signal())).resolves.toMatchObject({
			state: "succeeded",
		});
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(1);
	});
	it("atomically elects one dispatcher when separate providers race from an empty journal", async () => {
		const f = await fixture();
		const second = await f.reopen();
		const results = await Promise.allSettled([
			f.journal.reconcile(id(10), "create", signal()),
			second.reconcile(id(10), "create", signal()),
		]);
		expect(results.some((result) => result.status === "fulfilled" && result.value.state === "pending")).toBe(true);
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(1);
		expect((await f.events()).map((event) => event.kind)).toEqual(["dispatch", "accepted"]);
		await expect((await f.reopen()).reconcile(id(10), "create", signal())).resolves.toMatchObject({
			state: "pending",
		});
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(1);
	});
	it.each(["binding", "provider", "provider policy", "intent", "command action"])(
		"rejects changed %s without another physical request",
		async (changed) => {
			const f = await fixture();
			await f.journal.reconcile(id(10), "create", signal());
			if (changed === "binding")
				await expect(
					LxdOfficeOperationJournal.open(f.root, id(6), { ...f.config, computerGeneration: 2 }, f.client),
				).rejects.toThrow("JOURNAL_UNCONFIRMED");
			if (changed === "intent")
				await expect(LxdOfficeOperationJournal.open(f.root, id(7), f.config, f.client)).rejects.toThrow(
					"JOURNAL_UNCONFIRMED",
				);
			if (changed === "provider")
				await expect(
					LxdOfficeOperationJournal.open(f.root, id(6), { ...f.config, providerId: id(90) }, f.client),
				).rejects.toThrow("JOURNAL_UNCONFIRMED");
			if (changed === "provider policy")
				await expect(
					LxdOfficeOperationJournal.open(
						f.root,
						id(6),
						{ ...f.config, providerPolicySha256: "e".repeat(64) },
						f.client,
					),
				).rejects.toThrow("JOURNAL_UNCONFIRMED");
			if (changed === "command action")
				await expect(f.journal.reconcile(id(10), "delete", signal())).rejects.toThrow("COMMAND_CONFLICT");
			expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(1);
		},
	);
	it.each(["partial record", "sequence hole", "changed hash", "permissive mode", "symlink"])(
		"fails closed on %s instead of silently restarting the journal",
		async (corruption) => {
			const f = await fixture();
			await f.journal.reconcile(id(10), "create", signal());
			const path = join(f.path, "000001.json");
			if (corruption === "partial record") await writeFile(path, '{"schema":');
			if (corruption === "sequence hole") await rm(join(f.path, "000000.json"));
			if (corruption === "changed hash") {
				const record = JSON.parse(await readFile(path, "utf8"));
				record.previousSha256 = "0".repeat(64);
				await writeFile(path, JSON.stringify(record));
			}
			if (corruption === "permissive mode") await chmod(path, 0o644);
			if (corruption === "symlink") {
				await rm(path);
				await symlink(join(f.path, "authority.json"), path);
			}
			await expect(f.reopen()).rejects.toThrow("JOURNAL_UNCONFIRMED");
			expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(1);
		},
	);
	it("requires a private canonical provider-owned state directory", async () => {
		const f = await fixture();
		await chmod(f.root, 0o755);
		await expect(f.reopen()).rejects.toThrow("DIRECTORY_UNSAFE");
	});
	it("does not journal or submit an already cancelled request", async () => {
		const f = await fixture();
		const stop = new AbortController();
		stop.abort();
		await expect(f.journal.reconcile(id(10), "create", stop.signal)).rejects.toThrow();
		expect(await f.events()).toEqual([]);
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
	});
	it("refuses a response bound to another VM without recording an accepted operation", async () => {
		const f = await fixture();
		f.client.submitInstanceOperation.mockResolvedValue({
			project: f.config.project,
			instanceName: "other",
			operationId: id(100),
		});
		await expect(f.journal.reconcile(id(10), "create", signal())).resolves.toEqual({ state: "unknown" });
		expect(await f.events()).toHaveLength(1);
		expect(f.client.inspectInstanceOperation).not.toHaveBeenCalled();
	});
});
