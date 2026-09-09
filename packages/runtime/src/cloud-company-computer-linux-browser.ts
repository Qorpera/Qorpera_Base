import { constants } from "node:fs";
import { type FileHandle, lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import {
	assertCompanyComputerScope,
	assertCompanyComputerScreenBinding,
	COMPANY_COMPUTER_UUID,
	type CompanyComputerScope,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import { type Browser, chromium } from "playwright-core";
import {
	type CompanyComputerBrowserEgressTransport,
	startCompanyComputerBrowserEgress,
} from "./cloud-company-computer-browser-egress.ts";
import { CompanyComputerBrowserPipe } from "./cloud-company-computer-browser-pipe.ts";
import type {
	CompanyComputerBrowserAccess,
	CompanyComputerBrowserLaunch,
	CompanyComputerGuestBoundary,
} from "./cloud-company-computer-guest.ts";
import { assertCompanyComputerGuestLayout, type CompanyComputerGuestLayout } from "./cloud-company-computer-layout.ts";
import {
	assertCompanyComputerCommandLimits,
	assertCompanyComputerImageArtifact,
	assertCompanyComputerLinuxHost,
	assertCompanyComputerWorkbenchMount,
	type CompanyComputerCommandLimits,
	companyComputerLinuxSandboxArgs,
	openCompanyComputerLinuxDirectory,
	readCompanyComputerLinuxMetadata,
} from "./cloud-company-computer-linux-host.ts";
import { spawnCompanyComputerLinuxProcess } from "./cloud-company-computer-linux-process.ts";
import { companyComputerScreenDisplay } from "./cloud-company-computer-screens.ts";
import type { RecoveryDirectoryMount } from "./cloud-identity-recovery-filesystems.ts";
import { cloudToolRequest } from "./cloud-native-tool-authority.ts";

const policyPath = "/usr/local/share/qorpera/browser-policy.json";
const policy = {
	PasswordManagerEnabled: false,
	AutofillAddressEnabled: false,
	AutofillCreditCardEnabled: false,
	BrowserSignin: 0,
	SyncDisabled: true,
	DeveloperToolsAvailability: 1,
	RemoteDebuggingAllowed: true,
	ExtensionInstallBlocklist: ["*"],
	DownloadRestrictions: 3,
	AllowFileSelectionDialogs: false,
	URLBlocklist: ["file://*", "chrome://*", "chrome-untrusted://*", "devtools://*", "javascript://*", "view-source:*"],
	URLAllowlist: ["chrome://newtab/"],
};

/** Physical browser launch selected only by the cloud guest. Persistent profile
 * bytes are mounted exclusively here; HOME is ephemeral. The workbench is the
 * shared company surface. Only the assigned X socket and checked public HTTPS
 * relay cross the namespace; no host network, service env, canonical files or
 * another profile/control socket is available. Chrome's own sandbox remains on. */
export function createCompanyComputerLinuxBrowserLaunch(options: {
	scope: CompanyComputerScope;
	computerGeneration: number;
	layout: CompanyComputerGuestLayout;
	limits: CompanyComputerCommandLimits;
	workbenchMount: RecoveryDirectoryMount;
	runtimeRoot: string;
	boundary: CompanyComputerGuestBoundary;
	access: CompanyComputerBrowserAccess;
	xSocket: (binding: Parameters<CompanyComputerBrowserLaunch>[1]["binding"]) => string;
	/** Synthetic transport for disposable proofs only; never model/member configuration. */
	egressTransport?: CompanyComputerBrowserEgressTransport;
}): CompanyComputerBrowserLaunch {
	options = { ...options };
	assertCompanyComputerScope(options.scope, options.scope);
	assertCompanyComputerGuestLayout(options.layout);
	assertCompanyComputerCommandLimits(options.limits, {
		memory: String(options.limits.memoryBytes),
		pids: String(options.limits.pids),
		cpu: `${options.limits.cpuQuota} ${options.limits.cpuPeriod}`,
	});
	if (
		!Number.isSafeInteger(options.computerGeneration) ||
		options.computerGeneration < 1 ||
		options.runtimeRoot !== resolve(options.runtimeRoot) ||
		/[\x00-\x1f\x7f\\]/.test(options.runtimeRoot) ||
		options.runtimeRoot === "/" ||
		Object.values(options.layout).some(
			(root) =>
				root === options.runtimeRoot ||
				root.startsWith(`${options.runtimeRoot}/`) ||
				options.runtimeRoot.startsWith(`${root}/`),
		)
	)
		throw new Error("INVALID_OFFICE_BROWSER_CONFIGURATION");
	const layout = Object.freeze({ ...options.layout });
	const limits = Object.freeze({ ...options.limits });
	const mount = Object.freeze({ ...options.workbenchMount });
	const scope = Object.freeze({ ...options.scope });
	const generation = options.computerGeneration;
	const runtimeRoot = options.runtimeRoot;
	return async (directory, input) => {
		input = { ...input, binding: Object.freeze({ ...input.binding }), grant: Object.freeze({ ...input.grant }) };
		assertCompanyComputerScreenBinding(input.binding, input.binding);
		assertCompanyComputerScope(input.binding, scope);
		if (
			!COMPANY_COMPUTER_UUID.test(input.grant.profileId) ||
			!COMPANY_COMPUTER_UUID.test(input.grant.grantId) ||
			!Number.isSafeInteger(input.grant.version) ||
			input.grant.version < 1
		)
			throw new Error("INVALID_BROWSER_GRANT");
		if (
			input.binding.computerGeneration !== generation ||
			directory !== join(layout.browserProfilesRoot, input.grant.profileId) ||
			input.display !== companyComputerScreenDisplay(input.binding.screenOrdinal) ||
			input.home !== layout.desktopHome
		)
			throw new Error("OFFICE_BROWSER_BINDING_MISMATCH");
		const abort = new AbortController();
		const signal = AbortSignal.any([input.signal, abort.signal]);
		const files: FileHandle[] = [];
		let temporary: string | undefined;
		let egress: Awaited<ReturnType<typeof startCompanyComputerBrowserEgress>> | undefined;
		let launched: ReturnType<typeof spawnCompanyComputerLinuxProcess> | undefined;
		let exited: Promise<void> | undefined;
		let browser: Browser | undefined;
		let channel: CompanyComputerBrowserPipe | undefined;
		let closing: Promise<void> | undefined;
		const stop = (): void => {
			launched?.stop();
		};
		const check = async (checked: AbortSignal): Promise<void> => {
			checked.throwIfAborted();
			await options.boundary.assertReady(input.binding, checked);
			await options.access.assertGranted(input.grant, input.binding, checked);
			await assertCompanyComputerLinuxHost(limits, checked);
		};
		const close = (): Promise<void> => {
			closing ??= cloudToolRequest(
				async () => {
					await egress?.close();
					// Stop network effects first. A graceful browser close can flush its
					// persistent session; confirmed namespace exit is still mandatory.
					if (browser) {
						await cloudToolRequest(
							async () => {
								const control = await browser!.newBrowserCDPSession();
								await control.send("Browser.close");
							},
							new AbortController().signal,
							1000,
						).catch(() => undefined);
					}
					if (exited) {
						await cloudToolRequest(() => exited!, new AbortController().signal, 3000).catch(async () => {
							stop();
							await cloudToolRequest(() => exited!, new AbortController().signal, 5000);
						});
					}
					channel?.close();
					signal.removeEventListener("abort", onAbort);
					await Promise.all(files.map((file) => file.close()));
					if (temporary) await rm(temporary, { recursive: true, force: true });
				},
				new AbortController().signal,
				15000,
			).catch(() => {
				abort.abort();
				stop();
				throw new Error("BROWSER_DRAIN_FAILED");
			});
			return closing;
		};
		const onAbort = (): void => {
			// Revoke network immediately, then let an established browser flush
			// its profile on bounded shutdown. Pending starts have no session to
			// preserve and must lose namespace execution permission immediately.
			if (browser) void close().catch(() => undefined);
			else stop();
		};
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			await cloudToolRequest(check, signal);
			for (const path of [
				"/usr/bin/bwrap",
				"/usr/bin/tini",
				"/usr/bin/bash",
				"/usr/bin/node",
				"/usr/lib/qorpera-chromium/chrome",
				"/usr/local/lib/qorpera/office-browser-child.mjs",
				policyPath,
			])
				await assertCompanyComputerImageArtifact(path);
			if (!isDeepStrictEqual(JSON.parse(await readCompanyComputerLinuxMetadata(policyPath, 4096)), policy))
				throw new Error("OFFICE_BROWSER_POLICY_MISMATCH");
			files.push(await openCompanyComputerLinuxDirectory(layout.workbenchRoot, false));
			const root = await openCompanyComputerLinuxDirectory(layout.browserProfilesRoot, true);
			try {
				const profile = await open(
					`/proc/self/fd/${root.fd}/${input.grant.profileId}`,
					constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
				);
				files.push(profile);
				const info = await profile.stat();
				if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
					throw new Error("UNSAFE_OFFICE_BROWSER_PROFILE");
			} finally {
				await root.close();
			}
			await assertCompanyComputerWorkbenchMount(files[0], mount, [layout.workbenchRoot, layout.browserProfilesRoot]);
			const xSocket = options.xSocket(input.binding);
			const socket = await lstat(xSocket);
			const parent = await lstat(dirname(xSocket));
			if (
				!socket.isSocket() ||
				socket.uid !== process.getuid?.() ||
				(await realpath(xSocket)) !== xSocket ||
				!parent.isDirectory() ||
				parent.uid !== process.getuid?.() ||
				(parent.mode & 0o077) !== 0
			)
				throw new Error("OFFICE_BROWSER_DISPLAY_UNAVAILABLE");
			const runtime = await openCompanyComputerLinuxDirectory(runtimeRoot, true);
			try {
				temporary = await mkdtemp(join(runtimeRoot, "browser-"));
			} finally {
				await runtime.close();
			}
			egress = await startCompanyComputerBrowserEgress({
				root: temporary,
				signal,
				assertActive: check,
				onFailure: () => abort.abort(),
				transport: options.egressTransport,
			});
			// Chromium creates its own nested user/PID sandbox. Only the browser
			// namespace permits that; shell/desktop namespaces still disable it.
			const args = companyComputerLinuxSandboxArgs().filter(
				(arg) => !["--disable-userns", "--assert-userns-disabled"].includes(arg),
			);
			args.push(
				"--bind-fd",
				"5",
				layout.workbenchRoot,
				"--bind-fd",
				"6",
				"/profile",
				"--ro-bind",
				xSocket,
				`/tmp/.X11-unix/X${input.binding.screenOrdinal}`,
				"--ro-bind",
				egress.path,
				"/run/qorpera/egress.sock",
				"--ro-bind",
				policyPath,
				"/etc/chromium/policies/managed/qorpera.json",
				"--ro-bind",
				policyPath,
				"/etc/opt/chrome/policies/managed/qorpera.json",
				"--size",
				"33554432",
				"--tmpfs",
				"/home/qorpera",
			);
			for (const path of ["/etc/fonts", "/etc/ssl/certs", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf"]) {
				await assertCompanyComputerImageArtifact(path, ["/etc/fonts", "/etc/ssl/certs"].includes(path));
				args.push("--ro-bind", path, path);
			}
			for (const [key, value] of Object.entries({
				HOME: "/home/qorpera",
				PATH: "/usr/bin:/bin",
				LANG: "C.UTF-8",
				DISPLAY: input.display,
			}))
				args.push("--setenv", key, value);
			args.push("--chdir", layout.workbenchRoot, "--remount-ro", "/");
			signal.throwIfAborted();
			launched = spawnCompanyComputerLinuxProcess({
				args,
				files,
				stdin: "ignore",
				pipeCount: 2,
				command: [
					"/usr/bin/node",
					"/usr/local/lib/qorpera/office-browser-child.mjs",
					"/run/qorpera/egress.sock",
					"/usr/lib/qorpera-chromium/chrome",
					"--remote-debugging-pipe",
					"--user-data-dir=/profile",
					"--no-first-run",
					"--no-default-browser-check",
					"--disable-extensions",
					"--disable-component-extensions-with-background-pages",
					"--disable-background-networking",
					"--disable-sync",
					"--disable-quic",
					"--disable-gpu",
					"--disable-dev-shm-usage",
					"--password-store=basic",
					"--window-size=1920,1200",
				],
			});
			exited = new Promise<void>((finished) => launched!.child.once("close", () => finished()));
			let logs = 0;
			for (const stream of [launched.child.stdout!, launched.child.stderr!])
				stream.on("data", (bytes: Buffer) => {
					logs += bytes.length;
					if (logs > 1024 * 1024) abort.abort();
				});
			await launched.started;
			signal.throwIfAborted();
			channel = new CompanyComputerBrowserPipe(
				launched.child.stdio[3] as Duplex,
				launched.child.stdio[4] as Duplex,
				() => {
					// Browser.close can close CDP before Chromium finishes flushing.
					// The drain deadline still kills and reaps any surviving process.
					if (!closing) stop();
				},
			);
			browser = await chromium.connectOverCDP(channel, {
				timeout: 10000,
				artifactsDir: temporary,
				noDefaults: true,
			});
			await cloudToolRequest(check, signal);
			const contexts = browser.contexts();
			if (contexts.length !== 1) throw new Error("OFFICE_BROWSER_CONTEXT_MISMATCH");
			return { context: contexts[0], close };
		} catch (error) {
			abort.abort();
			await close();
			throw error;
		}
	};
}
