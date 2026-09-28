import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer } from "node:net";
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
// the office's namespace entry file, the broker relay) as the unprivileged
// office account. The container has no network; "public" hosts are local
// servers the relay's injected transport dials instead of the internet.
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
const limits = { memoryBytes: 1073741824, pids: 256, cpuQuota: 100000, cpuPeriod: 100000 };
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

// The stand-in for every public host, and a canary for the office's own
// loopback listeners (the service, viewer and native gateways).
const publicHost = createHttpServer((request, response) =>
	response.end(`public:${request.method} ${request.url} ${request.headers.host}`),
);
publicHost.on("connect", (_request, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
await new Promise<void>((resolve) => publicHost.listen(0, "127.0.0.1", resolve));
const publicPort = (publicHost.address() as { port: number }).port;
const canary = createServer((socket) => socket.end("HOST_NETWORK_CANARY"));
await new Promise<void>((resolve) => canary.listen(0, "127.0.0.1", resolve));
const canaryPort = (canary.address() as { port: number }).port;
const dialled: string[] = [];
const egressTransport = {
	resolve: async (host: string) => (host === "private.example.com" ? ["10.42.0.1"] : ["93.184.216.34"]),
	connect: (address: string, port: number) => {
		dialled.push(`${address}:${port}`);
		return createConnection({ host: "127.0.0.1", port: publicPort });
	},
};

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
			egressTransport,
		}),
	);
	const signal = new AbortController().signal;
	// Each model call is an effect (start, write, stop) and then a wait for its result.
	const read = (sessionId: string, waitMs = 10000) => shell!.result({ sessionId, waitMs, signal });
	const run = async (command: string, waitMs = 10000) =>
		read((await shell!.start({ key: randomUUID(), command, signal })).sessionId, waitMs);
	const stop = async (sessionId: string) => {
		await shell!.stop({ sessionId, signal });
		return read(sessionId, 4000);
	};
	const done = async (command: string) => {
		const result = await run(command);
		assert.equal(result.state, "exited", `${command}: ${result.output}`);
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
test "$HTTPS_PROXY" = http://127.0.0.1:3128
test ! -e /srv/profiles/credential-canary
test ! -e /run/office-screens
test ! -e /sys/fs/cgroup
test -S /run/qorpera-network/egress.sock
# No route out of the namespace: only loopback, no default or any other route
# (a kernel's inactive tunnel placeholders may still be listed as devices).
test "$(wc -l < /proc/net/route)" = 1
test -z "$(tail -n +3 /proc/net/dev | grep -v -E '^ *(lo|tunl0|sit0|ip6tnl0|ip6_vti0|ip_vti0|gre0|gretap0|erspan0|ip6gre0):' || true)"
if timeout 1 bash -c 'echo canary >/dev/tcp/127.0.0.1/${canaryPort}' 2>/dev/null; then exit 19; fi
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

	// Internet through the relay: plain HTTP, and CONNECT to any port.
	assert.equal(
		await done("curl -sS --max-time 10 http://files.example.com/hello"),
		"public:GET /hello files.example.com",
	);
	assert.equal(
		await done("curl -sS --max-time 10 -p http://tunnel.example.com:7000/via-connect"),
		"public:GET /via-connect tunnel.example.com:7000",
	);
	assert.deepEqual(dialled, ["93.184.216.34:80", "93.184.216.34:7000"]);
	// Never around the relay, and never to local, private or metadata addresses.
	for (const [command, expected] of [
		// Loopback skips the proxy (NO_PROXY), so force it for this one.
		[
			`curl -sS --max-time 5 --noproxy '' http://127.0.0.1:${canaryPort}/`,
			"local and private network addresses are not reachable",
		],
		[
			"curl -sS --max-time 5 http://169.254.169.254/latest/meta-data/",
			"local and private network addresses are not reachable",
		],
		["curl -sS --max-time 5 http://private.example.com/", "points at a local or private address"],
	]) {
		const output = await done(command);
		assert.ok(output.includes(expected), `${command}: ${output}`);
	}
	for (const command of [
		"curl -sS --max-time 5 --noproxy '*' http://93.184.216.34/",
		`curl -sS --max-time 5 http://127.0.0.1:${canaryPort}/`,
	]) {
		const direct = await run(command);
		assert.notEqual(direct.exitCode, 0, direct.output);
	}
	assert.equal(dialled.length, 2);
	if (await exists("/usr/bin/ssh")) {
		const ssh = await run(
			"ssh -v -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=5 git@code.example.com true 2>&1 | grep -m1 'Executing proxy command'",
		);
		assert.match(ssh.output, /office-browser-child\.mjs --connect code\.example\.com 22/);
		await until(() => dialled.includes("93.184.216.34:22"), "ssh through the relay");
	}

	// Commands share the shell's localhost: a server from one is reachable from the next.
	const server = await run(
		"node -e \"require('http').createServer((q,s)=>s.end('local-ok')).listen(8000,'127.0.0.1',()=>console.log('listening'))\"",
		3000,
	);
	assert.equal(server.state, "running", server.output);
	assert.equal(server.output.trim(), "listening");
	assert.equal(await done("curl -sS --max-time 5 http://localhost:8000/"), "local-ok");
	assert.equal((await stop(server.sessionId)).state, "stopped");

	// Input to a running command.
	const asking = await run('read -r answer; echo "got:$answer"', 200);
	assert.equal(asking.state, "running");
	await shell.write({ sessionId: asking.sessionId, text: "yes\n", endInput: false, signal });
	const answered = await read(asking.sessionId, 5000);
	assert.equal(answered.output, "got:yes\n");

	// The screen's display, as before.
	assert.equal((await done("xdotool getdisplaygeometry")).trim(), "1920 1200");

	// No 15-second stop: this runs for 17 seconds and finishes.
	const long = await run("sleep 17; echo survived", 1000);
	assert.equal(long.state, "running");
	let finished = await read(long.sessionId, 15000);
	if (finished.state === "running") finished = await read(long.sessionId, 10000);
	assert.equal(finished.state, "exited");
	assert.equal(finished.output, "survived\n");

	// Output past the kept tail is dropped, never fatal.
	const flood = await run("head -c 3000000 /dev/zero | tr '\\0' z; echo; echo END");
	assert.equal(flood.state, "exited");
	assert.match(flood.output, /^\[\d+ earlier bytes not kept\]\n/);
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
		"node -e \"globalThis.b=Buffer.alloc(700*1024*1024,1);console.log('holding');setInterval(()=>{},1000)\"",
		5000,
	);
	assert.equal(hog.state, "running", hog.output);
	const pid = shell.namespacePid;
	assert.ok(pid);
	const usage = (await readCompanyComputerShellUsage([pid])).get(pid)!;
	assert.ok(usage.memoryBytes > 600 * 1024 * 1024, JSON.stringify(usage));
	assert.ok(usage.tasks >= 3, JSON.stringify(usage));
	const guard = new CompanyComputerShellPressureGuard({ shells: () => [shell!], intervalMs: 500 });
	try {
		const stopped = await read(hog.sessionId, 10000);
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
	assert.deepEqual(await readdir("/run/office-screens"), []);
	process.stdout.write("Company Computer shell Linux proof passed\n");
} finally {
	await shell?.close().catch(() => undefined);
	xvfb.kill("SIGTERM");
	await xExited;
	publicHost.close();
	canary.close();
}
