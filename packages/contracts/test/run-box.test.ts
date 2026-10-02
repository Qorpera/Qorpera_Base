import { describe, expect, it } from "vitest";
import { parseRunBoxReply, parseRunBoxRequest, RUN_BOX_LINE_LIMIT } from "../src/run-box.ts";

const ID = "6f1f2a2e-5d43-4d4b-9a51-7d0f2bb5a001";

function result(fields: Record<string, unknown> = {}): string {
	return JSON.stringify({
		t: "result",
		id: ID,
		session: null,
		exitCode: 0,
		signal: null,
		output: { head: "hello\n", tail: "", skippedBytes: 0, totalBytes: 6 },
		logPath: null,
		wallMs: 12,
		...fields,
	});
}

describe("run box requests", () => {
	it("reads exec and write requests", () => {
		expect(
			parseRunBoxRequest(
				JSON.stringify({
					t: "exec",
					id: ID,
					cmd: "rg -l plan",
					workdir: null,
					tty: false,
					yieldMs: 10_000,
					maxOutputBytes: 4096,
				}),
			),
		).toEqual({
			t: "exec",
			id: ID,
			cmd: "rg -l plan",
			workdir: null,
			tty: false,
			yieldMs: 10_000,
			maxOutputBytes: 4096,
		});
		expect(
			parseRunBoxRequest(
				JSON.stringify({ t: "write", id: ID, session: 3, chars: "", yieldMs: 250, maxOutputBytes: 4096 }),
			),
		).toEqual({ t: "write", id: ID, session: 3, chars: "", yieldMs: 250, maxOutputBytes: 4096 });
	});

	it("refuses unknown fields, empty commands, NUL, long waits and budgets out of range", () => {
		const exec = { t: "exec", id: ID, cmd: "ls", workdir: null, tty: false, yieldMs: 0, maxOutputBytes: 4096 };
		for (const bad of [
			{ ...exec, extra: 1 },
			{ ...exec, cmd: "   " },
			{ ...exec, cmd: "ls\0" },
			{ ...exec, yieldMs: 30_001 },
			{ ...exec, maxOutputBytes: 255 },
			{ ...exec, maxOutputBytes: 65_537 },
			{ ...exec, id: ID.toUpperCase() },
			{ ...exec, tty: "yes" },
			{ t: "write", id: ID, session: 0, chars: "", yieldMs: 0, maxOutputBytes: 4096 },
			{ t: "kill", id: ID },
		])
			expect(() => parseRunBoxRequest(JSON.stringify(bad))).toThrow();
		expect(() => parseRunBoxRequest("x".repeat(RUN_BOX_LINE_LIMIT + 1))).toThrow();
	});
});

describe("run box replies", () => {
	it("reads ready, results and errors", () => {
		expect(parseRunBoxReply('{"t":"ready","protocol":1,"sessions":[2,5]}')).toEqual({
			t: "ready",
			protocol: 1,
			sessions: [2, 5],
		});
		expect(parseRunBoxReply(result())).toMatchObject({ session: null, exitCode: 0, output: { head: "hello\n" } });
		expect(parseRunBoxReply(result({ session: 4, exitCode: null }))).toMatchObject({ session: 4, exitCode: null });
		expect(parseRunBoxReply(result({ exitCode: null, signal: "SIGKILL" }))).toMatchObject({ signal: "SIGKILL" });
		expect(
			parseRunBoxReply(JSON.stringify({ t: "error", id: ID, code: "STDIN_CLOSED", message: "closed" })),
		).toMatchObject({ code: "STDIN_CLOSED" });
	});

	it("refuses inconsistent ends, output past the budget and odd paths", () => {
		for (const bad of [
			result({ session: 4 }),
			result({ exitCode: null }),
			result({ exitCode: 256 }),
			result({ signal: "KILL", exitCode: null }),
			result({ output: { head: "a", tail: "", skippedBytes: 2, totalBytes: 1 } }),
			result({ logPath: "relative.log" }),
			result({ logPath: "/tmp/home/output/1.log\n" }),
			JSON.stringify({ t: "error", id: ID, code: "NOPE", message: "" }),
			'{"t":"ready","protocol":2,"sessions":[]}',
		])
			expect(() => parseRunBoxReply(bad)).toThrow();
		const big = result({ output: { head: "é".repeat(200), tail: "x", skippedBytes: 0, totalBytes: 401 } });
		expect(() => parseRunBoxReply(big, 400)).toThrow(/larger than asked/);
		expect(parseRunBoxReply(big, 401).t).toBe("result");
	});
});
