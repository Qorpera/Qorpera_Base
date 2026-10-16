import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import {
	CompanyComputerLinuxShell,
	createCompanyComputerLinuxShellLauncher,
} from "../../src/cloud-company-computer-linux-shell.ts";
import { parseRecoveryDirectoryMount } from "../../src/cloud-identity-recovery-filesystems.ts";
import { computerBinding } from "./company-computer.ts";

/** The run that starts the commands here. */
const TOOLBOX_RUN = "00000000-0000-4000-8000-0000000000c7";

// Candidate office image only (scripts/build-office-image-candidate.sh): the
// image's own shell host, as the office account under the installed office
// unit's confinement and limits, runs every toolbox check of the image's
// dependency recipe from a computer's shell. The builder starts it with
// systemd-run; the launcher refuses any capability, a missing no_new_privs or
// limits above the ones below. No plumber answers, so the shell has loopback only.
//
//   node company-computer-linux-toolbox-probe.mjs <probe directory> <recipe>
const [root, recipePath] = process.argv.slice(2);
assert.ok(root && recipePath && process.argv.length === 4, "usage: <probe directory> <recipe>");
assert.equal(process.platform, "linux");
const recipe = JSON.parse(await readFile(recipePath, "utf8")) as {
	downloads: { name: string; version: string }[];
	toolbox: string[][];
};
const node = recipe.downloads.find((download) => download.name === "node")!.version;
const layout = {
	workbenchRoot: `${root}/workbench`,
	desktopHome: `${root}/desktop`,
	screenStateRoot: `${root}/screens`,
	browserProfilesRoot: `${root}/profiles`,
};
const directory = await open(layout.workbenchRoot, constants.O_RDONLY | constants.O_DIRECTORY);
const workbenchMount = parseRecoveryDirectoryMount(
	await readFile("/proc/self/mountinfo", "utf8"),
	await readFile(`/proc/self/fdinfo/${directory.fd}`, "utf8"),
);
await directory.close();
// The office unit's MemoryMax=4G, TasksMax=512 and CPUQuota=200%.
const limits = { memoryBytes: 4294967296, pids: 512, cpuQuota: 200000, cpuPeriod: 100000 };

const shell = new CompanyComputerLinuxShell(
	createCompanyComputerLinuxShellLauncher({
		binding: computerBinding(),
		layout,
		workbenchMount,
		limits,
		runtimeRoot: `${root}/runtime`,
		boundary: { assertReady: async () => undefined },
		plumbSocket: `${root}/no-plumber.sock`,
	}),
);
try {
	const signal = new AbortController().signal;
	/** Runs one command to its end; LibreOffice's first start is slow on a busy test machine. */
	const done = async (command: string) => {
		const { sessionId } = await shell.start({ runId: TOOLBOX_RUN, key: randomUUID(), command, signal });
		let result = await shell.result({ sessionId, waitMs: 10000, signal });
		for (let attempt = 0; result.state === "running" && attempt < 12; attempt++) {
			const next = await shell.result({ sessionId, waitMs: 10000, signal });
			result = { ...next, output: result.output + next.output };
		}
		assert.equal(result.state, "exited", `${command}: ${result.output} ${result.note ?? ""}`);
		assert.equal(result.exitCode, 0, `${command}: ${result.output}`);
		return result.output;
	};

	// The shell runs the image's one Node.js, and the machine has no swap.
	assert.equal(
		await done(`set -eu
test "$(command -v node)" = /usr/bin/node
test "$(node --version)" = v${node}
test "$(wc -l </proc/swaps)" = 1
echo sandbox-ok`),
		"sandbox-ok\n",
	);
	const checks = [];
	for (const check of recipe.toolbox) {
		const output = await done(check.join(" "));
		const first = output.split("\n")[0]!.trim();
		assert.ok(first, `${check.join(" ")} printed nothing`);
		checks.push({ check: check.join(" "), first });
	}
	console.log(JSON.stringify({ result: "passed", uid: process.getuid?.(), node: `v${node}`, swap: "off", checks }));
} finally {
	await shell.close().catch(() => undefined);
}
