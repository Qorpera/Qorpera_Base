import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	parseCodingGuestLeaseRefresh,
	reconcileCodingGuestLease,
	refreshCodingGuestLease,
	requireCodingGuestLease,
	runCodingGuestWatchdog,
} from "../src/cloud-coding-watchdog.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "coding-watchdog-"));
	roots.push(root);
	const config = {
		workerId: randomUUID(),
		vmId: randomUUID(),
		bootId: randomUUID(),
	};
	const refresh = {
		schema: "qorpera.coding-guest-lease-refresh/v2",
		workerId: config.workerId,
		vmId: config.vmId,
		requestId: randomUUID(),
		turn: 1,
		open: true,
		leaseTokenSha256: "a".repeat(64),
		ttlMs: 60000,
	};
	let time = 100000;
	let bootId: string = config.bootId;
	const system = vi.fn(async () => "");
	const ports = {
		root,
		protectedUid: process.getuid?.() ?? 0,
		protectedDirectoryRoot: root,
		nowMs: async () => time,
		inspectBoot: async () => bootId,
		system,
	};
	return {
		root,
		config,
		refresh,
		ports,
		system,
		setTime: (value: number) => {
			time = value;
		},
		setBoot: (value: string) => {
			bootId = value;
		},
	};
}
describe("coding guest lease watchdog", () => {
	it("does not turn delayed host delivery into a fresh full lease", async () => {
		const f = await fixture();
		await refreshCodingGuestLease({ ...f.refresh, notAfterMonoMs: 100500 }, f.config, f.ports);
		const stored = JSON.parse(await readFile(join(f.root, "lease.json"), "utf8"));
		expect(stored.expiresAtMonoMs).toBe(100500);
		f.setTime(100500);
		expect(await reconcileCodingGuestLease(f.config, f.ports)).toBe("stopped");
		// The expired generation never renews; a new attachment's delivery is still bounded.
		await expect(refreshCodingGuestLease(f.refresh, f.config, f.ports)).rejects.toThrow("GENERATION_UNAVAILABLE");
		await expect(
			refreshCodingGuestLease(
				{
					...f.refresh,
					turn: 2,
					requestId: randomUUID(),
					leaseTokenSha256: "b".repeat(64),
					notAfterMonoMs: 100499,
				},
				f.config,
				f.ports,
			),
		).rejects.toThrow("REFRESH_EXPIRED");
	});

	it("stamps only the protected guest clock, renews live custody and bounds disconnected execution", async () => {
		const f = await fixture();
		await refreshCodingGuestLease(f.refresh, f.config, f.ports);
		// Only this session's slice: the member's other sessions keep running.
		expect(f.system).toHaveBeenCalledWith("/usr/bin/systemctl", [
			"stop",
			`qorpera-coding-${f.config.workerId.replaceAll("-", "")}.slice`,
		]);
		await requireCodingGuestLease(f.refresh, f.config, f.ports);
		const record = JSON.parse(await readFile(join(f.root, "lease.json"), "utf8"));
		expect(record.refreshedAtMonoMs).toBe(100000);
		expect(record.expiresAtMonoMs).toBe(160000);
		f.setTime(130000);
		await refreshCodingGuestLease({ ...f.refresh, ttlMs: 30000 }, f.config, f.ports);
		expect(f.system).toHaveBeenCalledTimes(1);
		f.setTime(159999);
		expect(await reconcileCodingGuestLease(f.config, f.ports)).toBe("active");
		f.setTime(160000);
		expect(await reconcileCodingGuestLease(f.config, f.ports)).toBe("stopped");
		expect(f.system).toHaveBeenCalledTimes(2);
		await expect(requireCodingGuestLease(f.refresh, f.config, f.ports)).rejects.toThrow("LEASE_UNAVAILABLE");
		await expect(refreshCodingGuestLease(f.refresh, f.config, f.ports)).rejects.toThrow("GENERATION_UNAVAILABLE");
	});
	it("keeps the session's commands across its turns under one attachment", async () => {
		const f = await fixture();
		await refreshCodingGuestLease(f.refresh, f.config, f.ports);
		expect(f.system).toHaveBeenCalledTimes(1);
		await expect(
			requireCodingGuestLease({ ...f.refresh, requestId: randomUUID() }, f.config, f.ports),
		).rejects.toThrow();
		await expect(requireCodingGuestLease({ ...f.refresh, turn: 2 }, f.config, f.ports)).rejects.toThrow();
		// The turn ends: its commands keep running, but none may start.
		await refreshCodingGuestLease({ ...f.refresh, open: false }, f.config, f.ports);
		await expect(requireCodingGuestLease(f.refresh, f.config, f.ports)).rejects.toThrow("LEASE_UNAVAILABLE");
		await requireCodingGuestLease(f.refresh, f.config, f.ports, false);
		expect(await reconcileCodingGuestLease(f.config, f.ports)).toBe("active");
		await expect(refreshCodingGuestLease(f.refresh, f.config, f.ports)).rejects.toThrow("GENERATION_UNAVAILABLE");
		// The next turn opens under the same attachment without stopping anything.
		const next = { ...f.refresh, requestId: randomUUID(), turn: 2 };
		await refreshCodingGuestLease(next, f.config, f.ports);
		expect(f.system).toHaveBeenCalledTimes(1);
		await requireCodingGuestLease(next, f.config, f.ports);
		await expect(requireCodingGuestLease(f.refresh, f.config, f.ports)).rejects.toThrow();
		await expect(refreshCodingGuestLease(f.refresh, f.config, f.ports)).rejects.toThrow("GENERATION_UNAVAILABLE");
		await expect(refreshCodingGuestLease({ ...next, requestId: randomUUID() }, f.config, f.ports)).rejects.toThrow(
			"GENERATION_UNAVAILABLE",
		);
	});
	it("a new attachment stops what an earlier one left; turns never go back; a new boot has no lease", async () => {
		const f = await fixture();
		await refreshCodingGuestLease(f.refresh, f.config, f.ports);
		const successor = { ...f.refresh, leaseTokenSha256: "b".repeat(64) };
		await refreshCodingGuestLease(successor, f.config, f.ports);
		expect(f.system).toHaveBeenCalledTimes(2);
		await requireCodingGuestLease(successor, f.config, f.ports);
		const later = { ...successor, requestId: randomUUID(), turn: 3, leaseTokenSha256: "c".repeat(64) };
		await refreshCodingGuestLease(later, f.config, f.ports);
		expect(f.system).toHaveBeenCalledTimes(3);
		await expect(refreshCodingGuestLease(successor, f.config, f.ports)).rejects.toThrow("GENERATION_UNAVAILABLE");
		f.setBoot(randomUUID());
		expect(await reconcileCodingGuestLease(f.config, f.ports)).toBe("stopped");
		await expect(refreshCodingGuestLease(later, f.config, f.ports)).rejects.toThrow();
	});
	it("stops the session's command groups when the lease is missing, malformed, tampered, or time goes backwards", async () => {
		const f = await fixture();
		expect(await reconcileCodingGuestLease(f.config, f.ports)).toBe("stopped");
		await refreshCodingGuestLease(f.refresh, f.config, f.ports);
		f.setTime(99999);
		expect(await reconcileCodingGuestLease(f.config, f.ports)).toBe("stopped");
		await chmod(join(f.root, "lease.json"), 0o600);
		await writeFile(join(f.root, "lease.json"), "{}");
		expect(await reconcileCodingGuestLease(f.config, f.ports)).toBe("stopped");
		await expect(refreshCodingGuestLease(f.refresh, f.config, f.ports)).rejects.toThrow();
	});
	it("rejects symlinked lease evidence and propagates an unconfirmed stop", async () => {
		const f = await fixture();
		await writeFile(join(f.root, "elsewhere.json"), "{}");
		await symlink(join(f.root, "elsewhere.json"), join(f.root, "lease.json"));
		expect(await reconcileCodingGuestLease(f.config, f.ports)).toBe("stopped");
		await expect(refreshCodingGuestLease(f.refresh, f.config, f.ports)).rejects.toThrow();
		f.system.mockRejectedValueOnce(new Error("systemd unavailable"));
		await expect(reconcileCodingGuestLease(f.config, f.ports)).rejects.toThrow("systemd unavailable");
	});
	it("does not accept wall-clock expiry, raw token, an unbounded TTL or writable parent paths", async () => {
		const f = await fixture();
		for (const v of [
			{ ...f.refresh, ttlMs: 60001 },
			{ ...f.refresh, ttlMs: 0 },
			{ ...f.refresh, expiresAt: Date.now() + 60000 },
			{ ...f.refresh, leaseToken: randomUUID() },
			{ ...f.refresh, turn: 1.5 },
			{ ...f.refresh, open: "yes" },
			(({ open: _open, ...rest }) => rest)(f.refresh),
		])
			expect(() => parseCodingGuestLeaseRefresh(v)).toThrow();
		await chmod(f.root, 0o777);
		await expect(refreshCodingGuestLease(f.refresh, f.config, f.ports)).rejects.toThrow("UNPROTECTED");
		expect(await reconcileCodingGuestLease(f.config, f.ports)).toBe("stopped");
	});
});

describe("coding guest watchdog over a member's sessions", () => {
	async function machine() {
		const sessionsRoot = await mkdtemp(join(tmpdir(), "coding-watchdog-sessions-"));
		roots.push(sessionsRoot);
		let time = 100000;
		const bootId = randomUUID(),
			vmId = randomUUID();
		const system = vi.fn(async () => "");
		const ports = {
			sessionsRoot,
			protectedUid: process.getuid?.() ?? 0,
			protectedDirectoryRoot: sessionsRoot,
			nowMs: async () => time,
			inspectBoot: async () => bootId,
			system,
		};
		const session = async (lease: boolean, configured = true) => {
			const workerId = randomUUID(),
				root = join(sessionsRoot, workerId);
			await mkdir(join(root, "configuration"), { recursive: true, mode: 0o755 });
			await chmod(root, 0o755);
			if (configured)
				await writeFile(join(root, "configuration", "guest.json"), JSON.stringify({ workerId, vmId, bootId }), {
					mode: 0o444,
				});
			if (lease)
				await refreshCodingGuestLease(
					{
						schema: "qorpera.coding-guest-lease-refresh/v2",
						workerId,
						vmId,
						requestId: randomUUID(),
						turn: 1,
						open: false,
						leaseTokenSha256: "a".repeat(64),
						ttlMs: 30000,
					},
					{ workerId, vmId, bootId },
					{ ...ports, root, system: async () => "" },
				);
			return workerId;
		};
		const slice = (workerId: string) => ["stop", `qorpera-coding-${workerId.replaceAll("-", "")}.slice`];
		return {
			ports,
			system,
			session,
			slice,
			setTime: (value: number) => {
				time = value;
			},
		};
	}
	it("stops only the sessions whose lease is gone and leaves one still being prepared alone", async () => {
		const m = await machine();
		const live = await m.session(true),
			missing = await m.session(false),
			preparing = await m.session(false, false);
		await runCodingGuestWatchdog(m.ports);
		expect(m.system.mock.calls).toEqual([["/usr/bin/systemctl", m.slice(missing)]]);
		m.system.mockClear();
		m.setTime(130000);
		await runCodingGuestWatchdog(m.ports);
		expect(m.system.mock.calls).toEqual(
			expect.arrayContaining([
				["/usr/bin/systemctl", m.slice(live)],
				["/usr/bin/systemctl", m.slice(missing)],
			]),
		);
		expect(m.system.mock.calls).toHaveLength(2);
		expect(m.system.mock.calls.flat(2)).not.toContain(m.slice(preparing)[1]);
	});
	it("stops sessions whose leases ended together at once, not one after another", async () => {
		const m = await machine();
		const sessions = [await m.session(false), await m.session(false), await m.session(false)];
		let running = 0,
			most = 0;
		m.system.mockImplementation(async () => {
			most = Math.max(most, ++running);
			await new Promise((resolve) => setTimeout(resolve, 20));
			running--;
			return "";
		});
		await runCodingGuestWatchdog(m.ports);
		expect(m.system.mock.calls).toHaveLength(sessions.length);
		expect(most).toBe(sessions.length);
	});
	it("stops a session with a foreign or malformed configuration, not its neighbours", async () => {
		const m = await machine();
		const live = await m.session(true),
			bad = await m.session(false, false);
		await writeFile(
			join(m.ports.sessionsRoot, bad, "configuration", "guest.json"),
			JSON.stringify({ workerId: live }),
			{
				mode: 0o444,
			},
		);
		await expect(runCodingGuestWatchdog(m.ports)).rejects.toThrow("CONFIGURATION_INVALID");
		expect(m.system.mock.calls).toEqual([["/usr/bin/systemctl", m.slice(bad)]]);
	});
	it("stops every coding slice when the sessions cannot be listed safely", async () => {
		const m = await machine();
		await m.session(true);
		await chmod(m.ports.sessionsRoot, 0o777);
		await expect(runCodingGuestWatchdog(m.ports)).rejects.toThrow("UNPROTECTED");
		expect(m.system.mock.calls).toEqual([["/usr/bin/systemctl", ["stop", "qorpera-coding.slice"]]]);
	});
});
