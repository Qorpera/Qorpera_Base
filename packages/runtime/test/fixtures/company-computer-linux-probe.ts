import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile, readlink, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { CompanyComputerLinuxCommands } from "../../src/cloud-company-computer-linux-commands.ts";
import { companyComputerLinuxSandboxArgs } from "../../src/cloud-company-computer-linux-host.ts";
import { spawnCompanyComputerLinuxProcess } from "../../src/cloud-company-computer-linux-process.ts";
import { parseRecoveryDirectoryMount } from "../../src/cloud-identity-recovery-filesystems.ts";
import { cloudToolRequest } from "../../src/cloud-native-tool-authority.ts";
import { computerBinding } from "./company-computer.ts";

// Disposable Linux fixture only. Its synthetic mount pin and readiness callback
// are not office provisioning/adoption authority or a production acceptance test.
assert.equal(process.platform, "linux");
assert.equal(process.getuid?.(), 1000);
const status = await readFile("/proc/self/status", "utf8");
assert.match(status, /^CapEff:\s+0+$/m);
assert.match(status, /^CapBnd:\s+0+$/m);
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
const limits = { memoryBytes: 536870912, pids: 128, cpuQuota: 100000, cpuPeriod: 100000 };
let ready = true;
const options = {
	binding: computerBinding(),
	layout,
	workbenchMount,
	limits,
	xSocket: "/tmp/office-x/X1",
	captureRoot: "/run/office-captures",
	boundary: {
		async assertReady() {
			if (!ready) throw new Error("FIXTURE_BOUNDARY_REVOKED");
		},
	},
};
const commands = new CompanyComputerLinuxCommands(options);
const input = {
	program: "/bin/bash",
	args: [] as string[],
	environment: { DISPLAY: ":1", PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
	workingDirectory: layout.workbenchRoot,
	timeoutMs: 5000,
	maxOutputBytes: 16384,
	signal: new AbortController().signal,
};
async function shell(script: string) {
	const result = await commands.run({ ...input, args: ["--noprofile", "--norc", "-c", script] });
	assert.equal(result.code, 0, result.stderr);
	return result.stdout;
}
async function until(check: () => Promise<boolean>) {
	for (let i = 0; i < 100; i++) {
		if (await check()) return;
		await delay(25);
	}
	throw new Error("LINUX_FIXTURE_WAIT_TIMEOUT");
}
const exists = async (path: string) =>
	lstat(path).then(
		() => true,
		() => false,
	);
const server = createServer((socket) => socket.end("HOST_NETWORK_CANARY"));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const xvfb = spawn("/usr/bin/Xvfb", [":1", "-screen", "0", "1920x1200x24", "-nolisten", "tcp", "-ac", "-noreset"], {
	env: { PATH: "/usr/bin:/bin" },
	stdio: ["ignore", "ignore", "pipe"],
});
const xExited = new Promise<void>((resolve) => xvfb.once("close", () => resolve()));
let xErrors = "";
xvfb.stderr.on("data", (bytes: Buffer) => {
	xErrors += bytes.toString();
});
try {
	await until(() => exists("/tmp/.X11-unix/X1")).catch((error) => {
		throw new Error(`${error}: ${xErrors}`);
	});
	await rename("/tmp/.X11-unix/X1", options.xSocket);
	await writeFile("/srv/profiles/credential-canary", "SYNTHETIC_PROFILE_SECRET");
	process.env.QORPERA_SYNTHETIC_SECRET = "SYNTHETIC_SERVICE_SECRET";
	assert.equal(
		await shell("printf 'persistent-workbench' > result; printf 'desktop-state' > \"$HOME/state\"; cat result"),
		"persistent-workbench",
	);
	assert.equal(await readFile("/srv/desktop/state", "utf8"), "desktop-state");
	assert.equal(await shell("cat result"), "persistent-workbench");
	const namespace = await readlink("/proc/self/ns/net");
	assert.equal(
		await shell(`set -eu
test -z "\${QORPERA_SYNTHETIC_SECRET-}"
test "$HOME" = /home/qorpera
test ! -e /srv/profiles/credential-canary
test ! -e /proc/1/root/srv/profiles/credential-canary
test ! -e /run/office-captures
test ! -e /run/office-x
test ! -e /sys/fs/cgroup
test ! -e /tmp/.X11-unix/X2
test "$(readlink /proc/self/ns/net)" != '${namespace}'
test -z "$(ls /sys 2>/dev/null || true)"
if timeout 1 bash -c 'echo canary >/dev/tcp/127.0.0.1/${address.port}' 2>/dev/null; then exit 19; fi
if unshare --user --map-root-user true 2>/dev/null; then exit 20; fi
if touch /usr/office-write-canary 2>/dev/null; then exit 21; fi
printf isolated`),
		"isolated",
	);
	const geometry = await commands.run({ ...input, program: "/usr/bin/xdotool", args: ["getdisplaygeometry"] });
	assert.equal(geometry.code, 0, geometry.stderr);
	assert.equal(geometry.stdout.trim(), "1920 1200");
	const png = Buffer.from(
		await commands.capturePng({ display: ":1", maxBytes: 16 * 1024 * 1024, signal: input.signal }),
	);
	assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
	assert.equal(png.readUInt32BE(16), 1920);
	assert.equal(png.readUInt32BE(20), 1200);
	assert.deepEqual(await readdir(options.captureRoot), []);
	await assert.rejects(
		commands.capturePng({ display: ":1", maxBytes: 33, signal: input.signal }),
		/INVALID_OFFICE_CAPTURE/,
	);
	assert.deepEqual(await readdir(options.captureRoot), []);
	await assert.rejects(
		commands.run({ ...input, args: ["-c", "yes output"], maxOutputBytes: 100 }),
		/OFFICE_COMMAND_OUTPUT_LIMIT/,
	);
	// Stop in the same JavaScript turn as spawn, before the trusted gate can
	// report that namespace PID 1 has armed its parent-death signal. The previous
	// direct monitor kill could orphan that namespace during bwrap's setup fork.
	const workbenchFd = await open(layout.workbenchRoot, constants.O_RDONLY | constants.O_DIRECTORY);
	try {
		for (let attempt = 0; attempt < 12; attempt++) {
			const launched = spawnCompanyComputerLinuxProcess({
				args: [...companyComputerLinuxSandboxArgs(), "--bind-fd", "3", layout.workbenchRoot],
				files: [workbenchFd],
				stdin: "ignore",
				command: ["/usr/bin/bash", "-c", "touch /srv/workbench/early-start-must-not-exist; sleep 30"],
			});
			const exited = new Promise<void>((resolve) => launched.child.once("close", () => resolve()));
			launched.child.stdout!.resume();
			launched.child.stderr!.resume();
			launched.stop();
			await assert.rejects(launched.started, /OFFICE_PROCESS_(GATE_CANCELLED|EXITED_BEFORE_START)/);
			await cloudToolRequest(() => exited, input.signal, 5000);
		}
	} finally {
		await workbenchFd.close();
	}
	assert.equal(await exists("/srv/workbench/early-start-must-not-exist"), false);
	// Exercise the public runner with a deadline inside the same startup window.
	for (let attempt = 0; attempt < 8; attempt++) {
		await assert.rejects(
			commands.run({
				...input,
				timeoutMs: 1,
				args: [
					"-c",
					"setsid bash -c 'while true; do echo tick >> /srv/workbench/early-ticks; sleep 0.03; done' </dev/null >/dev/null 2>&1 & sleep 30",
				],
			}),
			/OFFICE_COMMAND_TIMEOUT/,
		);
	}
	const earlyTicks = await readFile("/srv/workbench/early-ticks", "utf8").catch(() => "");
	await delay(250);
	assert.equal(await readFile("/srv/workbench/early-ticks", "utf8").catch(() => ""), earlyTicks);
	for (const kind of ["timeout", "cancel", "close"] as const) {
		const stop = new AbortController();
		const marker = `${layout.workbenchRoot}/${kind}-ticks`;
		const pending = commands.run({
			...input,
			signal: stop.signal,
			timeoutMs: kind === "timeout" ? 1000 : 5000,
			args: [
				"-c",
				`setsid bash -c 'while true; do echo tick >> ${marker}; sleep 0.03; done' </dev/null >/dev/null 2>&1 & sleep 30`,
			],
		});
		const failed = assert.rejects(pending, /OFFICE_COMMAND_(TIMEOUT|CANCELLED)/);
		await until(() => exists(marker));
		if (kind === "cancel") stop.abort();
		if (kind === "close") await commands.close();
		await failed;
		const afterExit = await readFile(marker, "utf8");
		await delay(250);
		assert.equal(await readFile(marker, "utf8"), afterExit, `${kind} left detached descendants running`);
	}
	await assert.rejects(commands.run({ ...input, args: ["-c", "echo reopened"] }));
	const staleMount = new CompanyComputerLinuxCommands({
		...options,
		workbenchMount: { ...workbenchMount, source: "missing-fixture-mount" },
	});
	try {
		await assert.rejects(
			staleMount.run({ ...input, args: ["-c", "touch must-not-exist"] }),
			/OFFICE_WORKBENCH_MOUNT_CHANGED/,
		);
	} finally {
		await staleMount.close();
	}
	assert.equal(await exists("/srv/workbench/must-not-exist"), false);
	for (const changed of [
		{ memoryBytes: limits.memoryBytes - 1 },
		{ pids: limits.pids - 1 },
		{ cpuQuota: limits.cpuQuota - 1 },
	]) {
		const undersized = new CompanyComputerLinuxCommands({ ...options, limits: { ...limits, ...changed } });
		try {
			await assert.rejects(
				undersized.run({ ...input, args: ["-c", "touch must-not-exist"] }),
				/OFFICE_COMMAND_LIMITS_UNAVAILABLE/,
			);
		} finally {
			await undersized.close();
		}
		assert.equal(await exists("/srv/workbench/must-not-exist"), false);
	}
	let checks = 0;
	const lostAuthority = new CompanyComputerLinuxCommands({
		...options,
		boundary: {
			async assertReady() {
				if (++checks > 1) throw new Error("FIXTURE_BOUNDARY_REVOKED");
			},
		},
	});
	try {
		await assert.rejects(
			lostAuthority.run({ ...input, args: ["-c", "touch effect-before-revocation; echo result-must-not-escape"] }),
			/FIXTURE_BOUNDARY_REVOKED/,
		);
	} finally {
		await lostAuthority.close();
	}
	assert.equal(await exists("/srv/workbench/effect-before-revocation"), true);
	const revoked = new CompanyComputerLinuxCommands(options);
	ready = false;
	try {
		await assert.rejects(revoked.run({ ...input, args: ["-c", "touch must-not-exist"] }), /FIXTURE_BOUNDARY_REVOKED/);
	} finally {
		await revoked.close();
	}
	assert.equal(await exists("/srv/workbench/must-not-exist"), false);
	console.log(
		JSON.stringify({
			schema: "qorpera.office-linux-commands-proof/v1",
			platform: process.platform,
			arch: process.arch,
			node: process.version,
			uid: process.getuid?.(),
			syntheticAuthority: true,
			zeroCapabilities: true,
			finiteCgroupCeilingsChecked: true,
			sharedWorkbenchPersistence: true,
			privateDesktopHome: true,
			serviceEnvironmentAbsent: true,
			profileAndHostPathsAbsent: true,
			hostNetworkAbsent: true,
			nestedUserNamespaceDenied: true,
			assignedXSocket: true,
			screenshot: { bytes: png.length, width: 1920, height: 1200 },
			captureCleanup: true,
			boundedOutput: true,
			immediateStartupStopReaped: 12,
			earlyCommandTimeoutReaped: 8,
			timeoutReapsDetachedDescendants: true,
			cancelReapsDetachedDescendants: true,
			closeReapsDetachedDescendants: true,
			mountMismatchDenied: true,
			revokedBoundaryDenied: true,
			revokedResultWithheld: true,
			realProviderCalls: false,
		}),
	);
} finally {
	await commands.close();
	xvfb.kill("SIGKILL");
	await xExited;
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
