import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@qorpera/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CloudCompanyFolderClient,
	CloudCompanyFolderError,
	type CloudCompanyFolderRelease,
} from "../src/cloud-company-folder-client.ts";
import { type CloudToolContext, CloudToolRefusal } from "../src/cloud-native-tool-boundary.ts";
import { CloudRunBox, cloudRunBoxTools, runBoxAnswerText } from "../src/cloud-run-box-tools.ts";

const RUN = "80200000-0000-4000-8000-000000000001";
const VERSION = "80200000-0000-4000-8000-0000000000a1";
const RESOURCE = "80200000-0000-4000-8000-0000000000b1";
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const done of cleanup.splice(0).reverse()) await done();
});

type Answer = (request: Record<string, unknown>) => Record<string, unknown> | string;

/** The box's read log as the folder program keeps it: numbered reads that wait until acknowledged, under a log id. */
class ReadLog {
	id = "a".repeat(32);
	next = 1;
	waiting: (Record<string, unknown> & { seq: number })[] = [];
	takes: number[] = [];
	acks: number[] = [];
	add(...reads: Record<string, unknown>[]): void {
		for (const read of reads) this.waiting.push({ ...read, seq: this.next++ });
	}
	restart(): void {
		this.id = "b".repeat(32);
		this.waiting = [];
	}
	answer(request: { t: string; after?: number; max?: number; upTo?: number }): Record<string, unknown> {
		if (request.t === "ack") {
			this.acks.push(request.upTo as number);
			this.waiting = this.waiting.filter((read) => read.seq > (request.upTo as number));
			return { t: "acked", log: this.id, upTo: request.upTo };
		}
		this.takes.push(request.max as number);
		const after = this.waiting.filter((read) => read.seq > (request.after as number));
		return {
			t: "reads",
			log: this.id,
			reads: after.slice(0, request.max),
			more: after.length > (request.max as number),
		};
	}
}

/** A stand-in box host and read log on Unix sockets, answering as the test says. */
async function stage(answer: Answer, readLog = new ReadLog()) {
	const root = await mkdtemp(join(tmpdir(), "run-box-tools-"));
	const requests: Record<string, unknown>[] = [];
	const serve = (path: string, onLine: (line: string, socket: Socket) => void, greet?: string) =>
		new Promise<Server>((resolve) => {
			const server = createServer((socket) => {
				if (greet) socket.write(`${greet}\n`);
				let buffer = "";
				socket.setEncoding("utf8");
				socket.on("data", (text: string) => {
					buffer += text;
					for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
						onLine(buffer.slice(0, at), socket);
						buffer = buffer.slice(at + 1);
					}
				});
				socket.on("error", () => undefined);
			});
			server.listen(path, () => resolve(server));
		});
	const box = await serve(
		join(root, "box.sock"),
		(line, socket) => {
			const request = JSON.parse(line) as Record<string, unknown>;
			requests.push(request);
			const reply = answer(request);
			socket.write(`${typeof reply === "string" ? reply : JSON.stringify({ id: request.id, ...reply })}\n`);
		},
		'{"t":"ready","protocol":1,"sessions":[]}',
	);
	const log = await serve(join(root, "box.reads"), (line, socket) => {
		socket.write(`${JSON.stringify(readLog.answer(JSON.parse(line)))}\n`);
	});
	cleanup.push(async () => {
		box.close();
		log.close();
		await rm(root, { recursive: true, force: true });
	});
	return { paths: { socket: join(root, "box.sock"), reads: join(root, "box.reads") }, requests, log: readLog };
}

function folder(failure?: CloudCompanyFolderError) {
	const releases: { id: string; reads: readonly CloudCompanyFolderRelease[]; sha: string }[] = [];
	const client = {
		async release(id: string, reads: readonly CloudCompanyFolderRelease[], sha: string) {
			if (failure) throw failure;
			releases.push({ id, reads, sha });
			return { releaseId: id, reads: reads.length, replay: false };
		},
	} as unknown as CloudCompanyFolderClient;
	return { client, releases };
}

function context(callId = "call-1"): CloudToolContext {
	return {
		companyId: "80200000-0000-4000-8000-000000000002",
		runId: RUN,
		callId,
		argumentSha256: "a".repeat(64),
		signal: new AbortController().signal,
	};
}

function ended(output: Partial<Record<string, unknown>> = {}) {
	return {
		t: "result",
		session: null,
		exitCode: 0,
		signal: null,
		output: { head: "the plan\n", tail: "", skippedBytes: 0, totalBytes: 9, ...output },
		logPath: null,
		wallMs: 120,
	};
}

const read = (
	path: string,
	authority: unknown = { resourceId: RESOURCE, resourceRevision: 3, grantId: null, grantRevision: null },
) => ({
	path,
	kind: "file",
	version: VERSION,
	authority,
});

async function tools(paths: { socket: string; reads: string }, client: CloudCompanyFolderClient, waitMs?: number) {
	const [exec, write] = cloudRunBoxTools({ box: new CloudRunBox(paths, waitMs), folder: client, runId: RUN });
	return { exec: exec!, write: write! };
}

describe("run box tools", () => {
	it("runs a command, releases what it read with the run, cites the release, and only then acknowledges it", async () => {
		const box = await stage(() => ended());
		const { client, releases } = folder();
		const { exec } = await tools(box.paths, client);
		const parsed = exec.parseArguments({ cmd: "cat docs/plan.md" } as JsonValue);
		expect(parsed).toEqual({ cmd: "cat docs/plan.md", workdir: null, yield_time_ms: 10_000, tty: false });
		box.log.add(read("docs/plan.md"));
		const content = await exec.execute(parsed, context());
		expect(content.kind).toBe("text");
		const text = content.value as string;
		expect(text).toBe("Process exited with code 0\nWall time: 0.1 s\nOutput:\nthe plan\n");
		expect(box.requests[0]).toMatchObject({
			t: "exec",
			cmd: "cat docs/plan.md",
			workdir: null,
			tty: false,
			yieldMs: 10_000,
		});
		expect(releases).toHaveLength(1);
		expect(releases[0]?.sha).toBe(createHash("sha256").update(text).digest("hex"));
		expect(releases[0]?.reads).toEqual([
			{
				path: "docs/plan.md",
				version: VERSION,
				authority: { resourceId: RESOURCE, resourceRevision: 3, grantId: null, grantRevision: null },
			},
		]);
		expect(content.companyReadId).toBe(releases[0]?.id);
		expect(box.log.acks).toEqual([1]);
		expect(box.log.waiting).toEqual([]);
		// The same call replayed releases under the same id; another call under another.
		box.log.add(read("docs/plan.md"));
		await exec.execute(parsed, context());
		box.log.add(read("docs/plan.md"));
		await exec.execute(parsed, context("call-2"));
		expect(releases[1]?.id).toBe(releases[0]?.id);
		expect(releases[2]?.id).not.toBe(releases[0]?.id);
		expect(box.log.acks).toEqual([1, 2, 3]);
	});

	it("releases nothing and cites nothing when the command read nothing, and files a read without a receipt for the core to check", async () => {
		const box = await stage(() => ended({ head: "4\n", totalBytes: 2 }));
		const { client, releases } = folder();
		const { exec } = await tools(box.paths, client);
		const content = await exec.execute(exec.parseArguments({ cmd: "echo 4" }), context());
		expect(content.companyReadId).toBeUndefined();
		expect(releases).toEqual([]);
		box.log.add(read("rules/tone.md", null), read("docs/a.md", { resourceId: "not-a-uuid", resourceRevision: 1 }));
		await exec.execute(exec.parseArguments({ cmd: "cat rules/tone.md docs/a.md" }), context("call-3"));
		expect(releases[0]?.reads.map((r) => r.authority.resourceId)).toEqual([
			"00000000-0000-0000-0000-000000000000",
			"00000000-0000-0000-0000-000000000000",
		]);
	});

	it("splits more reads than one release holds, all under the answer's hash, and cites the first", async () => {
		const box = await stage(() => ended());
		box.log.add(...Array.from({ length: 10_001 }, (_, n) => read(`docs/${n}.md`)));
		const { client, releases } = folder();
		const { exec } = await tools(box.paths, client);
		const content = await exec.execute(exec.parseArguments({ cmd: "rg -l plan" }), context());
		expect(box.log.takes).toEqual(Array.from({ length: 6 }, () => 2_000));
		expect(releases.map((r) => r.reads.length)).toEqual([10_000, 1]);
		expect(new Set(releases.map((r) => r.sha)).size).toBe(1);
		expect(content.companyReadId).toBe(releases[0]?.id);
		expect(box.log.acks).toEqual([10_001]);
	});

	it("withholds the output when a read may no longer be made or cannot be recorded, and releases those reads with the next answer", async () => {
		const box = await stage(() => ended());
		box.log.add(read("docs/plan.md"));
		const revoked = await tools(box.paths, folder(new CloudCompanyFolderError("read_revoked")).client);
		await expect(
			revoked.exec.execute(revoked.exec.parseArguments({ cmd: "cat docs/plan.md" }), context()),
		).rejects.toThrow(/^READ_REVOKED/);
		const down = await tools(box.paths, folder(new CloudCompanyFolderError("unavailable")).client);
		await expect(down.exec.execute(down.exec.parseArguments({ cmd: "cat docs/plan.md" }), context())).rejects.toThrow(
			/^COMPANY_FOLDER_UNAVAILABLE/,
		);
		expect(box.log.acks).toEqual([]);
		// Nothing was acknowledged: the next answer that releases takes those reads along.
		const { client, releases } = folder();
		const later = await tools(box.paths, client);
		box.log.add(read("docs/other.md"));
		await later.exec.execute(later.exec.parseArguments({ cmd: "cat docs/other.md" }), context("call-4"));
		expect(releases[0]?.reads.map((r) => r.path)).toEqual(["docs/plan.md", "docs/other.md"]);
		expect(box.log.acks).toEqual([2]);
	});

	it("withholds an answer when the box's read log restarted, and goes on with the new one", async () => {
		const box = await stage(() => ended());
		const { client, releases } = folder();
		const { exec } = await tools(box.paths, client);
		box.log.add(read("docs/plan.md"));
		await exec.execute(exec.parseArguments({ cmd: "cat docs/plan.md" }), context());
		box.log.restart();
		box.log.add(read("docs/new.md"));
		await expect(exec.execute(exec.parseArguments({ cmd: "cat docs/new.md" }), context("call-2"))).rejects.toThrow(
			/^RUN_BOX_UNAVAILABLE: the run box's folder restarted/,
		);
		await exec.execute(exec.parseArguments({ cmd: "cat docs/new.md" }), context("call-3"));
		expect(releases.map((r) => r.reads.map((read) => read.path))).toEqual([["docs/plan.md"], ["docs/new.md"]]);
	});

	it("reads on and writes to a running command", async () => {
		const box = await stage((request) =>
			request.t === "exec"
				? { ...ended({ head: "name? ", totalBytes: 6 }), session: 4, exitCode: null }
				: ended({ head: "hello box\n", totalBytes: 10 }),
		);
		const { client } = folder();
		const { exec, write } = await tools(box.paths, client);
		const first = await exec.execute(
			exec.parseArguments({ cmd: "read n; echo hello $n", tty: true, yield_time_ms: 500 }),
			context(),
		);
		expect(first.value).toMatch(/^Process running with session ID 4\n/);
		const second = await write.execute(write.parseArguments({ session_id: 4, chars: "box\n" }), context("call-2"));
		expect(second.value).toMatch(/^Process exited with code 0\n[\s\S]*hello box\n$/);
		expect(box.requests[1]).toMatchObject({ t: "write", session: 4, chars: "box\n", yieldMs: 250 });
	});

	it("refuses what the box should not answer, and says when there is no box", async () => {
		const wrong = await stage((request) =>
			request.cmd === "error"
				? { t: "error", code: "WORKDIR_UNAVAILABLE", message: "No directory /company/x" }
				: request.cmd === "big"
					? ended({ head: "x".repeat(5000), totalBytes: 5000 })
					: "not json",
		);
		const { exec } = await tools(wrong.paths, folder().client);
		await expect(exec.execute(exec.parseArguments({ cmd: "error" }), context())).rejects.toThrow(
			/^WORKDIR_UNAVAILABLE/,
		);
		await expect(exec.execute(exec.parseArguments({ cmd: "big" }), context("c2"))).rejects.toThrow(
			/^RUN_BOX_UNAVAILABLE/,
		);
		await expect(exec.execute(exec.parseArguments({ cmd: "junk" }), context("c3"))).rejects.toThrow(
			/^RUN_BOX_UNAVAILABLE/,
		);
		const none = await tools(
			{ socket: "/nonexistent/box.sock", reads: "/nonexistent/box.reads" },
			folder().client,
			300,
		);
		await expect(none.exec.execute(none.exec.parseArguments({ cmd: "ls" }), context())).rejects.toBeInstanceOf(
			CloudToolRefusal,
		);
	});

	it("checks its arguments closely", async () => {
		const { exec, write } = await tools({ socket: "/x", reads: "/y" }, folder().client);
		for (const bad of [
			{},
			{ cmd: " " },
			{ cmd: "ls", extra: 1 },
			{ cmd: "ls", yield_time_ms: 30_001 },
			{ cmd: "ls", tty: "yes" },
		])
			expect(() => exec.parseArguments(bad as JsonValue)).toThrow();
		for (const bad of [{ session_id: 0 }, { session_id: 1, chars: "a\0" }, { session_id: 1.5 }])
			expect(() => write.parseArguments(bad as JsonValue)).toThrow();
		expect(write.parseArguments({ session_id: 2 })).toEqual({ session_id: 2, chars: "", yield_time_ms: 250 });
	});

	it("fits a long answer so its tail survives the result envelope", () => {
		const head = '\t"\\'.repeat(400);
		const tail = `${"\n".repeat(2000)}the end\n`;
		const text = runBoxAnswerText({
			t: "result",
			id: RUN,
			session: null,
			exitCode: 1,
			signal: null,
			output: { head, tail, skippedBytes: 100, totalBytes: 100 + head.length + tail.length },
			logPath: "/tmp/home/output/7.log",
			wallMs: 2500,
		});
		expect(Buffer.byteLength(JSON.stringify(text))).toBeLessThanOrEqual(6_000);
		expect(text.startsWith("Process exited with code 1\nWall time: 2.5 s\nOutput:\n")).toBe(true);
		expect(text.endsWith("the end\n")).toBe(true);
		expect(text).toMatch(/\[\d+ bytes not shown; the whole output is in \/tmp\/home\/output\/7\.log\]/);
	});
});
