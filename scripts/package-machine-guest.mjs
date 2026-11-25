import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { RECORD, readFolderProgramRecord } from "./folder-program-artifact.mjs";
import { MACHINE_DESKTOP_PICTURES, tarArchive } from "./machine-desktop-art.mjs";

// The company machine guest (2026-09-28): the command helper and its watchdog
// units, packaged as reviewable files with their checksums. Installing them
// into the machine image is deploy/machine/build-machine-image.sh's job.
// Since F3 step 6c it also carries the company folder's program (the build
// RECORD names, made by scripts/build-folder-program.mjs) and its unit, which
// mounts the folder at /company once the host hands the machine a view.
// Since 20260930705000 it also carries save_coding_value's clipboard helper,
// built as its own file after the guest helper, so the guest helper (the
// manifest's first artifact, whose sha-256 the executor pins) stays as it was.
// Since 20260930708000 it also carries machine_screen's screen helper, built the
// same way and for the same reason.
// Since 12 Nov 2026 it also carries every machine's compressed memory and edge
// guard (machine-memory, its two units, the LXD agent's drop-in): files only,
// so the guest helper stays as it was. And the desktop's look (desktop-look,
// the dock's request units, and one archive of pictures: the dock icons and
// the backdrop sets): files only too.
const USAGE = "Usage: package-machine-guest.mjs --out <new-directory> --folder-program <built qorpera-folder>";
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--out" || args[2] !== "--folder-program") throw new Error(USAGE);
const output = resolve(args[1]);
const units = [
	"qorpera-machine.slice",
	"qorpera-machine-watchdog.service",
	"qorpera-machine-watchdog.timer",
	"qorpera-machine-folder.service",
	"qorpera-machine-desktop.service",
	"qorpera-machine-memory.service",
	"qorpera-machine-memory-guard.service",
	"qorpera-machine-desktop-dock.path",
	"qorpera-machine-desktop-dock.service",
];
// The desktop (9 Nov 2026): its session, the agents' `desktop` command and Chromium's AppArmor profile. Since 10 Nov
// 2026 also the page `desktop selftest` opens, the browser's managed policy (no translate offer, no sign-in), a
// `chromium` that runs from root's shell, the login shells' paths to the installed Playwright, and the build's
// Playwright check. Since 12 Nov 2026 also every machine's memory at the edge: compressed memory at boot and the guard
// that ends one program when it runs out (machine-memory, with the two units above), and the LXD agent's protection;
// and the desktop's look, which the session writes at every start (desktop-look), the program root starts for a press
// on the dock (desktop-dock-open, with the two dock units above) and the folder such a press asks in; and what
// `desktop` does with files where the desktop's account can reach (desktop-files). Since 13 Nov 2026 also what the
// image's render tools need from the repository: the build's render check, and the starter set's list (each file's
// address and sha-256, which the build fetches), its guide for agents and a picture of everything in it.
const files = [
	{ file: "desktop-session", installedPath: "/opt/qorpera-machine/desktop-session", mode: "0555" },
	{ file: "desktop", installedPath: "/usr/local/bin/desktop", mode: "0555" },
	{ file: "qorpera-chromium.apparmor", installedPath: "/etc/apparmor.d/qorpera-chromium", mode: "0644" },
	{ file: "desktop-selftest.html", installedPath: "/opt/qorpera-machine/desktop-selftest.html", mode: "0444" },
	{ file: "playwright-check.cjs", installedPath: "/opt/qorpera-machine/playwright-check.cjs", mode: "0444" },
	{ file: "chromium", installedPath: "/usr/local/bin/chromium", mode: "0555" },
	{ file: "qorpera-machine-profile.sh", installedPath: "/etc/profile.d/qorpera-machine.sh", mode: "0644" },
	{
		file: "qorpera-chromium-policy.json",
		installedPath: "/etc/opt/chrome_for_testing/policies/managed/qorpera.json",
		mode: "0644",
	},
	{ file: "machine-memory", installedPath: "/opt/qorpera-machine/machine-memory", mode: "0555" },
	{
		file: "lxd-agent-memory.conf",
		installedPath: "/etc/systemd/system/lxd-agent.service.d/qorpera-memory.conf",
		mode: "0644",
	},
	{ file: "desktop-look", installedPath: "/opt/qorpera-machine/desktop-look", mode: "0555" },
	{ file: "desktop-dock-open", installedPath: "/opt/qorpera-machine/desktop-dock-open", mode: "0555" },
	{ file: "desktop-files", installedPath: "/opt/qorpera-machine/desktop-files", mode: "0555" },
	{
		file: "qorpera-machine-desktop.tmpfiles",
		installedPath: "/etc/tmpfiles.d/qorpera-machine-desktop.conf",
		mode: "0644",
	},
	{ file: "render-check.py", installedPath: "/opt/qorpera-machine/render-check.py", mode: "0444" },
	{ file: "render-assets.tsv", installedPath: "/opt/qorpera-assets/SOURCES.tsv", mode: "0444" },
	{ file: "render-assets.md", installedPath: "/opt/qorpera-assets/README.md", mode: "0444" },
	{ file: "render-assets-preview.jpg", installedPath: "/opt/qorpera-assets/preview.jpg", mode: "0444" },
	// The agent's home (13 Nov 2026): the account Codex's own shell runs as reaches root without a password, as every
	// coding session's user does, so that shell can do on the machine everything `machine_run` does there as root.
	{ file: "qorpera-agent.sudoers", installedPath: "/etc/sudoers.d/qorpera-agent", mode: "0440" },
];
await Promise.all([...units, ...files.map((entry) => entry.file)].map((file) => readFile(`deploy/machine/${file}`)));
// The desktop's pictures (the dock icons and the backdrop sets), one archive the image build unpacks at
// /usr/share/qorpera-desktop (scripts/machine-desktop-art.mjs).
const art = tarArchive(
	await Promise.all(MACHINE_DESKTOP_PICTURES.map(async ({ name, source }) => ({ name, bytes: await readFile(source) }))),
);
// Only the recorded build: the image script pins the same bytes.
const program = await readFile(resolve(args[3]));
const record = readFolderProgramRecord();
const programSha256 = createHash("sha256").update(program).digest("hex");
if (program.length !== record.bytes || programSha256 !== record.sha256) {
	throw new Error(`--folder-program is ${programSha256}, not the build ${RECORD} records (${record.sha256})`);
}
await mkdir(output, { recursive: false, mode: 0o700 });
const artifacts = [];
await build({
	entryPoints: ["packages/runtime/src/cloud-machine-guest.ts"],
	outfile: resolve(output, "cloud-machine-guest.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22.19",
	minifyWhitespace: true,
	minifySyntax: true,
	legalComments: "none",
	logLevel: "silent",
});
const helper = await readFile(resolve(output, "cloud-machine-guest.mjs"));
// The executor re-reads the helper through LXD's 64 KiB file read to check its pin.
if (helper.length > 65536) throw new Error("Machine guest helper exceeds the protected transport bound");
artifacts.push({
	file: "cloud-machine-guest.mjs",
	source: "packages/runtime/src/cloud-machine-guest.ts",
	installedPath: "/opt/qorpera-machine/cloud-machine-guest.mjs",
	owner: "root:root",
	mode: "0444",
	sha256: createHash("sha256").update(helper).digest("hex"),
	bytes: helper.length,
});
// save_coding_value's clipboard helper (20260930705000): the executor runs it with node; it reads the desktop's
// clipboard, seals the key in it for the vault and clears it.
await build({
	entryPoints: ["packages/runtime/src/cloud-machine-coding-value-main.ts"],
	outfile: resolve(output, "cloud-machine-coding-value.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22.19",
	minifyWhitespace: true,
	minifySyntax: true,
	legalComments: "none",
	logLevel: "silent",
});
const codingValues = await readFile(resolve(output, "cloud-machine-coding-value.mjs"));
artifacts.push({
	file: "cloud-machine-coding-value.mjs",
	source: "packages/runtime/src/cloud-machine-coding-value-main.ts",
	installedPath: "/opt/qorpera-machine/cloud-machine-coding-value.mjs",
	owner: "root:root",
	mode: "0444",
	sha256: createHash("sha256").update(codingValues).digest("hex"),
	bytes: codingValues.length,
});
// machine_screen's screen helper (20260930708000): the executor runs it with node; it takes one desktop action through
// `desktop`, takes a screenshot and prints it.
await build({
	entryPoints: ["packages/runtime/src/cloud-machine-screen-main.ts"],
	outfile: resolve(output, "cloud-machine-screen.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22.19",
	minifyWhitespace: true,
	minifySyntax: true,
	legalComments: "none",
	logLevel: "silent",
});
const screen = await readFile(resolve(output, "cloud-machine-screen.mjs"));
artifacts.push({
	file: "cloud-machine-screen.mjs",
	source: "packages/runtime/src/cloud-machine-screen-main.ts",
	installedPath: "/opt/qorpera-machine/cloud-machine-screen.mjs",
	owner: "root:root",
	mode: "0444",
	sha256: createHash("sha256").update(screen).digest("hex"),
	bytes: screen.length,
});
await build({
	entryPoints: ["packages/runtime/src/cloud-machine-account-fill-main.ts"],
	outfile: resolve(output, "cloud-machine-account-fill.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22.19",
	minifyWhitespace: true,
	minifySyntax: true,
	legalComments: "none",
	logLevel: "silent",
});
const accountFills = await readFile(resolve(output, "cloud-machine-account-fill.mjs"));
artifacts.push({
	file: "cloud-machine-account-fill.mjs",
	source: "packages/runtime/src/cloud-machine-account-fill-main.ts",
	installedPath: "/opt/qorpera-machine/cloud-machine-account-fill.mjs",
	owner: "root:root",
	mode: "0444",
	sha256: createHash("sha256").update(accountFills).digest("hex"),
	bytes: accountFills.length,
});
for (const unit of units) {
	const bytes = await readFile(`deploy/machine/${unit}`);
	await writeFile(resolve(output, unit), bytes, { mode: 0o644 });
	artifacts.push({
		file: unit,
		source: `deploy/machine/${unit}`,
		installedPath: `/etc/systemd/system/${unit}`,
		owner: "root:root",
		mode: "0644",
		sha256: createHash("sha256").update(bytes).digest("hex"),
		bytes: bytes.length,
	});
}
for (const { file, installedPath, mode } of files) {
	const bytes = await readFile(`deploy/machine/${file}`);
	await writeFile(resolve(output, file), bytes, { mode: Number.parseInt(mode, 8) });
	artifacts.push({
		file,
		source: `deploy/machine/${file}`,
		installedPath,
		owner: "root:root",
		mode,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		bytes: bytes.length,
	});
}
await writeFile(resolve(output, "desktop-art.tar"), art, { mode: 0o644 });
artifacts.push({
	file: "desktop-art.tar",
	source: "deploy/machine/dock, deploy/machine/backdrops",
	installedPath: "/usr/share/qorpera-desktop",
	owner: "root:root",
	mode: "0644",
	sha256: createHash("sha256").update(art).digest("hex"),
	bytes: art.length,
	entries: MACHINE_DESKTOP_PICTURES.length,
});
await writeFile(resolve(output, "qorpera-folder"), program, { mode: 0o755 });
artifacts.push({
	file: "qorpera-folder",
	source: RECORD,
	installedPath: "/opt/qorpera-folder/qorpera-folder",
	owner: "root:root",
	mode: "0555",
	sha256: programSha256,
	bytes: program.length,
});
// The node proof (deploy/machine/prove-machine-node.ts) is packaged beside it for
// the operator; it is never installed in the image.
await build({
	entryPoints: ["deploy/machine/prove-machine-node.ts"],
	outfile: resolve(output, "prove-machine-node.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22.19",
	minifyWhitespace: true,
	minifySyntax: true,
	legalComments: "none",
	logLevel: "silent",
});
const manifest = `${JSON.stringify({ schema: "qorpera.machine-guest-package/v1", artifacts, installationPerformed: false }, null, 2)}\n`;
await writeFile(resolve(output, "manifest.json"), manifest, { mode: 0o600 });
console.log(JSON.stringify({ output, helperSha256: artifacts[0].sha256, bytes: helper.length }));
