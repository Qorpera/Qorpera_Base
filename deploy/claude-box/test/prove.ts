// C2 proof: the driver (packages/runtime/src/cloud-claude-box.ts) as the run host runs it: an unprivileged account
// in a unit hardened like the company host, its home over the gateway (gateway.py, C1's contract), Claude Code's model
// a scripted stub reached through the driver's own egress relay (the proof transport sends Anthropic's hosts to it).
// Made-up sign-ins only. Usage (as the proof's account): node prove.ts MODE LABEL
//   MODE: shell | files | a5 (token on fd 3, attack + next run) | a6 (login FILE, attack + next run with the same folder)
//         | a2 (login file, no deny rules, no follow_symlinks) | a3 (login file, no deny rules) | cred-fresh |
//         cred-expired | cred-bare | two (two members at once; the first is ended mid-command)
// Prints one JSON line per run ("RUN {...}") and "PROOF-END".

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { CLAUDE_BOX_CONFIGURATION, type ClaudeBoxProofWeakening, launchClaudeCodeBox } from "./src/cloud-claude-box.ts";
import type { CloudClaudeHomeChannel, CloudClaudeHomeStream } from "./src/cloud-claude-home-shell.ts";

const P = "/opt/qorpera-c2-proof";
const BASE = "/var/lib/c2-proof";
const GATEWAY = "/run/c2-gw/gw.sock";
const STUB_PORT = 18443;
const [mode = "shell", label = "x"] = process.argv.slice(2);
const OUT = join(BASE, `out-${label}`);
mkdirSync(OUT, { recursive: true, mode: 0o700 });
const CANARY = new RegExp(`${"C2CAN"}ARY-(FD|FILE|RFR|FD2)-[0-9a-f]{16}`, "g");
const tags = (text: string): string[] => [...new Set([...text.matchAll(CANARY)].map((m) => m[1]))].sort();
const MACHINE = "00000000-0000-4000-8000-00000000c2c2";

const configuration = {
	...CLAUDE_BOX_CONFIGURATION,
	binary: `${P}/claude`,
	entryPoint: `${P}/src/cloud-native-isolation-child.ts`,
	shellClient: `${P}/src/cloud-claude-home-shell-client.ts`,
	stage: `${P}/qorpera-claude-box-stage.sh`,
	// On the test VM unprivileged user namespaces are not restricted (sysctl 0), so util-linux's own unshare stands in
	// for the run host's profiled copy (fusegate3.log proved the copy with its profile on a stock Ubuntu 26.04).
	namespaceHelper: "/usr/bin/unshare",
	sshfs: `${P}/sshfs`,
	node: process.execPath,
};

/** The home's channels through the gateway: the kind and the session in the first line, as C1's handshake carries them. */
const channel: CloudClaudeHomeChannel = {
	open: (input, signal) =>
		new Promise<CloudClaudeHomeStream>((resolve, reject) => {
			const socket: Socket = createConnection(GATEWAY);
			const abort = (): void => {
				socket.destroy();
				reject(new Error("stopped"));
			};
			signal.addEventListener("abort", abort, { once: true });
			socket.once("error", reject);
			socket.write(`${JSON.stringify({ kind: input.kind ?? "exec", sessionId: input.sessionId })}\n`);
			const queue: string[] = [];
			let wake: (() => void) | undefined;
			let ended = false;
			let rest = "";
			let ready = false;
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => {
				rest += chunk;
				let end = rest.indexOf("\n");
				while (end >= 0) {
					const line = rest.slice(0, end);
					rest = rest.slice(end + 1);
					end = rest.indexOf("\n");
					if (!ready) {
						ready = true;
						const answer = JSON.parse(line) as { ok: boolean; reason?: string };
						if (!answer.ok) {
							socket.destroy();
							reject(Object.assign(new Error("refused"), { reason: answer.reason }));
							return;
						}
						signal.removeEventListener("abort", abort);
						resolve({
							write: (text) => {
								if (socket.writable) socket.write(`${text}\n`);
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
								socket.destroy();
							},
						});
						continue;
					}
					queue.push(line);
					wake?.();
				}
			});
			socket.once("close", () => {
				ended = true;
				wake?.();
			});
		}),
};

const transport = {
	resolve: async () => ["93.184.216.34"],
	connect: () => createConnection({ host: "127.0.0.1", port: STUB_PORT }),
};

function stub(scenario: string, log: string): Promise<() => void> {
	const child = spawn(
		"/usr/bin/python3",
		["-I", `${P}/test/stub.py`, String(STUB_PORT), log, scenario, `${P}/tls/server.pem`, `${P}/tls/server.key`],
		{ stdio: ["ignore", "ignore", "inherit"] },
	);
	return new Promise((resolve) => {
		const t0 = Date.now();
		const tryConnect = (): void => {
			const s = createConnection({ host: "127.0.0.1", port: STUB_PORT });
			s.once("connect", () => {
				s.destroy();
				resolve(() => child.kill("SIGKILL"));
			});
			s.once("error", () => (Date.now() - t0 > 10_000 ? resolve(() => child.kill()) : setTimeout(tryConnect, 100)));
		};
		tryConnect();
	});
}

function credentials(kind: "FILE", expired: boolean): string {
	const token = `sk-ant-oat01-${"C2CAN"}ARY-${kind}-${randomBytes(8).toString("hex")}`;
	return JSON.stringify({
		claudeAiOauth: {
			accessToken: token,
			refreshToken: `${token}-r`,
			expiresAt: Date.now() + (expired ? -3600_000 : 30 * 86400_000),
			scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
			subscriptionType: "max",
		},
	});
}

/** What a login folder holds, without its secrets: each file's size, inode, mtime and the canary kinds in it. */
function folderFacts(folder: string): Record<string, unknown> {
	const facts: Record<string, unknown> = {};
	const walk = (dir: string, prefix: string): void => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			const st = lstatSync(path);
			const key = `${prefix}${name}`;
			if (st.isDirectory()) {
				facts[`${key}/`] = { entries: readdirSync(path).length };
				if (prefix.split("/").length < 3) walk(path, `${key}/`);
			} else {
				const text = st.isFile() && st.size < 4_000_000 ? readFileSync(path, "utf8") : "";
				let fields: string[] | undefined;
				if (name === ".credentials.json") {
					try {
						const value = JSON.parse(text) as { claudeAiOauth?: Record<string, unknown> };
						fields = Object.keys(value.claudeAiOauth ?? {}).sort();
						facts[`${key}#expiresInMin`] = Math.round(
							(Number(value.claudeAiOauth?.expiresAt ?? 0) - Date.now()) / 60_000,
						);
					} catch {
						fields = ["unparsable"];
					}
				}
				if (name === "settings.json" || name === ".last-cleanup") facts[`${key}#text`] = text.slice(0, 300);
				facts[key] = { size: st.size, ino: st.ino, mtime: Math.round(st.mtimeMs), mode: (st.mode & 0o777).toString(8), tags: tags(text), ...(fields ? { fields } : {}) };
			}
		}
	};
	walk(folder, "");
	return facts;
}

function grepTree(root: string, skip?: string): string[] {
	const hits: string[] = [];
	const walk = (dir: string): void => {
		let names: string[] = [];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			const path = join(dir, name);
			if (path === skip) continue;
			let st: ReturnType<typeof lstatSync>;
			try {
				st = lstatSync(path);
			} catch {
				continue;
			}
			if (st.isDirectory()) walk(path);
			else if (st.isFile()) {
				try {
					const found = tags(readFileSync(path).toString("latin1"));
					if (found.length) hits.push(`${path}:${found.join(",")}`);
				} catch {
					// unreadable
				}
			}
		}
	};
	walk(root);
	return hits;
}

function sshfsMountsHere(): number {
	return readFileSync("/proc/self/mountinfo", "utf8")
		.split("\n")
		.filter((line) => line.includes("fuse.sshfs")).length;
}

interface RunOptions {
	tag: string;
	scenario: string;
	login: { token: string } | { folder: string };
	weakening?: ClaudeBoxProofWeakening;
	scratch?: string;
	/** End the box this many ms after it starts (the run ends mid-command). */
	endAfterMs?: number;
	during?: (scratch: string) => Promise<void>;
}

async function run(options: RunOptions): Promise<Record<string, unknown>> {
	const scratch = options.scratch ?? mkdtempSync(join(BASE, "run-"));
	const stopStub = await stub(options.scenario, join(OUT, `stub-${options.tag}.jsonl`));
	const sessionId = randomUUID();
	const t0 = Date.now();
	const controller = new AbortController();
	const record: Record<string, unknown> = { tag: options.tag, session: sessionId.slice(0, 8), scratch };
	const loginFolder = "folder" in options.login ? options.login.folder : undefined;
	if (loginFolder) record.folderBefore = folderFacts(loginFolder);
	try {
		const box = await launchClaudeCodeBox({
			configuration,
			scratchRoot: scratch,
			login: options.login,
			channel,
			sessionId,
			machineId: MACHINE,
			prompt: "Run the C2 scenario.",
			signal: controller.signal,
			proof: { transport, extraCa: `${P}/tls/ca.pem`, weakening: options.weakening },
		});
		record.startMs = Date.now() - t0;
		record.sshfsMountsInDriverNamespace = sshfsMountsHere();
		const lines: string[] = [];
		const reading = (async () => {
			for await (const line of box.lines) lines.push(line);
		})();
		if (options.during) await options.during(scratch);
		let code: number;
		if (options.endAfterMs !== undefined) {
			await new Promise((resolve) => setTimeout(resolve, options.endAfterMs));
			record.endedByRun = true;
			await box.close();
			code = await box.exited;
		} else code = await box.exited;
		await reading;
		writeFileSync(join(OUT, `stream-${options.tag}.jsonl`), `${lines.join("\n")}\n`);
		writeFileSync(join(OUT, `stderr-${options.tag}.txt`), box.stderr());
		const result = lines.map((l) => {
			try {
				return JSON.parse(l) as Record<string, unknown>;
			} catch {
				return {};
			}
		});
		const final = result.filter((r) => r.type === "result").pop();
		record.exit = code;
		record.result = final ? { subtype: final.subtype, is_error: final.is_error, num_turns: final.num_turns } : null;
		record.streamTags = tags(lines.join("\n"));
		// The box's own folders before they go: the sign-in must be in none of them (a login folder is the caller's).
		record.canaryInBoxFolders = grepTree(scratch);
		record.shell = box.shell.counts;
		await box.close();
		record.ms = Date.now() - t0;
	} catch (error) {
		record.error = String((error as Error)?.stack ?? error).slice(0, 2000);
	} finally {
		controller.abort();
		stopStub();
	}
	record.afterClose = {
		sshfsMountsInDriverNamespace: sshfsMountsHere(),
		scratchLeft: readdirSync(scratch),
	};
	if (loginFolder) record.folderAfter = folderFacts(loginFolder);
	const stubLines = readFileSync(join(OUT, `stub-${options.tag}.jsonl`), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
	const requests = stubLines.filter((l) => l.kind === "request");
	record.model = {
		requests: requests.length,
		authTags: [...new Set(requests.flatMap((r) => r.auth_tags as string[]))].sort(),
		bodyTags: [...new Set(requests.flatMap((r) => (r.body_tags as string[] | undefined) ?? []))].sort(),
		attackerRequests: requests.filter((r) => r.attacker).length,
		attackerAuthTags: [...new Set(requests.filter((r) => r.attacker).flatMap((r) => r.auth_tags as string[]))],
		refreshes: stubLines.filter((l) => l.kind === "refresh").map((l) => ({ authTags: l.auth_tags, bodyTags: l.body_tags, grant: l.grant })),
		resultsWithCanary: stubLines.filter((l) => l.kind === "result" && (l.tags as string[]).length).map((l) => `${l.name}:${(l.tags as string[]).join(",")}`),
	};
	console.log(`RUN ${JSON.stringify(record)}`);
	return record;
}

function loginFolder(files: Record<string, string>): string {
	const folder = mkdtempSync(join(BASE, "login-"));
	for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text, { mode: 0o600 });
	return folder;
}

const ONBOARDED = JSON.stringify({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true });
const scen = (kind: string): string => `${P}/scen/${kind}.json`;
const token = (kind = "FD"): string => `sk-ant-oat01-${"C2CAN"}ARY-${kind}-${randomBytes(8).toString("hex")}`;

async function main(): Promise<void> {
	console.log(`PROOF ${JSON.stringify({ mode, label, uid: process.getuid?.(), node: process.version })}`);
	if (mode === "look") {
		configuration.entryPoint = `${P}/test/debug-entry.mjs`;
		await run({ tag: "look", scenario: scen("recon"), login: { token: token() } });
	} else if (mode === "shell" || mode === "files") await run({ tag: mode, scenario: scen(mode), login: { token: token() } });
	else if (mode === "a5") {
		await run({ tag: "a5-s1", scenario: scen("attack"), login: { token: token() } });
		await run({ tag: "a5-s2", scenario: scen("attack-next"), login: { token: token() } });
	} else if (mode === "a6" || mode === "a2" || mode === "a3") {
		const weakening: ClaudeBoxProofWeakening | undefined =
			mode === "a2" ? { noDenyRules: true, noFollowSymlinks: true } : mode === "a3" ? { noDenyRules: true } : undefined;
		const folder = loginFolder({ ".credentials.json": credentials("FILE", false), ".claude.json": ONBOARDED });
		await run({ tag: `${mode}-s1`, scenario: scen("attack"), login: { folder }, weakening });
		await run({ tag: `${mode}-s2`, scenario: scen("attack-next"), login: { folder }, weakening });
	} else if (mode.startsWith("cred-")) {
		const files: Record<string, string> = { ".credentials.json": credentials("FILE", mode === "cred-expired") };
		if (mode !== "cred-bare") files[".claude.json"] = ONBOARDED;
		const folder = loginFolder(files);
		await run({ tag: `${mode}-s1`, scenario: scen("recon"), login: { folder } });
		await run({ tag: `${mode}-s2`, scenario: scen("attack-next"), login: { folder } });
	} else if (mode === "two") {
		// The second member's scenario names this path (scen.py second ... /var/lib/c2-proof/run-first).
		const first = join(BASE, "run-first");
		mkdirSync(first, { mode: 0o700 });
		const firstRun = run({
			tag: "two-first",
			scenario: scen("end"),
			login: { token: token() },
			scratch: first,
			endAfterMs: 45_000,
		});
		await new Promise((resolve) => setTimeout(resolve, 8000));
		await run({
			tag: "two-second",
			scenario: `${P}/scen/second.json`,
			login: { token: token("FD2") },
		});
		await firstRun;
	}
	console.log("PROOF-END");
}

await main();
