import { describe, expect, it } from "vitest";
import {
	CODING_SNAPSHOT_LOG_BYTES,
	CODING_SNAPSHOT_RPCS,
	type CodingSnapshotBuild,
	CodingSnapshotRecords,
	codingSnapshotLog,
} from "../src/coding-snapshots.ts";

const NODE = "a".repeat(64);
const DIGEST = "d".repeat(64);
const COMMIT = "c".repeat(40);
const IMAGE = "f".repeat(64);
const WORKER = "52500000-0000-4000-8000-0000000000c1";
const LEASE = "52500000-0000-4000-8000-0000000000e1";
const SNAPSHOT = "52500000-0000-4000-8000-0000000000a1";
const BUILD = "52500000-0000-4000-8000-0000000000b1";
const TOKEN = "52500000-0000-4000-8000-0000000000b2";
const AT = "2026-10-15T01:02:03.123456+00:00";
const session = { workerId: WORKER, leaseToken: LEASE };
const setup = { setupDigest: DIGEST, commitSha: COMMIT };
const build: CodingSnapshotBuild = { buildId: BUILD, leaseToken: TOKEN, leaseUntil: AT };
const signal = () => new AbortController().signal;
// U+FFFD, the replacement character.
const R = String.fromCharCode(0xfffd);
const CUT = "[earlier output cut]\n";
/** A text's UTF-8 bytes as a JSON string, the quotes aside. */
const jsonBytes = (text: string) => Buffer.byteLength(JSON.stringify(text)) - 2;

/** A control that answers each call with the next scripted answer and keeps what it was asked. */
function fake(...answers: unknown[]) {
	const calls: { method: string; args: Record<string, unknown>; signal: AbortSignal }[] = [];
	const control = {
		async call(method: string, args: Record<string, unknown>, callSignal: AbortSignal) {
			calls.push({ method, args, signal: callSignal });
			return answers.shift();
		},
	};
	return { calls, records: new CodingSnapshotRecords({ control, owner: "exec-a", machineIdSha256: NODE }) };
}

const snapshot = { snapshotId: SNAPSHOT, setupDigest: DIGEST, commitSha: COMMIT, imageFingerprint: IMAGE, builtAt: AT };
const plan = (fields: Record<string, unknown>) => ({
	schema: "qorpera.coding-snapshot-plan/v1",
	snapshot: null,
	build: null,
	waitingUntil: null,
	failure: null,
	...fields,
});
const entry = (fields: Record<string, unknown> = {}) => ({
	schema: "qorpera.coding-snapshot-state/v1",
	snapshotId: SNAPSHOT,
	state: "ready",
	imageFingerprint: IMAGE,
	setupDigest: DIGEST,
	commitSha: COMMIT,
	startedAt: AT,
	builtAt: AT,
	leaseUntil: null,
	removeDue: false,
	...fields,
});

describe("coding snapshot records (5h-2)", () => {
	it("names the five RPCs the control lets through", () => {
		expect(CODING_SNAPSHOT_RPCS).toEqual([
			"qorpera_begin_coding_snapshot_build",
			"qorpera_renew_coding_snapshot_build",
			"qorpera_finish_coding_snapshot_build",
			"qorpera_list_coding_snapshots",
			"qorpera_record_coding_snapshot_removed",
		]);
	});

	it("refuses an owner or node it could not name", () => {
		const control = { call: async () => null };
		for (const options of [
			{ control, owner: "", machineIdSha256: NODE },
			{ control, owner: "exec a", machineIdSha256: NODE },
			{ control, owner: "e".repeat(121), machineIdSha256: NODE },
			{ control, owner: "exec-a", machineIdSha256: NODE.toUpperCase() },
			{ control, owner: "exec-a", machineIdSha256: "a".repeat(63) },
			{ control: {}, owner: "exec-a", machineIdSha256: NODE },
		]) {
			expect(() => new CodingSnapshotRecords(options as never)).toThrow("CODING_SNAPSHOT_CONFIGURATION_INVALID");
		}
	});

	it("asks at attach with the session's lease and this node, and reads each plan", async () => {
		const failure = { buildId: BUILD, code: "SETUP_COMMAND_FAILED", log: "npm ERR!", finishedAt: AT };
		const { calls, records } = fake(
			plan({ state: "current", snapshot }),
			plan({ state: "started", build: { buildId: BUILD, leaseToken: TOKEN, leaseUntil: AT } }),
			plan({ state: "waiting", snapshot, waitingUntil: AT }),
			plan({ state: "failed", snapshot, failure }),
			plan({ state: "failed", failure: { ...failure, log: null } }),
		);
		expect(await records.begin(session, setup, signal())).toEqual({ state: "current", snapshot });
		expect(await records.begin(session, setup, signal())).toEqual({ state: "started", snapshot: null, build });
		expect(await records.begin(session, setup, signal())).toEqual({ state: "waiting", snapshot, waitingUntil: AT });
		expect(await records.begin(session, setup, signal())).toEqual({ state: "failed", snapshot, failure });
		expect(await records.begin(session, setup, signal())).toEqual({
			state: "failed",
			snapshot: null,
			failure: { ...failure, log: null },
		});
		expect(calls[0]).toMatchObject({
			method: "qorpera_begin_coding_snapshot_build",
			args: {
				p_worker_id: WORKER,
				p_lease_token: LEASE,
				p_machine_id_sha256: NODE,
				p_setup_digest: DIGEST,
				p_commit_sha: COMMIT,
			},
		});
		expect(Object.keys(calls[0]?.args ?? {})).toHaveLength(5);
	});

	it("refuses input it would not send, without calling", async () => {
		const { calls, records } = fake();
		for (const [s, x] of [
			[{ ...session, workerId: "worker" }, setup],
			[{ ...session, leaseToken: LEASE.toUpperCase() }, setup],
			[session, { ...setup, setupDigest: DIGEST.slice(1) }],
			[session, { ...setup, commitSha: "C".repeat(40) }],
			[session, { ...setup, commitSha: "c".repeat(64) }],
		] as const) {
			await expect(records.begin(s, x, signal())).rejects.toThrow("CODING_SNAPSHOT_INPUT_INVALID");
		}
		await expect(records.renew({ ...build, buildId: "build" }, signal())).rejects.toThrow(
			"CODING_SNAPSHOT_INPUT_INVALID",
		);
		await expect(
			records.finish(build, { kind: "ready", imageFingerprint: "F".repeat(64) }, signal()),
		).rejects.toThrow("CODING_SNAPSHOT_INPUT_INVALID");
		await expect(records.finish(build, { kind: "failed", code: "setup failed" }, signal())).rejects.toThrow(
			"CODING_SNAPSHOT_INPUT_INVALID",
		);
		await expect(records.finish(build, { kind: "retired", code: "X" } as never, signal())).rejects.toThrow(
			"CODING_SNAPSHOT_INPUT_INVALID",
		);
		await expect(records.removed("snapshot", signal())).rejects.toThrow("CODING_SNAPSHOT_INPUT_INVALID");
		expect(calls).toEqual([]);
	});

	it("refuses a plan that is not exactly one of the four", async () => {
		const started = { buildId: BUILD, leaseToken: TOKEN, leaseUntil: AT };
		for (const answer of [
			null,
			[],
			plan({ state: "current", snapshot, extra: 1 }),
			{ ...plan({ state: "current", snapshot }), schema: "qorpera.coding-snapshot-plan/v2" },
			(({ failure: _, ...rest }) => rest)(plan({ state: "current", snapshot })),
			plan({ state: "built", snapshot }),
			// Current is this digest and commit only, and needs a snapshot.
			plan({ state: "current" }),
			plan({ state: "current", snapshot: { ...snapshot, commitSha: "b".repeat(40) } }),
			plan({ state: "current", snapshot: { ...snapshot, setupDigest: "e".repeat(64) } }),
			plan({ state: "current", snapshot, waitingUntil: AT }),
			plan({ state: "started" }),
			plan({ state: "started", build: { ...started, leaseToken: null } }),
			plan({ state: "started", build: { ...started, more: true } }),
			plan({ state: "started", build: started, failure: {} }),
			plan({ state: "waiting" }),
			plan({ state: "waiting", waitingUntil: "2026-10-15 01:02:03" }),
			plan({ state: "failed" }),
			plan({ state: "failed", failure: { buildId: BUILD, code: "setup failed", log: null, finishedAt: AT } }),
			plan({ state: "failed", failure: { buildId: BUILD, code: "SETUP", log: 1, finishedAt: AT } }),
			plan({ state: "started", build: started, snapshot: { ...snapshot, imageFingerprint: null } }),
			plan({ state: "started", build: started, snapshot: { ...snapshot, imageFingerprint: IMAGE.toUpperCase() } }),
			plan({ state: "started", build: started, snapshot: { ...snapshot, builtAt: null } }),
		]) {
			const { records } = fake(answer);
			await expect(records.begin(session, setup, signal()), JSON.stringify(answer)).rejects.toThrow(
				"CODING_SNAPSHOT_PLAN_INVALID",
			);
		}
	});

	it("renews the lease and reads its new end", async () => {
		const { calls, records } = fake(AT, "soon", null);
		expect(await records.renew(build, signal())).toBe(AT);
		expect(calls[0]).toMatchObject({
			method: "qorpera_renew_coding_snapshot_build",
			args: { p_build_id: BUILD, p_lease_token: TOKEN },
		});
		expect(Object.keys(calls[0]?.args ?? {})).toHaveLength(2);
		await expect(records.renew(build, signal())).rejects.toThrow("CODING_SNAPSHOT_LEASE_INVALID");
		await expect(records.renew(build, signal())).rejects.toThrow("CODING_SNAPSHOT_LEASE_INVALID");
	});

	it("finishes a build with its outcome and a log SQL can keep", async () => {
		const answer = (state: string, buildId = BUILD) => ({
			schema: "qorpera.coding-snapshot-build/v1",
			buildId,
			state,
		});
		const { calls, records } = fake(
			answer("ready"),
			answer("retired"),
			answer("failed"),
			answer("abandoned"),
			answer("failed"),
			answer("ready", SNAPSHOT),
			{ ...answer("ready"), more: 1 },
			{ ...answer("ready"), schema: "qorpera.coding-snapshot-build/v2" },
		);
		expect(await records.finish(build, { kind: "ready", imageFingerprint: IMAGE }, signal())).toBe("ready");
		// A replay after a newer snapshot retired it.
		expect(await records.finish(build, { kind: "ready", imageFingerprint: IMAGE, log: "done" }, signal())).toBe(
			"retired",
		);
		expect(await records.finish(build, { kind: "failed", code: "SETUP_FAILED", log: "a\0b" }, signal())).toBe(
			"failed",
		);
		expect(await records.finish(build, { kind: "abandoned", code: "BUILDER_LOST" }, signal())).toBe("abandoned");
		expect(calls.map((call) => call.args)).toEqual([
			{
				p_build_id: BUILD,
				p_lease_token: TOKEN,
				p_outcome: "ready",
				p_image_fingerprint: IMAGE,
				p_failure: null,
				p_log: null,
			},
			{
				p_build_id: BUILD,
				p_lease_token: TOKEN,
				p_outcome: "ready",
				p_image_fingerprint: IMAGE,
				p_failure: null,
				p_log: "done",
			},
			{
				p_build_id: BUILD,
				p_lease_token: TOKEN,
				p_outcome: "failed",
				p_image_fingerprint: null,
				p_failure: "SETUP_FAILED",
				p_log: `a${R}b`,
			},
			{
				p_build_id: BUILD,
				p_lease_token: TOKEN,
				p_outcome: "abandoned",
				p_image_fingerprint: null,
				p_failure: "BUILDER_LOST",
				p_log: null,
			},
		]);
		expect(new Set(calls.map((call) => call.method))).toEqual(new Set(["qorpera_finish_coding_snapshot_build"]));
		// An answer for another outcome or another build, or one not exactly of this shape.
		await expect(records.finish(build, { kind: "abandoned", code: "BUILDER_LOST" }, signal())).rejects.toThrow(
			"CODING_SNAPSHOT_FINISH_INVALID",
		);
		for (let i = 0; i < 3; i++) {
			await expect(records.finish(build, { kind: "ready", imageFingerprint: IMAGE }, signal())).rejects.toThrow(
				"CODING_SNAPSHOT_FINISH_INVALID",
			);
		}
	});

	it("lists this node's snapshots and refuses an entry that does not hold together", async () => {
		const other = "52500000-0000-4000-8000-0000000000a2";
		const listed = [
			entry(),
			entry({ snapshotId: other, state: "retired", removeDue: true }),
			entry({ snapshotId: BUILD, state: "building", imageFingerprint: null, builtAt: null, leaseUntil: AT }),
		];
		const { calls, records } = fake(listed, []);
		expect(await records.list(signal())).toEqual(listed.map(({ schema: _, ...rest }) => rest));
		expect(await records.list(signal())).toEqual([]);
		expect(calls[0]).toMatchObject({
			method: "qorpera_list_coding_snapshots",
			args: { p_owner: "exec-a", p_machine_id_sha256: NODE },
		});
		for (const answer of [
			null,
			{},
			[entry(), entry()],
			[entry({ extra: true })],
			[entry({ schema: "qorpera.coding-snapshot-state/v2" })],
			[entry({ state: "failed" })],
			[entry({ removeDue: "no" })],
			[entry({ state: "retired", removeDue: false })],
			// Only a retired snapshot is due: the list retires a departed member's first.
			[entry({ removeDue: true })],
			[entry({ leaseUntil: AT })],
			[entry({ builtAt: null })],
			[entry({ imageFingerprint: null })],
			[entry({ state: "building", imageFingerprint: null, builtAt: null, leaseUntil: null })],
			[entry({ state: "building", imageFingerprint: null, builtAt: null, leaseUntil: AT, removeDue: true })],
			[entry({ commitSha: "c".repeat(39) })],
			[entry({ startedAt: "yesterday" })],
		]) {
			const { records: refusing } = fake(answer);
			await expect(refusing.list(signal()), JSON.stringify(answer)).rejects.toThrow("CODING_SNAPSHOT_LIST_INVALID");
		}
	});

	it("records an image removed from this node", async () => {
		const answer = { schema: "qorpera.coding-snapshot-removed/v1", snapshotId: SNAPSHOT, removedAt: AT };
		const { calls, records } = fake(answer, { ...answer, snapshotId: BUILD }, { ...answer, removedAt: null }, null);
		await records.removed(SNAPSHOT, signal());
		expect(calls).toMatchObject([
			{
				method: "qorpera_record_coding_snapshot_removed",
				args: { p_snapshot_id: SNAPSHOT, p_owner: "exec-a", p_machine_id_sha256: NODE },
			},
		]);
		for (let i = 0; i < 3; i++) {
			await expect(records.removed(SNAPSHOT, signal())).rejects.toThrow("CODING_SNAPSHOT_REMOVAL_INVALID");
		}
	});

	it("gives every call the caller's signal and a 30 s limit", async () => {
		const { calls, records } = fake(AT);
		const caller = new AbortController();
		await records.renew(build, caller.signal);
		const passed = calls[0]?.signal as AbortSignal;
		expect(passed).not.toBe(caller.signal);
		expect(passed.aborted).toBe(false);
		caller.abort();
		expect(passed.aborted).toBe(true);
	});

	it("keeps a log SQL can hold: no NUL or lone surrogate, and the end of one too long", () => {
		expect(codingSnapshotLog("ok\n")).toBe("ok\n");
		expect(codingSnapshotLog("a\0b\uD800c\uDC00d😀")).toBe(`a${R}b${R}c${R}d😀`);
		const exact = "x".repeat(CODING_SNAPSHOT_LOG_BYTES);
		expect(codingSnapshotLog(exact)).toBe(exact);
		const long = `${"head\n".repeat(20000)}${"é".repeat(40000)}tail`;
		const cut = codingSnapshotLog(long);
		expect(cut.startsWith(CUT)).toBe(true);
		expect(cut.endsWith("étail")).toBe(true);
		expect(cut).not.toContain("head");
		expect(cut).not.toContain(R);
		// "é" is two bytes and the cut line 22 as JSON (its newline escaped): the cut lands on the limit.
		expect(jsonBytes(cut)).toBe(CODING_SNAPSHOT_LOG_BYTES);
	});

	it("measures the log as JSON, the form the control carries it in", () => {
		// ESC, a control character.
		const esc = String.fromCharCode(0x1b);
		// An escaped control character takes six bytes: 10922 of them and four more bytes are the limit.
		const exact = `${esc.repeat(10922)}xxxx`;
		expect(jsonBytes(exact)).toBe(CODING_SNAPSHOT_LOG_BYTES);
		expect(codingSnapshotLog(exact)).toBe(exact);
		const over = codingSnapshotLog(`${exact}x`);
		expect(over.startsWith(CUT)).toBe(true);
		expect(over.endsWith(`${esc}xxxxx`)).toBe(true);
		expect(jsonBytes(over)).toBeLessThanOrEqual(CODING_SNAPSHOT_LOG_BYTES);
		// 30000 of them, 180000 bytes as JSON, keep their last 10919; quotes take two bytes each.
		expect(codingSnapshotLog(esc.repeat(30000))).toBe(CUT + esc.repeat(10919));
		expect(codingSnapshotLog('"'.repeat(40000))).toBe(CUT + '"'.repeat(32757));
		// A surrogate pair is one character: the cut keeps whole emoji, two bytes short of the limit.
		const emoji = codingSnapshotLog(`${"head\n".repeat(20000)}${"😀".repeat(20000)}tail`);
		expect(emoji).toBe(`${CUT}${"😀".repeat(16377)}tail`);
		expect(jsonBytes(emoji)).toBe(CODING_SNAPSHOT_LOG_BYTES - 2);
	});
});
