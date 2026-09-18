import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LxdOperationState, LxdTrackedClient } from "../src/lxd-client.ts";
import { LxdLoginJournal } from "../src/lxd-login-journal.ts";
import { type LxdLoginBinding, lxdLoginPlan } from "../src/lxd-login-plan.ts";

const roots: string[] = [];
const caller = () => new AbortController().signal;
const nodeId = "30000000-0000-4000-8000-000000000010";
function binding(): LxdLoginBinding {
	return {
		schema: "qorpera.lxd-login-allocation/v1",
		allocationId: randomUUID(),
		loginId: randomUUID(),
		profileId: randomUUID(),
		computeIdentityId: randomUUID(),
		capabilitySha256: "c".repeat(64),
		bootstrapSha256: "b".repeat(64),
		policy: {
			schema: "qorpera.lxd-login-node-policy/v1",
			providerId: "lxd",
			machineIdSha256: "d".repeat(64),
			project: "qorpera",
			loginProfile: "login-v2",
			networkInterface: "eth0",
			imageServer: "local",
			imageFingerprint: "a".repeat(64),
			storagePool: "pool",
			identityVolumePrefix: "identity-",
			identityVolumeSize: "32GiB",
			rootDiskSize: "80GiB",
			cpuLimit: 4,
			memoryLimit: "8GiB",
		},
	};
}
async function setup() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "qorpera-login-journal-")));
	roots.push(root);
	const initial = binding();
	const client = {
		submitInstanceOperation: vi.fn<LxdTrackedClient["submitInstanceOperation"]>(async (project, action) => ({
			project,
			instanceName: action.action === "create" ? action.request.name : action.name,
			operationId: randomUUID(),
		})),
		inspectInstanceOperation: vi.fn<LxdTrackedClient["inspectInstanceOperation"]>(async () => "succeeded"),
	};
	const open = () => LxdLoginJournal.open(root, initial.loginId, client);
	const journal = await LxdLoginJournal.open(root, initial.loginId, client, initial);
	const authorize = vi.fn(async () => {
		await journal.place(nodeId);
		return caller();
	});
	return { root, initial, client, journal, open, authorize };
}
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("login physical operation history", () => {
	it.each(["providerId", "machineIdSha256", "imageFingerprint", "memoryLimit", "identityVolumePrefix"] as const)(
		"rejects coerced policy field %s",
		(key) => {
			const initial = binding();
			const changed = { ...initial, policy: { ...initial.policy, [key]: [initial.policy[key]] } };
			expect(() => lxdLoginPlan(changed as unknown as LxdLoginBinding)).toThrow("INVALID_LOGIN_POLICY");
		},
	);
	it("rejects coerced placement and release fields without recording them", async () => {
		const { journal } = await setup();
		await expect(journal.place([nodeId] as unknown as string)).rejects.toThrow("invalid placement");
		expect(await journal.close(caller())).toBe(true);
		await expect(journal.release(123 as unknown as string)).rejects.toThrow("invalid release");
		expect((await journal.state()).releasedAt).toBeNull();
	});
	it("retains distinct physical identity and exactly one create/start/stop/delete across reconstructed providers", async () => {
		const { journal, open, client, authorize, initial } = await setup();
		expect(initial.allocationId).not.toBe(initial.loginId);
		await expect(journal.run("create", caller(), authorize)).resolves.toMatchObject({ state: "succeeded" });
		await expect((await open()).run("create", caller(), authorize)).resolves.toMatchObject({ state: "succeeded" });
		await (await open()).run("start", caller(), authorize);
		expect(await journal.close(caller())).toBe(true);
		await (await open()).run("stop", caller());
		await (await open()).run("delete", caller());
		await journal.release("2026-09-08T00:00:00.000Z");
		await (await open()).release("2026-09-08T00:00:00.000Z");
		expect(client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual([
			"create",
			"start",
			"stop",
			"delete",
		]);
		expect(authorize).toHaveBeenCalledTimes(2);
		expect((await (await open()).state()).releasedAt).toBe("2026-09-08T00:00:00.000Z");
	});
	it("competing processes dispatch a create only once", async () => {
		const { journal, open, client, authorize } = await setup();
		const other = await open();
		await Promise.all([journal.run("create", caller(), authorize), other.run("create", caller(), authorize)]);
		expect(client.submitInstanceOperation).toHaveBeenCalledTimes(1);
		await expect(other.observe("create", caller())).resolves.toMatchObject({ state: "succeeded" });
	});
	it("a lost submission stays unknown after reconstruction and cannot close or release", async () => {
		const { journal, open, client, authorize } = await setup();
		client.submitInstanceOperation.mockRejectedValue(new Error("reply lost after effect"));
		await expect(journal.run("create", caller(), authorize)).resolves.toEqual({ state: "unknown" });
		const other = await open();
		await expect(other.run("create", caller(), authorize)).resolves.toEqual({ state: "unknown" });
		expect(await other.close(caller())).toBe(false);
		await expect(other.release("2026-09-08T00:00:00Z")).rejects.toThrow();
		expect(client.submitInstanceOperation).toHaveBeenCalledTimes(1);
		expect(client.inspectInstanceOperation).not.toHaveBeenCalled();
	});
	it("recovers an accepted operation after lost polls, including during cleanup", async () => {
		const { journal, open, client, authorize } = await setup();
		client.inspectInstanceOperation.mockRejectedValueOnce(new Error("lost poll"));
		await expect(journal.run("create", caller(), authorize)).resolves.toMatchObject({
			state: "unknown",
			operationId: expect.any(String),
		});
		expect(await (await open()).close(caller())).toBe(true);
		expect(client.submitInstanceOperation).toHaveBeenCalledTimes(1);
		expect((await journal.state()).operations.create?.state).toBe("succeeded");
	});
	it.each(["pending", "404", "invalid"])("does not release accepted IO on %s observation", async (observation) => {
		const { journal, open, client, authorize } = await setup();
		client.inspectInstanceOperation.mockImplementation(async () => {
			if (observation === "404") throw new Error("404");
			return observation as LxdOperationState;
		});
		await journal.run("create", caller(), authorize);
		expect(await (await open()).close(caller())).toBe(false);
		expect(client.submitInstanceOperation).toHaveBeenCalledTimes(1);
	});
	it("durable closure wins against a start awaiting admission", async () => {
		const { journal, open, client, authorize } = await setup();
		await journal.run("create", caller(), authorize);
		let resume = () => {};
		let entered = () => {};
		const held = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const reached = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const start = journal.run("start", caller(), async () => {
			entered();
			await held;
			return caller();
		});
		const assertion = expect(start).rejects.toThrow("invalid dispatch order");
		await reached;
		expect(await (await open()).close(caller())).toBe(true);
		resume();
		await assertion;
		expect(client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual(["create"]);
	});
	it("cleanup waits for a start already sent by another process", async () => {
		const { journal, open, client, authorize } = await setup();
		await journal.run("create", caller(), authorize);
		client.inspectInstanceOperation.mockResolvedValue("pending");
		await journal.run("start", caller(), authorize);
		const other = await open();
		expect(await other.close(caller())).toBe(false);
		client.inspectInstanceOperation.mockResolvedValue("succeeded");
		expect(await other.close(caller())).toBe(true);
		expect(client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual(["create", "start"]);
	});
	it("expired dispatch authority sends no IO, and caller cancellation after acceptance retains its operation", async () => {
		const { journal, client, authorize, open } = await setup();
		await expect(
			journal.run("create", caller(), async () => {
				await authorize();
				return AbortSignal.abort();
			}),
		).rejects.toThrow();
		expect(client.submitInstanceOperation).not.toHaveBeenCalled();
		const controller = new AbortController();
		client.submitInstanceOperation.mockImplementationOnce(async (project, action) => {
			controller.abort();
			return {
				project,
				instanceName: action.action === "create" ? action.request.name : action.name,
				operationId: randomUUID(),
			};
		});
		await expect(journal.run("create", controller.signal, authorize)).resolves.toMatchObject({
			state: "unknown",
			operationId: expect.any(String),
		});
		await expect((await open()).observe("create", caller())).resolves.toMatchObject({ state: "succeeded" });
	});
	it("requires admission and placement, refuses policy drift and node reassignment", async () => {
		const { journal, root, initial, client } = await setup();
		await expect(journal.run("create", caller())).rejects.toThrow("ADMISSION_REQUIRED");
		await expect(journal.run("create", caller(), async () => caller())).rejects.toThrow("invalid dispatch order");
		await journal.place(nodeId);
		await expect(journal.place(randomUUID())).rejects.toThrow("PLACEMENT_CONFLICT");
		await expect(
			LxdLoginJournal.open(root, initial.loginId, client, {
				...initial,
				policy: { ...initial.policy, cpuLimit: 1 },
			}),
		).rejects.toThrow("BINDING_CONFLICT");
		expect(client.submitInstanceOperation).not.toHaveBeenCalled();
	});
	it.each(["symlink", "permissions", "gap", "hash"])("refuses unsafe or broken history: %s", async (corruption) => {
		const { journal, root, initial, open, authorize } = await setup();
		await journal.run("create", caller(), authorize);
		const path = join(root, initial.loginId, "000001.json");
		if (corruption === "symlink") {
			await unlink(path);
			await symlink("000000.json", path);
		}
		if (corruption === "permissions") await chmod(path, 0o644);
		if (corruption === "gap") await unlink(path);
		if (corruption === "hash") {
			const value = JSON.parse(await readFile(path, "utf8"));
			value.previousSha256 = "0".repeat(64);
			await writeFile(path, JSON.stringify(value), { mode: 0o600 });
		}
		await expect(open()).rejects.toThrow("UNCONFIRMED");
	});
	it("stores only public binding and operation metadata", async () => {
		const { journal, root, initial, authorize } = await setup();
		await journal.run("create", caller(), authorize);
		const directory = join(root, initial.loginId),
			names = await readdir(directory);
		for (const name of names) {
			const content = await readFile(join(directory, name), "utf8");
			expect(content).not.toMatch(/sb_secret|Bearer|login_capability/);
		}
		const plan = lxdLoginPlan(initial);
		expect(plan.cpuMillis).toBe(4000);
		expect(plan.memoryBytes).toBe(8 * 1024 ** 3);
		expect(JSON.stringify(plan.request)).not.toContain(initial.capabilitySha256);
	});
});
