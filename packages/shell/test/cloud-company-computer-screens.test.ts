import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CloudCompanyComputerScreenManager,
	type CompanyComputerScreenLauncher,
	type CompanyComputerScreenSessionHandle,
	waitForCompanyComputerScreenReady,
} from "../src/cloud-company-computer-screens.ts";
import { companyComputerScreenBinding } from "../src/cloud-company-computer-state.ts";
import {
	computerBinding,
	computerDeferred,
	computerId,
	computerRegistry,
	computerScope,
} from "./fixtures/company-computer.ts";

const managers: CloudCompanyComputerScreenManager[] = [];
const servers: Server[] = [];
afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.stopAll().catch(() => undefined);
	for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

function launcherFixture() {
	const sessions: Array<{
		handle: CompanyComputerScreenSessionHandle;
		ready: ReturnType<typeof computerDeferred<void>>;
		exited: ReturnType<typeof computerDeferred<void>>;
	}> = [];
	const launcher: CompanyComputerScreenLauncher = {
		launch: vi.fn(async () => {
			const ready = computerDeferred<void>();
			const exited = computerDeferred<void>();
			const handle = {
				ready: ready.promise,
				exited: exited.promise,
				stop: vi.fn(async () => {
					exited.resolve();
				}),
			};
			sessions.push({ handle, ready, exited });
			return handle;
		}),
	};
	const manager = new CloudCompanyComputerScreenManager(computerScope(), launcher);
	managers.push(manager);
	return { launcher, manager, sessions };
}

describe("persistent desktop reconciliation (fake supervisor, no Linux/cloud startup)", () => {
	it("exposes a screen only after readiness and never substitutes a different binding", async () => {
		const { manager, sessions } = launcherFixture();
		const reconcile = manager.reconcile(computerRegistry(), new AbortController().signal);
		await vi.waitFor(() => expect(sessions).toHaveLength(1));
		expect(manager.liveVncPort(computerBinding())).toBeUndefined();
		sessions[0].ready.resolve();
		await reconcile;
		expect(manager.liveVncPort(computerBinding())).toBe(5901);
		expect(manager.liveVncPort({ ...computerBinding(), staffAgentId: computerId(99) })).toBeUndefined();
		expect(() => manager.liveVncPort({ ...computerBinding(), companyId: computerId(99) })).toThrow(
			"COMPUTER_BINDING_MISMATCH",
		);
	});

	it("retries a failed launch and reopens the same ordinal after a confirmed crash", async () => {
		const { manager, sessions } = launcherFixture();
		const first = manager
			.reconcile(computerRegistry(), new AbortController().signal)
			.catch((error: unknown) => error);
		await vi.waitFor(() => expect(sessions).toHaveLength(1));
		sessions[0].ready.reject(new Error("XFCE_FAILED"));
		expect(await first).toBeInstanceOf(AggregateError);
		const retry = manager.reconcile(computerRegistry(), new AbortController().signal);
		await vi.waitFor(() => expect(sessions).toHaveLength(2));
		sessions[1].ready.resolve();
		await retry;
		sessions[1].exited.resolve();
		await Promise.resolve();
		expect(manager.liveOrdinals()).toEqual([]);
		const restart = manager.reconcile(computerRegistry(), new AbortController().signal);
		await vi.waitFor(() => expect(sessions).toHaveLength(3));
		sessions[2].ready.resolve();
		await restart;
		expect(manager.liveOrdinals()).toEqual([1]);
	});

	it("does not launch a replacement until the prior generation has been reaped", async () => {
		const { manager, sessions } = launcherFixture();
		const initial = manager.reconcile(computerRegistry(), new AbortController().signal);
		await vi.waitFor(() => expect(sessions).toHaveLength(1));
		sessions[0].ready.resolve();
		await initial;
		const next = { ...computerRegistry(), revision: 2, computerGeneration: 2 };
		const stopped = computerDeferred<void>();
		sessions[0].handle.stop = vi.fn(() => stopped.promise);
		const replace = manager.reconcile(next, new AbortController().signal);
		await vi.waitFor(() => expect(sessions[0].handle.stop).toHaveBeenCalledOnce());
		expect(sessions).toHaveLength(1);
		expect(manager.liveOrdinals()).toEqual([]);
		stopped.resolve();
		await vi.waitFor(() => expect(sessions).toHaveLength(2));
		sessions[1].ready.resolve();
		await replace;
		expect(manager.liveVncPort(computerBinding())).toBeUndefined();
		expect(manager.liveVncPort(companyComputerScreenBinding(next, next.screens[0]))).toBe(5901);
		await expect(manager.reconcile(computerRegistry(), new AbortController().signal)).rejects.toThrow(
			"STALE_SCREEN_REGISTRY",
		);
	});

	it("retains a failed-stop quarantine and retries stopping before the next launch", async () => {
		const { manager, sessions } = launcherFixture();
		const initial = manager.reconcile(computerRegistry(), new AbortController().signal);
		await vi.waitFor(() => expect(sessions).toHaveLength(1));
		sessions[0].ready.resolve();
		await initial;
		sessions[0].handle.stop = vi.fn().mockRejectedValueOnce(new Error("STOP_FAILED")).mockResolvedValue(undefined);
		const next = {
			...computerRegistry(),
			revision: 2,
			screens: [{ ...computerRegistry().screens[0], generation: 2 }],
		};
		await expect(manager.reconcile(next, new AbortController().signal)).rejects.toThrow("STOP_FAILED");
		expect(manager.liveOrdinals()).toEqual([]);
		expect(sessions).toHaveLength(1);
		const retry = manager.reconcile(next, new AbortController().signal);
		await vi.waitFor(() => expect(sessions).toHaveLength(2));
		sessions[1].ready.resolve();
		await retry;
		expect(sessions[0].handle.stop).toHaveBeenCalledTimes(2);
	});

	it("rejects inconsistent equal-revision snapshots and respects recovery/maintenance state", async () => {
		const { manager, sessions, launcher } = launcherFixture();
		await manager.reconcile({ ...computerRegistry(), lifecycle: "recovering" }, new AbortController().signal);
		expect(launcher.launch).not.toHaveBeenCalled();
		await expect(manager.reconcile(computerRegistry(), new AbortController().signal)).rejects.toThrow(
			"STALE_SCREEN_REGISTRY",
		);
		const active = manager.reconcile({ ...computerRegistry(), revision: 2 }, new AbortController().signal);
		await vi.waitFor(() => expect(sessions).toHaveLength(1));
		sessions[0].ready.resolve();
		await active;
		await manager.reconcile(
			{ ...computerRegistry(), revision: 3, lifecycle: "maintenance" },
			new AbortController().signal,
		);
		expect(manager.liveOrdinals()).toEqual([]);
		expect(sessions[0].handle.stop).toHaveBeenCalledOnce();
	});
});

describe("bounded RFB readiness probe (loopback component test)", () => {
	it.each([true, false])("requires the actual 3.8 banner, not merely a listening socket: %s", async (valid) => {
		const server = createServer((socket) => {
			socket.on("error", () => undefined);
			socket.end(valid ? "RFB 003.008\n" : "HTTP/1.1 200 OK\r\n");
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("NO_TEST_PORT");
		const ready = waitForCompanyComputerScreenReady(address.port, new AbortController().signal, valid ? 500 : 30);
		if (valid) await expect(ready).resolves.toBeUndefined();
		else await expect(ready).rejects.toThrow();
	});
});
