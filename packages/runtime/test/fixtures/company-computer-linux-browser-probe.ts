import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, readFile, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { prepareCompanyComputerScreenWallpaper } from "../../src/cloud-company-computer-desktop.ts";
import {
	CompanyComputerGuestAutomation,
	PersistentCompanyComputerBrowser,
} from "../../src/cloud-company-computer-guest.ts";
import { createCompanyComputerLinuxBrowserLaunch } from "../../src/cloud-company-computer-linux-browser.ts";
import { CompanyComputerLinuxCommands } from "../../src/cloud-company-computer-linux-commands.ts";
import { CompanyComputerLinuxDesktopLauncher } from "../../src/cloud-company-computer-linux-desktop.ts";
import { parseRecoveryDirectoryMount } from "../../src/cloud-identity-recovery-filesystems.ts";
import {
	computerBinding,
	computerEffect,
	computerId,
	computerLease,
	computerOperation,
	computerScope,
} from "./company-computer.ts";

// Real contained Chromium, XFCE, profile persistence and page/pixel effects.
// Authority/adoption/mount provisioning and rendered HTTP content are fixtures.
// No external network, real provider or member credential is used.
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
const limits = { memoryBytes: 2147483648, pids: 512, cpuQuota: 200000, cpuPeriod: 100000 };
const signal = AbortSignal.timeout(90000);
const binding = computerBinding();
const grant = { profileId: computerId(81), grantId: computerId(82), version: 1 };
let admitted = true;
const boundary = {
	async assertReady() {
		if (!admitted) throw new Error("FIXTURE_OFFICE_REVOKED");
	},
};
const access = {
	async assertGranted() {
		if (!admitted) throw new Error("FIXTURE_BROWSER_REVOKED");
	},
};
const desktop = new CompanyComputerLinuxDesktopLauncher({
	scope: computerScope(),
	computerGeneration: 1,
	layout,
	workbenchMount,
	limits,
	runtimeRoot: "/run/office-screens",
	boundary,
});
let networkLookups = 0;
let networkDials = 0;
const destinations = new Set<string>();
const launch = createCompanyComputerLinuxBrowserLaunch({
	scope: computerScope(),
	computerGeneration: 1,
	layout,
	limits,
	workbenchMount,
	runtimeRoot: "/run/office-browser",
	boundary,
	access,
	xSocket: (exact) => desktop.xSocket(exact),
	egressTransport: {
		async resolve(host) {
			networkLookups++;
			destinations.add(host);
			return ["127.0.0.1"];
		},
		connect() {
			networkDials++;
			return new Socket();
		},
	},
});
let manager = new PersistentCompanyComputerBrowser({ layout, boundary, access, launch });
let commands: CompanyComputerLinuxCommands | undefined;
try {
	await prepareCompanyComputerScreenWallpaper({ binding, layout, boundary, creature: "pebble" }, signal);
	const screen = await desktop.launch(binding, signal);
	await screen.ready;
	commands = new CompanyComputerLinuxCommands({
		binding,
		layout,
		boundary,
		limits,
		workbenchMount,
		xSocket: desktop.xSocket(binding),
		captureRoot: "/run/office-captures",
	});
	const session = await manager.open(binding, grant, signal);
	const version = session.context.browser()!.version();
	const page = session.context.pages()[0] ?? (await session.context.newPage());
	let browserImage: Buffer | undefined;
	const automation = new CompanyComputerGuestAutomation({
		binding,
		layout,
		boundary,
		browser: session,
		commands,
		screenshots: {
			async publish(bytes) {
				browserImage = Buffer.from(bytes);
				return {
					assetId: computerId(83),
					sha256: createHash("sha256").update(bytes).digest("hex"),
					bytes: bytes.length,
					mediaType: "image/png",
				};
			},
		},
	});
	await session.context.route("https://browser.example/**", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><title>Office browser proof</title><h1>Shared office browser</h1><label>Proof field<input aria-label='Proof field'></label><button onclick=\"document.querySelector('p').textContent='Saved by the cloud browser'\">Save</button><p role='status'>Ready</p><label>Upload<input id='upload' type='file' oncancel=\"document.querySelector('p').textContent='File picker denied'\"></label>",
		}),
	);
	await automation.perform(
		{ kind: "browser", action: "navigate", url: "https://browser.example/" },
		computerLease(),
		computerEffect(signal),
		{
			...computerOperation(),
			tool: "computer_browser",
			arguments: { kind: "browser", action: "navigate", url: "https://browser.example/" },
		},
	);
	await automation.perform(
		{ kind: "browser", action: "fill", role: "textbox", name: "Proof field", text: "Persistent cloud browser" },
		computerLease(),
		computerEffect(signal),
		{
			...computerOperation(),
			tool: "computer_browser",
			arguments: {
				kind: "browser",
				action: "fill",
				role: "textbox",
				name: "Proof field",
				text: "Persistent cloud browser",
			},
		},
	);
	await automation.perform(
		{ kind: "browser", action: "click", role: "button", name: "Save" },
		computerLease(),
		computerEffect(signal),
		{
			...computerOperation(),
			tool: "computer_browser",
			arguments: { kind: "browser", action: "click", role: "button", name: "Save" },
		},
	);
	assert.equal(await page.getByRole("status").innerText(), "Saved by the cloud browser");
	const screenshot = await automation.perform(
		{ kind: "screenshot", surface: "browser" },
		computerLease(),
		computerEffect(signal),
		{
			...computerOperation(),
			tool: "computer_screenshot",
			arguments: { kind: "screenshot", surface: "browser" },
		},
	);
	assert.equal(screenshot.kind, "json");
	assert.ok(browserImage);
	const browserCapture = {
		bytes: browserImage.length,
		width: browserImage.readUInt32BE(16),
		height: browserImage.readUInt32BE(20),
	};
	assert.ok(browserCapture.width > 0 && browserCapture.width <= 1920);
	assert.ok(browserCapture.height > 0 && browserCapture.height < 1200);
	assert.ok(
		screenshot.kind === "json" &&
			screenshot.value &&
			typeof screenshot.value === "object" &&
			!Array.isArray(screenshot.value),
	);
	assert.equal(screenshot.value.surface, "browser");
	assert.equal(screenshot.value.width, browserCapture.width);
	assert.equal(screenshot.value.height, browserCapture.height);
	await writeFile("/opt/probe-artifacts/browser.png", browserImage, { mode: 0o600, flag: "wx" });
	const inspector = await session.context.browser()!.newBrowserCDPSession();
	const processes = (await inspector.send("SystemInfo.getProcessInfo")).processInfo;
	const rendererPids = new Set(
		processes.filter((process) => process.type === "renderer").map((process) => String(process.id)),
	);
	const browserPid = String(processes.find((process) => process.type === "browser")?.id);
	const physical = new Map<string, { status: string; pids: string[]; parent: string; args: string[] }>();
	for (const pid of (await readdir("/proc")).filter((entry) => /^[0-9]+$/.test(entry))) {
		const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
		const args = (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0");
		physical.set(pid, {
			status,
			args,
			pids: /^NSpid:\s+(.+)$/m.exec(status)?.[1].trim().split(/\s+/) ?? [],
			parent: /^PPid:\s+(\d+)$/m.exec(status)?.[1] ?? "",
		});
	}
	// PIDs reported by CDP belong to Chromium's namespace. The same numeric
	// child PID can identify XFCE in its independent desktop namespace.
	const browsers = [...physical].filter(
		([, process]) =>
			process.pids[1] === browserPid &&
			process.args[0] === "/usr/lib/qorpera-chromium/chrome" &&
			process.args.includes("--remote-debugging-pipe"),
	);
	assert.equal(browsers.length, 1, "Chromium's physical browser process must be unambiguous");
	const belongsToBrowser = (pid: string): boolean => {
		const seen = new Set<string>();
		while (pid && !seen.has(pid)) {
			if (pid === browsers[0][0]) return true;
			seen.add(pid);
			pid = physical.get(pid)?.parent ?? "";
		}
		return false;
	};
	let renderers = 0;
	for (const [pid, process] of physical) {
		const { status, pids: namespacePids } = process;
		if (!rendererPids.has(namespacePids[1]) || !belongsToBrowser(pid)) continue;
		// CDP identifies the renderer within this verified browser's process
		// tree. Its argv may be unreadable after Chromium becomes nondumpable;
		// do not confuse that with absent kernel sandboxing.
		assert.match(status, /^NoNewPrivs:\s+1$/m);
		assert.match(status, /^CapEff:\s+0{16}$/m);
		assert.match(status, /^Seccomp:\s+2$/m);
		assert.ok(namespacePids.length >= 3);
		renderers++;
	}
	assert.ok(renderers > 0, "No physically sandboxed Chromium renderer was observed");
	await page.getByLabel("Upload").click();
	await page.getByRole("status").filter({ hasText: "File picker denied" }).waitFor({ timeout: 5000 });
	const xdo = async (...args: string[]) => {
		const result = await commands!.run({
			program: "/usr/bin/xdotool",
			args,
			environment: { DISPLAY: ":1", PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
			workingDirectory: layout.workbenchRoot,
			timeoutMs: 5000,
			maxOutputBytes: 4096,
			signal,
		});
		assert.equal(result.code, 0, result.stderr);
		return result.stdout.trim();
	};
	const windows = (await xdo("search", "--onlyvisible", "--name", "Office browser proof")).split("\n");
	assert.equal(windows.length, 1);
	await xdo("windowactivate", "--sync", windows[0]);
	assert.match(await xdo("getactivewindow", "getwindowname"), /Office browser proof/);
	for (const key of ["F12", "ctrl+shift+j", "ctrl+shift+i"]) {
		await xdo("key", "--clearmodifiers", key);
		await delay(300);
		const { targetInfos } = await inspector.send("Target.getTargets");
		assert.ok(
			targetInfos.every((target) => !target.url.startsWith("devtools:")),
			`DevTools opened using ${key}`,
		);
		// Chrome shows a native policy notice. Dismiss it so the next shortcut
		// and omnibox probe cannot accidentally type into a blocking dialog.
		await xdo("key", "--clearmodifiers", "Return");
	}
	const typedNavigation = page.waitForURL("https://browser.example/keyboard", { timeout: 5000 });
	await xdo("key", "--clearmodifiers", "ctrl+l");
	await xdo("type", "--clearmodifiers", "https://browser.example/keyboard");
	await xdo("key", "Return");
	await typedNavigation;
	await page.waitForLoadState("load");
	// The omnibox accepts arbitrary typing through the desktop, so policy must
	// prevent bookmarklet execution as well as the broker's URL validator.
	await xdo("key", "--clearmodifiers", "ctrl+l");
	await xdo("type", "--clearmodifiers", "javascript:document.title='JAVASCRIPT_POLICY_BYPASSED'");
	await xdo("key", "Return");
	await delay(300);
	assert.equal(await page.title(), "Office browser proof");
	await xdo("key", "Escape");
	await session.context.addCookies([
		{
			name: "fixture_session",
			value: "SYNTHETIC_BROWSER_SESSION",
			domain: "browser.example",
			path: "/",
			secure: true,
			httpOnly: true,
			expires: Math.floor(Date.now() / 1000) + 3600,
		},
	]);
	await writeFile(`/srv/profiles/${grant.profileId}/credential-canary.txt`, "SYNTHETIC_PROFILE_SECRET", {
		mode: 0o600,
	});
	const png = Buffer.from(await commands.capturePng({ display: ":1", maxBytes: 16777216, signal }));
	assert.equal(png.readUInt32BE(16), 1920);
	assert.equal(png.readUInt32BE(20), 1200);
	await writeFile("/opt/probe-artifacts/desktop.png", png, { mode: 0o600, flag: "wx" });
	for (const url of ["file:///profile/credential-canary.txt", "chrome://settings/passwords"]) {
		// A rejected goto resolves before Chrome commits its error document.
		// Observe that new commit; waitForLoadState alone sees the old page.
		const committed = page.waitForEvent("framenavigated", {
			predicate: (frame) => frame === page.mainFrame(),
			timeout: 5000,
		});
		await assert.rejects(page.goto(url), /ERR_BLOCKED_BY_ADMINISTRATOR/);
		await committed;
		await page.waitForLoadState("load");
	}
	await assert.rejects(
		page.goto("https://private.example/", { timeout: 5000 }),
		/ERR_(?:TUNNEL_CONNECTION_FAILED|EMPTY_RESPONSE)/,
	);
	assert.ok(networkLookups > 0);
	assert.ok(destinations.has("private.example"));
	assert.equal(networkDials, 0);
	const shell = await commands.run({
		program: "/bin/bash",
		args: [
			"-c",
			"test ! -e /profile && test ! -e /srv/profiles && test ! -e /run/office-browser || exit 70; test -x /usr/local/lib/qorpera/qorpera-browser-bwrap || exit 71; if /usr/local/lib/qorpera/qorpera-browser-bwrap --unshare-user --ro-bind / / /usr/bin/true >/dev/null 2>&1; then exit 72; fi; printf isolated",
		],
		environment: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
		workingDirectory: layout.workbenchRoot,
		timeoutMs: 5000,
		maxOutputBytes: 1024,
		signal,
	});
	assert.equal(shell.code, 0);
	assert.equal(shell.stdout, "isolated");
	await manager.close();
	assert.deepEqual(await readdir("/run/office-browser"), []);
	manager = new PersistentCompanyComputerBrowser({ layout, boundary, access, launch });
	const reopened = await manager.open(binding, grant, signal);
	assert.equal(
		(await reopened.context.cookies("https://browser.example/")).find((cookie) => cookie.name === "fixture_session")
			?.value,
		"SYNTHETIC_BROWSER_SESSION",
	);
	assert.equal(
		await readFile(`/srv/profiles/${grant.profileId}/credential-canary.txt`, "utf8"),
		"SYNTHETIC_PROFILE_SECRET",
	);
	const closed = new Promise<void>((resolve) => reopened.context.once("close", () => resolve()));
	admitted = false;
	await Promise.race([
		closed,
		delay(5000).then(() => {
			throw new Error("BROWSER_REVOCATION_NOT_APPLIED");
		}),
	]);
	await assert.rejects(reopened.assertActive(signal), /BROWSER_ACCESS_ENDED/);
	await manager.close();
	assert.deepEqual(await readdir("/run/office-browser"), []);
	console.log(
		JSON.stringify({
			schema: "qorpera.office-linux-browser-proof/v1",
			platform: process.platform,
			arch: process.arch,
			node: process.version,
			chromium: version,
			syntheticAuthorityAndHttpContent: true,
			actualChromiumSandbox: true,
			verifiedSandboxedRenderers: renderers,
			rendererProcessAncestryVerified: true,
			privateDevToolsPipes: true,
			pageFillAndClick: true,
			actualGuestAutomation: true,
			browserCapture,
			screenshot: { bytes: png.length, width: 1920, height: 1200 },
			profileAbsentFromShell: true,
			browserLauncherCannotReenableShellUserNamespaces: true,
			fileAndPasswordUiDenied: true,
			filePickerDenied: true,
			developerToolsShortcutsDenied: true,
			javascriptOmniboxDenied: true,
			privateDestinationDenied: true,
			realNetworkDials: networkDials,
			profileCookieSurvivesRestart: true,
			revokedBrowserClosed: true,
			ephemeralStateRemoved: true,
			realProviderCalls: false,
		}),
	);
} finally {
	await manager.close();
	await commands?.close();
	await desktop.close();
}
