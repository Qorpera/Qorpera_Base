import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import type { CompanyComputerScreenBinding } from "@qorpera/cloud-client/cloud-company-computer-contract";
import { CompanyComputerLinuxCommands } from "../../src/cloud-company-computer-linux-commands.ts";
import { parseRecoveryDirectoryMount } from "../../src/cloud-identity-recovery-filesystems.ts";

// Disposable stdio bridge to the actual contained command adapter. Mount
// identity/readiness are local fixtures; this does not attest an LXD/NAS guest.
assert.equal(process.platform, "linux");
assert.equal(process.getuid?.(), 1000);
const status = await readFile("/proc/self/status", "utf8");
for (const pattern of [/^CapEff:\s+0+$/m, /^CapBnd:\s+0+$/m, /^NoNewPrivs:\s+1$/m]) assert.match(status, pattern);
const layout = {
	workbenchRoot: "/srv/workbench",
	desktopHome: "/srv/desktop",
	screenStateRoot: "/srv/screens",
	browserProfilesRoot: "/srv/profiles",
};
const root = await open(layout.workbenchRoot, constants.O_RDONLY | constants.O_DIRECTORY);
const workbenchMount = parseRecoveryDirectoryMount(
	await readFile("/proc/self/mountinfo", "utf8"),
	await readFile(`/proc/self/fdinfo/${root.fd}`, "utf8"),
);
await root.close();
const xvfb = spawn("/usr/bin/Xvfb", [":1", "-screen", "0", "1920x1200x24", "-nolisten", "tcp", "-ac", "-noreset"], {
	env: { PATH: "/usr/bin:/bin" },
	stdio: ["ignore", "ignore", "pipe"],
});
const exited = new Promise<void>((resolve) => xvfb.once("close", () => resolve()));
let errors = "";
xvfb.stderr.on("data", (chunk) => {
	errors += chunk.toString();
});
let commands: CompanyComputerLinuxCommands | undefined;
type Request = { id: number } & (
	| { action: "open"; binding: CompanyComputerScreenBinding }
	| { action: "run"; input: Omit<Parameters<CompanyComputerLinuxCommands["run"]>[0], "signal"> }
	| { action: "capture"; display: string; maxBytes: number }
	| { action: "write"; path: string; bytes: string; sha256: string }
	| { action: "read"; path: string }
	| { action: "staging-check" }
	| { action: "pointer" | "close" }
);
try {
	let ready = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		if (
			await lstat("/tmp/.X11-unix/X1").then(
				() => true,
				() => false,
			)
		) {
			ready = true;
			break;
		}
		await delay(25);
	}
	assert(ready, errors);
	await rename("/tmp/.X11-unix/X1", "/tmp/office-x/X1");
	process.stdout.write(`${JSON.stringify({ ready: true, uid: process.getuid?.() })}\n`);
	for await (const line of createInterface({ input: process.stdin })) {
		const request = JSON.parse(line) as Request;
		let value: unknown;
		if (request.action === "open") {
			assert(!commands);
			assert.equal(request.binding.screenOrdinal, 1);
			commands = new CompanyComputerLinuxCommands({
				binding: request.binding,
				layout,
				workbenchMount,
				limits: { memoryBytes: 536870912, pids: 128, cpuQuota: 100000, cpuPeriod: 100000 },
				xSocket: "/tmp/office-x/X1",
				captureRoot: "/run/office-captures",
				boundary: { assertReady: async () => {} },
			});
			value = { opened: true };
		} else {
			assert(commands);
			const signal = AbortSignal.timeout(10_000);
			if (request.action === "run") value = await commands.run({ ...request.input, signal });
			else if (request.action === "write") {
				await commands.writeFile({
					path: request.path,
					bytes: Buffer.from(request.bytes, "base64"),
					sha256: request.sha256,
					signal,
				});
				value = { written: true };
			} else if (request.action === "read")
				value = Buffer.from(await commands.readFile({ path: request.path, signal })).toString("base64");
			else if (request.action === "staging-check") {
				const path = "/srv/screens/.qorpera-import-canary";
				await writeFile(path, "PRIVATE_STAGING_CANARY", { flag: "wx", mode: 0o600 });
				try {
					value = await commands.run({
						program: "/bin/bash",
						args: [
							"--noprofile",
							"--norc",
							"-c",
							"test ! -e /srv/screens/.qorpera-import-canary && test ! -e /proc/1/root/srv/screens/.qorpera-import-canary",
						],
						environment: { DISPLAY: ":1", PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
						workingDirectory: layout.workbenchRoot,
						timeoutMs: 5000,
						maxOutputBytes: 16384,
						signal,
					});
				} finally {
					await unlink(path);
				}
			} else if (request.action === "capture")
				value = Buffer.from(
					await commands.capturePng({ display: request.display, maxBytes: request.maxBytes, signal }),
				).toString("base64");
			else if (request.action === "pointer")
				value = await commands.run({
					program: "/usr/bin/xdotool",
					args: ["getmouselocation", "--shell"],
					environment: { DISPLAY: ":1", PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
					workingDirectory: layout.workbenchRoot,
					timeoutMs: 5000,
					maxOutputBytes: 16384,
					signal,
				});
			else {
				await commands.close();
				assert.deepEqual(await readdir("/run/office-captures"), []);
				value = { closed: true };
			}
		}
		process.stdout.write(`${JSON.stringify({ id: request.id, value })}\n`);
		if (request.action === "close") break;
	}
} finally {
	await commands?.close();
	xvfb.kill("SIGTERM");
	await exited;
}
