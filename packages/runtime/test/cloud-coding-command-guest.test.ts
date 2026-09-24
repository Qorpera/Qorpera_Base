import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CodingGuestCommandPorts,
	executeCodingGuestCommand,
	parseCodingGuestCommandRequest,
	refreshCodingGuestCommandLease,
	runCodingGuestCommand,
} from "../src/cloud-coding-command-guest.ts";

import { refreshCodingGuestLease } from "../src/cloud-coding-watchdog.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "coding-command-guest-"));
	roots.push(root);
	// Production layout: the output root is the custody root's logs directory.
	for (const name of ["inbox", "commands", "logs", "repository"]) await mkdir(join(root, name), { mode: 0o755 });
	const request = {
		schema: "qorpera.coding-command-request/v1",
		workerId: randomUUID(),
		vmId: randomUUID(),
		commandId: randomUUID(),
		requestId: randomUUID(),
		turn: 1,
		inputSha256: "a".repeat(64),
		command: "printf 'hello'",
		timeoutMs: 120000,
	};
	const bootId = randomUUID();
	const configurationPath = join(root, "guest.json");
	// The session's folders, moved under the test's temporary custody root.
	const folders = {
		workspacePath: join(root, "repository"),
		homePath: join(root, "home"),
		cachePath: join(root, "cache"),
		outputRoot: join(root, "logs"),
	};
	await writeFile(
		configurationPath,
		JSON.stringify({
			schema: "qorpera.coding-command-guest/v3",
			workerId: request.workerId,
			vmId: request.vmId,
			bootId,
			// start chowns each log to uid:gid, so the test user must hold both;
			// CI runs this file under a gid >= 1000 (see step2-lxd.yml).
			uid: Math.max(1000, process.getuid?.() ?? 1000),
			gid: Math.max(1000, process.getgid?.() ?? 1000),
			...folders,
			resourceProfile: {
				maxTimeoutMs: 1800000,
				memoryBytes: 2147483648,
				tasksMax: 256,
				cpuQuotaPercent: 200,
				maxLogBytes: 67108864,
			},
		}),
		{ mode: 0o444 },
	);
	const requestPath = join(root, "inbox", `${request.commandId}.json`);
	await writeFile(requestPath, JSON.stringify(request), { mode: 0o444 });
	let status =
		"LoadState=loaded\nActiveState=active\nSubState=running\nResult=success\nExecMainCode=0\nExecMainStatus=0\n";
	const system = vi.fn(async (executable: string, args: readonly string[]) => {
		if (executable === "/usr/bin/systemd-run") {
			const intent = JSON.parse(await readFile(join(root, "commands", request.commandId, "intent.json"), "utf8"));
			expect(intent.request).toEqual(request);
			expect(intent.commandSha256).toMatch(/^[0-9a-f]{64}$/);
			return "";
		}
		if (args[0] === "stop") {
			status =
				"LoadState=loaded\nActiveState=inactive\nSubState=dead\nResult=success\nExecMainCode=2\nExecMainStatus=15\n";
			return "";
		}
		return status;
	});
	const ports: CodingGuestCommandPorts = {
		assertStorage: async () => undefined,
		root,
		configurationPath,
		folders,
		protectedUid: process.getuid?.() ?? 0,
		protectedDirectoryRoot: root,
		inspectMachine: async () => bootId,
		nowMs: async () => 1000,
		system,
	};
	await refreshCodingGuestLease(
		{
			schema: "qorpera.coding-guest-lease-refresh/v1",
			workerId: request.workerId,
			vmId: request.vmId,
			requestId: request.requestId,
			turn: request.turn,
			leaseTokenSha256: "f".repeat(64),
			ttlMs: 60000,
		},
		{ workerId: request.workerId, vmId: request.vmId, bootId },
		{ ...ports, inspectBoot: ports.inspectMachine, system: async () => "" },
	);
	return {
		root,
		request,
		requestPath,
		bootId,
		ports,
		system,
		setStatus: (value: string) => {
			status = value;
		},
	};
}

describe("coding VM command supervisor", () => {
	it("bounds derived read pages without deleting authoritative logs", async () => {
		const f = await fixture();
		await runCodingGuestCommand("start", f.request.workerId, f.request.commandId, f.ports);
		await writeFile(join(f.root, "logs", f.request.commandId, "output.log"), "x".repeat(128));
		for (let offset = 0; offset < 64; offset++)
			await runCodingGuestCommand("read", f.request.workerId, f.request.commandId, f.ports, { offset, limit: 4 });
		const pages = (await readdir(join(f.root, "commands", f.request.commandId))).filter((p) =>
			p.startsWith("read-page-"),
		);
		expect(pages.length).toBeLessThanOrEqual(32);
		expect(await readFile(join(f.root, "logs", f.request.commandId, "output.log"), "utf8")).toBe("x".repeat(128));
	});
	it("denies missing or changed storage before reading an inbox or dispatching a unit", async () => {
		const f = await fixture();
		await rm(f.requestPath);
		await expect(
			runCodingGuestCommand("start", f.request.workerId, f.request.commandId, {
				...f.ports,
				assertStorage: async () => {
					throw new Error("NAS_CHANGED");
				},
			}),
		).rejects.toThrow("NAS_CHANGED");
		expect(f.system).not.toHaveBeenCalled();
	});
	it("refuses command launch without a live guest lease and cannot renew when watchdog timer is disabled", async () => {
		const f = await fixture();
		await expect(
			runCodingGuestCommand("start", f.request.workerId, f.request.commandId, {
				...f.ports,
				nowMs: async () => 61000,
			}),
		).rejects.toThrow("LEASE_UNAVAILABLE");
		expect(f.system.mock.calls.filter(([exe]) => exe === "/usr/bin/systemd-run")).toHaveLength(0);
		await writeFile(
			join(f.root, "inbox", "lease-refresh.json"),
			JSON.stringify({
				schema: "qorpera.coding-guest-lease-refresh/v1",
				workerId: f.request.workerId,
				vmId: f.request.vmId,
				requestId: f.request.requestId,
				turn: 1,
				leaseTokenSha256: "f".repeat(64),
				ttlMs: 30000,
			}),
			{ mode: 0o444 },
		);
		await expect(
			refreshCodingGuestCommandLease(f.request.workerId, {
				...f.ports,
				system: async () => {
					throw new Error("watchdog disabled");
				},
			}),
		).rejects.toThrow("watchdog disabled");
		expect(JSON.parse(await readFile(join(f.root, "lease.json"), "utf8")).expiresAtMonoMs).toBe(61000);
	});

	it("retains intent before one background unit and publishes a protected running receipt", async () => {
		const f = await fixture();
		const result = await runCodingGuestCommand("start", f.request.workerId, f.request.commandId, f.ports);
		expect(result.schema).toBe("qorpera.coding-command-result/v2");
		expect(result.state).toBe("running");
		expect(result.exitCode).toBeNull();
		const command = f.system.mock.calls.find(([executable]) => executable === "/usr/bin/systemd-run")!;
		expect(command[1]).toContain("--property=RuntimeMaxSec=120");
		expect(command[1]).toContain("--property=NoNewPrivileges=yes");
		expect(command[1]).toContain("--property=KillMode=control-group");
		expect(command[1]).toContain("--property=RemainAfterExit=yes");
		expect(command[1]).toContain("--property=ExitType=cgroup");
		expect(command[1]).toContain("--property=ProtectProc=invisible");
		// Another session's shared memory and message queues stay out of reach.
		expect(command[1]).toContain("--property=PrivateIPC=yes");
		// The helper's own refusal line stays in the guest's journal.
		expect(command[1]).toContain("--property=StandardError=journal");
		expect(command[1]).not.toContain("--property=StandardError=null");
		expect(command[1]).not.toContain(f.request.command);
		expect(JSON.parse(await readFile(join(f.root, "commands", f.request.commandId, "status.json"), "utf8"))).toEqual(
			result,
		);
		await runCodingGuestCommand("start", f.request.workerId, f.request.commandId, f.ports);
		expect(f.system.mock.calls.filter(([executable]) => executable === "/usr/bin/systemd-run")).toHaveLength(1);
	});
	it("keeps uncertain launches unconfirmed across replacement without replay", async () => {
		const f = await fixture();
		f.system.mockImplementation(async (executable) => {
			if (executable === "/usr/bin/systemd-run") throw new Error("lost acceptance");
			return "LoadState=not-found\nActiveState=inactive\n";
		});
		expect((await runCodingGuestCommand("start", f.request.workerId, f.request.commandId, f.ports)).state).toBe(
			"unconfirmed",
		);
		expect(
			(
				await runCodingGuestCommand("start", f.request.workerId, f.request.commandId, {
					...f.ports,
				})
			).state,
		).toBe("unconfirmed");
		expect(f.system.mock.calls.filter(([executable]) => executable === "/usr/bin/systemd-run")).toHaveLength(1);
	});
	it("retains successful terminal state after transient unit loss", async () => {
		const f = await fixture();
		await runCodingGuestCommand("start", f.request.workerId, f.request.commandId, f.ports);
		await writeFile(join(f.root, "logs", f.request.commandId, "output.log"), "passed\n");
		f.setStatus(
			"LoadState=loaded\nActiveState=active\nSubState=exited\nResult=success\nExecMainCode=1\nExecMainStatus=0\n",
		);
		const complete = await runCodingGuestCommand("read", f.request.workerId, f.request.commandId, f.ports);
		expect(complete).toMatchObject({
			state: "succeeded",
			exitCode: 0,
			output: "passed\n",
			truncated: false,
		});
		await rm(join(f.root, "commands", f.request.commandId, "status.json"));
		f.system.mockRejectedValue(new Error("unit unavailable"));
		expect(await runCodingGuestCommand("read", f.request.workerId, f.request.commandId, f.ports)).toEqual(complete);
		expect(await runCodingGuestCommand("cancel", f.request.workerId, f.request.commandId, f.ports)).toEqual(complete);
		expect(JSON.parse(await readFile(join(f.root, "commands", f.request.commandId, "status.json"), "utf8"))).toEqual(
			complete,
		);
	});
	it("kills the exact command unit and records cancellation only after a stopped observation", async () => {
		const f = await fixture();
		await runCodingGuestCommand("start", f.request.workerId, f.request.commandId, f.ports);
		expect(await runCodingGuestCommand("cancel", f.request.workerId, f.request.commandId, f.ports)).toMatchObject({
			state: "cancelled",
			exitCode: null,
		});
		expect(f.system).toHaveBeenCalledWith("/usr/bin/systemctl", [
			"stop",
			`qorpera-coding-${f.request.workerId.replaceAll("-", "")}-${f.request.commandId}.service`,
		]);
	});
	it("reports reboot uncertainty without invoking another command", async () => {
		const f = await fixture();
		await runCodingGuestCommand("start", f.request.workerId, f.request.commandId, f.ports);
		await writeFile(join(f.root, "logs", f.request.commandId, "output.log"), "retained before reboot");
		f.system.mockClear();
		expect(
			(
				await runCodingGuestCommand("read", f.request.workerId, f.request.commandId, {
					...f.ports,
					inspectMachine: async () => randomUUID(),
				})
			).state,
		).toBe("unconfirmed");
		await expect(
			runCodingGuestCommand("start", f.request.workerId, f.request.commandId, {
				...f.ports,
				inspectMachine: async () => randomUUID(),
			}),
		).rejects.toThrow("LEASE_UNAVAILABLE");
		expect(f.system).not.toHaveBeenCalled();
		expect(
			(
				await runCodingGuestCommand("read", f.request.workerId, f.request.commandId, {
					...f.ports,
					inspectMachine: async () => randomUUID(),
				})
			).output,
		).toBe("retained before reboot");
	});
	it("bounds invalid UTF8 and output truncation in bytes", async () => {
		const f = await fixture();
		await runCodingGuestCommand("start", f.request.workerId, f.request.commandId, f.ports);
		await writeFile(join(f.root, "logs", f.request.commandId, "output.log"), Buffer.alloc(4097, 255));
		const result = await runCodingGuestCommand("read", f.request.workerId, f.request.commandId, f.ports);
		expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(4096);
		expect(result.truncated).toBe(true);
	});
	it("retains output beyond the preview and pages terminal logs without re-execution", async () => {
		const f = await fixture();
		await runCodingGuestCommand("start", f.request.workerId, f.request.commandId, f.ports);
		const contents = `first\n${"x".repeat(12000)}\nlast\n`;
		await writeFile(join(f.root, "logs", f.request.commandId, "output.log"), contents);
		f.setStatus(
			"LoadState=loaded\nActiveState=active\nSubState=exited\nResult=success\nExecMainCode=1\nExecMainStatus=0\n",
		);
		let offset = 0,
			combined = "";
		do {
			const page = await runCodingGuestCommand("read", f.request.workerId, f.request.commandId, f.ports, {
				offset,
				limit: 1024,
			});
			combined += page.output;
			offset = page.log.nextOffset;
			expect(page.state).toBe("succeeded");
		} while (offset < Buffer.byteLength(contents));
		expect(combined).toBe(contents);
		const tail = await runCodingGuestCommand("read", f.request.workerId, f.request.commandId, f.ports, {
			tail: true,
			limit: 16,
		});
		expect(tail.output).toBe(contents.slice(-16));
		expect(tail.truncated).toBe(false);
		expect(f.system.mock.calls.filter(([exe]) => exe === "/usr/bin/systemd-run")).toHaveLength(1);
	});
	it("applies the admitted resource limits and permits only the admitted NAS working paths", async () => {
		const f = await fixture(),
			path = f.ports.configurationPath!;
		const config = JSON.parse(await readFile(path, "utf8"));
		config.resourceProfile = {
			maxTimeoutMs: 120000,
			memoryBytes: 8589934592,
			tasksMax: 1024,
			cpuQuotaPercent: 400,
			maxLogBytes: 1048576,
		};
		await chmod(path, 0o644);
		await writeFile(path, JSON.stringify(config));
		await chmod(path, 0o444);
		await runCodingGuestCommand("start", f.request.workerId, f.request.commandId, f.ports);
		const args = f.system.mock.calls.find(([exe]) => exe === "/usr/bin/systemd-run")![1];
		expect(args).toContain("--property=MemoryMax=8589934592");
		expect(args).toContain("--property=CPUQuota=400%");
		expect(args).toContain("--property=TasksMax=1024");
		expect(args).toContain(
			`--property=ReadWritePaths=${config.workspacePath} ${config.homePath} ${config.cachePath} ${join(config.outputRoot, f.request.commandId)}`,
		);
		await writeFile(join(f.root, "logs", f.request.commandId, "output.log"), Buffer.alloc(1048577, 120));
		expect(
			(
				await runCodingGuestCommand("read", f.request.workerId, f.request.commandId, f.ports, {
					tail: true,
					limit: 16,
				})
			).log,
		).toMatchObject({ totalBytes: 1048576, limitBytes: 1048576, limitReached: true });
	});
	it("rejects changed requests and linked or writable inbox files before execution", async () => {
		const f = await fixture();
		await chmod(f.requestPath, 0o666);
		await expect(runCodingGuestCommand("start", f.request.workerId, f.request.commandId, f.ports)).rejects.toThrow(
			"UNPROTECTED",
		);
		await chmod(f.requestPath, 0o644);
		await runCodingGuestCommand("start", f.request.workerId, f.request.commandId, f.ports);
		await writeFile(f.requestPath, JSON.stringify({ ...f.request, command: "different command" }));
		await expect(runCodingGuestCommand("start", f.request.workerId, f.request.commandId, f.ports)).rejects.toThrow(
			"INTENT_CHANGED",
		);
		await rm(f.requestPath);
		await symlink(f.ports.configurationPath!, f.requestPath);
		await expect(runCodingGuestCommand("start", f.request.workerId, f.request.commandId, f.ports)).rejects.toThrow();
		expect(f.system.mock.calls.filter(([executable]) => executable === "/usr/bin/systemd-run")).toHaveLength(1);
	});
	it("reads a refused execute step back as failed with only its code, never unconfirmed", async () => {
		const f = await fixture();
		await runCodingGuestCommand("start", f.request.workerId, f.request.commandId, f.ports);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const refused = await executeCodingGuestCommand(f.request.workerId, f.request.commandId, {
				...f.ports,
				assertStorage: async () => {
					throw new Error("CODING_GUEST_STORAGE_MOUNT_INVALID");
				},
			});
			expect(refused).toBe(125);
		} finally {
			stderr.mockRestore();
		}
		f.setStatus(
			"LoadState=loaded\nActiveState=failed\nSubState=failed\nResult=exit-code\nExecMainCode=1\nExecMainStatus=125\n",
		);
		expect(await runCodingGuestCommand("read", f.request.workerId, f.request.commandId, f.ports)).toMatchObject({
			state: "failed",
			exitCode: 125,
			output: "CODING_GUEST_STORAGE_MOUNT_INVALID\n",
		});
	});
	it("rejects a replaced output ancestor without reading its target", async () => {
		const f = await fixture();
		await runCodingGuestCommand("start", f.request.workerId, f.request.commandId, f.ports);
		await rm(join(f.root, "logs", f.request.commandId), { recursive: true });
		const outside = join(f.root, "private");
		await mkdir(outside);
		await writeFile(join(outside, "output.log"), "private bytes");
		await symlink(outside, join(f.root, "logs", f.request.commandId));
		const receipt = await runCodingGuestCommand("read", f.request.workerId, f.request.commandId, f.ports);
		expect(receipt).toMatchObject({ state: "unconfirmed", output: "" });
	});
	it("requires configuration readable by the unprivileged execution helper", async () => {
		const f = await fixture();
		await chmod(f.ports.configurationPath!, 0o400);
		await expect(runCodingGuestCommand("start", f.request.workerId, f.request.commandId, f.ports)).rejects.toThrow(
			"CONFIGURATION",
		);
		expect(f.system).not.toHaveBeenCalled();
	});

	it.each([
		{ timeoutMs: 999 },
		{ timeoutMs: 1800001 },
		{ command: "x\0y" },
		{ command: "x\ud800" },
		{ command: "a".repeat(16385) },
		{ command: `x${"\u0001".repeat(16383)}` },
		{ commandId: "../escape" },
		{ token: "secret" },
		{ turn: 0 },
	])("rejects unbounded or open request %#", async (change) => {
		const f = await fixture();
		expect(() => parseCodingGuestCommandRequest({ ...f.request, ...change })).toThrow();
	});
});
