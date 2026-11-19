import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { CLAUDE_BOX_CONFIGURATION, launchClaudeCodeBox } from "../../../packages/runtime/src/cloud-claude-box.ts";
import type { CloudClaudeHomeChannel, CloudClaudeHomeStream } from "../../../packages/runtime/src/cloud-claude-home-shell.ts";
import { NATIVE_EGRESS_SOCKET_NAME } from "../../../packages/runtime/src/cloud-native-egress.ts";

const P = "/opt/qorpera-ccap-proof";
const BASE = "/var/lib/ccap-proof";
const HOLD_MS = 4000;
const RUN_MS = 240_000;
const [label = "x", ...cases] = process.argv.slice(2);
const OUT = join(BASE, `out-${label}`);
mkdirSync(OUT, { recursive: true, mode: 0o700 });

const configuration = {
	...CLAUDE_BOX_CONFIGURATION,
	binary: `${P}/claude`,
	entryPoint: `${P}/src/cloud-native-isolation-child.ts`,
	shellClient: `${P}/src/cloud-claude-home-shell-client.ts`,
	stage: `${P}/qorpera-claude-box-stage.sh`,
	namespaceHelper: "/usr/bin/unshare",
	sshfs: `${P}/sshfs`,
	node: process.execPath,
};

function homeChannel(home: string, opened: string[]): CloudClaudeHomeChannel {
	return {
		open: async (input) => {
			opened.push(input.kind ?? "exec");
			if (input.kind !== "sftp") throw new Error("This proof's home has no shell");
			const server: ChildProcess = spawn(
				"/usr/bin/bwrap",
				[
					"--unshare-user",
					"--ro-bind",
					"/usr",
					"/usr",
					"--symlink",
					"usr/lib",
					"/lib",
					"--symlink",
					"usr/lib64",
					"/lib64",
					"--symlink",
					"usr/bin",
					"/bin",
					"--ro-bind",
					"/etc",
					"/etc",
					"--dev",
					"/dev",
					"--proc",
					"/proc",
					"--bind",
					join(home, "company"),
					"/company",
					"--bind",
					join(home, "agent"),
					"/var/lib/qorpera-agent",
					"--bind",
					join(home, "tmp"),
					"/tmp",
					"--chdir",
					"/company",
					"--",
					"/usr/lib/openssh/sftp-server",
				],
				{ stdio: ["pipe", "pipe", "ignore"] },
			);
			const queue: string[] = [];
			let wake: (() => void) | undefined;
			let ended = false;
			server.stdout?.on("data", (chunk: Buffer) => {
				for (let at = 0; at < chunk.length; at += 512 * 1024)
					queue.push(chunk.subarray(at, at + 512 * 1024).toString("base64"));
				wake?.();
			});
			server.once("close", () => {
				ended = true;
				wake?.();
			});
			const stream: CloudClaudeHomeStream = {
				write: (line) => {
					if (server.stdin?.writable) server.stdin.write(Buffer.from(line, "base64"));
				},
				lines: (async function* () {
					for (;;) {
						const next = queue.shift();
						if (next !== undefined) {
							yield next;
							continue;
						}
						if (ended) return;
						await new Promise<void>((done) => {
							wake = done;
						});
						wake = undefined;
					}
				})(),
				close: async () => {
					server.kill("SIGKILL");
				},
			};
			return stream;
		},
	};
}

function startStub(port: number, scenario: string, summary: string): Promise<ChildProcess> {
	const child = spawn(
		"/usr/bin/python3",
		["-I", `${P}/test/connections-stub.py`, String(port), scenario, `${P}/tls/server.pem`, `${P}/tls/server.key`, summary],
		{ stdio: ["ignore", "pipe", "inherit"] },
	);
	return new Promise((resolve, reject) => {
		child.stdout?.once("data", () => resolve(child));
		child.once("exit", () => reject(new Error("stub ended")));
	});
}

function relayConnections(path: string): number {
	return readFileSync("/proc/net/unix", "utf8")
		.split("\n")
		.filter((line) => line.endsWith(` ${path}`) && line.split(/\s+/)[5] === "03").length;
}

async function run(kind: string, n: number, port: number): Promise<Record<string, unknown>> {
	const subagents = kind === "start" ? 0 : Number(kind.replace(/^sub/, ""));
	const dir = mkdtempSync(join(BASE, "r-"));
	const scratch = mkdtempSync(join(dir, "s"));
	const login = join(dir, "login");
	const home = join(dir, "home");
	for (const folder of [login, home, join(home, "company"), join(home, "agent"), join(home, "tmp")])
		mkdirSync(folder, { mode: 0o700 });
	const token = `sk-ant-oat01-CCAP-${randomBytes(16).toString("hex")}`;
	writeFileSync(
		join(login, ".credentials.json"),
		JSON.stringify({
			claudeAiOauth: {
				accessToken: token,
				refreshToken: `${token}-r`,
				expiresAt: Date.now() + 30 * 86400_000,
				scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
				subscriptionType: "max",
			},
		}),
		{ mode: 0o600 },
	);
	writeFileSync(join(login, ".claude.json"), '{"hasCompletedOnboarding":true,"bypassPermissionsModeAccepted":true}\n', {
		mode: 0o600,
	});
	const scenario = join(dir, "scenario.json");
	writeFileSync(scenario, JSON.stringify({ subagents, holdMs: HOLD_MS }));
	const summaryPath = join(OUT, `stub-${kind}-${n}.json`);
	const stub = await startStub(port, scenario, summaryPath);
	const upstream = { open: 0, peak: 0, total: 0 };
	const transport = {
		resolve: async () => ["93.184.216.34"],
		connect: () => {
			const socket: Socket = createConnection({ host: "127.0.0.1", port });
			upstream.open += 1;
			upstream.total += 1;
			upstream.peak = Math.max(upstream.peak, upstream.open);
			socket.once("close", () => {
				upstream.open -= 1;
			});
			return socket;
		},
	};
	const relayPath = join(scratch, NATIVE_EGRESS_SOCKET_NAME);
	const relay = { peak: 0 };
	const sampler = setInterval(() => {
		relay.peak = Math.max(relay.peak, relayConnections(relayPath));
	}, 10);
	const opened: string[] = [];
	const t0 = Date.now();
	const record: Record<string, unknown> = { kind, n, subagents };
	const lines: string[] = [];
	let code: number | undefined;
	try {
		const box = await launchClaudeCodeBox({
			configuration,
			scratchRoot: scratch,
			login: { folder: login },
			channel: homeChannel(home, opened),
			sessionId: randomUUID(),
			machineId: "00000000-0000-4000-8000-00000000cca9",
			prompt: "Run the connections proof.",
			signal: AbortSignal.timeout(RUN_MS),
			proof: { transport, extraCa: `${P}/tls/ca.pem` },
		});
		for await (const line of box.lines) lines.push(line);
		code = await box.exited;
		const debug = join(login, "debug");
		const debugText = existsSync(debug)
			? readdirSync(debug)
					.filter((name) => name.endsWith(".txt"))
					.map((name) => readFileSync(join(debug, name), "utf8"))
					.join("\n")
			: "";
		writeFileSync(join(OUT, `debug-${kind}-${n}.txt`), debugText);
		const failed = debugText.split("\n").filter((line) => /Proxy connection ended|ECONNRESET|socket hang up|ConnectionRefused|Connection error/i.test(line));
		record.debugBytes = debugText.length;
		record.debugConnectFailures = failed.length;
		record.debugFirstFailures = failed.slice(0, 3).map((line) => line.slice(0, 220));
		record.stderrTail = box.stderr().slice(-400);
		await box.close();
	} catch (error) {
		record.error = String(error).slice(0, 300);
	} finally {
		clearInterval(sampler);
		stub.kill("SIGTERM");
		await new Promise((resolve) => stub.once("exit", resolve));
	}
	writeFileSync(join(OUT, `stream-${kind}-${n}.jsonl`), `${lines.join("\n")}\n`);
	const events = lines.flatMap((line) => {
		try {
			return [JSON.parse(line) as Record<string, unknown>];
		} catch {
			return [];
		}
	});
	const result = events.find((event) => event.type === "result");
	const stub_ = existsSync(summaryPath)
		? (JSON.parse(readFileSync(summaryPath, "utf8")) as {
				peak: number;
				connections: number;
				requests: { kind: string }[];
				taskTool: string | null;
				taskSchema: string[] | null;
			})
		: undefined;
	Object.assign(record, {
		ms: Date.now() - t0,
		exit: code,
		result: result ? { subtype: result.subtype, isError: result.is_error, text: String(result.result ?? "").slice(0, 80) } : null,
		apiRetries: events.filter((event) => event.type === "system" && event.subtype === "api_retry").length,
		apiRetryErrors: [
			...new Set(
				events
					.filter((event) => event.type === "system" && event.subtype === "api_retry")
					.map((event) => `${event.error_status ?? "-"} ${JSON.stringify(event.error).slice(0, 160)}`),
			),
		],
		channels: opened,
		relayPeak: relay.peak,
		upstreamPeak: upstream.peak,
		upstreamTotal: upstream.total,
		stubPeak: stub_?.peak,
		stubConnections: stub_?.connections,
		requests: stub_?.requests.reduce<Record<string, number>>((counts, request) => {
			counts[request.kind] = (counts[request.kind] ?? 0) + 1;
			return counts;
		}, {}),
		taskTool: stub_?.taskTool,
	});
	return record;
}

let port = 18600;
for (const spec of cases) {
	const [kind = "start", repeats = "1"] = spec.split(":");
	for (let n = 1; n <= Number(repeats); n++) console.log(`RUN ${JSON.stringify(await run(kind, n, port++))}`);
}
console.log("PROOF-END");
