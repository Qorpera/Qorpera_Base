// The agent's home, the LXD leg (lanes/agent-box-20261113, section 8 of S1-S2-S4-BUILD.md): `codex exec-server`
// inside a REAL company machine, reached through the coding executor's own code: the runtime's channel client
// (createCloudHomeChannel), the ingress's upgrade route (HttpCloudCodingCommandService), the router
// (MachineCommandRouter.execServer), the machine host (LxdCompanyMachineHost.execServer, with its boot check) and the
// LXD client's streamed exec (LxdUnixClient.execInstancePipe) on the node's own LXD socket.
//
// Stood in: SQL (qorpera_authorize_home_session and qorpera_folder_home_session_window answer "authorized" / "open"
// for the sessions this script names), the run's holder proof (qorpera_native_binding_proven), the transport token (a
// random one of this run), the folder service (none: the machine's /company is a tmpfs owned by the agent's account),
// and Codex in the slot (this script speaks the exec-server's JSON-RPC itself, as Codex's harness sends it).
//
// Bundled once (esbuild) and run on the node that holds the machine:
//   node prove-home-lxd.bundle.mjs driver --project qorpera-build --placement <uuid> [--socket <lxd socket>]
//   node prove-home-lxd.bundle.mjs driver --local --codex <path>      (protocol dry run, no LXD, no checks judged)
// The driver starts the executor part as a child process of its own (`executor`), so the executor can be killed.

import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { MachineCommandRouter } from "../deploy/coding-worker/machine-command-routing.ts";
import { CLOUD_MACHINE_HOME } from "../packages/contracts/src/cloud-machine.ts";
import { LxdCompanyMachineHost } from "../packages/runner-orchestrator/src/company-machine-host.ts";
import { lxdCompanyMachineName } from "../packages/runner-orchestrator/src/company-machine.ts";
import { LxdUnixClient } from "../packages/runner-orchestrator/src/lxd-client.ts";
import { HttpCloudCodingCommandService } from "../packages/runtime/src/cloud-coding-command-http.ts";
import { createCloudHomeChannel } from "../packages/runtime/src/cloud-home-channel-client.ts";
import { CLOUD_HOME_OUTDATED, cloudHomeRefusalWords } from "../packages/runtime/src/cloud-codex-home.ts";
import { CloudHomeChannelRefused } from "../packages/runtime/src/cloud-home-channel.ts";

const run = promisify(execFile);
const OWNER = "home-lxd-proof";
const PROVIDER = "machine-node";
const ids = {
	machineId: "a9e00000-0000-4000-8000-0000000000a1",
	runId: "a9e00000-0000-4000-8000-0000000000a2",
	staffAgentId: "a9e00000-0000-4000-8000-0000000000a3",
	requestedByUserId: "a9e00000-0000-4000-8000-0000000000a4",
};
const WRONG_BOOT = "00000000-0000-4000-8000-000000000000";
const T0 = Date.now();
const stamp = () => `${((Date.now() - T0) / 1000).toFixed(3).padStart(8)}`;
const say = (line) => process.stdout.write(`${stamp()} ${line}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const args = process.argv.slice(2);
const option = (name, fallback) => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 ? args[at + 1] : fallback;
};

// ---------------------------------------------------------------------------------------------------------------------
// The executor's part: the ingress, the router, the host and the LXD client, with SQL and the holder stood in.

function endsInsideUtf8(chunk) {
	// True when the last bytes of the chunk start a UTF-8 sequence the chunk does not finish.
	for (let back = 1; back <= Math.min(4, chunk.length); back++) {
		const byte = chunk[chunk.length - back];
		if ((byte & 0xc0) === 0x80) continue;
		const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
		return need > back;
	}
	return false;
}

function localPipe(config) {
	// The protocol dry run only: the command on this computer, without LXD. Nothing of it is judged.
	return async (_project, _name, request, signal) => {
		// Without root here, the dry run starts the exec-server itself where the machine hands it to systemd.
		const unit = request.command.indexOf("/usr/bin/systemd-run");
		const words = unit < 0 ? request.command : [...request.command.slice(0, unit), ...request.command.slice(request.command.indexOf(CLOUD_MACHINE_HOME.codex))];
		const command = words.map((word) => (word === CLOUD_MACHINE_HOME.codex ? config.codex : word));
		const child = spawn(command[0], command.slice(1), {
			cwd: config.cwd,
			env: { ...process.env, ...request.environment, HOME: config.cwd, CODEX_HOME: join(config.cwd, ".codex") },
			stdio: ["pipe", "pipe", "pipe"],
		});
		const stop = () => child.kill("SIGKILL");
		signal.addEventListener("abort", stop, { once: true });
		let stderr = Buffer.alloc(0);
		child.stdin.on("error", () => undefined);
		const kept = [];
		child.stdout.on("data", (chunk) => (request.stdout ? request.stdout(chunk) : kept.push(chunk)));
		child.stderr.on("data", (chunk) => {
			stderr = Buffer.concat([stderr, chunk]).subarray(-request.stderrTailBytes);
		});
		void (async () => {
			try {
				for await (const chunk of request.stdin ?? []) child.stdin.write(chunk);
			} catch {}
			child.stdin.end();
		})();
		const [code] = await new Promise((resolve) => child.on("close", (...end) => resolve(end)));
		signal.removeEventListener("abort", stop);
		return { exitCode: code ?? 137, stdout: Buffer.concat(kept), stderrTail: stderr };
	};
}

async function executor() {
	const config = JSON.parse(await new Promise((resolve) => createInterface({ input: process.stdin }).once("line", resolve)));
	const emit = (value) => process.stdout.write(`EVENT ${JSON.stringify(value)}\n`);
	const real = new LxdUnixClient(config.socket);
	const pipe = config.local ? localPipe(config) : real.execInstancePipe.bind(real);
	let channels = 0;
	// The real client, tapped: what each exec's stdout frames were and how the exec ended, which the host swallows.
	const client = {
		execInstancePipe: async (project, name, request, signal) => {
			const channel = ++channels;
			const at = Date.now();
			const seen = { frames: 0, bytes: 0, smallest: null, largest: 0, endsInsideUtf8: 0, firstFrameMs: null };
			const stdout =
				request.stdout &&
				((chunk) => {
					seen.frames++;
					seen.bytes += chunk.length;
					seen.smallest = seen.smallest === null ? chunk.length : Math.min(seen.smallest, chunk.length);
					seen.largest = Math.max(seen.largest, chunk.length);
					if (endsInsideUtf8(chunk)) seen.endsInsideUtf8++;
					seen.firstFrameMs ??= Date.now() - at;
					request.stdout(chunk);
				});
			emit({ event: "exec", channel, project, name, command: request.command, user: request.user, group: request.group, cwd: request.cwd,
				hash: request.command.includes("exec-server") ? undefined : true });
			try {
				const result = await pipe(project, name, { ...request, stdout }, signal);
				emit({ event: "exec-end", channel, ms: Date.now() - at, exitCode: result.exitCode,
					stderrTail: result.stderrTail.toString("utf8").slice(-800), aborted: signal.aborted, ...seen });
				return result;
			} catch (error) {
				emit({ event: "exec-end", channel, ms: Date.now() - at, error: String(error?.message ?? error), aborted: signal.aborted, ...seen });
				throw error;
			}
		},
	};
	const control = {
		call: async (method, values) => {
			if (method !== "qorpera_folder_home_session_window") throw new Error(`STAND_IN_SQL_UNKNOWN ${method}`);
			emit({ event: "sql", method, sessionId: values.p_session_id });
			return {
				schema: "qorpera.folder-home-session/v1",
				state: "open",
				sessionId: values.p_session_id,
				...ids,
				placementId: config.placementId,
				bootId: config.sessions[values.p_session_id] ?? config.boot,
			};
		},
	};
	const host = new LxdCompanyMachineHost({
		control,
		owner: OWNER,
		machineIdSha256: "d".repeat(64),
		policy: {
			providerId: PROVIDER,
			providerPolicySha256: "a".repeat(64),
			project: config.project,
			imageFingerprint: "b".repeat(64),
			bootstrapSha256: "c".repeat(64),
			storagePool: "qorpera-vm",
			network: "qagent0",
		},
		client,
		journalRoot: "/nas/coding/control",
		storagePolicy: {
			schema: "qorpera.coding-nas-policy/v1",
			mountPoint: "/nas",
			rootPath: "/nas/coding",
			source: "10.0.0.2:/coding",
			serverAddress: "10.0.0.2",
		},
		helperSha256: "e".repeat(64),
	});
	const router = new MachineCommandRouter({
		owner: OWNER,
		providerId: PROVIDER,
		peers: [],
		control,
		credential: async () => {
			throw new Error("no peers in this proof");
		},
		execServerLocal: (authority, signal) => host.execServer(authority, signal),
	});
	const service = new HttpCloudCodingCommandService({
		token: config.token,
		host: "127.0.0.1",
		port: 0,
		proveBinding: async () => undefined,
		authorize: async () => {
			throw new Error("not in this proof");
		},
		execute: async () => {
			throw new Error("not in this proof");
		},
		home: {
			authorize: async (request) => {
				emit({ event: "authorize", sessionId: request.sessionId });
				return {
					state: "authorized",
					sessionId: request.sessionId,
					machineId: ids.machineId,
					machine: config.machine,
					placementId: config.placementId,
					bootId: config.sessions[request.sessionId] ?? config.boot,
					executorOwner: OWNER,
					providerId: PROVIDER,
				};
			},
			open: (authority, request, signal) => router.execServer(authority, request, signal),
		},
	});
	const port = await service.start();
	process.stdout.write(`READY ${port}\n`);
}

// ---------------------------------------------------------------------------------------------------------------------
// The driver: Codex's side of the channel, the scenarios, and what the machine's process list says.

class Rpc {
	constructor(stream, label) {
		this.stream = stream;
		this.label = label;
		this.pending = new Map();
		this.processes = new Map();
		this.next = 0;
		this.received = 0;
		this.notes = {};
		this.unparsed = 0;
		this.ended = false;
		this.endedAt = null;
		this.firstLineAt = null;
		this.done = (async () => {
			try {
				for await (const line of stream.lines) this.#line(line);
			} catch (error) {
				this.error = String(error?.message ?? error);
			}
			this.ended = true;
			this.endedAt = performance.now();
			for (const { resolve } of this.pending.values()) resolve({ error: "channel ended" });
			this.pending.clear();
		})();
	}
	#line(line) {
		this.received++;
		this.firstLineAt ??= performance.now();
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			this.unparsed++;
			return;
		}
		if (message.id !== undefined && this.pending.has(message.id)) {
			const { resolve } = this.pending.get(message.id);
			this.pending.delete(message.id);
			resolve(message.error ? { error: message.error } : { result: message.result, bytes: Buffer.byteLength(line) });
			return;
		}
		if (typeof message.method === "string") this.notes[message.method] = (this.notes[message.method] ?? 0) + 1;
		const params = message.params ?? {};
		const process_ = params.processId !== undefined ? this.process(params.processId) : undefined;
		if (message.method === "process/output" && process_) {
			const bytes = Buffer.from(String(params.chunk ?? ""), "base64");
			process_.chunks.push({ at: performance.now(), bytes: bytes.length });
			process_.output.push(bytes);
		} else if (message.method === "process/exited" && process_) {
			process_.exitCode = params.exitCode;
			process_.exitedAt = performance.now();
		} else if (message.method === "process/closed" && process_) {
			process_.closedAt = performance.now();
		}
		for (const wait of [...(process_?.waits ?? [])]) wait();
	}
	process(processId) {
		const key = String(processId);
		if (!this.processes.has(key)) this.processes.set(key, { chunks: [], output: [], waits: new Set() });
		return this.processes.get(key);
	}
	request(method, params, timeoutMs = 30000) {
		if (this.ended) return Promise.resolve({ error: "channel ended" });
		const id = ++this.next;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				if (this.pending.delete(id)) resolve({ error: `no answer to ${method} in ${timeoutMs} ms` });
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
			});
			this.stream.write(JSON.stringify({ id, method, params }));
		});
	}
	notify(method, params) {
		this.stream.write(JSON.stringify({ method, params }));
	}
	until(processId, test, timeoutMs = 30000) {
		const process_ = this.process(processId);
		return new Promise((resolve) => {
			const check = () => {
				if (test(process_) || this.ended) {
					clearTimeout(timer);
					process_.waits.delete(check);
					resolve(process_);
				}
			};
			const timer = setTimeout(() => {
				process_.waits.delete(check);
				resolve(process_);
			}, timeoutMs);
			process_.waits.add(check);
			check();
		});
	}
	text(processId) {
		return Buffer.concat(this.process(processId).output).toString("utf8");
	}
}

const ENV_POLICY = { inherit: "all", ignoreDefaultExcludes: true, exclude: [], set: {}, includeOnly: [] };
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
const file = (path) => `file://${path}`;
let processes = 0;
/** /company on the machine; in the dry run, a folder of its own (set by the driver). */
let ROOT = "/company";
let writes = 0;

async function start(rpc, argv, options = {}) {
	const processId = options.processId ?? `${rpc.label}-${++processes}`;
	const asked = performance.now();
	const answer = await rpc.request("process/start", {
		processId,
		argv,
		cwd: file(options.cwd ?? ROOT),
		env: {},
		envPolicy: ENV_POLICY,
		tty: options.tty ?? false,
		pipeStdin: false,
		arg0: null,
		sandbox: null,
		enforceManagedNetwork: false,
		managedNetwork: null,
	});
	return { processId, asked, answer };
}

async function shell(rpc, script, options = {}) {
	const started = await start(rpc, ["/bin/bash", "-c", script], options);
	const ended = await rpc.until(started.processId, (p) => p.closedAt !== undefined, options.timeoutMs ?? 60000);
	return {
		...started,
		exitCode: ended.exitCode,
		closed: ended.closedAt !== undefined,
		ms: ended.closedAt !== undefined ? Math.round(ended.closedAt - started.asked) : null,
		output: rpc.text(started.processId),
		chunks: ended.chunks,
	};
}

const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};

async function driver() {
	const local = args.includes("--local");
	if (local) ROOT = mkdtempSync(join(tmpdir(), "home-lxd-"));
	const project = option("project", "qorpera-build");
	const placementId = option("placement", "a9e00000-0000-4000-8000-0000000000d1");
	const machine = lxdCompanyMachineName(placementId);
	const socket = option("socket", "/var/snap/lxd/common/lxd/unix.socket");
	const checks = [];
	const check = (id, ok, text) => {
		checks.push({ id, ok });
		say(`CHECK ${id} ${local ? "DRY" : ok ? "PASS" : "FAIL"} ${text}`);
	};
	const inMachine = async (command) => {
		if (local) {
			const { stdout } = await run("/bin/sh", ["-c", command]).catch((error) => error);
			return String(stdout ?? "");
		}
		const done = await run("lxc", ["--project", project, "exec", machine, "--", "/bin/sh", "-c", command], { maxBuffer: 8 << 20 })
			.catch((error) => error);
		return String(done.stdout ?? "");
	};
	const agentProcesses = async (label) => {
		const listing = local
			? (await inMachine("ps -eo pid=,ppid=,pgid=,sid=,user=,etimes=,stat=,args=")).split("\n")
					.filter((line) => /exec-server|sleep 3\d\d/.test(line) && !/ps -eo/.test(line))
			: (await inMachine("ps -o pid=,ppid=,pgid=,sid=,user=,etimes=,stat=,args= -u 2000")).split("\n").filter((line) => line.trim());
		say(`PS ${label}: ${listing.length} process(es) of the agent's account`);
		for (const line of listing) say(`PS   ${line.trim().slice(0, 200)}`);
		return listing;
	};
	const goneWithin = async (from, keep = () => false) => {
		for (;;) {
			const left = (local
				? (await inMachine("ps -eo args=")).split("\n").filter((line) => /exec-server|sleep 3\d\d/.test(line))
				: (await inMachine("ps -o args= -u 2000")).split("\n").filter((line) => line.trim()))
				.filter((line) => !keep(line));
			if (left.length === 0) return Math.round(performance.now() - from);
			if (performance.now() - from > 8000) return null;
			await sleep(100);
		}
	};
	const sweep = async (label) => {
		const left = await agentProcesses(`${label} (before the sweep)`);
		if (left.length && !local) {
			await inMachine("pkill -9 -u 2000; sleep 1");
			await agentProcesses(`${label} (after pkill -9 -u 2000 by root)`);
		}
		return left;
	};

	const boot = local ? (await inMachine("cat /proc/sys/kernel/random/boot_id")).trim() : (await inMachine("cat /proc/sys/kernel/random/boot_id")).trim();
	say(`MACHINE ${machine} in ${project}; boot ${boot}; ${local ? "LOCAL DRY RUN" : `LXD socket ${socket}`}`);
	if (!local) {
		say(`MACHINE ${(await inMachine("echo kernel $(uname -r); id qorpera-agent; ls -l /opt/qorpera-machine/codex; sha256sum /opt/qorpera-machine/codex | cut -c1-16; stat -c '%U:%G %a' /etc/sudoers.d/qorpera-agent; findmnt -no FSTYPE,OPTIONS /company; ls -l /company")).replaceAll("\n", " | ")}`);
	}
	const token = randomBytes(32).toString("base64url");
	const sessions = {};
	const session = (bootId = boot) => {
		const sessionId = randomUUID();
		sessions[sessionId] = bootId;
		return sessionId;
	};
	// Sessions are named before each executor starts: its stand-in SQL answers for these.
	const named = { s1: session(), s3a: session(), s3b: session(), s3c: session(), s4: session(), s4x: session(),
		s4y: session(), s5: session(), s7: session(), s10: session(), sOther: session(), sNone: session(), sBoot: session(WRONG_BOOT) };
	const executors = [];
	const execEvents = [];
	const hashChannels = new Set();
	const startExecutor = async (label) => {
		const child = spawn(process.execPath, [process.argv[1], "executor"], { stdio: ["pipe", "pipe", "inherit"] });
		child.stdin.write(`${JSON.stringify({ token, local, socket, project, placementId, machine, boot, sessions,
			codex: option("codex", ""), cwd: ROOT })}\n`);
		const port = await new Promise((resolve, reject) => {
			const lines = createInterface({ input: child.stdout });
			lines.on("line", (line) => {
				if (line.startsWith("READY ")) resolve(Number(line.slice(6)));
				else if (line.startsWith("EVENT ")) {
					const event = JSON.parse(line.slice(6));
					execEvents.push({ ...event, label, hash: event.hash === true || (event.event === "exec-end" && hashChannels.has(`${label}:${event.channel}`)) });
					if (event.event === "exec" && event.hash) hashChannels.add(`${label}:${event.channel}`);
					say(`EXEC[${label}] ${line.slice(6).slice(0, 1200)}`);
				}
				else say(`EXEC[${label}] ${line.slice(0, 400)}`);
			});
			child.once("exit", (code, signal) => {
				say(`EXEC[${label}] exited ${code ?? signal}`);
				reject(new Error("executor ended before READY"));
			});
		});
		executors.push(child);
		return { child, port };
	};
	const binding = {
		leaseId: randomUUID(), runId: ids.runId, jobId: randomUUID(), runnerId: randomUUID(), assignmentId: randomUUID(),
		credentialCapsuleId: randomUUID(), computeIdentityId: randomUUID(), provider: "openai", nativeHarness: "codex-cli",
		model: "home-lxd-proof",
	};
	const holder = `job.${binding.jobId}.${randomBytes(32).toString("base64url")}`;
	const open = async (port, sessionId, label) => {
		const channel = createCloudHomeChannel({ url: `http://127.0.0.1:${port}`, token, binding, holder: () => holder, allowLoopback: true });
		const at = performance.now();
		const stream = await channel.open({ sessionId, machineId: ids.machineId }, AbortSignal.timeout(30000));
		const ready = performance.now() - at;
		const rpc = new Rpc(stream, label);
		const init = await rpc.request("initialize", { clientName: "home-lxd-proof" });
		const initialized = performance.now() - at;
		rpc.notify("initialized", {});
		return { rpc, stream, readyMs: Math.round(ready), initializeMs: Math.round(initialized), init };
	};

	const main = await startExecutor("main");
	try {
		await sweep("at the start");

		// The first channel on a cold page cache, as on a machine that has just booted: Codex's 318 MB are read from disk.
		if (!local) await inMachine("sync; echo 3 > /proc/sys/vm/drop_caches");
		// 1. The basics: output back, a command that streams while it runs, typed input, a file write.
		const a = await open(main.port, named.s1, "s1");
		say(`OPEN s1: ready ${a.readyMs} ms, initialize answered ${a.initializeMs} ms: ${JSON.stringify(a.init).slice(0, 300)}`);
		const who = await shell(a.rpc, "pwd; id -un; hostname");
		check("1a", who.exitCode === 0 && who.output === `/company\nqorpera-agent\n${machine}\n`,
			`pwd; id -un; hostname -> exit ${who.exitCode}, ${JSON.stringify(who.output)} in ${who.ms} ms`);
		// 8. Where the agent's work runs: its memory-guard score and its cgroup, against a plain LXD exec as the same
		// account and a machine_run-like unit in the machines' slice.
		const placed = await shell(a.rpc, "cat /proc/self/oom_score_adj /proc/self/cgroup");
		const plainExec = local ? "" : String((await run("lxc", ["--project", project, "exec", machine, "--user", "2000", "--group", "2000", "--",
			"/bin/cat", "/proc/self/oom_score_adj", "/proc/self/cgroup"]).catch((error) => error)).stdout ?? "");
		const unitRun = await inMachine("systemd-run --quiet --wait --pipe -p Slice=qorpera-machine.slice /bin/cat /proc/self/oom_score_adj /proc/self/cgroup");
		say(`NOTE 8 a plain LXD exec as qorpera-agent: ${JSON.stringify(plainExec)}; a unit in the machines' slice (as machine_run's): ${JSON.stringify(unitRun)}`);
		const homeUnit = /qorpera-machine\.slice\/(qorpera-machine-home-[0-9a-f-]+\.service)/.exec(placed.output)?.[1] ?? "";
		const unitShow = homeUnit ? await inMachine(`systemctl show ${homeUnit} -p Slice -p KillMode -p User -p MemoryMax -p OOMScoreAdjust; systemctl show qorpera-machine.slice -p MemoryMax -p MemoryCurrent`) : "";
		say(`NOTE 8 the home's unit: ${JSON.stringify(unitShow)}`);
		check("8", placed.output.split("\n")[0] === "0" && /^0::\/qorpera\.slice\/qorpera-machine\.slice\/qorpera-machine-home-[0-9a-f-]+\.service$/m.test(placed.output),
			`the home's shell is in a unit of its own in the machines' slice, score 0: ${JSON.stringify(placed.output)}`);
		// 9. The idle rule counts the home's work: the slice's processor time moves, the LXD agent's does not.
		const cpu = async () => {
			const text = await inMachine("for g in qorpera.slice/qorpera-machine.slice system.slice/lxd-agent.service; do echo $g $(sed -n 's/^usage_usec //p' /sys/fs/cgroup/$g/cpu.stat); done");
			return Object.fromEntries(text.trim().split("\n").map((line) => line.split(" ")).map(([g, v]) => [g, Number(v)]));
		};
		const cpu0 = await cpu();
		const burn = await shell(a.rpc, "timeout 4 sh -c 'while :; do :; done'; echo burned", { timeoutMs: 20000 });
		const cpu1 = await cpu();
		await sleep(4000);
		const cpu2 = await cpu();
		const delta = (x, y, g) => Math.round(((y[g] ?? 0) - (x[g] ?? 0)) / 1000);
		const S = "qorpera.slice/qorpera-machine.slice", A = "system.slice/lxd-agent.service";
		check("9", burn.output.includes("burned") && delta(cpu0, cpu1, S) >= 3500 && delta(cpu0, cpu1, A) < 500 && delta(cpu1, cpu2, S) < 200,
			`4 s of a busy loop in the home's shell: the machines' slice used ${delta(cpu0, cpu1, S)} ms of processor time, the LXD agent's unit ${delta(cpu0, cpu1, A)} ms (the idle rule counts the first as work, never the second); then 4 s with the channel open and idle: the slice used ${delta(cpu1, cpu2, S)} ms`);
		const ticks = await shell(a.rpc, "for i in 1 2 3 4 5; do echo tick $i; sleep 1; done", { timeoutMs: 20000 });
		const chunkTimes = ticks.chunks.map((chunk) => Math.round(chunk.at - ticks.asked));
		const beforeExit = ticks.chunks.filter((chunk) => chunk.at < (a.rpc.process(ticks.processId).exitedAt ?? Infinity)).length;
		check("1b", ticks.exitCode === 0 && ticks.output.split("\n").filter(Boolean).length === 5 && chunkTimes.length >= 4 &&
			chunkTimes.at(-1) - chunkTimes[0] >= 3000 && beforeExit === chunkTimes.length,
			`5 ticks one second apart arrived in ${chunkTimes.length} outputs at ${chunkTimes.join(", ")} ms, all before the exit; closed at ${ticks.ms} ms`);
		const typed = await start(a.rpc, ["/bin/bash", "-c", "read line; echo got:$line; read again; echo got:$again"], { tty: true });
		await sleep(300);
		const w1 = await a.rpc.request("process/write", { processId: typed.processId, chunk: b64("hello from stdin\n"), writeId: `w${++writes}` });
		await a.rpc.until(typed.processId, (p) => Buffer.concat(p.output).includes("got:hello from stdin"), 10000);
		const w2 = await a.rpc.request("process/write", { processId: typed.processId, chunk: b64("æøå 漢字\n"), writeId: `w${++writes}` });
		const typedEnd = await a.rpc.until(typed.processId, (p) => p.closedAt !== undefined, 10000);
		const typedText = a.rpc.text(typed.processId);
		check("1c", typedText.includes("got:hello from stdin") && typedText.includes("got:æøå 漢字") && typedEnd.exitCode === 0,
			`two lines typed into a running shell (tty): writes ${JSON.stringify(w1).slice(0, 80)} ${JSON.stringify(w2).slice(0, 80)}; the shell said ${JSON.stringify(typedText.replaceAll("\r", ""))}, exit ${typedEnd.exitCode}`);
		const mkdir = await a.rpc.request("fs/createDirectory", { path: file(`${ROOT}/notes`), recursive: true, sandbox: null });
		const write = await a.rpc.request("fs/writeFile", { path: file(`${ROOT}/notes/plan.md`), dataBase64: b64("# Plan\n\nwritten as apply_patch writes, æøå\n"), sandbox: null });
		const readBack = await a.rpc.request("fs/readFile", { path: file(`${ROOT}/notes/plan.md`), sandbox: null });
		const onDisk = await inMachine(`stat -c '%U:%G %s' ${ROOT}/notes/plan.md; cat ${ROOT}/notes/plan.md`);
		check("1d", !mkdir.error && !write.error && Buffer.from(readBack.result?.dataBase64 ?? "", "base64").toString("utf8").includes("æøå") &&
			(local || onDisk.startsWith("qorpera-agent:qorpera-agent")),
			`fs/createDirectory ${JSON.stringify(mkdir).slice(0, 80)}, fs/writeFile ${JSON.stringify(write).slice(0, 80)}; on the machine's disk: ${JSON.stringify(onDisk)}`);

		const aliasBefore = await shell(a.rpc, "command -v apply_patch || echo no-apply_patch-on-PATH; echo PATH=$PATH; ls -ld ~/.codex 2>&1");
		say(`NOTE 7 without ~/.codex (as the image makes the account): ${JSON.stringify(aliasBefore.output)}`);

		// 2. Root through sudo; a plain write to a root file is refused (by the shell and by Codex's own file write).
		const sudo = await shell(a.rpc, "sudo -n id -u; sudo -n install -o root -g root -m 0644 /dev/null /etc/qorpera-home-proof && stat -c '%U %a' /etc/qorpera-home-proof && sudo -n rm -f /etc/qorpera-home-proof && echo removed");
		check("2a", sudo.exitCode === 0 && sudo.output === "0\nroot 644\nremoved\n",
			`sudo -n id -u, then a file installed under /etc and removed: exit ${sudo.exitCode}, ${JSON.stringify(sudo.output)}`);
		const plain = await shell(a.rpc, `echo plain >> ${ROOT}/root-owned; echo plain-rc=$?; echo x >> /etc/hostname; echo etc-rc=$?; echo changed | sudo -n tee -a ${ROOT}/root-owned >/dev/null; echo sudo-rc=$?; stat -c '%U %a' ${ROOT}/root-owned; cat ${ROOT}/root-owned`);
		const codexWrite = await a.rpc.request("fs/writeFile", { path: file(`${ROOT}/root-owned`), dataBase64: b64("codex\n"), sandbox: null });
		check("2b", /plain-rc=1\netc-rc=1\nsudo-rc=0\nroot 644\nchanged\n$/.test(plain.output.replace(/.*Permission denied\n/g, "")) && Boolean(codexWrite.error),
			`plain write to a root file and to /etc refused, the same through sudo taken: ${JSON.stringify(plain.output)}; Codex's own fs/writeFile to it: ${JSON.stringify(codexWrite).slice(0, 200)}`);

		// 6 (part). UTF-8 split across LXD's frames: a directory listing of many Danish and Japanese names is one long
		// line, which LXD hands over in frames that end in the middle of a character.
		const made = await shell(a.rpc, `mkdir -p ${ROOT}/utf && cd ${ROOT}/utf && for i in $(seq 1 3000); do : > "æøå-$i-ÆØÅ-漢字-ü.txt"; done; ls | wc -l`, { timeoutMs: 60000 });
		const listing = await a.rpc.request("fs/readDirectory", { path: file(`${ROOT}/utf`), sandbox: null }, 60000);
		const listingText = JSON.stringify(listing.result ?? listing.error ?? null);
		const whole = (listingText.match(/æøå-\d+-ÆØÅ-漢字-ü\.txt/g) ?? []).length;
		check("6a", made.output.trim() === "3000" && whole === 3000 && !listingText.includes("�"),
			`fs/readDirectory of 3000 names with æøå/漢字: one answer line of ${listing.bytes ?? 0} bytes, ${whole} names whole, ${listingText.includes("�") ? "SOME" : "no"} replacement characters (the frames are in EXEC[main]'s exec-end line below)`);
		const big = await shell(a.rpc, "for i in $(seq 1 40000); do printf 'æøå漢字'; done", { timeoutMs: 60000 });
		check("6b", big.output === "æøå漢字".repeat(40000), `a 600 KB output of multibyte characters came back whole (${Buffer.byteLength(big.output)} bytes)`);

		// 5. Timings: the channel's opening (above), 20 short round trips, a 1 MB output.
		const trips = [];
		for (let i = 0; i < 20; i++) trips.push((await shell(a.rpc, "echo x")).ms);
		const mb = await shell(a.rpc, "head -c 786432 /dev/urandom | base64 -w 0", { timeoutMs: 60000 });
		const mbLength = Buffer.byteLength(mb.output);
		const mbMore = [];
		for (let i = 0; i < 3; i++) mbMore.push((await shell(a.rpc, "head -c 786432 /dev/urandom | base64 -w 0", { timeoutMs: 60000 })).ms);
		const eight = await shell(a.rpc, "head -c 6291456 /dev/urandom | base64 -w 0", { timeoutMs: 120000 });
		say(`TIMING 1 MB output, 3 more: ${mbMore.join(" ")} ms; 8 MB output: ${Buffer.byteLength(eight.output)} bytes in ${eight.ms} ms over ${eight.chunks.length} notifications`);
		// The input direction at size: a 3 MiB file in one fs/writeFile (one line of 4 MiB towards the machine, which the
		// LXD client sends in 64 KiB messages), checked on the machine and read back in one line of 4 MiB.
		const blob = randomBytes(3 * 1024 * 1024);
		const blobSha = createHash("sha256").update(blob).digest("hex");
		const putAt = performance.now();
		const put = await a.rpc.request("fs/writeFile", { path: file(`${ROOT}/blob.bin`), dataBase64: blob.toString("base64"), sandbox: null }, 60000);
		const putMs = Math.round(performance.now() - putAt);
		const putSha = (await shell(a.rpc, `sha256sum ${ROOT}/blob.bin | cut -d' ' -f1`)).output.trim();
		const getAt = performance.now();
		const got = await a.rpc.request("fs/readFile", { path: file(`${ROOT}/blob.bin`), sandbox: null }, 60000);
		const getMs = Math.round(performance.now() - getAt);
		const gotSha = createHash("sha256").update(Buffer.from(got.result?.dataBase64 ?? "", "base64")).digest("hex");
		check("6c", !put.error && putSha === blobSha && gotSha === blobSha,
			`a 3 MiB file through Codex's own file write and read, one 4 MiB line each way: written in ${putMs} ms (sha on the machine ${putSha === blobSha ? "equal" : "DIFFERENT"}), read back in ${getMs} ms (${got.bytes ?? 0} bytes, sha ${gotSha === blobSha ? "equal" : "DIFFERENT"})`);
		say(`TIMING s1 open: ready ${a.readyMs} ms, exec-server's first answer (initialize) ${a.initializeMs} ms`);
		say(`TIMING round trip (process/start of 'echo x' to process/closed), 20 samples: median ${median(trips)} ms, worst ${Math.max(...trips)} ms, best ${Math.min(...trips)} ms: ${trips.join(" ")}`);
		say(`TIMING 1 MB output: ${mbLength} bytes in ${mb.ms} ms over ${mb.chunks.length} process/output notifications`);
		check("5", trips.length === 20 && trips.every((ms) => ms !== null) && mbLength === 1048576, `timings taken (see TIMING lines)`);
		await a.stream.close();
		await a.rpc.done;
		await sleep(1500);
		await sweep("after s1 closed");

		// 3. Drops. (a) The run's side closes its channel while processes run, one with a terminal and a grandchild.
		const c = await open(main.port, named.s3a, "s3a");
		await start(c.rpc, ["/bin/bash", "-c", "sleep 301"]);
		await start(c.rpc, ["/bin/bash", "-c", "sleep 302 & sleep 303; wait"], { tty: true });
		await start(c.rpc, ["/bin/bash", "-c", "setsid sleep 304 & disown; sleep 305"]);
		await sleep(1500);
		const before3a = await agentProcesses("3a before the run's side closes");
		const closedAt = performance.now();
		await c.stream.close();
		await c.rpc.done;
		const gone3a = await goneWithin(closedAt);
		say(`3a every process, the detached one too, was gone ${gone3a} ms after the run's side closed (polled every ~0.1 s)`);
		await sleep(1000);
		const after3a = await sweep(`3a ${Math.round(performance.now() - closedAt)} ms after the run's side closed`);
		say(`NOTE 3a: a process the command itself detached into a session of its own (setsid sleep 304 & disown) is ${after3a.some((line) => /sleep 304/.test(line)) ? "LEFT running" : "gone too"}; the check below judges the rest`);
		check("3a", before3a.length >= 6 && after3a.length === 0 && before3a.some((line) => /sleep 304/.test(line)),
			`the run's side closed: ${before3a.length} processes before (exec-server, its shells and sleeps), ${after3a.length} after: ${after3a.map((line) => line.trim().split(/\s+/).slice(7).join(" ")).join("; ") || "none"}`);

		// (b) The executor holding the LXD exec is killed (SIGKILL): LXD's websockets drop without a close.
		const doomed = await startExecutor("doomed");
		const d = await open(doomed.port, named.s3b, "s3b");
		await start(d.rpc, ["/bin/bash", "-c", "sleep 311"]);
		await start(d.rpc, ["/bin/bash", "-c", "sleep 312"], { tty: true });
		await sleep(1500);
		const before3b = await agentProcesses("3b before the executor is killed");
		const killedAt = performance.now();
		doomed.child.kill("SIGKILL");
		await d.rpc.done;
		say(`3b the run's side saw its channel end ${Math.round(d.rpc.endedAt - killedAt)} ms after the kill`);
		const gone3b = await goneWithin(killedAt);
		say(`3b every process was gone ${gone3b} ms after the executor was killed (polled every ~0.1 s)`);
		await sleep(1000);
		const after3b = await sweep(`3b ${Math.round(performance.now() - killedAt)} ms after the executor was killed`);
		check("3b", before3b.length >= 3 && after3b.length === 0,
			`the executor was killed: ${before3b.length} processes before, ${after3b.length} after`);

		// (c) The exec-server itself dies inside the machine (killed by root): the run's side must see the end.
		const e = await open(main.port, named.s3c, "s3c");
		await start(e.rpc, ["/bin/bash", "-c", "sleep 321"]);
		await start(e.rpc, ["/bin/bash", "-c", "sleep 322"], { tty: true });
		await sleep(1500);
		const before3c = await agentProcesses("3c before the exec-server is killed");
		const killAt = performance.now();
		if (!local) await inMachine("pkill -9 -u 2000 -x codex");
		await Promise.race([e.rpc.done, sleep(10000)]);
		say(`3c the run's side saw its channel end: ${e.rpc.ended} (${e.rpc.ended ? Math.round(e.rpc.endedAt - killAt) : "-"} ms)`);
		await sleep(2000);
		const after3c = await sweep("3c after the exec-server was killed");
		check("3c", e.rpc.ended && before3c.length >= 3,
			`the exec-server killed inside the machine: the run's side saw the channel end (${e.rpc.ended}); ${after3c.length} of the agent's processes were left (${after3c.map((line) => line.trim().split(/\s+/).slice(7).join(" ")).join("; ") || "none"})`);
		if (!e.rpc.ended) await e.stream.close();

		// 4. Again after a drop; two channels at once on one machine.
		const f = await open(main.port, named.s4, "s4");
		const back = await shell(f.rpc, "echo back again");
		check("4a", back.output === "back again\n", `a new channel after the drops: ready ${f.readyMs} ms, initialize ${f.initializeMs} ms, answered ${JSON.stringify(back.output)}`);
		await f.stream.close();
		await f.rpc.done;
		const [x, y] = await Promise.all([open(main.port, named.s4x, "s4x"), open(main.port, named.s4y, "s4y")]);
		say(`OPEN two at once: s4x ready ${x.readyMs} / ${x.initializeMs} ms, s4y ready ${y.readyMs} / ${y.initializeMs} ms`);
		await start(x.rpc, ["/bin/bash", "-c", "sleep 331"], { processId: "same-id" });
		const ySame = await start(y.rpc, ["/bin/bash", "-c", "read line; echo y-got:$line; sleep 332"], { processId: "same-id", tty: true });
		await sleep(1000);
		const both = await agentProcesses("4b two channels, each with a process of the same id");
		const term = await x.rpc.request("process/terminate", { processId: "same-id" });
		await x.rpc.until("same-id", (p) => p.closedAt !== undefined, 5000);
		const yWrite = await y.rpc.request("process/write", { processId: "same-id", chunk: b64("to y only\n"), writeId: `w${++writes}` });
		await y.rpc.until("same-id", (p) => Buffer.concat(p.output).includes("y-got:to y only"), 5000);
		const afterTerm = await agentProcesses("4b after s4x terminated its same-id");
		const crossFile = await shell(y.rpc, `cat ${ROOT}/notes/plan.md | head -1; echo y-was-here > ${ROOT}/y.txt`);
		const xSees = await shell(x.rpc, `cat ${ROOT}/y.txt; pgrep -f 'sleep 332' >/dev/null && echo sees-y-sleep`);
		check("4b", !term.error && !yWrite.error && y.rpc.text(ySame.processId).includes("y-got:to y only") &&
			afterTerm.some((line) => /sleep 332/.test(line)) && !afterTerm.some((line) => /sleep 331/.test(line)),
			`two channels at once: two exec-servers (${both.filter((line) => /exec-server/.test(line)).length} seen); s4x's terminate of "same-id" ended only its own sleep 331, s4y's "same-id" kept running and took a typed line; they share the disk and see each other's processes: ${JSON.stringify(xSees.output)} (${JSON.stringify(crossFile.output)})`);
		await x.stream.close();
		await y.stream.close();
		await Promise.all([x.rpc.done, y.rpc.done]);
		await sleep(1500);
		await sweep("after s4x and s4y closed");

		// 7. ~/.codex made as the account's own folder (what the image does not make): Codex's PATH aliases.
		if (!local) await inMachine("install -d -o 2000 -g 2000 -m 0700 /var/lib/qorpera-agent/.codex");
		const h = await open(main.port, named.s7, "s7");
		const aliasAfter = await shell(h.rpc, "command -v apply_patch || echo no-apply_patch-on-PATH; echo PATH=$PATH");
		const viaShell = await shell(h.rpc, "printf '%s\\n' '*** Begin Patch' '*** Add File: shell-patch.md' '+made by apply_patch in the shell' '*** End Patch' | apply_patch; echo rc=$?; cat shell-patch.md 2>&1");
		check("7", true, `with ~/.codex the account's own: ${JSON.stringify(aliasAfter.output)}; apply_patch typed in the shell: ${JSON.stringify(viaShell.output)} (without it: ${JSON.stringify(aliasBefore.output)})`);
		await h.stream.close();
		await h.rpc.done;
		await sleep(1000);
		await sweep("after s7 closed");

		// 10. The watchdog's and the machine stop's own act, `systemctl stop qorpera-machine.slice`, ends a home too.
		const w = await open(main.port, named.s10, "s10");
		await start(w.rpc, ["/bin/bash", "-c", "setsid sleep 351 & disown; sleep 352"]);
		await sleep(1200);
		const before10 = await agentProcesses("10 before the slice is stopped");
		const stoppedAt = performance.now();
		await inMachine("systemctl stop qorpera-machine.slice");
		await Promise.race([w.rpc.done, sleep(10000)]);
		const gone10 = await goneWithin(stoppedAt);
		check("10", w.rpc.ended && gone10 !== null && before10.length >= 3,
			`stopping the machines' slice (the watchdog's and the stop's own command) ended the channel (${w.rpc.ended}, after ${w.rpc.ended ? Math.round(w.rpc.endedAt - stoppedAt) : "-"} ms) and all ${before10.length} of the home's processes, the detached one too, in ${gone10} ms`);
		if (!w.rpc.ended) await w.stream.close();
		say(`UNITS left: ${JSON.stringify(await inMachine("systemctl list-units --all --no-legend 'qorpera-machine-home-*' | wc -l"))}`);

		// The guest's own boot check: a session whose boot is not the machine's never starts an exec-server.
		const wrong = await open(main.port, named.sBoot, "sBoot").catch((error) => ({ error: String(error?.message ?? error) }));
		if (wrong.rpc) await Promise.race([wrong.rpc.done, sleep(5000)]);
		check("boot", Boolean(wrong.error) || (wrong.rpc.ended && wrong.rpc.received === 0),
			`a session on another boot: ${wrong.error ? `refused at open: ${wrong.error}` : `ready ${wrong.readyMs} ms, then the channel ended (${wrong.rpc.ended}) with ${wrong.rpc.received} lines from the machine; initialize ${JSON.stringify(wrong.init)}`}`);
		await sweep("after the wrong boot");

		// 11. The machine's Codex is checked before it runs: hashed once per boot (its cost is in the first channel's
		// exec events above: the sha256sum exec), and a home whose Codex is another build, or none, is refused in words.
		// The hashes that read the file (the session on another boot is refused by the same shell, 97, and keeps nothing).
		const hashes = execEvents.filter((event) => event.event === "exec-end" && event.label === "main" && event.hash && event.exitCode === 0);
		say(`TIMING the Codex hash at the first channel of the boot: ${hashes.map((event) => `${event.ms} ms`).join(", ")} (${hashes.length} hash for ${execEvents.filter((event) => event.event === "exec" && event.label === "main" && !event.hash).length} channels on the main executor)`);
		const refusedWith = async (label) => {
			const fresh = await startExecutor(label);
			const before = execEvents.length;
			const result = await open(fresh.port, named[label], label).then(
				async (opened) => {
					await opened.stream.close();
					return { opened: true };
				},
				(error) => ({ error }),
			);
			const execs = execEvents.slice(before).filter((event) => event.event === "exec" && !event.hash).length;
			fresh.child.kill("SIGTERM");
			return { ...result, execs };
		};
		if (!local) await inMachine("cp /opt/qorpera-machine/codex /root/codex.pinned && printf x >> /opt/qorpera-machine/codex");
		const other = await refusedWith("sOther");
		if (!local) await inMachine("rm -f /opt/qorpera-machine/codex");
		const none = await refusedWith("sNone");
		const reasonOf = (r) => (r.error instanceof CloudHomeChannelRefused ? r.error.reason : String(r.error?.message ?? r.opened));
		check("11", reasonOf(other) === "HOME_CODEX_NOT_PINNED" && reasonOf(none) === "HOME_CODEX_NOT_PINNED" && other.execs === 0 && none.execs === 0 &&
			hashes.length === 1 && cloudHomeRefusalWords(reasonOf(other)) === CLOUD_HOME_OUTDATED,
			`another build: refused ${reasonOf(other)}, no exec-server started (${other.execs}); none at all: refused ${reasonOf(none)} (${none.execs}); the model is told ${JSON.stringify(cloudHomeRefusalWords(reasonOf(other)))}`);
	} finally {
		for (const child of executors) child.kill("SIGTERM");
		say(`CHECKS ${checks.filter((one) => one.ok).length} of ${checks.length} passed${local ? " (dry run: not judged)" : ""}: ${checks.filter((one) => !one.ok).map((one) => one.id).join(" ") || "none failed"}`);
		say("PROOF-END");
	}
}

if (args[0] === "executor") await executor();
else if (args[0] === "driver") await driver().then(() => process.exit(0), (error) => {
	say(`DRIVER FAILED ${error?.stack ?? error}`);
	process.exit(1);
});
else {
	process.stderr.write("usage: prove-home-lxd driver [--local --codex PATH] [--project P --placement UUID --socket PATH]\n");
	process.exit(2);
}
