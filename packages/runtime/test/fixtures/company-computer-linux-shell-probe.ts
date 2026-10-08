import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
	CompanyComputerLinuxShell,
	CompanyComputerShellPressureGuard,
	companyComputerShellBusy,
	createCompanyComputerLinuxShellLauncher,
	readCompanyComputerShellUsage,
} from "../../src/cloud-company-computer-linux-shell.ts";
import { startCompanyComputerBrowserEgress } from "../../src/cloud-company-computer-browser-egress.ts";
import { companyComputerAgentPlugAddress } from "../../src/cloud-company-computer-linux-network.ts";
import { parseRecoveryDirectoryMount } from "../../src/cloud-identity-recovery-filesystems.ts";
import { computerBinding } from "./company-computer.ts";

/** The run that starts the commands here. */
const SHELL_RUN = "00000000-0000-4000-8000-0000000000c1";

// Disposable Linux fixture only: the real shell namespace (Bubblewrap, Tini,
// the office's namespace entry file) as the unprivileged office account, with
// the image's own firewall and root plumber set up by the runner. The
// container has no internet: "public" (93.184.216.34) and "private"
// (10.9.9.9, 169.254.169.254) hosts are stand-ins behind this machine, and so
// is the node's agent exit (10.210.0.1) behind its agent card (10.210.1.1).
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
			boundary: { assertReady: async () => undefined },
		}),
	);
	const signal = new AbortController().signal;
	// Each model call is an effect (start, write, stop) and then a wait for its result.
	const read = (sessionId: string, waitMs = 10000) => shell!.result({ sessionId, waitMs, signal });
	const run = async (command: string, waitMs = 10000) =>
		read((await shell!.start({ runId: SHELL_RUN, key: randomUUID(), command, signal })).sessionId, waitMs);
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
test "$(head -n 1 /etc/resolv.conf)" = "nameserver 10.210.0.1"
test "$(grep -c '^nameserver' /etc/resolv.conf)" = 1
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
	// Out by the machine's agent card, through the node's agent exit, which also
	// names hosts. Its name server is the one address of the agents' network a
	// computer reaches, and only on port 53.
	assert.equal(await done("curl -sS --max-time 10 http://pub.example:8080/from"), "public:10.210.1.1");
	assert.equal(await done("timeout 5 bash -c 'exec 3<>/dev/tcp/10.210.0.1/53; head -c 8 <&3'"), "exit-dns");
	const exitPort = await run("curl -sS --max-time 4 http://10.210.0.1:8080/");
	assert.equal((await settled(exitPort.sessionId, exitPort)).exitCode, 28, "the exit's other ports");

	// Computers are separate: another computer's server is out of reach, its own is not.
	const other = new CompanyComputerLinuxShell(
		createCompanyComputerLinuxShellLauncher({
			binding: { ...computerBinding(), screenId: "00000000-0000-4000-8000-0000000000b2", screenOrdinal: 2 },
			layout,
			workbenchMount,
			limits,
			runtimeRoot: "/run/office-screens",
			boundary: { assertReady: async () => undefined },
		}),
	);
	try {
		const otherServer = (
			await other.start({
				runId: SHELL_RUN,
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

	// The plumber takes the office account's word for nothing: a namespace whose
	// program already runs, or any other process, is refused before anything changes.
	const ask = (request: string) =>
		new Promise<string>((resolve, reject) => {
			const socket = createConnection("/run/qorpera-computer-network/plumb.sock");
			let answer = "";
			socket.setEncoding("utf8");
			socket.on("data", (text: string) => {
				answer += text;
			});
			socket.on("end", () => resolve(answer));
			socket.on("error", reject);
			socket.end(`${request}\n`);
		});
	// The namespace's own Tini (its program runs, so nothing waits at the gate),
	// Bubblewrap's monitor outside it, and any other process.
	const monitor = shell.namespacePid;
	const tini = (await readFile(`/proc/${monitor}/task/${monitor}/children`, "utf8")).trim();
	assert.match(tini, /^[0-9]+$/);
	assert.match(await readFile(`/proc/${tini}/cmdline`, "utf8"), /^\/usr\/bin\/tini\0/);
	for (const pid of [tini, monitor, process.pid])
		assert.equal(await ask(`plumb 1 shell ${pid}`), "refused process\n", `pid ${pid}`);
	assert.match(await done("cat /proc/net/dev"), /^ *eth0:/m);

	// The browser's relay looks names up and connects by the agent card too.
	assert.equal(companyComputerAgentPlugAddress(), "10.210.1.1");
	const relayStop = new AbortController();
	const relay = await startCompanyComputerBrowserEgress({
		root: await mkdtemp("/tmp/egress-"),
		assertActive: async () => undefined,
		signal: relayStop.signal,
		onFailure: () => undefined,
	});
	const relayed = () =>
		new Promise<string>((resolve) => {
			const socket = createConnection(relay.path);
			let answer = "";
			socket.setEncoding("utf8");
			socket.on("data", (text: string) => {
				answer += text;
			});
			socket.on("error", () => undefined);
			socket.on("close", () => resolve(answer));
			socket.setTimeout(8000, () => socket.destroy());
			socket.write("CONNECT pub.example:443 HTTP/1.1\r\nHost: pub.example:443\r\n\r\n");
		});
	const relayedAnswer = "HTTP/1.1 200 Connection Established\r\n\r\nrelay:10.210.1.1";
	assert.equal(await relayed(), relayedAnswer);
	// Without the card's routing (an accident) nothing leaves by the machine's
	// first card either: its firewall drops what would, so the way out fails closed.
	assert.equal(await ask("test-route fault"), "done\n");
	try {
		const leaking = await run("curl -sS --max-time 4 http://93.184.216.34:8080/from");
		assert.equal((await settled(leaking.sessionId, leaking)).exitCode, 28, "a computer without the card's routing");
		assert.equal(await relayed(), "", "the relay without the card's routing");
		const direct = await new Promise<string>((resolve) => {
			const socket = createConnection({ host: "93.184.216.34", port: 443, localAddress: "10.210.1.1" });
			const settle = (outcome: string): void => {
				socket.destroy();
				resolve(outcome);
			};
			socket.once("connect", () => settle("connected"));
			socket.once("error", (error: NodeJS.ErrnoException) => settle(error.code ?? "error"));
			socket.setTimeout(3000, () => settle("timeout"));
		});
		assert.notEqual(direct, "connected", "the card's address without its routing");
	} finally {
		assert.equal(await ask("test-firewall up"), "done\n");
	}
	assert.equal(await relayed(), relayedAnswer);
	assert.equal(await done("curl -sS --max-time 10 http://93.184.216.34:8080/from"), "public:10.210.1.1");
	relayStop.abort();
	await relay.close();

	// Without the machine's firewall (an accident), each computer's own filter
	// still keeps every private address and the machine out of reach, and a new
	// computer gets no network at all.
	assert.equal(await ask("test-firewall flush"), "done\n");
	try {
		for (const target of ["10.9.9.9:8080", `10.253.1.1:${canaryPort}`]) {
			const fetching = await run(`curl -sS --max-time 4 http://${target}/`);
			assert.equal((await settled(fetching.sessionId, fetching)).exitCode, 28, target);
		}
		const unplumbed = new CompanyComputerLinuxShell(
			createCompanyComputerLinuxShellLauncher({
				binding: { ...computerBinding(), screenId: "00000000-0000-4000-8000-0000000000b3", screenOrdinal: 3 },
				layout,
				workbenchMount,
				limits,
				runtimeRoot: "/run/office-screens",
				boundary: { assertReady: async () => undefined },
			}),
		);
		try {
			let devices = await unplumbed.result({
				sessionId: (
					await unplumbed.start({ runId: SHELL_RUN, key: randomUUID(), command: "cat /proc/net/dev", signal })
				).sessionId,
				waitMs: 10000,
				signal,
			});
			for (let attempt = 0; devices.state === "running" && attempt < 6; attempt++)
				devices = await unplumbed.result({ sessionId: devices.sessionId, waitMs: 10000, signal });
			assert.equal(devices.exitCode, 0, devices.output);
			assert.match(devices.output, /^ *lo:/m);
			assert.doesNotMatch(devices.output, /eth0/);
		} finally {
			await unplumbed.close();
		}
		// Stopping the machine's network removes every computer's link first.
		assert.equal(await ask("test-firewall down"), "done\n");
		assert.doesNotMatch(await done("cat /proc/net/dev"), /eth0/);
	} finally {
		assert.equal(await ask("test-firewall up"), "done\n");
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

	// Busy is processor time in the whole namespace: a server that only waits is
	// not busy (the computer may sleep), a loop is (it keeps the computer awake).
	const sample = async () => {
		const pid = shell!.namespacePid!;
		const usage = (await readCompanyComputerShellUsage([pid])).get(pid)!;
		return { cpuTicks: usage.cpuTicks, ioBytes: usage.ioBytes, at: Date.now() };
	};
	const waiting = await run(
		"node -e \"require('http').createServer(()=>{}).listen(8001,'127.0.0.1',()=>console.log('listening'))\"",
		3000,
	);
	assert.match(await printed(waiting.sessionId, waiting.output, "listening"), /listening/);
	assert.ok(shell.report().open.some((open) => open.id === waiting.sessionId && open.runId === SHELL_RUN));
	let before = await sample();
	await delay(3000);
	assert.equal(companyComputerShellBusy(before, await sample()), false, "a waiting server is not busy");
	const loop = await run("timeout 4 sh -c 'while :; do :; done'", 200);
	assert.equal(loop.state, "running");
	before = await sample();
	await delay(3000);
	assert.equal(companyComputerShellBusy(before, await sample()), true, "a busy loop is busy");
	assert.equal((await settled(loop.sessionId, await read(loop.sessionId, 5000))).state, "exited");
	before = await sample();
	await delay(3000);
	assert.equal(companyComputerShellBusy(before, await sample()), false, "once the loop ends, the server waits again");
	// Moving data is busy too: a download throttled to 64 KB a second uses almost no processor, and the office reads
	// what the shell's commands read and write (/proc/<pid>/io) from outside their namespace. The file comes from the
	// shell's own localhost: by now the probe has taken the computers' network down and up again.
	const serving = await run(
		"node -e \"require('http').createServer((q,s)=>{const c=Buffer.alloc(65536);let n=1024;const w=()=>{while(n-->0){if(!s.write(c))return s.once('drain',w)}s.end()};w()}).listen(8002,'127.0.0.1',()=>console.log('serving'))\"",
		3000,
	);
	assert.match(await printed(serving.sessionId, serving.output, "serving"), /serving/);
	const download = await run("curl -sS --limit-rate 64k -o /tmp/large http://127.0.0.1:8002/", 200);
	assert.equal(download.state, "running", download.output);
	before = await sample();
	await delay(3000);
	const during = await sample();
	assert.ok(
		during.ioBytes - before.ioBytes >= 100 * 1024,
		`the download's bytes are seen: ${during.ioBytes - before.ioBytes}`,
	);
	assert.equal(
		companyComputerShellBusy({ ...before, ioBytes: 0 }, { ...during, ioBytes: 0 }),
		false,
		"by processor alone the download looks idle",
	);
	assert.equal(companyComputerShellBusy(before, during), true, "the download is busy by the data it moves");
	assert.equal((await stop(download.sessionId)).state, "stopped");
	assert.equal((await stop(serving.sessionId)).state, "stopped");
	// A program left running in the background, after its command has ended, still counts: it lives on under the
	// namespace's init, outside the shell host's tree. With the server stopped, its own writes are all that moves.
	assert.equal(
		await done(
			"nohup sh -c 'while :; do head -c 65536 /dev/zero > /tmp/background; sleep 0.5; done' >/dev/null 2>&1 & echo $! > /tmp/background.pid; echo left",
		),
		"left\n",
	);
	assert.equal(
		await done(
			'while read -r key value; do [ "$key" != PPid: ] || echo "$value"; done < /proc/$(cat /tmp/background.pid)/status',
		),
		"1\n",
		"the background program left the shell host's tree for the namespace's init (Tini, PID 1)",
	);
	before = await sample();
	await delay(3000);
	const background = await sample();
	assert.equal(
		companyComputerShellBusy({ ...before, ioBytes: 0 }, { ...background, ioBytes: 0 }),
		false,
		"by processor alone the background program looks idle",
	);
	assert.equal(companyComputerShellBusy(before, background), true, "a background program is busy by its data");
	assert.equal(await done("kill $(cat /tmp/background.pid) && echo stopped"), "stopped\n");
	before = await sample();
	await delay(3000);
	assert.equal(companyComputerShellBusy(before, await sample()), false, "the waiting server still moves nothing");
	assert.equal((await stop(waiting.sessionId)).state, "stopped");

	// Never the screen's display (any X client of it could read what a member
	// types there): no DISPLAY, no X socket, and none of the display server's
	// sockets in reach, while this machine itself can connect to them.
	const xConnect = (path: string) =>
		new Promise<string>((resolve) => {
			const socket = createConnection(path);
			socket.once("connect", () => {
				socket.destroy();
				resolve("connected");
			});
			socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
		});
	assert.equal(await xConnect("\0/tmp/.X11-unix/X1"), "connected", "the display's abstract socket");
	assert.equal(await xConnect("/tmp/office-x/X1"), "connected", "the display's socket file");
	assert.equal(
		await done(`set -u
test -z "\${DISPLAY-}" || exit 31
test ! -e /tmp/.X11-unix || exit 32
test ! -e /tmp/office-x || exit 33
node -e 'for (const p of ["\\0/tmp/.X11-unix/X1", "/tmp/.X11-unix/X1", "/tmp/office-x/X1"]) { const s = require("net").connect(p); s.on("connect", () => process.exit(34)); s.on("error", () => {}); } setTimeout(() => process.exit(0), 2000);' || exit $?
if xdotool getdisplaygeometry >/dev/null 2>&1; then exit 35; fi
if DISPLAY=:1 xdotool getdisplaygeometry >/dev/null 2>&1; then exit 36; fi
printf no-display`),
		"no-display",
	);

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
