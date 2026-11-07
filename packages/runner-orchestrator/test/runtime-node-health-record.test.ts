import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertNodeHealthRecord, NodeHealthRefusal } from "../src/runtime-node-health-record.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const NOW = 1794057605123;
const bootId = randomUUID();

/** A node whose image ships the gate, with node health's folder and a healthy record of this boot written 3 s ago
 * (HEALTH.md §6), all owned by the test's own user. */
async function node() {
	const root = await mkdtemp(join(tmpdir(), "qorpera-node-health-"));
	roots.push(root);
	const paths = {
		gate: join(root, "qorpera-health"),
		record: join(root, "run", "node.json"),
		owner: process.getuid?.() ?? 0,
		now: () => NOW,
	};
	await writeFile(paths.gate, "#!/bin/bash\n");
	await mkdir(join(root, "run"));
	// The reader refuses a folder or a file others can write: fix the modes whatever the umask.
	await chmod(join(root, "run"), 0o755);
	const value = {
		schema: "qorpera.health/v1",
		ts: "2026-11-07T13:20:02Z",
		ts_ms: NOW - 3000,
		level: "node",
		final: true,
		ok: true,
		remote_ok: true,
		boot_id: bootId,
		version: "0.1.1",
		kind: "release",
		boot_mode: "blessed",
		emergency_reboots: 0,
		seal: "s1",
		ms: 812,
		checks: [
			{ name: "zpool", scope: "local", ok: true, warn: false, reason: "ok", ms: 41 },
			{ name: "pool-write", scope: "local", ok: true, warn: false, reason: "ok", ms: 120 },
			{ name: "tailnet", scope: "remote", ok: true, warn: false, reason: "ok", ms: 30 },
		] as Record<string, unknown>[],
	};
	const write = async (record: unknown = value) => {
		await rm(paths.record, { force: true, recursive: true });
		await writeFile(
			paths.record,
			typeof record === "string" || Buffer.isBuffer(record) ? record : JSON.stringify(record),
		);
		await chmod(paths.record, 0o644);
	};
	await write();
	return { root, paths, value, write };
}
const refusal = async (promise: Promise<void>) => {
	const error = await promise.then(
		() => null,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(NodeHealthRefusal);
	return { code: (error as NodeHealthRefusal).message, entries: (error as NodeHealthRefusal).entries };
};

describe("the node health record (WS18 HEALTH.md §6, R-C10)", () => {
	it("lets a node take work while its record is this boot's, fresh and ok; remote checks never count", async () => {
		const n = await node();
		await expect(assertNodeHealthRecord(bootId, n.paths)).resolves.toBeUndefined();
		n.value.remote_ok = false;
		n.value.checks[2].ok = false;
		n.value.ts_ms = NOW - 45000;
		await n.write();
		await expect(assertNodeHealthRecord(bootId, n.paths)).resolves.toBeUndefined();
	});
	it("reads nothing on a node whose image has no gate", async () => {
		const n = await node();
		await rm(n.paths.gate);
		await rm(join(n.root, "run"), { recursive: true });
		await expect(assertNodeHealthRecord(bootId, n.paths)).resolves.toBeUndefined();
		// Any entry at the gate's path counts, even a dangling link.
		await symlink(join(n.root, "nothing"), n.paths.gate);
		expect(await refusal(assertNodeHealthRecord(bootId, n.paths))).toEqual({
			code: "NODE_HEALTH_RECORD_MISSING",
			entries: undefined,
		});
	});
	it("refuses a missing record or folder", async () => {
		const n = await node();
		await rm(n.paths.record);
		expect((await refusal(assertNodeHealthRecord(bootId, n.paths))).code).toBe("NODE_HEALTH_RECORD_MISSING");
		await rm(join(n.root, "run"), { recursive: true });
		expect((await refusal(assertNodeHealthRecord(bootId, n.paths))).code).toBe("NODE_HEALTH_RECORD_MISSING");
	});
	it("refuses a link, a pipe, a folder, another owner and a group- or world-writable folder or file", async () => {
		const unsafe = async (change: (n: Awaited<ReturnType<typeof node>>) => Promise<void>) => {
			const n = await node();
			await change(n);
			return (await refusal(assertNodeHealthRecord(bootId, n.paths))).code;
		};
		const cases = [
			async (n: Awaited<ReturnType<typeof node>>) => {
				await writeFile(join(n.root, "elsewhere.json"), JSON.stringify(n.value));
				await rm(n.paths.record);
				await symlink(join(n.root, "elsewhere.json"), n.paths.record);
			},
			async (n: Awaited<ReturnType<typeof node>>) => {
				await rm(n.paths.record);
				expect(spawnSync("mkfifo", [n.paths.record]).status).toBe(0);
			},
			async (n: Awaited<ReturnType<typeof node>>) => {
				await rm(n.paths.record);
				await mkdir(n.paths.record);
			},
			async (n: Awaited<ReturnType<typeof node>>) => {
				n.paths.owner += 1;
			},
			async (n: Awaited<ReturnType<typeof node>>) => {
				await chmod(n.paths.record, 0o664);
			},
			async (n: Awaited<ReturnType<typeof node>>) => {
				await chmod(n.paths.record, 0o646);
			},
			async (n: Awaited<ReturnType<typeof node>>) => {
				await chmod(join(n.root, "run"), 0o775);
			},
			async (n: Awaited<ReturnType<typeof node>>) => {
				await mkdir(join(n.root, "real"));
				await chmod(join(n.root, "real"), 0o755);
				await writeFile(join(n.root, "real", "node.json"), JSON.stringify(n.value));
				await rm(join(n.root, "run"), { recursive: true });
				await symlink(join(n.root, "real"), join(n.root, "run"));
			},
		];
		for (const change of cases) expect(await unsafe(change)).toBe("NODE_HEALTH_RECORD_UNSAFE");
	});
	it("refuses a record that is too big, not strict JSON or not a node health record", async () => {
		const n = await node();
		const invalid = async (record: unknown) => {
			await n.write(record);
			expect(await refusal(assertNodeHealthRecord(bootId, n.paths))).toEqual({
				code: "NODE_HEALTH_RECORD_INVALID",
				entries: undefined,
			});
		};
		await invalid(JSON.stringify({ ...n.value, pad: "x".repeat(16384) }));
		await invalid(Buffer.from([0x7b, 0xff, 0x7d]));
		await invalid(`${JSON.stringify(n.value).slice(0, -1)},}`);
		await invalid([n.value]);
		const changed: [string, unknown][] = [
			["schema", "qorpera.health/v2"],
			["level", "boot"],
			["boot_id", bootId.toUpperCase()],
			["boot_id", undefined],
			["ts_ms", NOW - 3000.5],
			["ts_ms", String(NOW - 3000)],
			["ok", "true"],
			["final", undefined],
			["checks", {}],
			["checks", Array(65).fill({ name: "zpool", scope: "local", ok: true })],
			["checks", [{ name: "Zpool", scope: "local", ok: true }]],
			["checks", [{ name: "zpool", scope: "both", ok: true }]],
			["checks", [{ name: "zpool", scope: "local", ok: 1 }]],
		];
		for (const [key, value] of changed) await invalid({ ...n.value, [key]: value });
		// Written after now by its own clock: an age below zero is no age.
		await invalid({ ...n.value, ts_ms: NOW + 1 });
	});
	it("refuses another boot's record and one older than 45 seconds", async () => {
		const n = await node();
		await n.write({ ...n.value, boot_id: randomUUID() });
		expect((await refusal(assertNodeHealthRecord(bootId, n.paths))).code).toBe("NODE_HEALTH_RECORD_OTHER_BOOT");
		await n.write({ ...n.value, ts_ms: NOW - 45001 });
		expect((await refusal(assertNodeHealthRecord(bootId, n.paths))).code).toBe("NODE_HEALTH_RECORD_STALE");
	});
	it("refuses a record that is not ok, naming its failed local checks once each, never their reasons", async () => {
		const n = await node();
		n.value.ok = false;
		n.value.checks[1] = { name: "pool-write", scope: "local", ok: false, warn: false, reason: "pool-stuck", ms: 1 };
		n.value.checks.push(
			{ name: "boot-gate", scope: "local", ok: false, warn: false, reason: "boot-gate-failed", ms: 1 },
			{ name: "pool-write", scope: "local", ok: false, warn: false, reason: "pool-stuck", ms: 1 },
			{ name: "observer-post", scope: "remote", ok: false, warn: false, reason: "observer-post-stale", ms: 1 },
		);
		await n.write();
		expect(await refusal(assertNodeHealthRecord(bootId, n.paths))).toEqual({
			code: "NODE_HEALTH_NOT_OK",
			entries: ["boot-gate", "pool-write"],
		});
		// A record that says ok over a failed local check, or is not final, is not trusted either.
		await n.write({ ...n.value, ok: true });
		expect(await refusal(assertNodeHealthRecord(bootId, n.paths))).toEqual({
			code: "NODE_HEALTH_NOT_OK",
			entries: ["boot-gate", "pool-write"],
		});
		const m = await node();
		await m.write({ ...m.value, final: false });
		expect(await refusal(assertNodeHealthRecord(bootId, m.paths))).toEqual({
			code: "NODE_HEALTH_NOT_OK",
			entries: [],
		});
	});
});
