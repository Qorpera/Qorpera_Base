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

describe("codingMachineChannelCommand", () => {
	const bootId = randomUUID();
	const workerId = randomUUID();
	const compact = workerId.replaceAll("-", "").toLowerCase();

	it("builds an isolated transient systemd-run unit for exec channels", () => {
		const args = codingMachineChannelCommand({
			bootId,
			workerId,
			uid: 200042,
			cwd: "/company/code/org/repo/worktrees/s1",
			channel: "0123456789abcdef",
			kind: "exec",
			environment: { CUSTOM_FLAG: "1", HOME: "/spoofed" },
		});
		expect(args.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
		expect(args[2]).toContain("/proc/sys/kernel/random/boot_id");
		expect(args[2]).toContain("/run/systemd/resolve/resolv.conf");
		expect(args[3]).toBe(bootId);
		expect(args[4]).toBe("/usr/bin/systemd-run");
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
		expect(args).toContain("--setenv=DOCKER_HOST=unix:///run/user/200042/docker.sock");
		expect(args).toContain("--setenv=CUSTOM_FLAG=1");
		expect(args).not.toContain("--setenv=HOME=/spoofed");
		expect(args.slice(-5)).toEqual(["--", CODING_MACHINE_CHANNEL.codex, "exec-server", "--listen", "stdio"]);
		expect(CODING_MACHINE_CHANNEL.codexSha256).toBe(CLOUD_MACHINE_HOME.codexSha256);
	});

	it("builds a minimal-environment unit for sftp channels", () => {
		const args = codingMachineChannelCommand({
			bootId,
			workerId,
			uid: 200042,
			cwd: "/company",
			channel: "fedcba9876543210",
			kind: "sftp",
			environment: { SECRET_SHOULD_NOT_APPEAR: "supersecret" },
		});
		expect(args).toContain(`--unit=${CODING_MACHINE_CHANNEL.unitPrefix}${compact}-sftp-fedcba9876543210`);
		expect(args).not.toContain("--setenv=SECRET_SHOULD_NOT_APPEAR=supersecret");
		expect(args.slice(-2)).toEqual(["--", CODING_MACHINE_CHANNEL.sftpServer]);
	});

	it("rejects invalid uid, channel, cwd, or environment values", () => {
		expect(() =>
			codingMachineChannelCommand({ bootId, workerId, uid: 1000, cwd: "/company", channel: "0123456789abcdef" }),
		).toThrow("CODING_CHANNEL_COMMAND_INVALID");
		expect(() =>
			codingMachineChannelCommand({ bootId, workerId, uid: 200001, cwd: "relative", channel: "0123456789abcdef" }),
		).toThrow("CODING_CHANNEL_COMMAND_INVALID");
		expect(() =>
			codingMachineChannelCommand({
				bootId,
				workerId,
				uid: 200001,
				cwd: "/company",
				channel: "0123456789abcdef",
				environment: { BAD: "line1\nline2" },
			}),
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
		const out = JSON.parse(injectCodingChannelExecEnv(input, authoritative)) as {
			params: { env: Record<string, string> };
		};
		expect(out.params.env).toEqual({
			...authoritative,
			CLAUDECODE: "1",
			TERM: "xterm-256color",
		});

		const initLine = '{"id":0,"method":"initialize","params":{}}';
		expect(injectCodingChannelExecEnv(initLine, authoritative)).toBe(initLine);
	});
});

describe("maskCodingChannelExecLines", () => {
	it("masks secrets across split process/output base64 chunks and flushes before process/exited", async () => {
		const secret = "top-secret-token-12345678";
		const mask = new CodingSecretMask([secret]);
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
					chunks: [{ chunk: Buffer.from(`read ${secret} done`).toString("base64") }],
					note: `saw ${secret}`,
				},
			}),
		];
		const collected: Record<string, unknown>[] = [];
		for await (const line of maskCodingChannelExecLines(
			(async function* () {
				for (const l of rawLines) yield l;
			})(),
			() => mask.stream(),
		)) {
			collected.push(JSON.parse(line) as Record<string, unknown>);
		}
		const decodedStdout = collected
			.filter((m) => m.method === "process/output")
			.map((m) => Buffer.from(String((m.params as { chunk: string }).chunk), "base64").toString("utf8"))
			.join("");
		expect(decodedStdout).toBe("prefix *** suffix");
		let lastOutput = -1;
		for (let i = collected.length - 1; i >= 0; i -= 1) {
			if (collected[i]?.method === "process/output") {
				lastOutput = i;
				break;
			}
		}
		expect(collected.findIndex((m) => m.method === "process/exited")).toBe(lastOutput + 1);
		const readResult = collected.at(-1)?.result as { chunks: { chunk: string }[]; note: string };
		expect(Buffer.from(readResult.chunks[0]!.chunk, "base64").toString("utf8")).toBe("read *** done");
		expect(readResult.note).toBe("saw ***");
	});
});
