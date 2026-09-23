import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	parseCodingGuestLeaseRefresh,
	reconcileCodingGuestLease,
	refreshCodingGuestLease,
	requireCodingGuestLease,
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
		schema: "qorpera.coding-guest-lease-refresh/v1",
		workerId: config.workerId,
		vmId: config.vmId,
		requestId: randomUUID(),
		turn: 1,
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
		await expect(
			refreshCodingGuestLease(
				{ ...f.refresh, turn: 2, requestId: randomUUID(), notAfterMonoMs: 100499 },
				f.config,
				f.ports,
			),
		).rejects.toThrow("REFRESH_EXPIRED");
	});

	it("stamps only the protected guest clock, renews live custody and bounds disconnected execution", async () => {
		const f = await fixture();
		await refreshCodingGuestLease(f.refresh, f.config, f.ports);
		expect(f.system).toHaveBeenCalledWith("/usr/bin/systemctl", ["stop", "qorpera-coding.slice"]);
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
	it("requires the current request, turn, owner marker and boot; a successor stops old cgroups", async () => {
		const f = await fixture();
		await refreshCodingGuestLease(f.refresh, f.config, f.ports);
		await expect(
			requireCodingGuestLease({ ...f.refresh, requestId: randomUUID() }, f.config, f.ports),
		).rejects.toThrow();
		await expect(requireCodingGuestLease({ ...f.refresh, turn: 2 }, f.config, f.ports)).rejects.toThrow();
		await expect(
			refreshCodingGuestLease({ ...f.refresh, leaseTokenSha256: "b".repeat(64) }, f.config, f.ports),
		).rejects.toThrow();
		const successor = {
			...f.refresh,
			requestId: randomUUID(),
			turn: 2,
			leaseTokenSha256: "b".repeat(64),
		};
		await refreshCodingGuestLease(successor, f.config, f.ports);
		expect(f.system).toHaveBeenCalledTimes(2);
		await expect(requireCodingGuestLease(f.refresh, f.config, f.ports)).rejects.toThrow();
		await expect(refreshCodingGuestLease(f.refresh, f.config, f.ports)).rejects.toThrow();
		await requireCodingGuestLease(successor, f.config, f.ports);
		f.setBoot(randomUUID());
		expect(await reconcileCodingGuestLease(f.config, f.ports)).toBe("stopped");
		await expect(refreshCodingGuestLease(successor, f.config, f.ports)).rejects.toThrow();
	});
	it("stops all command groups when the lease is missing, malformed, tampered, or time goes backwards", async () => {
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
		])
			expect(() => parseCodingGuestLeaseRefresh(v)).toThrow();
		await chmod(f.root, 0o777);
		await expect(refreshCodingGuestLease(f.refresh, f.config, f.ports)).rejects.toThrow("UNPROTECTED");
		expect(await reconcileCodingGuestLease(f.config, f.ports)).toBe("stopped");
	});
});
