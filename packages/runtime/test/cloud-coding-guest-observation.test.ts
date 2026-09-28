import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudCodingSessionLayout } from "@qorpera/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
	CODING_GUEST_OBSERVATION_MAX_BYTES,
	CODING_GUEST_OBSERVED_COMMANDS,
	type CodingGuestRunning,
	codingCommandPreview,
	observeCloudCodingGuest,
} from "../src/cloud-coding-guest-observation.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function machine() {
	const root = await mkdtemp(join(tmpdir(), "coding-observation-"));
	roots.push(root);
	const runtimeRoot = join(root, "run"),
		custodyRoot = join(root, "custody"),
		cgroupRoot = join(root, "cgroup");
	for (const path of [runtimeRoot, custodyRoot, cgroupRoot]) await mkdir(path, { recursive: true });
	const bootId = randomUUID();
	let units = "";
	const session = async (
		options: { cpu?: number; commands?: { id?: string; turn: number; command: string }[] } = {},
	) => {
		const workerId = randomUUID(),
			layout = cloudCodingSessionLayout(workerId);
		await mkdir(join(runtimeRoot, workerId, "configuration"), { recursive: true });
		await mkdir(join(custodyRoot, workerId, "inbox"), { recursive: true });
		if (options.cpu !== undefined) {
			await mkdir(join(cgroupRoot, layout.slice), { recursive: true });
			await writeFile(
				join(cgroupRoot, layout.slice, "cpu.stat"),
				`usage_usec ${options.cpu}\nuser_usec 1\nsystem_usec 2\n`,
			);
		}
		const ids: string[] = [];
		for (const command of options.commands ?? []) {
			const commandId = command.id ?? randomUUID();
			ids.push(commandId);
			await writeFile(
				join(custodyRoot, workerId, "inbox", `${commandId}.json`),
				JSON.stringify({
					schema: "qorpera.coding-command-request/v2",
					commandId,
					turn: command.turn,
					command: command.command,
				}),
			);
		}
		return { workerId, layout, ids };
	};
	return {
		runtimeRoot,
		session,
		setUnits: (value: string) => {
			units = value;
		},
		observe: () =>
			observeCloudCodingGuest({
				runtimeRoot,
				custodyRoot,
				cgroupRoot,
				system: async () => units,
				protectedUid: process.getuid?.() ?? 0,
				bootId: async () => bootId,
				uptimeMs: async () => 123456,
			}),
		running: async (workerId: string): Promise<CodingGuestRunning> =>
			JSON.parse(await readFile(join(runtimeRoot, `observation-${workerId}.json`), "utf8")),
		lease: (workerId: string, token: string, expiresAtMonoMs: number, boot = bootId) =>
			writeFile(
				join(runtimeRoot, workerId, "lease.json"),
				JSON.stringify({
					leaseTokenSha256: createHash("sha256").update(token).digest("hex"),
					bootId: boot,
					refreshedAtMonoMs: 100000,
					expiresAtMonoMs,
				}),
			),
		bootId,
	};
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

describe("what runs inside a member's coding machine", () => {
	it("names each session's commands whose processes still run and its processor time, and publishes it root-read-only", async () => {
		const m = await machine();
		const a = await m.session({
			cpu: 5000,
			commands: [
				{ turn: 2, command: "npm run dev" },
				{ turn: 3, command: "npm test" },
			],
		});
		const b = await m.session();
		m.setUnits(
			[
				`${a.layout.unitPrefix}${a.ids[0]}.service loaded active running Dev server`,
				// Retained after its last process exited (RemainAfterExit): not running.
				`${a.layout.unitPrefix}${a.ids[1]}.service loaded active exited Tests`,
				"qorpera-coding-watchdog.service loaded inactive dead Expire the coding guest execution lease",
			].join("\n"),
		);
		await m.lease(a.workerId, "token-a", 150000);
		const observation = await m.observe();
		expect(observation).toEqual({
			schema: "qorpera.coding-guest-observation/v2",
			bootId: m.bootId,
			uptimeMs: 123456,
			sessions: expect.arrayContaining([
				{
					workerId: a.workerId,
					cpuUsageUsec: 5000,
					running: 1,
					lease: { tokenSha256: sha("token-a"), expiresInMs: 150000 - 123456 },
				},
				{ workerId: b.workerId, cpuUsageUsec: 0, running: 0, lease: null },
			]),
		});
		expect(await m.running(a.workerId)).toEqual({
			schema: "qorpera.coding-guest-running/v1",
			bootId: m.bootId,
			workerId: a.workerId,
			running: [{ commandId: a.ids[0], turn: 2, command: "npm run dev" }],
			moreRunning: 0,
		});
		expect((await m.running(b.workerId)).running).toEqual([]);
		const published = join(m.runtimeRoot, "observation.json");
		expect(JSON.parse(await readFile(published, "utf8"))).toEqual(observation);
		for (const name of ["observation.json", `observation-${a.workerId}.json`])
			expect((await stat(join(m.runtimeRoot, name))).mode & 0o777).toBe(0o444);
	});
	it("reports a lease that ran out, or belongs to another boot, as run out", async () => {
		const m = await machine();
		const a = await m.session(),
			b = await m.session();
		await m.lease(a.workerId, "token-a", 123456);
		await m.lease(b.workerId, "token-b", 999999, randomUUID());
		const leases = Object.fromEntries((await m.observe()).sessions.map((s) => [s.workerId, s.lease]));
		expect(leases).toEqual({
			[a.workerId]: { tokenSha256: sha("token-a"), expiresInMs: 0 },
			[b.workerId]: { tokenSha256: sha("token-b"), expiresInMs: 0 },
		});
	});
	it("removes the file of a session no longer attached", async () => {
		const m = await machine();
		const a = await m.session();
		await m.observe();
		await rm(join(m.runtimeRoot, a.workerId), { recursive: true });
		expect((await m.observe()).sessions).toEqual([]);
		expect((await readdir(m.runtimeRoot)).sort()).toEqual(["observation.json"]);
	});
	it("names a bounded number of commands, counts the rest, and keeps only a command's first bytes", async () => {
		const m = await machine();
		const long = `echo ${"é".repeat(400)}`;
		const s = await m.session({
			commands: Array.from({ length: CODING_GUEST_OBSERVED_COMMANDS + 3 }, (_, index) => ({
				turn: 1,
				command: index === 0 ? long : `sleep ${index}`,
			})),
		});
		m.setUnits(s.ids.map((id) => `${s.layout.unitPrefix}${id}.service loaded active running x`).join("\n"));
		expect((await m.observe()).sessions[0].running).toBe(CODING_GUEST_OBSERVED_COMMANDS + 3);
		const session = await m.running(s.workerId);
		expect(session.running).toHaveLength(CODING_GUEST_OBSERVED_COMMANDS);
		expect(session.moreRunning).toBe(3);
		const preview = session.running.find((command) => command.command.startsWith("echo"))?.command;
		expect(preview && Buffer.byteLength(preview)).toBeLessThanOrEqual(300);
		expect(preview && long.startsWith(preview)).toBe(true);
		expect(codingCommandPreview("ab€", 3)).toBe("ab");
	});
	it("names commands only while the session's file stays one read", async () => {
		const m = await machine();
		// Each preview escapes to about six bytes per character.
		const s = await m.session({
			commands: Array.from({ length: CODING_GUEST_OBSERVED_COMMANDS }, () => ({
				turn: 1,
				command: "\u0001".repeat(300),
			})),
		});
		m.setUnits(s.ids.map((id) => `${s.layout.unitPrefix}${id}.service loaded active running x`).join("\n"));
		await m.observe();
		const text = await readFile(join(m.runtimeRoot, `observation-${s.workerId}.json`), "utf8");
		const session: CodingGuestRunning = JSON.parse(text);
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(CODING_GUEST_OBSERVATION_MAX_BYTES);
		expect(session.running.length).toBeGreaterThan(0);
		expect(session.running.length + session.moreRunning).toBe(CODING_GUEST_OBSERVED_COMMANDS);
		expect(session.moreRunning).toBeGreaterThan(0);
	});
	it("ignores units of sessions not attached this boot and malformed unit names", async () => {
		const m = await machine();
		const s = await m.session();
		const stranger = cloudCodingSessionLayout(randomUUID());
		m.setUnits(
			[
				`${stranger.unitPrefix}${randomUUID()}.service loaded active running other`,
				`${s.layout.unitPrefix}not-a-uuid.service loaded active running odd`,
			].join("\n"),
		);
		expect((await m.observe()).sessions).toEqual([
			{ workerId: s.workerId, cpuUsageUsec: 0, running: 0, lease: null },
		]);
	});
});
