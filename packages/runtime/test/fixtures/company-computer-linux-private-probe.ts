import assert from "node:assert/strict";
import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { CompanyComputerPrivacyChallenge } from "@qorpera/cloud-client/cloud-company-computer-privacy";
import type { CompanyComputerViewerGrant } from "@qorpera/cloud-client/cloud-company-computer-viewer";
import { prepareCompanyComputerScreenWallpaper } from "../../src/cloud-company-computer-desktop.ts";
import { CompanyComputerLinuxCommands } from "../../src/cloud-company-computer-linux-commands.ts";
import { CompanyComputerLinuxDesktopLauncher } from "../../src/cloud-company-computer-linux-desktop.ts";
import { startCompanyComputerLinuxPrivateSurface } from "../../src/cloud-company-computer-linux-private-surface.ts";
import { CloudCompanyComputerPrivateSurfaceControl } from "../../src/cloud-company-computer-private-surface-control.ts";
import { parseRecoveryDirectoryMount } from "../../src/cloud-identity-recovery-filesystems.ts";
import { computerBinding, computerId, computerLease, computerScope } from "./company-computer.ts";

// The sole synthetic sign-in content is typed through raw RFB in a disposable
// browser. SQL authority, mount provisioning and drain coordination are fixture
// inputs. No member credential, real website, provider, or external dial is used.
const layout = {
	workbenchRoot: "/srv/workbench",
	desktopHome: "/srv/desktop",
	screenStateRoot: "/srv/screens",
	browserProfilesRoot: "/srv/profiles",
};
async function mount(path: string) {
	const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
	try {
		return parseRecoveryDirectoryMount(
			await readFile("/proc/self/mountinfo", "utf8"),
			await readFile(`/proc/self/fdinfo/${directory.fd}`, "utf8"),
		);
	} finally {
		await directory.close();
	}
}
const workbenchMount = await mount(layout.workbenchRoot);
const privateWorkbenchMount = await mount("/run/office-private-workbench");
const limits = { memoryBytes: 2147483648, pids: 512, cpuQuota: 200000, cpuPeriod: 100000 };
const binding = computerBinding();
const signal = AbortSignal.timeout(90000);
const challenge: CompanyComputerPrivacyChallenge = {
	scope: computerScope(),
	computerGeneration: 1,
	challengeId: computerId(71),
	version: 1,
	state: "entering",
	memberId: computerId(72),
	profileId: computerId(73),
	profileVersion: 2,
	screenId: binding.screenId,
	drains: [{ state: "draining", drainId: computerId(74), epoch: 2, binding }],
};
const viewer: CompanyComputerViewerGrant = {
	binding,
	viewerSessionId: computerId(75),
	memberId: challenge.memberId,
	mode: "control",
	privacyVersion: 1,
	screenEpoch: 2,
	validForMs: 30000,
	lease: {
		...computerLease(),
		epoch: 2,
		driver: { kind: "member", memberId: challenge.memberId, sessionId: computerId(75) },
	},
	privateSignIn: {
		challengeId: challenge.challengeId,
		profileId: challenge.profileId,
		profileVersion: challenge.profileVersion,
	},
};
let admitted = true;
let checks = 0;
let drained = false;
let dials = 0;
const failures: string[] = [];
const authority = new CloudCompanyComputerPrivateSurfaceControl({
	scope: computerScope(),
	computerGeneration: 1,
	control: {
		async call(method, args) {
			checks++;
			assert.equal(method, "qorpera_check_runtime_office_private_surface");
			assert.deepEqual(args, { p_challenge: challenge });
			if (!admitted) throw new Error("FIXTURE_OWNER_REMOVED");
			return { state: "authorized", privacyState: "private", version: 1, validForMs: 5000 };
		},
	},
});
const boundary = { async assertReady() {} };
const desktop = new CompanyComputerLinuxDesktopLauncher({
	scope: computerScope(),
	computerGeneration: 1,
	layout,
	workbenchMount,
	limits,
	runtimeRoot: "/run/office-screens",
	boundary,
});
let surface: Awaited<ReturnType<typeof startCompanyComputerLinuxPrivateSurface>> | undefined;
let inspection: CompanyComputerLinuxCommands | undefined;
const options = {
	scope: computerScope(),
	computerGeneration: 1,
	challenge,
	layout,
	limits,
	privateWorkbenchMount,
	displayRuntimeRoot: "/run/office-screens",
	browserRuntimeRoot: "/run/office-browser",
	authority,
	async assertDrained() {
		assert.equal(drained, true, "Old desktop must physically stop before private launch");
	},
	onFailure(error: Error) {
		failures.push(error.message);
	},
	signal,
	egressTransport: {
		async resolve() {
			return ["127.0.0.1"];
		},
		connect() {
			dials++;
			return new Socket();
		},
	},
};
async function handshake(socket: Socket) {
	let bytes = Buffer.alloc(0);
	socket.on("data", (chunk: Buffer) => {
		bytes = Buffer.concat([bytes, chunk]);
		assert.ok(bytes.length < 1024);
	});
	socket.resume();
	const take = async (count: number) => {
		for (let attempt = 0; bytes.length < count && attempt < 200; attempt++) {
			assert.equal(socket.destroyed, false);
			await delay(10);
		}
		assert.ok(bytes.length >= count, "Private RFB handshake timed out");
		const result = bytes.subarray(0, count);
		bytes = bytes.subarray(count);
		return result;
	};
	assert.equal((await take(12)).toString(), "RFB 003.008\n");
	socket.write("RFB 003.008\n");
	assert.equal((await take(1))[0], 1);
	assert.equal((await take(1))[0], 1);
	socket.write(Buffer.from([1]));
	assert.equal((await take(4)).readUInt32BE(), 0);
	socket.write(Buffer.from([1]));
	const init = await take(24);
	assert.equal(init.readUInt16BE(), 1920);
	assert.equal(init.readUInt16BE(2), 1200);
	assert.equal((await take(init.readUInt32BE(20))).toString(), "Qorpera Private Sign-in");
}
function key(socket: Socket, symbol: number, down: boolean) {
	const bytes = Buffer.alloc(8);
	bytes[0] = 4;
	bytes[1] = down ? 1 : 0;
	bytes.writeUInt32BE(symbol, 4);
	socket.write(bytes);
}
function click(socket: Socket, x: number, y: number) {
	for (const button of [1, 0]) {
		const bytes = Buffer.alloc(6);
		bytes[0] = 5;
		bytes[1] = button;
		bytes.writeUInt16BE(x, 2);
		bytes.writeUInt16BE(y, 4);
		socket.write(bytes);
	}
}
async function xdo(...args: string[]) {
	const result = await inspection!.run({
		program: "/usr/bin/xdotool",
		args,
		environment: { DISPLAY: ":1", PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
		workingDirectory: layout.workbenchRoot,
		timeoutMs: 5000,
		maxOutputBytes: 4096,
		signal,
	});
	return result;
}
try {
	await prepareCompanyComputerScreenWallpaper({ binding, layout, boundary, creature: "pebble" }, signal);
	const autostart = `/srv/screens/${binding.screenId}/config/autostart`;
	await mkdir(autostart, { recursive: true, mode: 0o700 });
	await writeFile(
		`${autostart}/private-spy.desktop`,
		'[Desktop Entry]\nType=Application\nName=Private isolation fixture\nExec=/usr/bin/bash -c "while true; do echo tick >> /srv/workbench/desktop-ticks; sleep 0.05; done"\nTerminal=false\n',
	);
	const shared = await desktop.launch(binding, signal);
	await shared.ready;
	for (let attempt = 0; attempt < 100; attempt++) {
		if (
			await readFile("/srv/workbench/desktop-ticks", "utf8").then(
				(value) => value.includes("tick"),
				() => false,
			)
		)
			break;
		await delay(25);
	}
	assert.match(await readFile("/srv/workbench/desktop-ticks", "utf8"), /tick/);
	await assert.rejects(startCompanyComputerLinuxPrivateSurface(options), /Old desktop must physically stop/);
	await shared.stop();
	await shared.exited;
	await desktop.close();
	drained = true;
	const oldTicks = await readFile("/srv/workbench/desktop-ticks", "utf8");
	assert.match(oldTicks, /tick/);
	// A rejected nonempty private root is never cleaned as if this call owned it.
	await writeFile("/run/office-private-workbench/unowned", "do not remove");
	await assert.rejects(startCompanyComputerLinuxPrivateSurface(options), /PRIVATE_SURFACE_WORKBENCH_NOT_EMPTY/);
	assert.equal(await readFile("/run/office-private-workbench/unowned", "utf8"), "do not remove");
	const { unlink } = await import("node:fs/promises");
	await unlink("/run/office-private-workbench/unowned");
	surface = await startCompanyComputerLinuxPrivateSurface(options);
	assert.deepEqual(Object.keys(surface).sort(), ["close", "closed", "connect"]);
	for (const invalid of [
		{ ...viewer, privateSignIn: undefined },
		{ ...viewer, privateSignIn: { ...viewer.privateSignIn!, profileVersion: 3 } },
		{ ...viewer, privacyVersion: 2 },
	])
		await assert.rejects(surface.connect(invalid, signal));
	const { socket } = await surface.connect(viewer, signal);
	assert.equal(socket.isPaused(), true);
	await handshake(socket);
	// Fixture-only inspection discovers the private X socket in the broker
	// namespace. The production surface deliberately does not expose this path.
	const privateDirectory = (await readdir("/run/office-screens")).filter((name) => name.startsWith("private-"));
	assert.equal(privateDirectory.length, 1);
	inspection = new CompanyComputerLinuxCommands({
		binding,
		layout,
		workbenchMount,
		limits,
		boundary,
		xSocket: `/run/office-screens/${privateDirectory[0]}/x11/X1`,
		captureRoot: "/run/office-captures",
	});
	const uri = `data:text/html,${encodeURIComponent('<title>Private sign-in fixture</title><h1>Private sign-in</h1><p>Disposable proof. No real credentials.</p><input autofocus oninput="document.title=this.value">')}`;
	click(socket, 200, 60);
	key(socket, 0xffe3, true);
	key(socket, 108, true);
	key(socket, 108, false);
	key(socket, 0xffe3, false);
	for (const character of uri) {
		key(socket, character.charCodeAt(0), true);
		key(socket, character.charCodeAt(0), false);
	}
	key(socket, 0xff0d, true);
	key(socket, 0xff0d, false);
	let pageWindow = "";
	for (let attempt = 0; attempt < 40; attempt++) {
		const result = await xdo("search", "--onlyvisible", "--name", "Private sign-in fixture");
		if (result.code === 0) {
			pageWindow = result.stdout.trim();
			break;
		}
		await delay(100);
	}
	assert.match(pageWindow, /^[0-9]+$/);
	const sentinel = "PRIVATE-FIXTURE-ONLY";
	for (const character of sentinel) {
		key(socket, character.charCodeAt(0), true);
		key(socket, character.charCodeAt(0), false);
	}
	await delay(500);
	assert.match((await xdo("getwindowname", pageWindow)).stdout, /PRIVATE-FIXTURE-ONLY/);
	const png = await inspection.capturePng({ display: ":1", signal, maxBytes: 16777216 });
	await writeFile("/opt/probe-artifacts/private.png", png, { mode: 0o600, flag: "wx" });
	assert.equal(await readFile("/srv/workbench/desktop-ticks", "utf8"), oldTicks);
	let isolatedProcesses = 0;
	for (const pid of (await readdir("/proc")).filter((name) => /^[0-9]+$/.test(name))) {
		const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
		if (!cmdline.startsWith("/usr/bin/Xtigervnc\0") && !cmdline.startsWith("/usr/lib/qorpera-chromium/chrome\0"))
			continue;
		const info = await readFile(`/proc/${pid}/mountinfo`, "utf8");
		for (const path of Object.values(layout))
			assert.ok(!info.split("\n").some((line) => line.split(" ")[4] === path), `Shared path exposed: ${path}`);
		isolatedProcesses++;
	}
	assert.ok(isolatedProcesses >= 2);
	await inspection.close();
	inspection = undefined;
	key(socket, 0xffe3, true); // Held input must disappear with the private X server.
	admitted = false;
	await Promise.race([
		surface.closed,
		delay(10000).then(() => {
			throw new Error("PRIVATE_REVOCATION_NOT_DRAINED");
		}),
	]);
	assert.ok(socket.destroyed);
	assert.ok(failures.includes("PRIVATE_SURFACE_AUTHORITY_UNCONFIRMED"));
	await surface.close();
	assert.deepEqual(await readdir("/run/office-screens"), []);
	assert.deepEqual(await readdir("/run/office-browser"), []);
	assert.deepEqual(await readdir("/run/office-private-workbench"), []);
	assert.ok((await readdir(`/srv/profiles/${challenge.profileId}`)).includes("Default"));
	// Reopen the same profile on a fresh framebuffer; neither old pixels nor
	// held input can be inherited through the former X/RFB socket directory.
	admitted = true;
	surface = await startCompanyComputerLinuxPrivateSurface(options);
	const reopened = await surface.connect(viewer, signal);
	await handshake(reopened.socket);
	const nextDirectory = (await readdir("/run/office-screens")).filter((name) => name.startsWith("private-"));
	assert.equal(nextDirectory.length, 1);
	assert.notEqual(nextDirectory[0], privateDirectory[0]);
	inspection = new CompanyComputerLinuxCommands({
		binding,
		layout,
		workbenchMount,
		limits,
		boundary,
		xSocket: `/run/office-screens/${nextDirectory[0]}/x11/X1`,
		captureRoot: "/run/office-captures",
	});
	assert.notEqual((await xdo("search", "--onlyvisible", "--name", sentinel)).code, 0);
	await inspection.close();
	inspection = undefined;
	await surface.close();
	await surface.closed;
	assert.ok(reopened.socket.destroyed);
	assert.deepEqual(await readdir("/run/office-screens"), []);
	assert.deepEqual(await readdir("/run/office-browser"), []);
	assert.deepEqual(await readdir("/run/office-private-workbench"), []);
	assert.equal(dials, 0);
	console.log(
		JSON.stringify({
			schema: "qorpera.office-linux-private-proof/v1",
			platform: process.platform,
			arch: process.arch,
			syntheticAuthorityAndSignIn: true,
			oldAutostartStopped: true,
			freshPrivateXServer: true,
			actualRfbTypedInput: true,
			privateViewerOnly: true,
			isolatedProcesses,
			authorityChecks: checks,
			revocationClosedDisplayAndBrowser: true,
			profilePreserved: true,
			freshFramebufferOnReopen: true,
			ephemeralStateRemoved: true,
			realNetworkDials: dials,
			screenshotBytes: png.length,
			realProviderCalls: false,
		}),
	);
} finally {
	await inspection?.close();
	await surface?.close();
	await desktop.close();
}
