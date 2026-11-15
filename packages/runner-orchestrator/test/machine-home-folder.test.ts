import { describe, expect, it } from "vitest";
import { HomeOutputGate, parseHomeFolderAnswer } from "../src/machine-home-folder.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const open = {
	schema: "qorpera.folder-home-session/v1",
	state: "open",
	sessionId: id(1),
	runId: id(2),
	staffAgentId: id(3),
	requestedByUserId: id(4),
	machineId: id(5),
	placementId: id(6),
	bootId: id(7),
};

describe("the executor's ask for a home session (20260930754000)", () => {
	it("reads an open session for the session and placement it asked about", () => {
		const { schema: _schema, state: _state, ...session } = open;
		expect(parseHomeFolderAnswer(open, { sessionId: id(1), placementId: id(6) })).toEqual({ state: "open", session });
	});

	it("reads each refusal by its reason", () => {
		for (const reason of ["HOME_SESSION_ENDED", "HOME_NOT_SHARED"])
			expect(
				parseHomeFolderAnswer(
					{ schema: "qorpera.folder-home-session/v1", state: "refused", reason },
					{ sessionId: id(1), placementId: id(6) },
				),
			).toEqual({ state: "refused", reason });
	});

	it("refuses any other answer, and an answer about another session or placement", () => {
		const request = { sessionId: id(1), placementId: id(6) };
		for (const answer of [
			null,
			[],
			"open",
			{ ...open, schema: "qorpera.folder-home-session/v2" },
			{ ...open, state: "closed" },
			{ ...open, extra: true },
			{ ...open, runId: "not-a-uuid" },
			{ ...open, bootId: "0000000A-0000-4000-8000-00000000000B" },
			{ ...open, sessionId: id(9) },
			{ ...open, placementId: id(9) },
			{ schema: "qorpera.folder-home-session/v1", state: "refused", reason: "MACHINE_GONE" },
			{ schema: "qorpera.folder-home-session/v1", state: "refused", reason: "HOME_NOT_SHARED", extra: 1 },
		])
			expect(() => parseHomeFolderAnswer(answer, request), JSON.stringify(answer)).toThrow(
				"HOME_FOLDER_SESSION_INVALID",
			);
	});
});

/** A gate over a release the test answers by hand, on a clock it moves. */
function gated(spacingMs = 0, limitBytes = 1024) {
	const passed: string[] = [];
	const failed: string[] = [];
	const releases: { resolve(held: string | undefined): void; reject(error: Error): void }[] = [];
	let now = 0;
	const sleeps: number[] = [];
	const gate = new HomeOutputGate({
		release: () =>
			new Promise<string | undefined>((resolve, reject) => {
				releases.push({ resolve, reject });
			}),
		pass: (chunk) => passed.push(chunk.toString()),
		fail: (why) => failed.push(why),
		spacingMs,
		limitBytes,
		now: () => now,
		sleep: async (ms) => {
			sleeps.push(ms);
			now += ms;
		},
	});
	const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
	return {
		gate,
		passed,
		failed,
		releases,
		sleeps,
		turn,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("a home's output waits for the company folder (20260930754000)", () => {
	it("lets out what came before a release once it answers, in order, and batches what comes meanwhile", async () => {
		const g = gated();
		g.gate.push(Buffer.from("a"));
		g.gate.push(Buffer.from("b"));
		await g.turn();
		expect(g.releases).toHaveLength(1);
		expect(g.passed).toEqual([]);
		// Output that comes while the release is out waits for the next one.
		g.gate.push(Buffer.from("c"));
		g.gate.push(Buffer.from("d"));
		g.releases[0]!.resolve(undefined);
		await g.turn();
		expect(g.passed).toEqual(["a", "b"]);
		expect(g.releases).toHaveLength(2);
		g.releases[1]!.resolve(undefined);
		await g.gate.drained();
		expect(g.passed).toEqual(["a", "b", "c", "d"]);
		expect(g.releases).toHaveLength(2);
		// Quiet, then more: one release more.
		g.gate.push(Buffer.from("e"));
		await g.turn();
		g.releases[2]!.resolve(undefined);
		await g.gate.drained();
		expect(g.passed).toEqual(["a", "b", "c", "d", "e"]);
		expect(g.failed).toEqual([]);
	});

	it("ends at a release that holds: nothing of that batch or later leaves, and it fails once", async () => {
		const g = gated();
		g.gate.push(Buffer.from("seen"));
		await g.turn();
		g.releases[0]!.resolve(undefined);
		await g.turn();
		g.gate.push(Buffer.from("secret"));
		await g.turn();
		g.gate.push(Buffer.from("later"));
		g.releases[1]!.resolve("held: no longer readable");
		await g.gate.drained();
		g.gate.push(Buffer.from("after"));
		await g.gate.drained();
		expect(g.passed).toEqual(["seen"]);
		expect(g.failed).toEqual(["held: no longer readable"]);
		expect(g.releases).toHaveLength(2);
	});

	it("takes a release that throws as one that holds", async () => {
		const g = gated();
		g.gate.push(Buffer.from("x"));
		await g.turn();
		g.releases[0]!.reject(new Error("FOLDER_CONTROL_UNANSWERED"));
		await g.gate.drained();
		expect(g.passed).toEqual([]);
		expect(g.failed).toEqual(["HOME_OUTPUT_UNRELEASED"]);
	});

	it("starts two releases no closer than its spacing, and the first after a quiet spell at once", async () => {
		const g = gated(200);
		g.gate.push(Buffer.from("a"));
		await g.turn();
		expect(g.sleeps).toEqual([]);
		g.gate.push(Buffer.from("b"));
		g.advance(50);
		g.releases[0]!.resolve(undefined);
		await g.turn();
		await g.turn();
		// 50 ms after the first began: it waits the other 150.
		expect(g.sleeps).toEqual([150]);
		g.releases[1]!.resolve(undefined);
		await g.gate.drained();
		g.advance(1000);
		g.gate.push(Buffer.from("c"));
		await g.turn();
		g.releases[2]!.resolve(undefined);
		await g.gate.drained();
		expect(g.sleeps).toEqual([150]);
		expect(g.passed).toEqual(["a", "b", "c"]);
	});

	it("ends rather than keep more than its limit waiting", async () => {
		const g = gated(0, 4);
		g.gate.push(Buffer.from("ab"));
		await g.turn();
		g.gate.push(Buffer.from("cde"));
		g.releases[0]!.resolve(undefined);
		await g.gate.drained();
		expect(g.failed).toEqual(["HOME_OUTPUT_UNRELEASED"]);
		expect(g.passed).toEqual([]);
	});

	it("lets nothing more out once the channel closed from the other side, and fails nothing", async () => {
		const g = gated();
		g.gate.push(Buffer.from("a"));
		await g.turn();
		g.gate.close();
		g.releases[0]!.resolve(undefined);
		await g.gate.drained();
		g.gate.push(Buffer.from("b"));
		await g.gate.drained();
		expect(g.passed).toEqual([]);
		expect(g.failed).toEqual([]);
	});
});
