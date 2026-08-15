import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendKernelSessionRuntimeObservation,
	bindTrailSession,
	latestResumableTrailSession,
	pruneEmptyTrailSessions,
} from "../src/agent-runtime.ts";
import { SessionControlPlane } from "../src/session-control-plane.ts";

let root: string;

beforeEach(() => {
	root = join(tmpdir(), `qorpera-session-control-plane-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(root, "trail"), { recursive: true });
});

afterEach(() => {
	if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("session control plane", () => {
	it("persists lifecycle facts and reconstructs the read model from the trail", async () => {
		const binding = bindTrailSession(root, root, {
			actor: "controller",
			attended: false,
		});
		const plane = await SessionControlPlane.create(root, "kernel-a");
		const observed: string[] = [];
		plane.subscribe(({ event }) => observed.push(event.kind));

		plane.record(binding, {
			kind: "executor_started",
			executorId: "executor-a",
			pid: 42,
		});
		plane.record(binding, { kind: "executor_ready", executorId: "executor-a" });
		plane.record(binding, {
			kind: "turn_started",
			executorId: "executor-a",
			origin: "composer-attended",
		});
		plane.observeActivity(binding, "executor-a", {
			kind: "tool",
			tool: "read",
			subject: "company.md",
		});
		plane.record(binding, { kind: "turn_settled", executorId: "executor-a" });

		expect(observed).toEqual(["executor_started", "executor_ready", "turn_started", "activity", "turn_settled"]);
		expect(plane.snapshot().sessions[0]).toMatchObject({
			trailFile: binding.file,
			status: "idle",
			live: true,
			executorId: "executor-a",
		});

		const restarted = (await SessionControlPlane.create(root, "kernel-b")).snapshot().sessions[0];
		expect(restarted).toMatchObject({
			trailFile: binding.file,
			status: "detached",
			live: false,
			executorId: "executor-a",
		});
		expect(readFileSync(binding.path, "utf-8")).toContain('"customType":"qorpera_kernel_session_runtime"');
		expect(readFileSync(binding.path, "utf-8")).not.toContain('"subject":"company.md"');
	});

	it("restores unchanged trails from a derived cache and ignores an invalid cache", async () => {
		const binding = bindTrailSession(root, root, {
			actor: "controller",
			attended: false,
			staffAgentId: "staff-night-shift",
		});
		const cachePath = join(root, "kernel-state", "sessions-v1.json");
		const plane = await SessionControlPlane.create(root, "kernel-a", cachePath);
		plane.record(binding, { kind: "executor_started", executorId: "executor-a" });
		plane.record(binding, { kind: "executor_ready", executorId: "executor-a" });

		const firstRestart = await SessionControlPlane.create(root, "kernel-b", cachePath);
		expect(firstRestart.snapshot().sessions[0]).toMatchObject({
			trailFile: binding.file,
			staffAgentId: "staff-night-shift",
			executorId: "executor-a",
			status: "detached",
			live: false,
		});
		expect(readFileSync(cachePath, "utf-8")).toContain(binding.file);
		const cachedRestart = await SessionControlPlane.create(root, "kernel-c", cachePath);
		expect(cachedRestart.snapshot().sessions[0]).toMatchObject({
			trailFile: binding.file,
			staffAgentId: "staff-night-shift",
			executorId: "executor-a",
			status: "detached",
			live: false,
		});
		plane.record(binding, {
			kind: "turn_started",
			executorId: "executor-a",
			origin: "composer-attended",
		});
		const changedRestart = await SessionControlPlane.create(root, "kernel-d", cachePath);
		expect(changedRestart.snapshot().sessions[0]).toMatchObject({
			trailFile: binding.file,
			staffAgentId: "staff-night-shift",
			executorId: "executor-a",
			status: "interrupted",
			turnInterrupted: true,
			live: false,
		});

		writeFileSync(cachePath, "not-json\n", "utf-8");
		const replayed = await SessionControlPlane.create(root, "kernel-e", cachePath);
		expect(replayed.snapshot().sessions[0]).toMatchObject({
			trailFile: binding.file,
			staffAgentId: "staff-night-shift",
			executorId: "executor-a",
			status: "interrupted",
			live: false,
		});
	});

	it("keeps a replacement executor authoritative over late events from the old process", async () => {
		const binding = bindTrailSession(root, root, {
			actor: "controller",
			attended: false,
		});
		const plane = await SessionControlPlane.create(root, "kernel-a");

		plane.record(binding, { kind: "executor_started", executorId: "old" });
		plane.record(binding, {
			kind: "turn_started",
			executorId: "old",
			origin: "composer-attended",
		});
		plane.record(binding, {
			kind: "executor_started",
			executorId: "replacement",
		});
		plane.record(binding, {
			kind: "executor_exited",
			executorId: "old",
			expected: false,
			code: 1,
			signal: null,
			busy: true,
		});

		expect(plane.snapshot().sessions[0]).toMatchObject({
			executorId: "replacement",
			status: "starting",
			live: true,
		});
	});

	it("keeps an attended session alive while its replaceable executor reconnects", async () => {
		const binding = bindTrailSession(root, root, {
			actor: "controller",
			attended: false,
		});
		const plane = await SessionControlPlane.create(root, "kernel-a");
		plane.record(binding, {
			kind: "executor_started",
			executorId: "executor-a",
		});
		plane.record(binding, {
			kind: "turn_started",
			executorId: "executor-a",
			origin: "composer-attended",
		});
		plane.record(binding, {
			kind: "executor_exited",
			executorId: "executor-a",
			expected: false,
			code: 1,
			signal: null,
			busy: true,
		});

		expect(plane.snapshot().sessions[0]).toMatchObject({
			status: "reconnecting",
			live: true,
		});
		plane.record(binding, {
			kind: "executor_started",
			executorId: "executor-b",
		});
		plane.record(binding, { kind: "executor_ready", executorId: "executor-b" });
		expect(plane.snapshot().sessions[0]).toMatchObject({
			status: "idle",
			live: true,
			turnInterrupted: true,
		});
		plane.record(binding, {
			kind: "reconnect_failed",
			executorId: "executor-b",
			attempt: 4,
		});
		expect(plane.snapshot().sessions[0]).toMatchObject({
			status: "interrupted",
			live: false,
		});
	});

	it("replays canonical append order even when the wall clock moves backward", async () => {
		const binding = bindTrailSession(root, root, {
			actor: "controller",
			attended: false,
		});
		appendKernelSessionRuntimeObservation(binding, {
			kind: "executor_started",
			executorId: "executor-a",
			kernelInstanceId: "kernel-a",
			at: "2026-08-14T10:00:00.000Z",
		});
		appendKernelSessionRuntimeObservation(binding, {
			kind: "executor_ready",
			executorId: "executor-a",
			kernelInstanceId: "kernel-a",
			at: "2026-08-14T09:00:00.000Z",
		});

		expect((await SessionControlPlane.create(root, "kernel-a")).snapshot().sessions[0]).toMatchObject({
			executorId: "executor-a",
			status: "detached",
			live: false,
		});
	});

	it("does not let buffered frames revive an exited executor", async () => {
		const binding = bindTrailSession(root, root, {
			actor: "controller",
			attended: false,
		});
		const plane = await SessionControlPlane.create(root, "kernel-a");
		plane.record(binding, { kind: "executor_started", executorId: "executor-a" });
		plane.record(binding, { kind: "turn_started", executorId: "executor-a", origin: "composer-attended" });
		plane.record(binding, {
			kind: "executor_exited",
			executorId: "executor-a",
			expected: false,
			code: 1,
			signal: null,
			busy: true,
		});
		plane.observeActivity(binding, "executor-a", { kind: "writing" });
		plane.record(binding, { kind: "turn_settled", executorId: "executor-a" });

		expect(plane.snapshot().sessions[0]).toMatchObject({
			executorId: "executor-a",
			status: "reconnecting",
			live: true,
			exit: { code: 1, busy: true, expected: false },
		});
	});

	it("treats same-process reconstruction as an executor ownership boundary", async () => {
		const binding = bindTrailSession(root, root, {
			actor: "controller",
			attended: false,
		});
		const plane = await SessionControlPlane.create(root, "kernel-a");
		plane.record(binding, { kind: "executor_started", executorId: "executor-a" });
		plane.record(binding, { kind: "executor_ready", executorId: "executor-a" });

		expect((await SessionControlPlane.create(root, "kernel-a")).snapshot().sessions[0]).toMatchObject({
			executorId: "executor-a",
			status: "detached",
			live: false,
		});
	});

	it("selects the founder chat most recently attached by the kernel", async () => {
		const older = bindTrailSession(root, root, {
			actor: "controller",
			attended: false,
		});
		const newer = bindTrailSession(root, root, {
			actor: "controller",
			attended: false,
		});
		const staff = bindTrailSession(root, root, {
			actor: "controller",
			attended: false,
			staffAgentId: "staff-chief-of-staff",
		});
		const plane = await SessionControlPlane.create(root, "kernel-a");
		plane.record(newer, { kind: "executor_started", executorId: "newer" });
		plane.record(older, {
			kind: "executor_started",
			executorId: "older-reopened",
		});
		plane.record(staff, { kind: "executor_started", executorId: "staff-reopened" });
		expect(plane.latestAttendedControllerTrailFile()).toBe(older.file);
		const restarted = await SessionControlPlane.create(root, "kernel-b");
		expect(restarted.latestAttendedControllerTrailFile()).toBe(older.file);
		expect(restarted.snapshot().sessions.find((session) => session.trailFile === staff.file)).toMatchObject({
			staffAgentId: "staff-chief-of-staff",
		});
		expect(
			restarted.snapshot().sessions.find((session) => session.trailFile === older.file)?.staffAgentId,
		).toBeUndefined();
	});

	it("isolates read-model listeners from durable control decisions", async () => {
		const binding = bindTrailSession(root, root, {
			actor: "controller",
			attended: false,
		});
		const plane = await SessionControlPlane.create(root, "kernel-a");
		plane.subscribe(() => {
			throw new Error("disconnected observer");
		});
		expect(() => plane.record(binding, { kind: "executor_started", executorId: "executor-a" })).not.toThrow();
		expect(plane.snapshot().sessions[0]).toMatchObject({ status: "starting", live: true });
	});

	it("stops replay at the first broken trail hash-chain link", async () => {
		const binding = bindTrailSession(root, root, {
			actor: "controller",
			attended: false,
		});
		const plane = await SessionControlPlane.create(root, "kernel-a");
		plane.record(binding, { kind: "executor_started", executorId: "executor-a" });
		plane.record(binding, { kind: "executor_ready", executorId: "executor-a" });
		plane.record(binding, { kind: "turn_started", executorId: "executor-a", origin: "composer-attended" });
		const lines = readFileSync(binding.path, "utf-8").trimEnd().split("\n");
		const tampered = JSON.parse(lines[2]) as { data: { kind: string } };
		tampered.data.kind = "turn_settled";
		lines[2] = JSON.stringify(tampered);
		writeFileSync(binding.path, `${lines.join("\n")}\n`, "utf-8");

		const cachePath = join(root, "kernel-state", "sessions-v1.json");
		const restarted = await SessionControlPlane.create(root, "kernel-b", cachePath);
		expect(restarted.snapshot().sessions[0]).toMatchObject({
			status: "detached",
			executorId: "executor-a",
		});
		expect(restarted.latestAttendedControllerTrailFile()).toBeUndefined();
		expect(latestResumableTrailSession(root)).toBeUndefined();
		const reopened = await SessionControlPlane.create(root, "kernel-c", cachePath);
		expect(reopened.latestAttendedControllerTrailFile()).toBeUndefined();
		expect(latestResumableTrailSession(root)).toBeUndefined();
	});

	it("rejects a metadata-matching cache written before verification quarantine", async () => {
		const binding = bindTrailSession(root, root, {
			actor: "controller",
			attended: false,
		});
		const plane = await SessionControlPlane.create(root, "kernel-a");
		plane.record(binding, { kind: "executor_started", executorId: "executor-a" });
		plane.record(binding, { kind: "executor_ready", executorId: "executor-a" });
		const cachePath = join(root, "kernel-state", "sessions-v2.json");
		await SessionControlPlane.create(root, "kernel-b", cachePath);
		const validCache = JSON.parse(readFileSync(cachePath, "utf-8"));

		writeFileSync(binding.path, `${readFileSync(binding.path, "utf-8")}not-json\n`, "utf-8");
		const stat = statSync(binding.path, { bigint: true });
		const legacyEntry = validCache.files[binding.file];
		legacyEntry.size = stat.size.toString();
		legacyEntry.mtimeNs = stat.mtimeNs.toString();
		legacyEntry.ctimeNs = stat.ctimeNs.toString();
		legacyEntry.device = stat.dev.toString();
		legacyEntry.inode = stat.ino.toString();
		writeFileSync(cachePath, `${JSON.stringify({ ...validCache, version: 1 })}\n`, "utf-8");

		const restarted = await SessionControlPlane.create(root, "kernel-c", cachePath);
		expect(restarted.latestAttendedControllerTrailFile()).toBeUndefined();
		expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toMatchObject({ version: 2, files: {} });
	});

	it("marks unfinished autonomous work interrupted after a kernel restart", async () => {
		const binding = bindTrailSession(root, root, {
			actor: "controller",
			attended: false,
			autonomousLabel: "autonomous — scheduled review",
		});
		const plane = await SessionControlPlane.create(root, "kernel-a");
		plane.record(binding, { kind: "executor_started", executorId: "worker" });
		plane.record(binding, {
			kind: "turn_started",
			executorId: "worker",
			origin: "kernel-wake-schedule",
		});

		expect((await SessionControlPlane.create(root, "kernel-b")).snapshot().sessions[0]).toMatchObject({
			status: "interrupted",
			live: false,
			autonomous: true,
		});
	});

	it("keeps autonomous work nonterminal until its executor closes", async () => {
		const binding = bindTrailSession(root, root, {
			actor: "controller",
			attended: false,
			autonomousLabel: "autonomous — scheduled review",
		});
		const plane = await SessionControlPlane.create(root, "kernel-a");
		plane.record(binding, { kind: "executor_started", executorId: "worker" });
		plane.record(binding, {
			kind: "turn_started",
			executorId: "worker",
			origin: "kernel-wake-schedule",
		});
		plane.record(binding, { kind: "turn_settled", executorId: "worker" });
		expect(plane.snapshot().sessions[0]).toMatchObject({
			status: "finishing",
			live: true,
		});
		plane.record(binding, {
			kind: "executor_exited",
			executorId: "worker",
			expected: true,
			code: 0,
			signal: null,
			busy: false,
		});
		expect(plane.snapshot().sessions[0]).toMatchObject({
			status: "settled",
			live: false,
		});
	});

	it("marks an intentionally stopped in-flight founder turn interrupted", async () => {
		const binding = bindTrailSession(root, root, {
			actor: "controller",
			attended: false,
		});
		const plane = await SessionControlPlane.create(root, "kernel-a");
		plane.record(binding, {
			kind: "executor_started",
			executorId: "executor-a",
		});
		plane.record(binding, {
			kind: "turn_started",
			executorId: "executor-a",
			origin: "composer-attended",
		});
		plane.record(binding, {
			kind: "executor_exited",
			executorId: "executor-a",
			expected: true,
			code: 0,
			signal: null,
			busy: true,
		});
		expect(plane.snapshot().sessions[0]).toMatchObject({
			status: "interrupted",
			live: false,
			turnInterrupted: true,
		});
	});

	it("does not make an otherwise empty founder session permanent", async () => {
		const binding = bindTrailSession(root, root, {
			actor: "controller",
			attended: false,
		});
		const plane = await SessionControlPlane.create(root, "kernel-a");
		plane.record(binding, {
			kind: "executor_started",
			executorId: "executor-a",
		});
		plane.record(binding, {
			kind: "executor_exited",
			executorId: "executor-a",
			expected: true,
			code: 0,
			signal: null,
			busy: false,
		});

		expect(pruneEmptyTrailSessions(root)).toBe(1);
		expect(existsSync(binding.path)).toBe(false);
	});
});
