import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
	CompanyComputerLinuxShell,
	CompanyComputerShellPressureGuard,
	createCompanyComputerLinuxShellLauncher,
	readCompanyComputerShellUsage,
} from "../../src/cloud-company-computer-linux-shell.ts";
import { parseRecoveryDirectoryMount } from "../../src/cloud-identity-recovery-filesystems.ts";
import { computerBinding } from "./company-computer.ts";

// Disposable Linux fixture only: the real shell namespace (Bubblewrap, Tini,
// the office's namespace entry file) as the unprivileged office account, with
// the image's own firewall and root plumber set up by the runner. The
// container has no internet: "public" (93.184.216.34) and "private"
// (10.9.9.9, 169.254.169.254) hosts are stand-ins behind this machine.
assert.equal(process.platform, "linux");
assert.equal(process.getuid?.(), 1000);
const status = await readFile("/proc/self/status", "utf8");
assert.match(status, /^CapEff:\s+0+$/m);
assert.match(status, /^NoNewPrivs:\s+1$/m);
const layout = {
	workbenchRoot: "/srv/workbench",
	desktopHome: "/srv/desktop",
	screenStateRoot: "/srv/screens",
	browserProfilesRoot: "/srv/profiles",
};
const directory = await open(layout.workbenchRoot, constants.O_RDONLY | constants.O_DIRECTORY);
const workbenchMount = parseRecoveryDirectoryMount(
	await readFile("/proc/self/mountinfo", "utf8"),
	await readFile(`/proc/self/fdinfo/${directory.fd}`, "utf8"),
);
await directory.close();
// The container's own limits (640 MiB keeps the proof inside a shared test machine's memory).
const limits = { memoryBytes: 671088640, pids: 256, cpuQuota: 100000, cpuPeriod: 100000 };
const exists = (path: string) =>
	lstat(path).then(
		() => true,
		() => false,
	);
async function until(check: () => Promise<boolean> | boolean, what: string) {
	for (let i = 0; i < 200; i++) {
		if (await check()) return;
		await delay(50);
	}
	throw new Error(`LINUX_FIXTURE_WAIT_TIMEOUT: ${what}`);
}

// This machine's own listener, which no computer may reach.
const canary = createServer((socket) => socket.end("HOST_NETWORK_CANARY"));
await new Promise<void>((resolve) => canary.listen(0, "0.0.0.0", resolve));
const canaryPort = (canary.address() as { port: number }).port;

const xvfb = spawn("/usr/bin/Xvfb", [":1", "-screen", "0", "1920x1200x24", "-nolisten", "tcp", "-ac", "-noreset"], {
	env: { PATH: "/usr/bin:/bin" },
	stdio: ["ignore", "ignore", "pipe"],
});
const xExited = new Promise<void>((resolve) => xvfb.once("close", () => resolve()));
let shell: CompanyComputerLinuxShell | undefined;
try {
	await until(() => exists("/tmp/.X11-unix/X1"), "X display");
	await rename("/tmp/.X11-unix/X1", "/tmp/office-x/X1");
	await writeFile("/srv/profiles/credential-canary", "SYNTHETIC_PROFILE_SECRET");
	process.env.QORPERA_SYNTHETIC_SECRET = "SYNTHETIC_SERVICE_SECRET";
	shell = new CompanyComputerLinuxShell(
		createCompanyComputerLinuxShellLauncher({
			binding: computerBinding(),
			layout,
			workbenchMount,
			limits,
			runtimeRoot: "/run/office-screens",
			xSocket: () => "/tmp/office-x/X1",
			boundary: { assertReady: async () => undefined },
		}),
	);
	const signal = new AbortController().signal;
	// Each model call is an effect (start, write, stop) and then a wait for its result.
	const read = (sessionId: string, waitMs = 10000) => shell!.result({ sessionId, waitMs, signal });
	const run = async (command: string, waitMs = 10000) =>
		read((await shell!.start({ key: randomUUID(), command, signal })).sessionId, waitMs);
	/** Reads until the command has ended; a busy test machine can be slow to deliver its exit. */
	const settled = async (sessionId: string, first: Awaited<ReturnType<typeof read>>) => {
		let result = first;
		for (let attempt = 0; result.state === "running" && attempt < 6; attempt++) {
			const next = await read(sessionId, 10000);
			result = { ...next, output: result.output + next.output };
		}
		return result;
	};
	/** Reads until the command has printed `text`; a busy test machine starts programs slowly. */
	const printed = async (sessionId: string, output: string, text: string) => {
		for (let attempt = 0; !output.includes(text) && attempt < 15; attempt++)
			output += (await read(sessionId, 2000)).output;
		return output;
	};
	const stop = async (sessionId: string) => {
		await shell!.stop({ sessionId, signal });
		return settled(sessionId, await read(sessionId, 4000));
	};
	const done = async (command: string) => {
		// The shell starts in the background; on a busy machine the first reply may come first.
		let result = await run(command);
		for (let attempt = 0; result.state === "running" && attempt < 6; attempt++) {
			const next = await read(result.sessionId, 10000);
			result = { ...next, output: result.output + next.output };
		}
		assert.equal(result.state, "exited", `${command}: ${result.output} ${result.note ?? ""}`);
		assert.equal(result.exitCode, 0, `${command}: ${result.output}`);
		return result.output;
	};

	// The same sandbox as before: no host network, profiles, service secrets or cgroups.
	assert.equal(
		await done(`set -eu
trap 'echo "failed at line $LINENO"' ERR
test -z "\${QORPERA_SYNTHETIC_SECRET-}"
test "$HOME" = /home/qorpera
test "$(pwd)" = /srv/workbench
test -z "\${HTTPS_PROXY-}\${http_proxy-}"
test "$(head -n 1 /etc/resolv.conf)" = "nameserver 1.1.1.1"
test ! -e /srv/profiles/credential-canary
test ! -e /run/office-screens
test ! -e /sys/fs/cgroup
# Its own network card and route out, from the plumber.
grep -q '^ *eth0:' /proc/net/dev
test -n "$(awk '$2 == "00000000"' /proc/net/route)"
if timeout 1 bash -c 'echo canary >/dev/tcp/127.0.0.1/${canaryPort}' 2>/dev/null; then exit 19; fi
if timeout 3 bash -c 'echo canary >/dev/tcp/10.253.1.1/${canaryPort}' 2>/dev/null; then exit 22; fi
if unshare --user --map-root-user true 2>/dev/null; then exit 20; fi
if touch /usr/office-write-canary 2>/dev/null; then exit 21; fi
getent hosts localhost >/dev/null
id -un >/dev/null
# Only standard input, output and error, and the descriptor ls opens itself.
test "$(ls /proc/self/fd | tr '\\n' ' ')" = "0 1 2 3 "
# The machine's first choice when memory runs out.
test "$(cat /proc/self/oom_score_adj)" = 1000
printf isolated`),
		"isolated",
	);

	// The real network: any port and protocol to public addresses, no proxy.
	assert.equal(await done("curl -sS --max-time 10 http://93.184.216.34:8080/hello"), "public:/hello");
	assert.equal(
		await done("timeout 10 bash -c 'exec 3<>/dev/tcp/93.184.216.34/2222; head -c 14 <&3'"),
		"SSH-2.0-public",
	);
	assert.equal(
		await done(
			"node -e \"const s=require('dgram').createSocket('udp4');s.on('message',m=>{console.log(String(m));s.close()});s.send('ping',5353,'93.184.216.34');setTimeout(()=>process.exit(3),8000).unref()\"",
		),
		"public:ping\n",
	);
	assert.match(await done("ping -c 1 -W 5 93.184.216.34"), /1 received/);
	// Never private, metadata or this machine, whichever port or protocol.
	for (const address of ["10.9.9.9", "169.254.169.254"]) {
		// Something listens there; the firewall drops the packets, so curl times out (28).
		const fetching = await run(`curl -sS --max-time 4 http://${address}:8080/`);
		const blocked = await settled(fetching.sessionId, fetching);
		assert.equal(blocked.exitCode, 28, `${address}: ${blocked.output}`);
		const pinging = await run(`ping -c 1 -W 3 ${address}`);
		const pinged = await settled(pinging.sessionId, pinging);
		assert.notEqual(pinged.exitCode, 0, `${address}: ${pinged.output}`);
	}

	// Computers are separate: another computer's server is out of reach, its own is not.
	const other = new CompanyComputerLinuxShell(
		createCompanyComputerLinuxShellLauncher({
			binding: { ...computerBinding(), screenId: "00000000-0000-4000-8000-0000000000b2", screenOrdinal: 2 },
			layout,
			workbenchMount,
			limits,
			runtimeRoot: "/run/office-screens",
			xSocket: () => "/tmp/office-x/X1",
			boundary: { assertReady: async () => undefined },
		}),
	);
	try {
		const otherServer = (
			await other.start({
				key: randomUUID(),
				command:
					"node -e \"require('http').createServer((q,s)=>s.end('other')).listen(8001,'0.0.0.0',()=>console.log('listening'))\"",
				signal,
			})
		).sessionId;
		let heard = "";
		for (let attempt = 0; !heard.includes("listening") && attempt < 15; attempt++)
			heard += (await other.result({ sessionId: otherServer, waitMs: 2000, signal })).output;
		assert.match(heard, /listening/);
		const reaching = await run("curl -sS --max-time 4 http://10.253.2.2:8001/");
		assert.notEqual((await settled(reaching.sessionId, reaching)).exitCode, 0);
	} finally {
		await other.close();
	}

	// Commands share the shell's localhost: a server from one is reachable from the next.
	const server = await run(
		"node -e \"require('http').createServer((q,s)=>s.end('local-ok')).listen(8000,'127.0.0.1',()=>console.log('listening'))\"",
		3000,
	);
	assert.equal(server.state, "running", server.output);
	assert.equal((await printed(server.sessionId, server.output, "listening")).trim(), "listening");
	assert.equal(await done("curl -sS --max-time 5 http://localhost:8000/"), "local-ok");
	assert.equal((await stop(server.sessionId)).state, "stopped");

	// Input to a running command.
	const asking = await run('read -r answer; echo "got:$answer"', 200);
	assert.equal(asking.state, "running");
	await shell.write({ sessionId: asking.sessionId, text: "yes\n", endInput: false, signal });
	const answered = await settled(asking.sessionId, await read(asking.sessionId, 5000));
	assert.equal(answered.output, "got:yes\n");

	// The screen's display, as before.
	assert.equal((await done("xdotool getdisplaygeometry")).trim(), "1920 1200");

	// No 15-second stop: this runs for 17 seconds and finishes.
	const long = await run("sleep 17; echo survived", 1000);
	assert.equal(long.state, "running");
	const finished = await settled(long.sessionId, await read(long.sessionId, 15000));
	assert.equal(finished.state, "exited");
	assert.equal(finished.output, "survived\n");

	// Output past the kept tail is dropped, never fatal.
	const flooding = await run("head -c 3000000 /dev/zero | tr '\\0' z; echo; echo END");
	const flood = await settled(flooding.sessionId, flooding);
	assert.equal(flood.state, "exited");
	// However its replies fell, some of the 3 MB was older than the kept 1 MiB.
	assert.match(flood.output, /\[\d+ earlier bytes not kept\]\n/);
	assert.match(flood.output, /END\n$/);

	// Stop ends the command's whole process group.
	const pair = await run("sleep 1000 & sleep 1000", 200);
	assert.equal(pair.state, "running");
	await until(() => shell!.list().processes >= 2, "both sleeps counted");
	assert.equal((await stop(pair.sessionId)).state, "stopped");
	await until(() => shell!.list().processes === 0, "group stopped");

	// A process left in the background keeps running, and keeps the computer busy.
	assert.equal(await done("nohup sleep 300 >/dev/null 2>&1 & echo left"), "left\n");
	await until(() => shell!.busy && shell!.list().processes === 1, "background process counted");
	await delay(500);
	assert.equal(shell.list().processes, 1);
	assert.deepEqual(await shell.stop({ signal }), { stopped: 0 });
	assert.equal(shell.busy, false);
	assert.equal(await done("echo fresh"), "fresh\n");

	// Memory safety: nearing the machine's limit, the guard ends the shell
	// holding the most, before the kernel's own stop would end the service.
	const hog = await run(
		"node -e \"globalThis.b=Buffer.alloc(300*1024*1024,1);console.log('holding');setInterval(()=>{},1000)\"",
		5000,
	);
	assert.equal(hog.state, "running", hog.output);
	// Measured once it holds the memory; a busy machine starts it slowly.
	assert.match(await printed(hog.sessionId, hog.output, "holding"), /holding/);
	const pid = shell.namespacePid;
	assert.ok(pid);
	const usage = (await readCompanyComputerShellUsage([pid])).get(pid)!;
	assert.ok(usage.memoryBytes > 250 * 1024 * 1024, JSON.stringify(usage));
	assert.ok(usage.tasks >= 3, JSON.stringify(usage));
	const guard = new CompanyComputerShellPressureGuard({ shells: () => [shell!], intervalMs: 500 });
	try {
		const stopped = await settled(hog.sessionId, await read(hog.sessionId, 10000));
		assert.equal(stopped.state, "stopped");
		assert.match(stopped.note ?? "", /running out of memory/);
	} finally {
		guard.close();
	}
	assert.equal(await done("echo after-pressure"), "after-pressure\n");

	// Closing the screen ends everything and reaps the namespace.
	await run("nohup sleep 300 >/dev/null 2>&1 &", 200);
	await shell.close();
	const survivors: string[] = [];
	for (const pid of (await readdir("/proc")).filter((name) => /^[0-9]+$/.test(name))) {
		const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
		if (/sleep|--shell-host|bwrap|tini/.test(command)) survivors.push(command.replaceAll("\0", " "));
	}
	assert.deepEqual(survivors, []);
	// The computers' network cards go with their namespaces (the kernel frees a
	// namespace shortly after its last process).
	await until(() => !/qcmp/.test(execFileSync("ip", ["-o", "link"], { encoding: "utf8" })), "network cards removed");
	assert.deepEqual(await readdir("/run/office-screens"), []);
	process.stdout.write("Company Computer shell Linux proof passed\n");
} finally {
	await shell?.close().catch(() => undefined);
	xvfb.kill("SIGTERM");
	await xExited;
	canary.close();
}
