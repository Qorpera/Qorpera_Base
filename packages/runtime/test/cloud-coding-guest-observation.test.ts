import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudCodingSessionLayout } from "@qorpera/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
	CODING_GUEST_OBSERVED_COMMANDS,
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
				bootId: async () => bootId,
				uptimeMs: async () => 123456,
			}),
		bootId,
	};
}

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
		const observation = await m.observe();
		expect(observation).toEqual({
			schema: "qorpera.coding-guest-observation/v1",
			bootId: m.bootId,
			uptimeMs: 123456,
			sessions: expect.arrayContaining([
				{
					workerId: a.workerId,
					cpuUsageUsec: 5000,
					running: [{ commandId: a.ids[0], turn: 2, command: "npm run dev" }],
					moreRunning: 0,
				},
				{ workerId: b.workerId, cpuUsageUsec: 0, running: [], moreRunning: 0 },
			]),
		});
		const published = join(m.runtimeRoot, "observation.json");
		expect(JSON.parse(await readFile(published, "utf8"))).toEqual(observation);
		expect((await stat(published)).mode & 0o777).toBe(0o444);
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
		const [session] = (await m.observe()).sessions;
		expect(session.running).toHaveLength(CODING_GUEST_OBSERVED_COMMANDS);
		expect(session.moreRunning).toBe(3);
		const preview = session.running.find((command) => command.command.startsWith("echo"))?.command;
		expect(preview && Buffer.byteLength(preview)).toBeLessThanOrEqual(300);
		expect(preview && long.startsWith(preview)).toBe(true);
		expect(codingCommandPreview("ab€", 3)).toBe("ab");
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
			{ workerId: s.workerId, cpuUsageUsec: 0, running: [], moreRunning: 0 },
		]);
	});
});
