// Claude Code on the agent's home, slice C1 (lanes/agent-box-20261113/CLAUDE-HOME-BUILD.md): the file channel. A real
// OpenSSH `sftp-server` inside a real machine (an LXD VM), reached through the coding executor's own code: the
// runtime's channel client (createCloudHomeChannel, kind "sftp"), the ingress's upgrade route
// (HttpCloudCodingCommandService), the router (MachineCommandRouter.execServer), the machine host
// (LxdCompanyMachineHost.execServer: its sftp-server check, its boot check, its unit) and the LXD client's streamed
// exec (LxdUnixClient.execInstancePipe); a real sshfs (passive mode) on this side, mounted over the channel.
//
// Stood in: SQL (qorpera_authorize_home_session and qorpera_folder_home_session_window answer "authorized" / "open"
// for the sessions this script names), the run's holder proof, the transport token (a random one of this run), the
// folder service (none: the machine's /company is a plain folder owned by the agent's account) and so the folder's
// release: where a run measures the gate, the executor part puts the host's own HomeOutputGate (the class and spacing
// the host uses) in front of the channel's output, with a release that answers after `releaseMs`.
//
// Bundled (esbuild) and run as root on the test machine, in a mount namespace of its own:
//   unshare -m --propagation private node prove-home-sftp.bundle.mjs driver --project default --placement <uuid>
//     --sshfs <path to sshfs> [--socket <lxd socket>] [--only bench]

import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { MachineCommandRouter } from "../deploy/coding-worker/machine-command-routing.ts";
import { CLOUD_MACHINE_HOME } from "../packages/contracts/src/cloud-machine.ts";
import { companyMachineHomeCommand, LxdCompanyMachineHost } from "../packages/runner-orchestrator/src/company-machine-host.ts";
import { lxdCompanyMachineName } from "../packages/runner-orchestrator/src/company-machine.ts";
import { LxdUnixClient } from "../packages/runner-orchestrator/src/lxd-client.ts";
import { HomeOutputGate } from "../packages/runner-orchestrator/src/machine-home-folder.ts";
import { CLOUD_HOME_OUTDATED, cloudHomeRefusalWords } from "../packages/runtime/src/cloud-codex-home.ts";
import { HttpCloudCodingCommandService } from "../packages/runtime/src/cloud-coding-command-http.ts";
import { CloudHomeChannelRefused, cloudHomeSftpBytes, cloudHomeSftpLines } from "../packages/runtime/src/cloud-home-channel.ts";
import { createCloudHomeChannel } from "../packages/runtime/src/cloud-home-channel-client.ts";

const run = promisify(execFile);
const OWNER = "home-sftp-proof";
const PROVIDER = "machine-node";
const ids = {
	machineId: "c1e00000-0000-4000-8000-0000000000a1",
	runId: "c1e00000-0000-4000-8000-0000000000a2",
	staffAgentId: "c1e00000-0000-4000-8000-0000000000a3",
	requestedByUserId: "c1e00000-0000-4000-8000-0000000000a4",
};
const WRONG_BOOT = "00000000-0000-4000-8000-000000000000";
const T0 = Date.now();
const stamp = () => `${((Date.now() - T0) / 1000).toFixed(3).padStart(8)}`;
const say = (line) => process.stdout.write(`${stamp()} ${line}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** A mount folder goes only when it is empty: never a recursive removal, which would reach through a mount that is
 * still there into the machine's /company. */
const rmdirOnly = (path) => {
	try {
		rmdirSync(path);
	} catch {}
};
const args = process.argv.slice(2);
const option = (name, fallback) => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 ? args[at + 1] : fallback;
};

// ---------------------------------------------------------------------------------------------------------------------
// The executor's part: the ingress, the router, the host and the LXD client, with SQL and the holder stood in.

async function executor() {
	const config = JSON.parse(await new Promise((resolve) => createInterface({ input: process.stdin }).once("line", resolve)));
	const emit = (value) => process.stdout.write(`EVENT ${JSON.stringify(value)}\n`);
	const real = new LxdUnixClient(config.socket);
	let channels = 0;
	let releases = 0;
	const client = {
		execInstancePipe: async (project, name, request, signal) => {
			const channel = ++channels;
			const at = Date.now();
			emit({ event: "exec", channel, project, name, command: request.command, user: request.user, group: request.group });
			// The host's gate on a channel's output, as #homeFolder builds it, where this executor measures it.
			const gate =
				request.stdout && config.gate
					? new HomeOutputGate({
							release: async () => {
								releases++;
								if (config.gate.releaseMs) await sleep(config.gate.releaseMs);
								return undefined;
							},
							pass: request.stdout,
							fail: () => undefined,
							spacingMs: config.gate.spacingMs,
							limitBytes: 16 * 1024 * 1024,
						})
					: undefined;
			try {
				const result = await real.execInstancePipe(
					project,
					name,
					{ ...request, ...(gate ? { stdout: (chunk) => gate.push(chunk) } : {}) },
					signal,
				);
				await gate?.drained();
				emit({ event: "exec-end", channel, ms: Date.now() - at, exitCode: result.exitCode, stdout: result.stdout.toString("utf8").slice(0, 200),
					stderrTail: result.stderrTail.toString("utf8").slice(-600), aborted: signal.aborted });
				return result;
			} catch (error) {
				emit({ event: "exec-end", channel, ms: Date.now() - at, error: String(error?.message ?? error), aborted: signal.aborted });
				throw error;
			}
		},
	};
	setInterval(() => emit({ event: "releases", releases }), 1000).unref();
	process.on("SIGUSR2", () => emit({ event: "releases", releases }));
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
// The driver: the run's side (sshfs over the channel), the scenarios, and what the machine says.

async function driver() {
	const project = option("project", "default");
	const placementId = option("placement", "c1e00000-0000-4000-8000-0000000000d1");
	const machine = lxdCompanyMachineName(placementId);
	const socket = option("socket", "/var/snap/lxd/common/lxd/unix.socket");
	const sshfs = option("sshfs", "/home/tester/lanes/agent-box-C1/sshfs/usr/bin/sshfs");
	const only = option("only", "all");
	const checks = [];
	const check = (id, ok, text) => {
		checks.push({ id, ok });
		say(`CHECK ${id} ${ok ? "PASS" : "FAIL"} ${text}`);
	};
	const inMachine = async (command) => {
		const done = await run("lxc", ["--project", project, "exec", machine, "--", "/bin/sh", "-c", command], { maxBuffer: 64 << 20 })
			.catch((error) => error);
		return String(done.stdout ?? "");
	};
	const sh = async (command, timeoutMs = 600000) => {
		const at = performance.now();
		const done = await run("/bin/bash", ["-c", command], { maxBuffer: 64 << 20, timeout: timeoutMs }).catch((error) => error);
		return { ms: Math.round(performance.now() - at), stdout: String(done.stdout ?? ""), code: done.code ?? 0, stderr: String(done.stderr ?? "") };
	};
	const agentProcesses = async () =>
		(await inMachine("ps -o pid=,user=,etimes=,args= -u 2000")).split("\n").filter((line) => line.trim());
	const homeUnits = async () =>
		(await inMachine("systemctl list-units --all --plain --no-legend 'qorpera-machine-home-*' | cut -d' ' -f1")).split("\n").filter(Boolean);
	const goneWithin = async (from, limitMs = 15000) => {
		for (;;) {
			const left = [...(await agentProcesses()), ...(await homeUnits())];
			if (left.length === 0) return Math.round(performance.now() - from);
			if (performance.now() - from > limitMs) {
				say(`LEFT ${left.join(" | ")}`);
				return null;
			}
			await sleep(100);
		}
	};

	// Empty mount folders an earlier run left when it was stopped from outside (rmdir: only an empty folder goes).
	for (const name of readdirSync("/run").filter((entry) => /^c1m-[a-z0-9]+-[0-9a-f]{6}$/.test(entry))) {
		try {
			rmdirSync(`/run/${name}`);
			say(`LEFTOVER /run/${name}: an empty folder, removed`);
		} catch (error) {
			say(`LEFTOVER /run/${name}: kept (${error?.code})`);
		}
	}
	const boot = (await inMachine("cat /proc/sys/kernel/random/boot_id")).trim();
	say(`MACHINE ${machine} in ${project}; boot ${boot}; LXD socket ${socket}`);
	say(`MACHINE ${(await inMachine("echo kernel $(uname -r); id qorpera-agent; ls -l /usr/lib/openssh/sftp-server 2>&1; stat -c '%U:%G %a' /company; ls /company; nproc; free -m | awk '/Mem/{print $2}'")).replaceAll("\n", " | ")}`);
	say(`TEST VM load ${(await sh("cut -d' ' -f1-3 /proc/loadavg")).stdout.trim()}; sshfs ${(await sh(`${sshfs} --version 2>&1 | head -1`)).stdout.trim()}`);
	const token = randomBytes(32).toString("base64url");
	const sessions = {};
	const session = (bootId = boot) => {
		const sessionId = randomUUID();
		sessions[sessionId] = bootId;
		return sessionId;
	};
	const named = { missing: session(), main: session(), kill: session(), wrongBoot: session(WRONG_BOOT), bench: session() };
	const executors = [];
	const startExecutor = async (label, gate) => {
		const child = spawn(process.execPath, [process.argv[1], "executor"], { stdio: ["pipe", "pipe", "inherit"] });
		child.stdin.write(`${JSON.stringify({ token, socket, project, placementId, machine, boot, sessions, gate })}\n`);
		const state = { releases: 0, execs: [] };
		const port = await new Promise((resolve, reject) => {
			const lines = createInterface({ input: child.stdout });
			lines.on("line", (line) => {
				if (line.startsWith("READY ")) resolve(Number(line.slice(6)));
				else if (line.startsWith("EVENT ")) {
					const event = JSON.parse(line.slice(6));
					if (event.event === "releases") {
						state.releases = event.releases;
						return;
					}
					if (event.event === "exec") state.execs.push(event);
					say(`EXEC[${label}] ${line.slice(6).slice(0, 900)}`);
				} else say(`EXEC[${label}] ${line.slice(0, 400)}`);
			});
			child.once("exit", (code, signal) => {
				say(`EXEC[${label}] exited ${code ?? signal}`);
				reject(new Error("executor ended before READY"));
			});
		});
		executors.push(child);
		return { child, port, state };
	};
	const binding = {
		leaseId: randomUUID(), runId: ids.runId, jobId: randomUUID(), runnerId: randomUUID(), assignmentId: randomUUID(),
		credentialCapsuleId: randomUUID(), computeIdentityId: randomUUID(), provider: "openai", nativeHarness: "codex-cli",
		model: "home-sftp-proof",
	};
	// A Codex binding: the ingress's binding parser takes no other harness yet (cloud-native-tool-authority.ts, the
	// gates C4 opens). The file channel itself does not depend on the harness.
	const holder = `job.${binding.jobId}.${randomBytes(32).toString("base64url")}`;
	const openChannel = (port, sessionId) =>
		createCloudHomeChannel({ url: `http://127.0.0.1:${port}`, token, binding, holder: () => holder, allowLoopback: true })
			.open({ sessionId, machineId: ids.machineId, kind: "sftp" }, AbortSignal.timeout(30000));
	const refusal = (error) => (error instanceof CloudHomeChannelRefused ? error.reason : String(error?.message ?? error));

	/** sshfs in passive mode at a fresh folder, its stdin and stdout wired to `wire`. */
	const mounts = [];
	const mountWith = async (label, wire) => {
		const mnt = `/run/c1m-${label}-${randomBytes(3).toString("hex")}`;
		mkdirSync(mnt, { recursive: true });
		const fs = spawn(sshfs, ["-f", "-o", "passive,nosuid,nodev,noexec,follow_symlinks", "home:/", mnt], { stdio: ["pipe", "pipe", "pipe"] });
		let stderr = "";
		fs.stderr.on("data", (chunk) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-2000);
		});
		fs.stdin.on("error", () => undefined);
		const ended = new Promise((resolve) => fs.once("exit", (code, signal) => resolve(code ?? signal)));
		try {
			await wire(fs);
		} catch (error) {
			fs.kill("SIGTERM");
			rmdirOnly(mnt);
			throw error;
		}
		const at = performance.now();
		while ((await sh(`mountpoint -q ${mnt} && test -d ${mnt}/company`)).code !== 0) {
			if (performance.now() - at > 15000) throw new Error(`no mount at ${mnt}: ${stderr}`);
			await sleep(50);
		}
		const mount = { label, mnt, fs, ended, stderr: () => stderr };
		mounts.push(mount);
		say(`MOUNT ${label} at ${mnt} in ${Math.round(performance.now() - at)} ms`);
		return mount;
	};
	const unmount = async (mount) => {
		await sh(`fusermount3 -u -z ${mount.mnt} 2>/dev/null || umount -l ${mount.mnt} 2>/dev/null; true`);
		mount.fs.kill("SIGTERM");
		await Promise.race([mount.ended, sleep(3000)]);
		rmdirOnly(mount.mnt);
	};
	/** sshfs over the executor's route: the channel's lines are the stream as base64. */
	const viaRoute = async (label, port, sessionId) => {
		let stream;
		const mount = await mountWith(label, async (fs) => {
			stream = await openChannel(port, sessionId);
			void (async () => {
				for await (const line of cloudHomeSftpLines(fs.stdout)) stream.write(line);
				await stream.close();
			})().catch(() => undefined);
			void (async () => {
				try {
					for await (const line of stream.lines) if (!fs.stdin.write(cloudHomeSftpBytes(line))) await new Promise((resolve) => fs.stdin.once("drain", resolve));
				} catch {}
				fs.stdin.end();
			})();
		});
		return { ...mount, stream };
	};
	/** sshfs straight to the same sftp-server, the unit started by `lxc exec` (P4's shape): no executor, no gate. */
	const viaPlain = async (label) => {
		const unit = companyMachineHomeCommand(boot, randomUUID(), randomBytes(8).toString("hex"), "sftp");
		let child;
		const mount = await mountWith(label, async (fs) => {
			child = spawn("lxc", ["--project", project, "exec", machine, "--", ...unit], { stdio: ["pipe", "pipe", "inherit"] });
			fs.stdout.pipe(child.stdin);
			child.stdout.pipe(fs.stdin);
		});
		return { ...mount, child };
	};

	// The five operations, on one mount: (a) 200 small files read one after another, (b) grep over 2,000 files in 20
	// folders, (c) the 5,000-file listing, (d) 200 small files written one after another; and a single small read.
	const bench = async (mount, mode, state, light = false) => {
		const c = `${mount.mnt}/company`;
		const out = {};
		const time = async (name, command, expect) => {
			if (state) await sleep(1100);
			const r0 = state?.releases ?? 0;
			const r = await sh(command);
			if (state) await sleep(1100);
			const got = r.stdout.trim();
			out[name] = { ms: r.ms, releases: state ? state.releases - r0 : null, ok: expect(got), got: got.slice(0, 80) };
			say(`BENCH ${mode} ${name}: ${r.ms} ms${state ? `, ${state.releases - r0} releases` : ""} (${got.slice(0, 60)})${r.code ? ` exit ${r.code} ${r.stderr.slice(0, 200)}` : ""}`);
		};
		await time("one-read", `cat ${c}/tree/d40/f000.txt | wc -c`, (got) => Number(got) > 1000);
		await time("read-200", `n=0; for d in d30 d31; do for f in ${c}/tree/$d/f*.txt; do cat "$f" >/dev/null && n=$((n+1)); done; done; echo $n`, (got) => got === "200");
		// The gate as it was (200 ms between releases) greps 200 files only: 2,000 would take a quarter of an hour.
		if (light) await time("grep-200", `grep -rl P4NEEDLE ${c}/tree/d00 ${c}/tree/d01 | wc -l`, (got) => Number(got) >= 0);
		else await time("grep-2000", `grep -rl P4NEEDLE ${c}/tree/d0* ${c}/tree/d1* | wc -l`, (got) => Number(got) > 0);
		await time("list-5000", `find ${c}/tree -type f | wc -l`, (got) => got === "5000");
		await time("write-200", `mkdir -p ${c}/c1w/${mode} && for i in $(seq 1 200); do echo "c1 write $i" > ${c}/c1w/${mode}/f$i.txt; done; ls ${c}/c1w/${mode} | wc -l`, (got) => got === "200");
		return out;
	};

	try {
		const ex = await startExecutor("route", undefined);

		if (only === "all" || only === "checks") {
			// 1. A machine whose image has no sftp-server: refused with its own reason, nothing started, words for the model.
			await inMachine("[ -x /usr/lib/openssh/sftp-server ] && mv /usr/lib/openssh/sftp-server /usr/lib/openssh/sftp-server.c1-aside; true");
			const missing = await openChannel(ex.port, named.missing).then(() => "opened", refusal);
			const startedMissing = ex.state.execs.filter((e) => e.command.includes("/usr/bin/systemd-run")).length;
			check("1", missing === "HOME_SFTP_MISSING" && startedMissing === 0 && cloudHomeRefusalWords(missing) === CLOUD_HOME_OUTDATED,
				`no sftp-server on the machine: refused ${missing}, no unit started (${startedMissing}); the model is told ${JSON.stringify(cloudHomeRefusalWords(missing).slice(0, 60))}...`);
			await inMachine("[ -e /usr/lib/openssh/sftp-server.c1-aside ] && mv /usr/lib/openssh/sftp-server.c1-aside /usr/lib/openssh/sftp-server; true");
			if (!(await inMachine("[ -x /usr/lib/openssh/sftp-server ] && echo yes")).includes("yes")) {
				await run("lxc", ["--project", project, "file", "push", "/usr/lib/openssh/sftp-server", `${machine}/usr/lib/openssh/sftp-server`, "--uid", "0", "--gid", "0", "--mode", "0755"]);
			}
			say(`MACHINE sftp-server now: ${(await inMachine("ls -l /usr/lib/openssh/sftp-server; sha256sum /usr/lib/openssh/sftp-server | cut -c1-16")).replaceAll("\n", " ")}`);

			// 2. A session of another boot: the guest's own check refuses it; nothing runs.
			const execsBefore = ex.state.execs.length;
			const wrong = await openChannel(ex.port, named.wrongBoot).then(() => "opened", refusal);
			check("2", wrong !== "opened" && (await homeUnits()).length === 0,
				`a session of another boot: refused (${wrong}), ${ex.state.execs.length - execsBefore} exec(s) asked (the boot check), no unit left`);

			// 3. Reads, writes, renames, binary, as the agent's account, through the route.
			const m = await viaRoute("main", ex.port, named.main);
			const c = `${m.mnt}/company`;
			const units = await homeUnits();
			const unitInfo = units.length ? await inMachine(`systemctl show -p Slice -p User -p Group -p WorkingDirectory -p KillMode -p ExecStart --value ${units[0]} | tr '\\n' ' '`) : "";
			const procs = await agentProcesses();
			check("3", units.length === 1 && /^qorpera-machine-home-[0-9a-f-]{36}-sftp-[0-9a-f]{16}\.service$/.test(units[0]) &&
				/qorpera-machine\.slice/.test(unitInfo) && /\/company/.test(unitInfo) && procs.some((line) => line.includes("/usr/lib/openssh/sftp-server")),
				`the file channel is one unit in the machines' slice as the agent: ${units.join(" ")} | ${unitInfo.slice(0, 300)} | ${procs.join(" ; ").slice(0, 300)}`);
			// Each run its own folder: a run stopped from outside leaves its files.
			const mine = `c1-${randomBytes(4).toString("hex")}`;
			const seed = (await sh(`cat ${c}/seed.txt`)).stdout;
			const homeSeed = (await inMachine("cat /company/seed.txt"));
			const random = randomBytes(1024 * 1024 + 13);
			const want = createHash("sha256").update(random).digest("hex");
			const binPath = `/run/c1-random-${randomBytes(3).toString("hex")}`;
			writeFileSync(binPath, random);
			const w = await sh(`set -e; mkdir -p ${c}/${mine}; printf 'hello from the box\\n' > ${c}/${mine}/note.txt; cp ${binPath} ${c}/${mine}/random.bin; mv ${c}/${mine}/note.txt ${c}/${mine}/renamed.txt; echo more >> ${c}/${mine}/renamed.txt; echo all-done`);
			rmSync(binPath, { force: true });
			const onHome = await inMachine(`stat -c '%U:%G %a %s %n' /company/${mine}/renamed.txt /company/${mine}/random.bin; cat /company/${mine}/renamed.txt; sha256sum /company/${mine}/random.bin | cut -d' ' -f1; ls /company/${mine}`);
			const back = await sh(`sha256sum ${c}/${mine}/random.bin | cut -d' ' -f1; cat ${c}/${mine}/renamed.txt`);
			check("4", w.stdout.includes("all-done") && seed.length > 0 && seed === homeSeed && onHome.includes(`qorpera-agent:qorpera-agent 644 24 /company/${mine}/renamed.txt`) &&
				onHome.includes("hello from the box\nmore\n") && onHome.includes(want) && !/note\.txt/.test(onHome) && back.stdout.startsWith(want) &&
				back.stdout.includes("hello from the box"),
				`read (${seed.length} B, same as the home's), write + rename + append + 1 MiB binary as the agent: ${w.stdout.trim()} ${w.stderr.trim().slice(0, 200)} | home: ${onHome.replaceAll("\n", " | ").slice(0, 400)}`);
			// Root's file: the agent's account reads it, and its write is refused (EACCES), as P4 found for the file tools.
			await inMachine(`echo root-made > /company/${mine}/root.txt && chown root:root /company/${mine}/root.txt && chmod 0644 /company/${mine}/root.txt`);
			const rootRead = await sh(`cat ${c}/${mine}/root.txt`);
			const rootWrite = await sh(`echo x >> ${c}/${mine}/root.txt`);
			check("5", rootRead.stdout.trim() === "root-made" && rootWrite.code !== 0 && (await inMachine(`cat /company/${mine}/root.txt`)).trim() === "root-made",
				`a root file: read (${rootRead.stdout.trim()}), a write refused (exit ${rootWrite.code}: ${rootWrite.stderr.trim().slice(0, 80)}), unchanged on the home`);
			// 4b. A symlink made through sshfs: what the route gives must be what plain sshfs to the same sftp-server gives
			// (the channel adds nothing; sshfs's own handling of OpenSSH's SYMLINK is sshfs's).
			const linkVia = async (base, name) => {
				const made = await sh(`ln -s renamed.txt ${base}/${mine}/${name}; echo rc=$?`);
				const there = (await inMachine(`readlink /company/${mine}/${name}`)).trim();
				const read = (await sh(`cat ${base}/${mine}/${name} 2>&1 | head -1`)).stdout.trim();
				return `${made.stdout.trim()} ${made.stderr.trim().replace(/^.*: /, "")} | on the home -> ${there || "none"} | read: ${read}`;
			};
			const viaRouteLink = await linkVia(c, "link-route.txt");
			const plainForLink = await viaPlain("plainlink");
			const viaPlainLink = await linkVia(`${plainForLink.mnt}/company`, "link-plain.txt");
			plainForLink.child.kill("SIGTERM");
			await unmount(plainForLink);
			say(`SYMLINK route: ${viaRouteLink}`);
			say(`SYMLINK plain: ${viaPlainLink}`);
			check("4b", viaRouteLink.replaceAll("link-route", "L") === viaPlainLink.replaceAll("link-plain", "L"),
				`a symlink through the route behaves as through plain sshfs to the same sftp-server (route: ${viaRouteLink}; plain: ${viaPlainLink})`);
			const list = await sh(`find ${c}/tree -type f | wc -l; ls ${c}/tree/d49 | wc -l`);
			check("6", list.stdout.split("\n")[0].trim() === "5000", `the 5,000-file listing through the route: ${list.stdout.replaceAll("\n", " ")} in ${list.ms} ms`);

			// 7. The run's side drops its channel: sftp-server's unit ends and nothing of it stays.
			const dropAt = performance.now();
			await m.stream.close();
			const gone = await goneWithin(dropAt);
			const after = await sh(`ls ${c} 2>&1 | head -2`);
			check("7", gone !== null, `the run's side dropped its channel: unit and processes gone in ${gone} ms; the mount now says ${JSON.stringify(after.stdout.trim().slice(0, 80))}`);
			await unmount(m);

			// 8. The executor dies under an open channel (an executor roll): the unit ends with its LXD exec.
			const ex2 = await startExecutor("killed", undefined);
			const k = await viaRoute("kill", ex2.port, named.kill);
			const busy = await homeUnits();
			const killAt = performance.now();
			ex2.child.kill("SIGKILL");
			const gone2 = await goneWithin(killAt);
			check("8", busy.length === 1 && gone2 !== null, `the executor was killed under an open file channel (${busy.join(" ")}): unit and processes gone in ${gone2} ms`);
			await unmount(k);
		}

		// 9. The speed: the same five operations over plain sshfs (P4's shape: no executor, no gate), through the route
		// (no folder: no gate), and through the route with the host's gate (spacing 200 ms, release at once / after 25 ms).
		const results = {};
		if (only === "checks") {
			const left = await goneWithin(performance.now(), 10000);
			check("10", left !== null, `nothing of any file channel is left on the machine (${left} ms)`);
			return;
		}
		const plain = await viaPlain("plain");
		results.plain = await bench(plain, "plain");
		plain.child.kill("SIGTERM");
		await unmount(plain);
		const r = await viaRoute("route", ex.port, named.bench);
		results.route = await bench(r, "route", undefined);
		await r.stream.close();
		await unmount(r);
		// The host's gate: as first built (200 ms between releases, every channel), and as the file channel has it now
		// (none), with a release that answers at once, after 10 ms and after 25 ms (a real one is not measured here).
		for (const [mode, gate, light] of [
			["gate200", { spacingMs: 200, releaseMs: 0 }, true],
			["gate0", { spacingMs: 0, releaseMs: 0 }, false],
			["gate0r10", { spacingMs: 0, releaseMs: 10 }, false],
			["gate0r25", { spacingMs: 0, releaseMs: 25 }, false],
		]) {
			if (only !== "all" && only !== "bench") continue;
			const exG = await startExecutor(mode, gate);
			const g = await viaRoute(mode, exG.port, session());
			results[mode] = await bench(g, mode, exG.state, light);
			await g.stream.close();
			await unmount(g);
			exG.child.kill("SIGTERM");
		}
		const plain2 = await viaPlain("plain2");
		results.plain2 = await bench(plain2, "plain2");
		plain2.child.kill("SIGTERM");
		await unmount(plain2);
		say(`RESULTS ${JSON.stringify(results)}`);
		const allOk = Object.values(results).every((modes) => Object.values(modes).every((one) => one.ok));
		check("9", allOk, "every operation gave the right answer in every mode (numbers in RESULTS)");
		await sleep(500);
		const left = await goneWithin(performance.now(), 10000);
		check("10", left !== null, `nothing of any file channel is left on the machine (${left} ms)`);
	} finally {
		for (const mount of mounts) await unmount(mount).catch(() => undefined);
		for (const child of executors) child.kill("SIGTERM");
		say(`CHECKS ${checks.filter((one) => one.ok).length} of ${checks.length} passed: ${checks.filter((one) => !one.ok).map((one) => one.id).join(" ") || "none failed"}`);
		say("PROOF-END");
	}
}

if (args[0] === "executor") await executor();
else if (args[0] === "driver")
	await driver().then(
		() => process.exit(0),
		(error) => {
			say(`DRIVER FAILED ${error?.stack ?? error}`);
			process.exit(1);
		},
	);
else {
	process.stderr.write("usage: prove-home-sftp driver [--project P --placement UUID --socket PATH --sshfs PATH --only all|bench]\n");
	process.exit(2);
}
