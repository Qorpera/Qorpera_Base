import { randomUUID } from "node:crypto";
import { CLOUD_MACHINE_HOME, CODING_GUEST } from "@qorpera/contracts";
import { describe, expect, it } from "vitest";
import {
	CODING_MACHINE_CHANNEL,
	codingMachineChannelCommand,
	injectCodingChannelExecEnv,
	maskCodingChannelExecLines,
} from "../src/coding-executor-host.ts";
import { CodingSecretMask } from "../src/coding-secret-mask.ts";
import { validExecPipe } from "../src/lxd-client.ts";

describe("codingMachineChannelCommand", () => {
	const bootId = randomUUID();
	const workerId = randomUUID();
	const compact = workerId.replaceAll("-", "").toLowerCase();

	it("builds an isolated transient systemd-run unit for exec channels within LXD validExecPipe limits", () => {
		const args = codingMachineChannelCommand({
			bootId,
			workerId,
			uid: 200042,
			cwd: "/company/code/org/repo/worktrees/s1",
			channel: "0123456789abcdef",
			kind: "exec",
		});
		expect(args.length).toBeLessThanOrEqual(64);
		expect(
			validExecPipe({
				command: args,
				environment: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
				cwd: "/",
				maxStdoutBytes: 1024,
				stderrTailBytes: 4096,
			}),
		).toBe(true);
		expect(args.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
		expect(args[2]).toContain("/proc/sys/kernel/random/boot_id");
		expect(args[2]).toContain("user.json");
		expect(args[2]).toContain("qorpera-folder-$worker.service");
		expect(args[2]).toContain("/proc/self/mountinfo");
		expect(args[2]).toContain("/home/qorpera-$uid/.codex");
		expect(args[2]).toContain("/run/systemd/resolve/resolv.conf");
		expect(args.slice(3, 8)).toEqual([bootId, compact, "200042", "1", "/usr/bin/systemd-run"]);
		expect(args).toContain(`--unit=${CODING_MACHINE_CHANNEL.unitPrefix}${compact}-0123456789abcdef`);
		expect(args).toContain(`--slice=qorpera-coding-${compact}.slice`);
		expect(args).toContain("--uid=200042");
		expect(args).toContain("--gid=200042");
		expect(args).toContain("--working-directory=/company/code/org/repo/worktrees/s1");
		expect(args).toContain("--property=ProtectProc=invisible");
		expect(args).toContain("--property=PrivateIPC=yes");
		expect(args).toContain(`--property=NetworkNamespacePath=/run/netns/qorpera-${compact}`);
		expect(args).toContain(`--property=BindPaths=${CODING_GUEST.folder}/mounts/${compact}:/company`);
		expect(args).toContain(
			`--property=BindReadOnlyPaths=${CODING_GUEST.folder}/views/${compact}.json:${CODING_GUEST.folder}/view.json`,
		);
		expect(args).toContain("--setenv=HOME=/home/qorpera-200042");
		expect(args).toContain("--setenv=USER=qorpera-200042");
		expect(args).toContain("--setenv=CODEX_HOME=/home/qorpera-200042/.codex");
		expect(args).toContain("--setenv=DOCKER_HOST=unix:///run/user/200042/docker.sock");
		expect(args.slice(-5)).toEqual(["--", CODING_MACHINE_CHANNEL.codex, "exec-server", "--listen", "stdio"]);
		expect(CODING_MACHINE_CHANNEL.codexSha256).toBe(CLOUD_MACHINE_HOME.codexSha256);
	});

	it("builds a minimal-environment unit for sftp channels within LXD validExecPipe limits", () => {
		const args = codingMachineChannelCommand({
			bootId,
			workerId,
			uid: 200042,
			cwd: "/company",
			channel: "fedcba9876543210",
			kind: "sftp",
		});
		expect(args.length).toBeLessThanOrEqual(64);
		expect(
			validExecPipe({
				command: args,
				environment: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
				cwd: "/",
				maxStdoutBytes: 1024,
				stderrTailBytes: 4096,
			}),
		).toBe(true);
		expect(args[6]).toBe("0");
		expect(args).toContain(`--unit=${CODING_MACHINE_CHANNEL.unitPrefix}${compact}-sftp-fedcba9876543210`);
		expect(args).not.toContain("--setenv=CODEX_HOME=/home/qorpera-200042/.codex");
		expect(args.slice(-2)).toEqual(["--", CODING_MACHINE_CHANNEL.sftpServer]);
	});

	it("rejects invalid uid, channel, or cwd values", () => {
		expect(() =>
			codingMachineChannelCommand({ bootId, workerId, uid: 1000, cwd: "/company", channel: "0123456789abcdef" }),
		).toThrow("CODING_CHANNEL_COMMAND_INVALID");
		expect(() =>
			codingMachineChannelCommand({ bootId, workerId, uid: 200001, cwd: "relative", channel: "0123456789abcdef" }),
		).toThrow("CODING_CHANNEL_COMMAND_INVALID");
		expect(() =>
			codingMachineChannelCommand({ bootId, workerId, uid: 200001, cwd: "/company", channel: "not-hex!" }),
		).toThrow("CODING_CHANNEL_COMMAND_INVALID");
	});
});

describe("injectCodingChannelExecEnv", () => {
	it("merges authoritative session env and keeps only allowlisted client vars on process/start", () => {
		const authoritative = {
			HOME: "/home/qorpera-200001",
			USER: "qorpera-200001",
			SECRET_API_KEY: "sk-live-secret-9999",
			GIT_CONFIG_COUNT: "1",
		};
		const readMap = new Map<string, string>();
		const input = JSON.stringify({
			id: 1,
			method: "process/start",
			params: {
				processId: "p1",
				argv: ["/bin/bash", "-c", "env"],
				env: {
					HOME: "/var/lib/qorpera-agent",
					LD_PRELOAD: "/tmp/evil.so",
					CLAUDECODE: "1",
					TERM: "xterm-256color",
				},
			},
		});
		const out = JSON.parse(injectCodingChannelExecEnv(input, authoritative, readMap)) as {
			params: { env: Record<string, string> };
		};
		expect(out.params.env).toEqual({
			...authoritative,
			CLAUDECODE: "1",
			TERM: "xterm-256color",
		});

		const readReq = JSON.stringify({ id: 7, method: "process/read", params: { processId: "p1" } });
		expect(injectCodingChannelExecEnv(readReq, authoritative, readMap)).toBe(readReq);
		expect(readMap.get("7")).toBe("p1");

		const initLine = '{"id":0,"method":"initialize","params":{}}';
		expect(injectCodingChannelExecEnv(initLine, authoritative, readMap)).toBe(initLine);
	});
});

describe("maskCodingChannelExecLines", () => {
	it("masks secrets across split process/output, split process/read chunks, fs/readFile dataBase64, stream eviction, and early EOF", async () => {
		const secret = "top-secret-token-12345678";
		const mask = new CodingSecretMask([secret]);
		const readProcessById = new Map<string, string>([
			["2", "p2"],
			["3", "p2"],
		]);
		const rawLines = [
			JSON.stringify({
				method: "process/output",
				params: { processId: "p1", stream: "stdout", chunk: Buffer.from("prefix top-secret-").toString("base64") },
			}),
			JSON.stringify({
				method: "process/output",
				params: {
					processId: "p1",
					stream: "stdout",
					chunk: Buffer.from("token-12345678 suffix").toString("base64"),
				},
			}),
			JSON.stringify({
				method: "process/exited",
				params: { processId: "p1", exitCode: 0 },
			}),
			JSON.stringify({
				id: 2,
				result: {
					chunks: [
						{ stream: "stdout", chunk: Buffer.from("first top-").toString("base64") },
						{ stream: "stdout", chunk: Buffer.from("secret-").toString("base64") },
					],
					note: `saw ${secret}`,
				},
			}),
			JSON.stringify({
				id: 3,
				result: {
					chunks: [{ stream: "stdout", chunk: Buffer.from("token-12345678 end").toString("base64") }],
					closed: true,
				},
			}),
			JSON.stringify({
				id: 4,
				result: {
					dataBase64: Buffer.from(`config=${secret}\n`).toString("base64"),
				},
			}),
			JSON.stringify({
				method: "process/output",
				params: { processId: "p3", stream: "stdout", chunk: Buffer.from("tail top-sec").toString("base64") },
			}),
		];
		const collected: Record<string, unknown>[] = [];
		for await (const line of maskCodingChannelExecLines(
			(async function* () {
				for (const l of rawLines) yield l;
			})(),
			() => mask.stream(),
			readProcessById,
		)) {
			collected.push(JSON.parse(line) as Record<string, unknown>);
		}
		const p1Stdout = collected
			.filter((m) => m.method === "process/output" && (m.params as { processId: string }).processId === "p1")
			.map((m) => Buffer.from(String((m.params as { chunk: string }).chunk), "base64").toString("utf8"))
			.join("");
		expect(p1Stdout).toBe("prefix *** suffix");
		const exitedIdx = collected.findIndex((m) => m.method === "process/exited");
		const lastP1OutputIdx = collected.reduce(
			(last, m, idx) =>
				m.method === "process/output" && (m.params as { processId: string }).processId === "p1" ? idx : last,
			-1,
		);
		expect(exitedIdx).toBe(lastP1OutputIdx + 1);

		const readRes1 = collected.find((m) => m.id === 2)?.result as {
			chunks: { chunk: string }[];
			note: string;
		};
		const readRes2 = collected.find((m) => m.id === 3)?.result as { chunks: { chunk: string }[] };
		const combinedRead = [...readRes1.chunks, ...readRes2.chunks]
			.map((c) => Buffer.from(c.chunk, "base64").toString("utf8"))
			.join("");
		expect(combinedRead).toBe("first *** end");
		expect(readRes1.note).toBe("saw ***");

		const readFileRes = collected.find((m) => m.id === 4)?.result as { dataBase64: string };
		expect(Buffer.from(readFileRes.dataBase64, "base64").toString("utf8")).toBe("config=***\n");

		const p3Stdout = collected
			.filter((m) => m.method === "process/output" && (m.params as { processId: string }).processId === "p3")
			.map((m) => Buffer.from(String((m.params as { chunk: string }).chunk), "base64").toString("utf8"))
			.join("");
		expect(p3Stdout).toBe("tail top-sec");
	});

	it("keeps process/read masks intact across an interleaved process/exited notification until closed read", async () => {
		const secret = "top-secret-token-12345678";
		const mask = new CodingSecretMask([secret]);
		const readProcessById = new Map<string, string>([
			["10", "p-poll"],
			["11", "p-poll"],
		]);
		const rawLines = [
			JSON.stringify({
				id: 10,
				result: {
					chunks: [{ seq: 1, stream: "stdout", chunk: Buffer.from("line top-sec").toString("base64") }],
					closed: false,
				},
			}),
			JSON.stringify({
				method: "process/exited",
				params: { processId: "p-poll", exitCode: 0 },
			}),
			JSON.stringify({
				id: 11,
				result: {
					chunks: [{ seq: 2, stream: "stdout", chunk: Buffer.from("ret-done").toString("base64") }],
					closed: true,
				},
			}),
		];
		const collected: Record<string, unknown>[] = [];
		for await (const line of maskCodingChannelExecLines(
			(async function* () {
				for (const l of rawLines) yield l;
			})(),
			() => mask.stream(),
			readProcessById,
		)) {
			collected.push(JSON.parse(line) as Record<string, unknown>);
		}
		expect(collected.some((m) => m.method === "process/output")).toBe(false);
		const res1 = collected.find((m) => m.id === 10)?.result as { chunks: { seq: number; chunk: string }[] };
		const res2 = collected.find((m) => m.id === 11)?.result as { chunks: { seq: number; chunk: string }[] };
		const combined = [...res1.chunks, ...res2.chunks]
			.map((c) => Buffer.from(c.chunk, "base64").toString("utf8"))
			.join("");
		expect(combined).toBe("line top-secret-done");
		expect(res2.chunks).toHaveLength(1);
		expect(res2.chunks[0]?.seq).toBe(2);
	});

	it("preserves metadata and advances seq when flushing a held-back tail on an empty closed read", async () => {
		const secret = "top-secret-token-12345678";
		const mask = new CodingSecretMask([secret]);
		const readProcessById = new Map<string, string>([
			["20", "p-empty-close"],
			["21", "p-empty-close"],
		]);
		const rawLines = [
			JSON.stringify({
				id: 20,
				result: {
					chunks: [
						{ seq: 4, stream: "stdout", tag: "keep", chunk: Buffer.from("prefix top-sec").toString("base64") },
					],
					closed: false,
				},
			}),
			JSON.stringify({
				id: 21,
				result: {
					chunks: [],
					closed: true,
				},
			}),
		];
		const collected: Record<string, unknown>[] = [];
		for await (const line of maskCodingChannelExecLines(
			(async function* () {
				for (const l of rawLines) yield l;
			})(),
			() => mask.stream(),
			readProcessById,
		)) {
			collected.push(JSON.parse(line) as Record<string, unknown>);
		}
		const res1 = collected.find((m) => m.id === 20)?.result as {
			chunks: { seq: number; stream: string; tag?: string; chunk: string }[];
		};
		const res2 = collected.find((m) => m.id === 21)?.result as {
			chunks: { seq: number; stream: string; tag?: string; chunk: string }[];
		};
		const combined = [...res1.chunks, ...res2.chunks]
			.map((c) => Buffer.from(c.chunk, "base64").toString("utf8"))
			.join("");
		expect(combined).toBe("prefix top-sec");
		expect(res2.chunks).toHaveLength(1);
		expect(res2.chunks[0]).toMatchObject({ seq: 5, stream: "stdout", tag: "keep" });
	});

	it("assigns distinct process-wide seq numbers and advances nextSeq when flushing two streams on an empty closed read", async () => {
		const secret = "top-secret-token-12345678";
		const mask = new CodingSecretMask([secret]);
		const readProcessById = new Map<string, string>([
			["30", "p-two-stream"],
			["31", "p-two-stream"],
		]);
		const rawLines = [
			JSON.stringify({
				id: 30,
				result: {
					chunks: [
						{ seq: 4, stream: "stdout", chunk: Buffer.from("out top-sec").toString("base64") },
						{ seq: 5, stream: "stderr", chunk: Buffer.from("err top-sec").toString("base64") },
					],
					nextSeq: 6,
					closed: false,
				},
			}),
			JSON.stringify({
				id: 31,
				result: {
					chunks: [],
					nextSeq: 6,
					closed: true,
				},
			}),
		];
		const collected: Record<string, unknown>[] = [];
		for await (const line of maskCodingChannelExecLines(
			(async function* () {
				for (const l of rawLines) yield l;
			})(),
			() => mask.stream(),
			readProcessById,
		)) {
			collected.push(JSON.parse(line) as Record<string, unknown>);
		}
		const res1 = collected.find((m) => m.id === 30)?.result as {
			chunks: { seq: number; stream: string; chunk: string }[];
		};
		const res2 = collected.find((m) => m.id === 31)?.result as {
			chunks: { seq: number; stream: string; chunk: string }[];
			nextSeq: number;
		};
		const byStream = (stream: string) =>
			[...res1.chunks, ...res2.chunks]
				.filter((c) => c.stream === stream)
				.map((c) => Buffer.from(c.chunk, "base64").toString("utf8"))
				.join("");
		expect(byStream("stdout")).toBe("out top-sec");
		expect(byStream("stderr")).toBe("err top-sec");
		expect(res2.chunks).toHaveLength(2);
		expect(res2.chunks.map((c) => c.seq)).toEqual([6, 7]);
		expect(res2.nextSeq).toBe(8);
	});

	it("flushes oldest held-back stream bytes cleanly when more than 1024 streams are opened", async () => {
		const secret = "top-secret-token-12345678";
		const mask = new CodingSecretMask([secret]);
		const rawLines: string[] = [];
		for (let i = 0; i < 1026; i += 1) {
			rawLines.push(
				JSON.stringify({
					method: "process/output",
					params: {
						processId: `s-${i}`,
						stream: "stdout",
						chunk: Buffer.from("top-sec").toString("base64"),
					},
				}),
			);
		}
		const byProc = new Map<string, string>();
		for await (const line of maskCodingChannelExecLines(
			(async function* () {
				for (const l of rawLines) yield l;
			})(),
			() => mask.stream(),
		)) {
			const parsed = JSON.parse(line) as { method?: string; params?: { processId: string; chunk: string } };
			if (parsed.method === "process/output" && parsed.params) {
				const prev = byProc.get(parsed.params.processId) ?? "";
				byProc.set(parsed.params.processId, prev + Buffer.from(parsed.params.chunk, "base64").toString("utf8"));
			}
		}
		expect(byProc.get("s-0")).toBe("top-sec");
		expect(byProc.get("s-1")).toBe("top-sec");
		expect(byProc.get("s-1025")).toBe("top-sec");
		expect(byProc.size).toBe(1026);
	});
});
