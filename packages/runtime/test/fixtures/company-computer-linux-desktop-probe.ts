import assert from "node:assert/strict";
import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { CompanyComputerScreenBinding } from "@qorpera/cloud-client/cloud-company-computer-contract";
import { prepareCompanyComputerScreenWallpaper } from "../../src/cloud-company-computer-desktop.ts";
import { CompanyComputerLinuxCommands } from "../../src/cloud-company-computer-linux-commands.ts";
import { CompanyComputerLinuxDesktopLauncher } from "../../src/cloud-company-computer-linux-desktop.ts";
import { parseRecoveryDirectoryMount } from "../../src/cloud-identity-recovery-filesystems.ts";
import { computerBinding, computerId, computerScope } from "./company-computer.ts";

// Real Linux desktop/command/RFB effects; authority, adoption and mount
// provisioning are synthetic fixture inputs, never production acceptance.
assert.equal(process.platform, "linux");
assert.equal(process.getuid?.(), 1000);
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
const limits = { memoryBytes: 1073741824, pids: 256, cpuQuota: 200000, cpuPeriod: 100000 };
let admitted = true;
const boundary = {
	async assertReady() {
		if (!admitted) throw new Error("FIXTURE_OFFICE_REVOKED");
	},
};
const options = {
	scope: computerScope(),
	computerGeneration: 1,
	layout,
	workbenchMount,
	limits,
	runtimeRoot: "/run/office-screens",
	boundary,
};
const launcher = new CompanyComputerLinuxDesktopLauncher(options);
const bindings = [
	computerBinding(),
	{ ...computerBinding(), screenId: computerId(60), screenOrdinal: 2, staffAgentId: computerId(50) },
];
const running: CompanyComputerLinuxCommands[] = [];
const signal = AbortSignal.timeout(60000);
function commands(binding: CompanyComputerScreenBinding) {
	const command = new CompanyComputerLinuxCommands({
		binding,
		layout,
		boundary,
		limits,
		workbenchMount,
		xSocket: launcher.xSocket(binding),
		captureRoot: "/run/office-captures",
	});
	running.push(command);
	return command;
}
// A shell command never gets the screen's display; the screen's own tools do.
async function shell(command: CompanyComputerLinuxCommands, script: string) {
	const result = await command.run({
		program: "/bin/bash",
		args: ["--noprofile", "--norc", "-c", script],
		environment: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
		workingDirectory: layout.workbenchRoot,
		timeoutMs: 5000,
		maxOutputBytes: 16384,
		signal,
	});
	assert.equal(result.code, 0, result.stderr);
	return result.stdout.trim();
}
async function xdo(command: CompanyComputerLinuxCommands, binding: CompanyComputerScreenBinding, ...args: string[]) {
	const result = await command.run({
		program: "/usr/bin/xdotool",
		args,
		environment: { DISPLAY: `:${binding.screenOrdinal}`, PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
		workingDirectory: layout.workbenchRoot,
		timeoutMs: 5000,
		maxOutputBytes: 16384,
		signal,
	});
	assert.equal(result.code, 0, result.stderr);
	return result.stdout.trim();
}
async function handshake(socket: Socket) {
	let buffered = Buffer.alloc(0);
	let wake: () => void = () => undefined;
	let failure: Error | undefined;
	socket.on("data", (bytes: Buffer) => {
		buffered = Buffer.concat([buffered, bytes]);
		wake();
	});
	socket.on("error", () => {
		failure = new Error("RFB_FIXTURE_ERROR");
		wake();
	});
	socket.on("close", () => {
		failure = new Error("RFB_FIXTURE_CLOSED");
		wake();
	});
	const take = async (length: number) => {
		while (buffered.length < length) {
			if (failure) throw failure;
			await Promise.race([
				new Promise<void>((resolve) => {
					wake = resolve;
				}),
				delay(2000).then(() => {
					throw new Error("RFB_FIXTURE_TIMEOUT");
				}),
			]);
		}
		const result = buffered.subarray(0, length);
		buffered = buffered.subarray(length);
		return result;
	};
	assert.equal((await take(12)).toString(), "RFB 003.008\n");
	socket.write("RFB 003.008\n");
	const count = (await take(1))[0];
	assert.ok(count > 0 && count < 10);
	assert.ok((await take(count)).includes(1));
	socket.write(Buffer.from([1]));
	assert.equal((await take(4)).readUInt32BE(0), 0);
	socket.write(Buffer.from([1]));
	const init = await take(24);
	assert.equal(init.readUInt16BE(0), 1920);
	assert.equal(init.readUInt16BE(2), 1200);
	assert.equal(init[4], 32);
	assert.equal(init[5], 24);
	const nameLength = init.readUInt32BE(20);
	assert.ok(nameLength < 128);
	assert.match((await take(nameLength)).toString(), /^Qorpera Screen [12]$/);
}
try {
	for (const binding of bindings)
		await prepareCompanyComputerScreenWallpaper({ binding, layout, boundary, creature: "pebble" }, signal);
	const thirdBinding = {
		...computerBinding(),
		screenId: computerId(61),
		screenOrdinal: 3,
		staffAgentId: computerId(51),
	};
	await assert.rejects(launcher.launch(thirdBinding, signal), { code: "ENOENT" });
	assert.deepEqual(await readdir(options.runtimeRoot), []);
	await mkdir(`/srv/screens/${thirdBinding.screenId}`, { mode: 0o700 });
	const missingWallpaper = await launcher.launch(thirdBinding, signal);
	await assert.rejects(missingWallpaper.ready, /OFFICE_DESKTOP_EXITED/);
	await missingWallpaper.exited;
	assert.deepEqual(await readdir(options.runtimeRoot), []);
	await prepareCompanyComputerScreenWallpaper({ binding: thirdBinding, layout, boundary, creature: "pebble" }, signal);
	const cancelledStart = new AbortController();
	const cancelledDesktop = await launcher.launch(thirdBinding, cancelledStart.signal);
	cancelledStart.abort();
	await assert.rejects(cancelledDesktop.ready);
	await cancelledDesktop.stop();
	assert.deepEqual(await readdir(options.runtimeRoot), []);
	const autostart = `/srv/screens/${bindings[0].screenId}/config/autostart`;
	await mkdir(autostart, { recursive: true, mode: 0o700 });
	await writeFile(
		`${autostart}/detached-proof.desktop`,
		`[Desktop Entry]\nType=Application\nName=Detached lifecycle fixture\nExec=/usr/bin/setsid /usr/bin/bash -c "while true; do echo tick >> /srv/workbench/desktop-ticks; sleep 0.03; done"\nTerminal=false\n`,
		{ mode: 0o600 },
	);
	// HTTPS from inside the desktop, with certificate checks: a server on the desktop's own loopback, its certificate
	// signed by a CA the image trusts (the proof adds one, as the public ones are), and curl as the Terminal runs it.
	for (const name of ["tls-proof-key.pem", "tls-proof-cert.pem"])
		await writeFile(`/srv/workbench/${name}`, await readFile(`/opt/probe/${name}`), { mode: 0o600 });
	await writeFile(
		"/srv/workbench/tls-proof-server.mjs",
		`import { readFileSync } from "node:fs";\nimport { createServer } from "node:https";\ncreateServer({ key: readFileSync("/srv/workbench/tls-proof-key.pem"), cert: readFileSync("/srv/workbench/tls-proof-cert.pem") }, (_request, response) => response.end("verified\\n")).listen(8443, "127.0.0.1");\n`,
	);
	await writeFile(
		"/srv/workbench/tls-proof.sh",
		`/usr/bin/node /srv/workbench/tls-proof-server.mjs &\nserver=$!\n/usr/bin/curl --silent --show-error --retry 30 --retry-delay 1 --retry-connrefused https://127.0.0.1:8443/ > /srv/workbench/tls-proof.partial 2>&1\necho "exit=$?" >> /srv/workbench/tls-proof.partial\nmv /srv/workbench/tls-proof.partial /srv/workbench/tls-proof\nkill "$server"\n`,
	);
	await writeFile(
		`${autostart}/tls-proof.desktop`,
		`[Desktop Entry]\nType=Application\nName=HTTPS fixture\nExec=/usr/bin/bash /srv/workbench/tls-proof.sh\nTerminal=false\n`,
		{ mode: 0o600 },
	);
	const firstStart = new AbortController();
	const firstLaunching = launcher.launch(bindings[0], firstStart.signal);
	await assert.rejects(launcher.launch(bindings[0], signal), /OFFICE_DESKTOP_ALREADY_OCCUPIED/);
	const first = await firstLaunching;
	await first.ready;
	firstStart.abort(); // A completed reconciliation/request does not own the desktop.
	const second = await launcher.launch(bindings[1], signal);
	await second.ready;
	for (let attempt = 0; attempt < 100; attempt++) {
		if (
			await readFile("/srv/workbench/desktop-ticks", "utf8").then(
				() => true,
				() => false,
			)
		)
			break;
		await delay(25);
	}
	assert.ok((await readFile("/srv/workbench/desktop-ticks", "utf8")).includes("tick"));
	let tls = "";
	for (let attempt = 0; attempt < 400 && !tls; attempt++) {
		tls = await readFile("/srv/workbench/tls-proof", "utf8").catch(() => "");
		if (!tls) await delay(100);
	}
	assert.equal(tls, "verified\nexit=0\n", "the desktop verifies HTTPS against the image's CA store");
	// Internet for the Terminal is the desktop's own network from the root
	// plumber, not a proxy: what the desktop starts carries no proxy settings and
	// resolves through public name servers. This proof has no plumber, so the
	// desktop keeps loopback only, never an unfiltered network.
	const processes: { pid: string; command: string; environment: string }[] = [];
	for (const pid of (await readdir("/proc")).filter((name) => /^[0-9]+$/.test(name))) {
		const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
		const environment = await readFile(`/proc/${pid}/environ`, "utf8").catch(() => "");
		processes.push({ pid, command: command.replaceAll("\0", " "), environment });
	}
	const started = processes.find((entry) => entry.command.includes("desktop-ticks"));
	assert.ok(started, "the autostart fixture is running");
	assert.ok(
		!/^(HTTPS?_PROXY|https?_proxy|ALL_PROXY|NO_PROXY)=/m.test(started.environment.replaceAll("\0", "\n")),
		started.environment,
	);
	assert.match(await readFile(`/proc/${started.pid}/root/etc/resolv.conf`, "utf8"), /^nameserver 1\.1\.1\.1\n/);
	const devices = await readFile(`/proc/${started.pid}/net/dev`, "utf8");
	assert.match(devices, /^ *lo:/m);
	assert.doesNotMatch(devices, /eth0/);
	assert.equal(processes.filter((entry) => entry.command.includes("--network-proxy")).length, 0);
	const firstCommands = commands(bindings[0]);
	const secondCommands = commands(bindings[1]);
	assert.notEqual(launcher.xSocket(bindings[0]), launcher.xSocket(bindings[1]));
	await shell(firstCommands, "printf shared-from-first > shared.txt");
	await xdo(firstCommands, bindings[0], "mousemove", "120", "230");
	assert.match(
		await xdo(firstCommands, bindings[0], "getmouselocation", "--shell"),
		/^X=120\nY=230\nSCREEN=0\nWINDOW=[0-9]+$/,
	);
	assert.equal(await shell(secondCommands, "cat shared.txt"), "shared-from-first");
	await xdo(secondCommands, bindings[1], "mousemove", "420", "530");
	assert.match(await xdo(firstCommands, bindings[0], "getmouselocation", "--shell"), /^X=120\nY=230\n/);
	assert.match(await xdo(secondCommands, bindings[1], "getmouselocation", "--shell"), /^X=420\nY=530\n/);
	assert.equal(
		await shell(
			firstCommands,
			`test ! -e /srv/profiles; test ! -e /run/office-screens; test ! -e /tmp/.X11-unix; test -z "\${DISPLAY-}"; printf contained`,
		),
		"contained",
	);
	for (const binding of bindings) {
		const socket = await launcher.connectRfb(binding, signal);
		await handshake(socket);
		socket.destroy();
	}
	await delay(250);
	assert.equal(await xdo(firstCommands, bindings[0], "getdisplaygeometry"), "1920 1200");
	const png = Buffer.from(await firstCommands.capturePng({ display: ":1", signal, maxBytes: 16777216 }));
	assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
	assert.equal(png.readUInt32BE(16), 1920);
	assert.equal(png.readUInt32BE(20), 1200);
	assert.ok(png.length > 10000, "Expected the actual XFCE desktop, not an empty framebuffer");
	await writeFile("/opt/probe-artifacts/desktop.png", png, { mode: 0o600, flag: "wx" });
	await assert.rejects(launcher.launch(bindings[0], signal), /OFFICE_DESKTOP_ALREADY_OCCUPIED/);
	assert.throws(() => launcher.xSocket({ ...bindings[0], screenGeneration: 2 }), /SCREEN_BINDING_MISMATCH/);
	await writeFile(`/srv/screens/${bindings[0].screenId}/preserved-setting`, "survives-close-and-reopen");
	const watching = await launcher.connectRfb(bindings[0], signal);
	await handshake(watching);
	const viewerClosed = new Promise<void>((resolve) => watching.once("close", resolve));
	await firstCommands.close();
	await first.stop();
	await first.exited;
	await viewerClosed;
	const stoppedTicks = await readFile("/srv/workbench/desktop-ticks", "utf8");
	await delay(250);
	assert.equal(
		await readFile("/srv/workbench/desktop-ticks", "utf8"),
		stoppedTicks,
		"Detached desktop daemon survived stop",
	);
	assert.throws(() => launcher.xSocket(bindings[0]), /OFFICE_DESKTOP_NOT_READY/);
	assert.equal(
		await readFile(`/srv/screens/${bindings[0].screenId}/preserved-setting`, "utf8"),
		"survives-close-and-reopen",
	);
	assert.equal(await shell(secondCommands, "cat shared.txt"), "shared-from-first");
	const reopened = await launcher.launch(bindings[0], signal);
	await reopened.ready;
	await reopened.stop();
	admitted = false;
	await assert.rejects(launcher.launch(bindings[0], signal), /FIXTURE_OFFICE_REVOKED/);
	await launcher.close();
	await second.exited;
	assert.deepEqual(await readdir(options.runtimeRoot), []);
	assert.equal(await readFile("/srv/workbench/shared.txt", "utf8"), "shared-from-first");
	console.log(
		JSON.stringify({
			schema: "qorpera.office-linux-desktop-proof/v1",
			platform: process.platform,
			arch: process.arch,
			node: process.version,
			syntheticAuthority: true,
			desktops: 2,
			realXfce: true,
			privateRfbHandshake: true,
			sharedWorkbench: true,
			independentPointers: true,
			allViewersDisconnected: true,
			startupRequestLifetimeIndependent: true,
			capture: { bytes: png.length, width: 1920, height: 1200 },
			stoppedViewerClosed: true,
			persistentSettingsPreserved: true,
			reopenedDesktop: true,
			staleBindingDenied: true,
			missingAdoptedStateDenied: true,
			startupFailureReaped: true,
			startupCancellationReaped: true,
			duplicatePendingLaunchDenied: true,
			revokedLaunchDenied: true,
			serviceCloseReapedDesktops: true,
			detachedDesktopDaemonReaped: true,
			temporarySocketsRemoved: true,
			realProviderCalls: false,
		}),
	);
} finally {
	await Promise.all(running.map((command) => command.close()));
	await launcher.close();
}
