import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { build } from "esbuild";
import { BACKDROP_FILES, DOCK_ICONS, MACHINE_DESKTOP_PICTURES, NEUTRAL_BACKDROP, tarArchive } from "./machine-desktop-art.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(repositoryRoot, path), "utf8");
const imageScript = read("deploy/machine/build-machine-image.sh");
/** The words of a shell list that may continue over `\` line ends. */
const words = (text) => text.split(/[\s\\]+/).filter(Boolean);

test("the image installs the toolbox every Qorpera machine has, and its checks ask each command its version", () => {
	// deploy/first-node/RUNTIME-FOLDER-COMPANY-MACHINES.md (4e): bash and the usual Unix tools, git, Node.js with npm,
	// npx, tsc and tsx, Python 3 with pip and uv, mise (QORPERA-RUNTIME-CONTRACT.md, "One toolbox on every machine"),
	// ripgrep, fd, jq, sqlite3, curl, zip, unzip, LibreOffice.
	const apt = words(imageScript.match(/apt-get install -y --no-install-recommends((?:[^\n]*\\\n)*[^\n]*)/)[1]);
	for (const name of [
		"git",
		"curl",
		"jq",
		"zip",
		"unzip",
		"python3",
		"python3-pip",
		"ripgrep",
		"fd-find",
		"sqlite3",
		"libreoffice-nogui",
		"fuse3",
	])
		assert.ok(apt.includes(name), `apt installs ${name}`);
	const checked = words(imageScript.match(/for tool in ([^;]+); do\s*\n\s*"\$tool" --version/)[1]);
	for (const tool of [
		"bash",
		"git",
		"node",
		"npm",
		"npx",
		"tsc",
		"tsx",
		"python3",
		"pip",
		"uv",
		"mise",
		"rg",
		"fd",
		"jq",
		"sqlite3",
		"curl",
		"zip",
		"libreoffice",
		"fusermount3",
	])
		assert.ok(checked.includes(tool), `the image checks ${tool} --version`);
	// unzip alone has no --version.
	assert.match(imageScript, /\n\tunzip -v >\/dev\/null\n/);
	// What apt does not bring is pinned: uv and mise by their releases' sha-256, tsc and tsx by exact npm versions.
	assert.match(imageScript, /\nUV_VERSION=\d+\.\d+\.\d+\nUV_SHA256=[0-9a-f]{64}\n/);
	assert.match(imageScript, /\nMISE_VERSION=\d{4}\.\d+\.\d+\nMISE_SHA256=[0-9a-f]{64}\n/);
	assert.match(imageScript, /\nTYPESCRIPT_VERSION=\d+\.\d+\.\d+\nTSX_VERSION=\d+\.\d+\.\d+\n/);
	assert.match(imageScript, /echo "\$\{UV_SHA256\}  \/tmp\/uv\.tar\.gz" \| sha256sum -c -/);
	// mise is the release's own linux-x64 binary, checked before it goes on every user's PATH.
	assert.match(
		imageScript,
		/curl -fsSLo \/tmp\/mise "https:\/\/github\.com\/jdx\/mise\/releases\/download\/v\$\{MISE_VERSION\}\/mise-v\$\{MISE_VERSION\}-linux-x64"\n\techo "\$\{MISE_SHA256\}  \/tmp\/mise" \| sha256sum -c -\n\tinstall -o root -g root -m 0755 \/tmp\/mise \/usr\/local\/bin\/mise\n/,
	);
	assert.match(
		imageScript,
		/npm install -g --ignore-scripts --no-fund --no-audit "typescript@\$\{TYPESCRIPT_VERSION\}" "tsx@\$\{TSX_VERSION\}"/,
	);
});

test("the image carries the pinned folder program, every unit the guest package has, and empty /company and caches", () => {
	const packager = read("scripts/package-machine-guest.mjs");
	const units = [...packager.match(/const units = \[([^\]]+)\]/)[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
	assert.ok(units.includes("qorpera-machine-folder.service"));
	const pushed = words(imageScript.match(/for unit in ([^;]+); do\n\tlx file push "\$PACKAGE\/\$unit"/)[1]);
	assert.deepEqual(pushed, units);
	const required = words(imageScript.match(/for file in ([^;]+); do\n\t\[\[ -f \$PACKAGE\/\$file \]\]/)[1]);
	for (const file of ["cloud-machine-guest.mjs", ...units, "qorpera-folder", "manifest.json"]) assert.ok(required.includes(file));
	// The program goes where its unit starts it, read-only, and is checked against the pin before and after.
	assert.match(
		imageScript,
		/lx file push "\$PACKAGE\/qorpera-folder" "\$BUILDER\/opt\/qorpera-folder\/qorpera-folder" --uid 0 --gid 0 --mode 0555\n/,
	);
	assert.match(read("deploy/machine/qorpera-machine-folder.service"), /\nExecStart=\/opt\/qorpera-folder\/qorpera-folder mount /);
	assert.match(imageScript, /\[\[ \$\(sha256sum <"\$PACKAGE\/qorpera-folder" \| cut -d' ' -f1\) == "\$EXPECTED_FOLDER_PROGRAM_SHA256" \]\]/);
	assert.match(imageScript, /\n\t\/opt\/qorpera-folder\/qorpera-folder --version\n/);
	assert.match(imageScript, /\[\[ \$\(systemctl is-enabled qorpera-machine-folder\.service \|\| true\) == static \]\]/);
	assert.match(imageScript, /install -d -o root -g root -m 0755 \/company\n/);
	assert.match(imageScript, /systemd-analyze verify [^\n]*\\\n\t\t\/etc\/systemd\/system\/qorpera-machine-folder\.service\n/);
	// The program's cache folder, which its unit names: on the machine's disk, root's, closed and empty in the image.
	const unit = read("deploy/machine/qorpera-machine-folder.service");
	assert.match(unit, /\nExecStart=[^\n]* --cache-dir \/var\/lib\/qorpera-folder\/cache\/machine /);
	assert.match(
		imageScript,
		/\n\tinstall -d -o root -g root -m 0700 \/var\/lib\/qorpera-folder \/var\/lib\/qorpera-folder\/cache \\\n\t\t\/var\/lib\/qorpera-folder\/cache\/machine\n/,
	);
	assert.match(imageScript, /\[\[ \$\(stat -c "%U:%G %a %F" "\$folder"\) == "root:root 700 directory" \]\]/);
	assert.match(imageScript, /\[\[ -z \$\(ls -A \/var\/lib\/qorpera-folder\/cache\/machine\) \]\]/);
});

test("the image never updates itself, firmware metadata included, and its checks refuse one that could", () => {
	// A quiet machine sleeps only if nothing in it works by itself: fwupd's refresh counted as busy (C8 MA-5b).
	const masked = [...imageScript.matchAll(/\n\tsystemctl mask ([^\n]+)\n/g)].flatMap((match) => words(match[1]));
	for (const unit of [
		"apt-daily.timer",
		"apt-daily-upgrade.timer",
		"apt-daily.service",
		"apt-daily-upgrade.service",
		"unattended-upgrades.service",
		"fwupd-refresh.timer",
		"fwupd-refresh.service",
		"fwupd.service",
	])
		assert.ok(masked.includes(unit), `the image masks ${unit}`);
	// Every masked unit is checked to link to /dev/null.
	const checked = words(
		imageScript.match(/for unit in ([^;]+); do\n\t\t\[\[ \$\(readlink "\/etc\/systemd\/system\/\$unit"\) == \/dev\/null \]\]/)[1],
	);
	assert.deepEqual(checked.toSorted(), masked.toSorted());
	// Whatever fwupd names its units: no fwupd timer that is not masked, no other fwupd unit that starts at boot, and no
	// bus name of fwupd that starts anything but a masked unit.
	assert.match(imageScript, /\n\tunits=\$\(systemctl list-unit-files --no-legend "\*fwupd\*"\)\n/);
	assert.match(
		imageScript,
		/\[\[ \$state == masked \|\| \( \$unit != \*\.timer && \( \$state == static \|\| \$state == disabled \) \) \]\] \|\|/,
	);
	assert.match(imageScript, /grep -q "\^Name=org\\\.freedesktop\\\.fwupd" "\$bus" \|\| continue\n/);
	assert.match(imageScript, /\[\[ -n \$service && \$\(systemctl is-enabled "\$service" \|\| true\) == masked \]\] \|\|/);
});

test("the guest package takes only the recorded folder program", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-machine-guest-test-"));
	try {
		const program = join(temporary, "qorpera-folder");
		await writeFile(program, Buffer.from("\x7fELF not the recorded build", "latin1"));
		const destination = join(temporary, "package");
		const run = (args) =>
			spawnSync(process.execPath, ["scripts/package-machine-guest.mjs", ...args], {
				cwd: repositoryRoot,
				encoding: "utf8",
				timeout: 60_000,
			});
		const other = run(["--out", destination, "--folder-program", program]);
		assert.notEqual(other.status, 0);
		assert.match(other.stderr, /--folder-program is [0-9a-f]{64}, not the build deploy\/folder-service\/folder-program-linux-x64\.json records/);
		const without = run(["--out", destination]);
		assert.notEqual(without.status, 0);
		assert.match(without.stderr, /Usage: package-machine-guest\.mjs --out <new-directory> --folder-program/);
		assert.equal(existsSync(destination), false, "a refused package writes nothing");
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test("the guest helper with the folder mount stays under the executor's 64 KiB read", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-machine-guest-helper-"));
	try {
		const outfile = join(temporary, "cloud-machine-guest.mjs");
		// The packager's own options (scripts/package-machine-guest.mjs).
		await build({
			entryPoints: [join(repositoryRoot, "packages/runtime/src/cloud-machine-guest.ts")],
			outfile,
			bundle: true,
			platform: "node",
			format: "esm",
			target: "node22.19",
			legalComments: "none",
			logLevel: "silent",
		});
		const helper = await readFile(outfile);
		assert.ok(helper.length <= 65536, `the helper is ${helper.length} bytes`);
		assert.match(helper.toString("utf8"), /folder-mount/);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test("the image has a desktop that only `desktop start` starts, with Chromium sandboxed, and checks it end to end", () => {
	// deploy/machine/README.md, "The desktop" (9 Nov 2026).
	const packager = read("scripts/package-machine-guest.mjs");
	const files = [...packager.matchAll(/\{\s*file: "([^"]+)",\s*installedPath: "([^"]+)",\s*mode: "(\d{4})",?\s*\}/g)].map(
		([, file, installedPath, mode]) => ({ file, installedPath, mode }),
	);
	assert.deepEqual(files, [
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
		{
			file: "qorpera-machine-desktop.tmpfiles",
			installedPath: "/etc/tmpfiles.d/qorpera-machine-desktop.conf",
			mode: "0644",
		},
	]);
	const required = words(imageScript.match(/for file in ([^;]+); do\n\t\[\[ -f \$PACKAGE\/\$file \]\]/)[1]);
	for (const { file, installedPath, mode } of files) {
		assert.ok(required.includes(file), file);
		assert.ok(
			imageScript.includes(`lx file push "$PACKAGE/${file}" "$BUILDER${installedPath}" --uid 0 --gid 0 --mode ${mode}\n`),
			file,
		);
	}
	const unit = read("deploy/machine/qorpera-machine-desktop.service");
	assert.doesNotMatch(unit, /^\[Install\]/m);
	assert.match(unit, /\nSlice=qorpera-machine\.slice\n/);
	assert.match(unit, /\nUser=desktop\n/);
	assert.match(unit, /\nExecStart=\/opt\/qorpera-machine\/desktop-session\n/);
	const session = read("deploy/machine/desktop-session");
	// VNC only on the machine's loopback, no TCP X.
	assert.match(session, /Xvnc :1 [^\n]*-localhost yes [^\n]*-nolisten tcp/);
	const apt = words(imageScript.match(/apt-get install -y --no-install-recommends((?:[^\n]*\\\n)*[^\n]*)/)[1]);
	for (const tool of ["tigervnc-standalone-server", "xfce4-session", "xdotool", "wmctrl", "scrot", "x11-utils", "file"])
		assert.ok(apt.includes(tool), tool);
	// The coding image's Chromium pin, the same bytes.
	const coding = JSON.parse(read("deploy/coding-machine/coding-image.json")).chromium;
	assert.match(imageScript, new RegExp(`\\nCHROMIUM_VERSION=${coding.version.replaceAll(".", "\\.")}\\n`));
	assert.ok(imageScript.includes(`\nCHROMIUM_URL=${coding.url}\n`));
	assert.ok(imageScript.includes(`\nCHROMIUM_SHA256=${coding.sha256}\n`));
	assert.ok(imageScript.includes(`[[ $(chromium --version) == *" ${coding.version}"* ]]`));
	assert.match(read("deploy/machine/qorpera-chromium.apparmor"), /profile qorpera-chromium \/usr\/lib\/qorpera-chromium\/chrome flags=\(unconfined\) \{\n\s+userns,/);
	// The build's own check: started, Chromium on it, a 1600x1000 shot, stopped with nothing left.
	for (const line of [
		"\tdesktop start\n",
		'\tdesktop shot /tmp/desktop.png | grep -q " 1600 x 1000$"',
		"\tdesktop stop\n",
		"\t[[ -z $(pgrep -u desktop || true) ]]",
		"\tsystemd-analyze verify /etc/systemd/system/qorpera-machine-desktop.service\n",
	])
		assert.ok(imageScript.includes(line), line);
	// A program on the desktop: refused unless the desktop is active, stopped with it, its arguments not expanded by
	// systemd, and start/stop/launch take turns under one lock (review r1 F3, F4).
	const command = read("deploy/machine/desktop");
	assert.match(command, /systemd-run --quiet --collect --expand-environment=no /);
	assert.match(command, /-p Requisite="\$UNIT" -p BindsTo="\$UNIT" -p After="\$UNIT"/);
	assert.doesNotMatch(command, /PartOf=/);
	assert.match(command, /start \| stop \| open \| run\)\n\texec 9>\/run\/qorpera-desktop\.lock\n\tflock 9\n/);
	for (const line of [
		'\t[[ $(cat /tmp/desktop-run) == "literal \\$HOME" ]]',
		'\tif desktop run sleep 600 2>/dev/null; then echo "a program started on a stopped desktop" >&2; exit 1; fi\n',
	])
		assert.ok(imageScript.includes(line), line);
	// The proof changes nothing on its host: no module loads, no firewall rules (review r1 F1).
	const proof = read("scripts/prove-machine-desktop-vm.sh");
	assert.doesNotMatch(proof, /modprobe|iptables -[ID]/);
	const cli = spawnSync("bash", [join(repositoryRoot, "deploy/machine/desktop"), "help"], { encoding: "utf8" });
	assert.equal(cli.status, 0);
	for (const command of ["start", "stop", "status", "shot", "open", "run", "click", "double", "move", "drag", "type", "key", "scroll", "windows", "size", "selftest"])
		assert.match(cli.stdout, new RegExp(`^desktop ${command}\\b`, "m"), command);
	const unknown = spawnSync("bash", [join(repositoryRoot, "deploy/machine/desktop"), "fly"], { encoding: "utf8" });
	assert.equal(unknown.status, 2);
});

test("the image carries save_coding_value's clipboard helper as its own file, with xsel, and checks it on the desktop", async () => {
	// 20260930705000: the helper is built beside the guest helper, never into it, so the guest helper's pin stays as it was.
	const packager = read("scripts/package-machine-guest.mjs");
	assert.match(packager, /entryPoints: \["packages\/runtime\/src\/cloud-machine-coding-value-main\.ts"\]/);
	assert.match(
		packager,
		/file: "cloud-machine-coding-value\.mjs",\n\tsource: "packages\/runtime\/src\/cloud-machine-coding-value-main\.ts",\n\tinstalledPath: "\/opt\/qorpera-machine\/cloud-machine-coding-value\.mjs",\n\towner: "root:root",\n\tmode: "0444",/,
	);
	// The runtime imports the helper's module (its refusal codes), and every service bundle with it: loading it runs
	// nothing. Only its entry, which nothing imports, runs the program.
	assert.doesNotMatch(read("packages/runtime/src/cloud-machine-coding-value.ts"), /process\.(argv|stdin|exitCode)|import\.meta/);
	assert.match(read("packages/runtime/src/cloud-machine-coding-value-main.ts"), /^runMachineCodingValueCli\(/m);
	// The guest helper stays the manifest's first artifact: the build record and the proofs read its pin there.
	assert.ok(packager.indexOf('file: "cloud-machine-guest.mjs"') < packager.indexOf('file: "cloud-machine-coding-value.mjs"'));
	assert.match(imageScript, /--arg helperSha256 "\$\(jq -r '\.artifacts\[0\]\.sha256' "\$PACKAGE\/manifest\.json"\)"/);
	const required = words(imageScript.match(/for file in ([^;]+); do\n\t\[\[ -f \$PACKAGE\/\$file \]\]/)[1]);
	assert.ok(required.includes("cloud-machine-coding-value.mjs"));
	assert.ok(
		imageScript.includes(
			'lx file push "$PACKAGE/cloud-machine-coding-value.mjs" "$BUILDER/opt/qorpera-machine/cloud-machine-coding-value.mjs" --uid 0 --gid 0 --mode 0444\n',
		),
	);
	const apt = words(imageScript.match(/apt-get install -y --no-install-recommends((?:[^\n]*\\\n)*[^\n]*)/)[1]);
	assert.ok(apt.includes("xsel"));
	// The build's own check: a key copied on the desktop is sealed, never printed, both selections left empty, and an
	// empty clipboard and a stopped desktop refused; no clipboard manager keeps what is copied.
	for (const line of [
		'\t[[ -z $(command -v xfce4-clipman || true) ]] || { echo "a clipboard manager would keep copied keys" >&2; exit 1; }\n',
		'spawnSync("/usr/bin/node", ["/opt/qorpera-machine/cloud-machine-coding-value.mjs"]',
		'fail("the clipboard helper printed the key")',
		'fail("the clipboard helper left the key on the clipboard")',
		'fail("the clipboard helper did not refuse an empty clipboard")',
		'fail("the clipboard helper did not refuse a stopped desktop")',
		'fail("--clear-only left the key on the clipboard")',
	])
		assert.ok(imageScript.includes(line), line);
	// The check's script sits in the build's single-quoted script: it must hold no single quote.
	const check = imageScript.slice(imageScript.indexOf('\tnode - <<"JS"\n'), imageScript.indexOf("\nJS\n"));
	assert.ok(check.length > 0 && !check.includes("'"));
	// The helper's time fits the executor's deadlines: a read and both clears side by side are two xsels' time, killed
	// at MACHINE_XSEL_MS each, plus its start, well inside the run's deadline; the executor's own clear (--clear-only)
	// is one xsel's time and its start, inside its own.
	const helperSource = read("packages/runtime/src/cloud-machine-coding-value.ts");
	const hostSource = read("packages/runner-orchestrator/src/company-machine-host.ts");
	const xselMs = Number(helperSource.match(/\nexport const MACHINE_XSEL_MS = ([0-9_]+);\n/)[1].replaceAll("_", ""));
	const runMs = Number(hostSource.match(/\nconst CODING_VALUE_MS = (\d+);\n/)[1]);
	const clearMs = Number(hostSource.match(/\nconst CODING_VALUE_CLEAR_MS = (\d+);\n/)[1]);
	assert.ok(2 * xselMs + 4000 <= runMs / 1.5, `${xselMs} ms per xsel against ${runMs} ms`);
	assert.ok(xselMs + 4000 <= clearMs, `${xselMs} ms per xsel against the clear's ${clearMs} ms`);
	assert.match(helperSource, /timeout: timeoutMs,\n\t\t\tkillSignal: "SIGKILL",/);
	assert.match(helperSource, /return Promise\.all\(\[clipboard\.clear\("clipboard"\), clipboard\.clear\("primary"\)\]\);/);
	// The executor's own clear runs on a deadline of its own, never the request's signal.
	assert.match(hostSource, /AbortSignal\.timeout\(this\.#options\.codingValueClearTimeoutMs \?\? CODING_VALUE_CLEAR_MS\)/);
	// The executor runs it where the image put it.
	assert.match(
		read("packages/runner-orchestrator/src/company-machine-host.ts"),
		/COMPANY_MACHINE_CODING_VALUE_HELPER = "\/opt\/qorpera-machine\/cloud-machine-coding-value\.mjs"/,
	);
	// Built with the packager's options, the guest helper holds none of it, and the clipboard helper reads the clipboard
	// with xsel against the desktop's display only.
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-machine-coding-value-"));
	try {
		const options = { bundle: true, platform: "node", format: "esm", target: "node22.19", legalComments: "none", logLevel: "silent" };
		await build({ ...options, entryPoints: [join(repositoryRoot, "packages/runtime/src/cloud-machine-guest.ts")], outfile: join(temporary, "guest.mjs") });
		await build({ ...options, entryPoints: [join(repositoryRoot, "packages/runtime/src/cloud-machine-coding-value-main.ts")], outfile: join(temporary, "coding-value.mjs") });
		const guest = await readFile(join(temporary, "guest.mjs"), "utf8");
		const helper = await readFile(join(temporary, "coding-value.mjs"), "utf8");
		assert.doesNotMatch(guest, /coding-value-machine|xsel/);
		assert.match(helper, /"\/usr\/bin\/xsel"/);
		assert.match(helper, /DISPLAY = ":1"/);
		assert.ok(helper.length < 65536, `the clipboard helper is ${helper.length} bytes`);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test("the image carries machine_screen's screen helper as its own file, and checks it on the desktop as the executor runs it", async () => {
	// 20260930708000: the helper is built beside the guest helper, never into it, so the guest helper's pin stays as it was.
	const packager = read("scripts/package-machine-guest.mjs");
	assert.match(packager, /entryPoints: \["packages\/runtime\/src\/cloud-machine-screen-main\.ts"\]/);
	assert.match(
		packager,
		/file: "cloud-machine-screen\.mjs",\n\tsource: "packages\/runtime\/src\/cloud-machine-screen-main\.ts",\n\tinstalledPath: "\/opt\/qorpera-machine\/cloud-machine-screen\.mjs",\n\towner: "root:root",\n\tmode: "0444",/,
	);
	// The runtime imports the helper's module (the action's shape, the refusal codes): loading it runs nothing. Only its
	// entry, which nothing imports, runs the program.
	assert.doesNotMatch(read("packages/runtime/src/cloud-machine-screen.ts"), /process\.(argv|stdin|exitCode)|import\.meta/);
	assert.match(read("packages/runtime/src/cloud-machine-screen-main.ts"), /^runMachineScreenCli\(/m);
	// The guest helper stays the manifest's first artifact, and its source does not reach the screen helper's module.
	assert.ok(packager.indexOf('file: "cloud-machine-guest.mjs"') < packager.indexOf('file: "cloud-machine-screen.mjs"'));
	assert.doesNotMatch(read("packages/runtime/src/cloud-machine-guest.ts"), /cloud-machine-screen/);
	const required = words(imageScript.match(/for file in ([^;]+); do\n\t\[\[ -f \$PACKAGE\/\$file \]\]/)[1]);
	assert.ok(required.includes("cloud-machine-screen.mjs"));
	assert.ok(
		imageScript.includes(
			'lx file push "$PACKAGE/cloud-machine-screen.mjs" "$BUILDER/opt/qorpera-machine/cloud-machine-screen.mjs" --uid 0 --gid 0 --mode 0444\n',
		),
	);
	// The build's own check runs the helper under the executor's boot wrapper, with the request on stdin.
	const hostSource = read("packages/runner-orchestrator/src/company-machine-host.ts");
	const wrapper = hostSource.match(/\nconst CODING_VALUE_ON_BOOT =\n\t'([^']+)';\n/)[1];
	assert.ok(imageScript.includes(`const ON_BOOT = \`${wrapper}\`;`), "the image check runs the executor's own wrapper");
	assert.match(hostSource, /COMPANY_MACHINE_SCREEN_HELPER = "\/opt\/qorpera-machine\/cloud-machine-screen\.mjs"/);
	for (const line of [
		'spawnSync("/bin/sh", ["-c", ON_BOOT, on, "/usr/bin/node", "/opt/qorpera-machine/cloud-machine-screen.mjs"]',
		'fail("a look did not start the stopped desktop")',
		'fail("the same receipt acted a second time")',
		'fail("the screen helper ran on another boot")',
		'fail("the screen helper acted on a stopped desktop")',
		'fail("the screen helper left a picture on the disk")',
		// Review r2 F4: an action cut off while it waits on the desktop lock dies at its own deadline, and never runs.
		'fail("the open did not wait on the desktop lock, so the cut-off check tests nothing")',
		'if (waiting()) fail("the cut-off open outlived its deadline: "',
		'fail("the cut-off open ran once the desktop lock was free")',
		'\t[[ -z $(ls -A /company) ]] || { echo "the screen helper wrote into /company" >&2; exit 1; }\n',
	])
		assert.ok(imageScript.includes(line), line);
	// Every check of the build sits in its one single-quoted script: no single quote may appear in it, comments too.
	const opening = "bash -euo pipefail -c '\n";
	const start = imageScript.indexOf(opening, imageScript.indexOf('lx exec "$BUILDER" -- env EXPECTED_FOLDER_PROGRAM_SHA256='));
	const end = imageScript.indexOf("\n'\nlx stop \"$BUILDER\"");
	assert.ok(start > 0 && end > start);
	const script = imageScript.slice(start + opening.length, end);
	assert.ok(script.includes("cloud-machine-screen.mjs") && !script.includes("'"), "a single quote in the build's checks");
	// The helper's steps fit the executor's deadline, which fits the gateway's 30 s with the folder's release.
	const helperSource = read("packages/runtime/src/cloud-machine-screen.ts");
	const steps = helperSource.match(
		/MACHINE_SCREEN_STEP_MS = Object\.freeze\(\{ status: (\d+), start: (\d+), action: (\d+), shot: (\d+) \}\)/,
	);
	const [status, startMs, action, shot] = steps.slice(1).map(Number);
	const settle = Number(helperSource.match(/\nexport const MACHINE_SCREEN_MAX_SETTLE_MS = (\d+);\n/)[1]);
	const runMs = Number(hostSource.match(/\nconst SCREEN_MS = (\d+);\n/)[1]);
	const boundaryMs = Number(hostSource.match(/\nconst SCREEN_BOUNDARY_MS = (\d+);\n/)[1]);
	assert.ok(status + Math.max(startMs, action) + settle + shot < runMs, "the helper's steps against the executor's deadline");
	assert.ok(runMs + boundaryMs + 2000 <= 30000, "the executor's deadline and the release against the gateway's 30 s");
	// A desktop cut off mid-action stays busy for the action's deadline, which each command's own transient unit keeps on
	// the machine (RuntimeMaxSec, its whole control group killed with SIGKILL), and a second for its kill to land (review
	// r1 F4, r2 F4). Not coreutils' timeout: the image's is uutils', whose KILL ends only its direct child.
	const killMs = Number(helperSource.match(/\nexport const MACHINE_SCREEN_KILL_MS = (\d+);\n/)[1]);
	assert.equal(Number(hostSource.match(/\nconst SCREEN_ACTION_GRACE_MS = (\d+);\n/)[1]), action + killMs);
	assert.match(helperSource, /\nconst SYSTEMD_RUN = "\/usr\/bin\/systemd-run";\n/);
	for (const option of [
		'"--wait",',
		'"--pipe",',
		'"--collect",',
		'"--expand-environment=no",',
		'"--slice=qorpera-machine.slice",',
		"`RuntimeMaxSec=${seconds}`,",
		'"KillMode=control-group",',
		'"KillSignal=SIGKILL",',
		'"--",\n\t\t\tDESKTOP,\n\t\t\t...args,',
	])
		assert.ok(helperSource.includes(option), option);
	assert.doesNotMatch(helperSource, /usr\/bin\/timeout/);
	// Keys (review r1 F2): the build checks every word of the installed xdotool help against the helper and the desktop
	// command, and that real keys still work and an unknown one fails.
	for (const line of [
		'fail(`the screen helper took ${word} as a key`)',
		"\twords=$(DISPLAY=:1 xdotool help | tail -n +2)\n",
		'\t[[ ! -e /tmp/qorpera-key-ran ]] || { echo "a key ran a program" >&2; exit 1; }\n',
		'\t[[ $code == 2 ]] || { echo "desktop key took a key that does not exist (exit $code)" >&2; exit 1; }\n',
	])
		assert.ok(imageScript.includes(line), line);
	// Built with the packager's options, the guest helper holds none of it, and the screen helper drives the desktop only
	// through its command and scrot.
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-machine-screen-"));
	try {
		const options = { bundle: true, platform: "node", format: "esm", target: "node22.19", legalComments: "none", logLevel: "silent" };
		await build({ ...options, entryPoints: [join(repositoryRoot, "packages/runtime/src/cloud-machine-guest.ts")], outfile: join(temporary, "guest.mjs") });
		await build({ ...options, entryPoints: [join(repositoryRoot, "packages/runtime/src/cloud-machine-screen-main.ts")], outfile: join(temporary, "screen.mjs") });
		const guest = await readFile(join(temporary, "guest.mjs"), "utf8");
		const helper = await readFile(join(temporary, "screen.mjs"), "utf8");
		assert.doesNotMatch(guest, /machine-screen|scrot/);
		assert.match(helper, /"\/usr\/local\/bin\/desktop"/);
		assert.match(helper, /"\/usr\/bin\/scrot"/);
		assert.match(helper, /DISPLAY: ":1"/);
		assert.doesNotMatch(helper, /shell: true|execSync|"\/bin\/sh"/);
		assert.ok(helper.length < 65536, `the screen helper is ${helper.length} bytes`);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test("desktop key presses no xdotool command word, whatever its case, by the installed xdotool's own list (review r1 F2)", async () => {
	// A stand-in xdotool whose help lists the commands as xdotool 3.20160805.1 prints them; any other use of it is a
	// failure here, since a refused key must never reach xdotool.
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-desktop-key-"));
	try {
		const stub = join(temporary, "xdotool");
		await writeFile(
			stub,
			'#!/bin/sh\nif [ "$1" = help ]; then printf "Available commands:\\n  key\\n  type\\n  exec\\n  sleep\\n  windowkill\\n"; exit 0; fi\necho "xdotool ran: $*" >&2\nexit 9\n',
			{ mode: 0o755 },
		);
		const env = { ...process.env, PATH: `${temporary}:${process.env.PATH}` };
		const key = (...args) =>
			spawnSync("bash", [join(repositoryRoot, "deploy/machine/desktop"), "key", ...args], { encoding: "utf8", env });
		for (const args of [["exec", "id"], ["EXEC", "id"], ["Return", "Sleep"], ["WindowKill"]]) {
			const refused = key(...args);
			assert.equal(refused.status, 2, `${args.join(" ")}: ${refused.stderr}`);
			assert.match(refused.stderr, /^not a key: [A-Za-z]+ \(it is an xdotool command\)\n$/);
		}
		// A real key passes the check and goes on to the desktop (which is not running here); nothing ran xdotool's key.
		const real = key("Return", "ctrl+exec");
		assert.equal(real.status, 1);
		assert.match(real.stderr, /^the desktop is not running/);
		assert.doesNotMatch(real.stderr, /xdotool ran/);
		// Without xdotool's list no key is pressed.
		await writeFile(stub, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		assert.notEqual(key("Return").status, 0);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
	// An unknown key name, which xdotool only reports on stderr, fails the command instead of passing as pressed.
	assert.match(read("deploy/machine/desktop"), /if \[\[ \$skipped == \*"No such key name"\* \]\]; then\n\t\tfail "no such key: /);
});

test("a desktop is asked for: small machines refuse it, chosen files open on it, and pages work without a screen too", () => {
	// deploy/machine/README.md, "The desktop" (10 Nov 2026: Jonas's shape, and the audit's fixes).
	const command = read("deploy/machine/desktop");
	// A machine below a desktop computer's size refuses `desktop start`, and names the way to get one.
	assert.match(command, /\nMIN_CPUS=2\n/);
	assert.match(command, /\nMIN_MEMORY_KB=3500000\n/);
	assert.match(command, /if \(\( cpus < MIN_CPUS \|\| memory < MIN_MEMORY_KB \)\); then\n\t\t\tfail "this machine is too small for a desktop: [^\n]*machine_start with desktop true" 3\n/);
	// Files and folders are put on the desktop as links (the company's stay where they are) and opened; a folder with a
	// page is served on the machine's loopback only.
	assert.match(command, /ln -s -- "\$path" "\$place"\n/);
	// Nothing on the desktop is ever replaced: the same link is used again, and a taken name gets a number (review r1 F1).
	assert.doesNotMatch(command, /rm -rf -- "\$place"/);
	assert.match(command, /if \(\( ! copy \)\) && \[\[ -L \$place && \$\(readlink -- "\$place"\) == "\$path" \]\]; then break; fi\n/);
	assert.match(command, /if \[\[ ! -e \$place && ! -L \$place \]\]; then\n\t\t\tif \(\( copy \)\); then\n\t\t\t\tcp -a -- "\$path" "\$place"\n/);
	for (const line of [
		'\tdesktop open /tmp/site --copy | grep "as site-2)" >/dev/null || { echo "a copy did not get a name of its own" >&2; exit 1; }\n',
		"\techo edited >/home/desktop/Desktop/site-2/kept.txt\n",
		'\t\t{ echo "opening again replaced something on the desktop" >&2; exit 1; }\n',
	])
		assert.ok(imageScript.includes(line), line);
	assert.match(command, /launch \/usr\/bin\/python3 -m http\.server "\$port" --bind 127\.0\.0\.1 --directory "\$folder"\n/);
	assert.match(command, /for target in "\$@"; do open_target "\$target" 0; done\n/);
	// 3D drawing, no test bar, the session's bus for launched programs.
	assert.match(command, /--disable-infobars\n\t\t--enable-unsafe-swiftshader\)/);
	assert.match(command, /--setenv=DBUS_SESSION_BUS_ADDRESS="unix:path=\$RUN\/bus"/);
	// Text beyond plain ASCII is pasted (xdotool types a capital Å small), on both selections.
	assert.match(command, /if \[\[ \$text == \*\[!\[:ascii:\]\]\* \|\| \$text == \*\[\[:cntrl:\]\]\* \]\]; then\n/);
	assert.match(command, /xdotool key --clearmodifiers shift\+Insert\n/);
	// A picture nothing could show is refused.
	assert.match(command, /&& ! mountpoint -q \/company; then\n\t\tfail "this machine has no company folder at \/company/);
	// A forgotten desktop stops itself; every desktop command puts that off.
	const session = read("deploy/machine/desktop-session");
	assert.match(session, /\nIDLE=\$\{QORPERA_DESKTOP_IDLE_SECONDS:-3600\}\n/);
	assert.match(command, /\ttouch "\$RUN\/last-use"\n/);
	assert.match(session, /dbus-daemon --session --address="\$DBUS_SESSION_BUS_ADDRESS" --nofork --nopidfile &\n/);
	// Root's Chromium runs without the sandbox root cannot use; any other account keeps it.
	const wrapper = read("deploy/machine/chromium");
	assert.match(wrapper, /if \[ "\$\(id -u\)" = 0 \]; then\n\texec \/usr\/lib\/qorpera-chromium\/chrome --no-sandbox --enable-unsafe-swiftshader "\$@"\nfi\nexec \/usr\/lib\/qorpera-chromium\/chrome --enable-unsafe-swiftshader "\$@"\n$/);
	assert.ok(!imageScript.includes("ln -sf /usr/lib/qorpera-chromium/chrome /usr/local/bin/chromium"), "the wrapper is a file, never a link to the binary");
	assert.deepEqual(JSON.parse(read("deploy/machine/qorpera-chromium-policy.json")).TranslateEnabled, false);
	// Playwright by pinned version with its own browsers, found from any folder; ffmpeg; the build proves each.
	assert.match(imageScript, /\nPLAYWRIGHT_VERSION=\d+\.\d+\.\d+\n/);
	assert.match(imageScript, /npm install -g --ignore-scripts --no-fund --no-audit "playwright@\$\{PLAYWRIGHT_VERSION\}"\n/);
	assert.match(read("deploy/machine/qorpera-machine-profile.sh"), /\nexport PLAYWRIGHT_BROWSERS_PATH=\/opt\/ms-playwright\n/);
	const apt = words(imageScript.match(/apt-get install -y --no-install-recommends((?:[^\n]*\\\n)*[^\n]*)/)[1]);
	for (const tool of ["ffmpeg", "fonts-noto-cjk", "xsel"]) assert.ok(apt.includes(tool), tool);
	for (const line of [
		"\tdesktop selftest\n",
		'\tmkdir /tmp/empty && (cd /tmp/empty && bash -lc "node /opt/qorpera-machine/playwright-check.cjs")\n',
		'\tif desktop shot /company/never.png 2>/dev/null; then echo "a screenshot went into an unmounted /company" >&2; exit 1; fi\n',
		"\tdesktop start --lang da-DK --tz Europe/Copenhagen\n",
	])
		assert.ok(imageScript.includes(line), line);
	// The selftest reads 3D drawing and the typed text from the page's title.
	assert.match(read("deploy/machine/desktop-selftest.html"), /"SELFTEST\[webgl=" \+ \(context \? "yes" : "no"\) \+ "\|typed=" \+ typed\.value \+ "\]"/);
});

test("a desktop action on the spot the pointer is on never waits for a move that cannot come", async () => {
	// 12 Nov 2026: `xdotool mousemove --sync` waits until the pointer has moved, and for 15 s when it is already there
	// (measured: a second `desktop click 640 400` took 15.2 s). Stand-ins for the desktop's tools: the unit is active,
	// the display answers, and xdotool says where the pointer is and writes down what it is asked to do.
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-desktop-pointer-"));
	try {
		const asked = join(temporary, "asked");
		const tool = (name, body) => writeFile(join(temporary, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
		await tool("systemctl", "echo active");
		await tool("xdpyinfo", "exit 0");
		await tool("touch", "exit 0");
		await tool(
			"xdotool",
			[
				'case "$1" in',
				// One call for both, as the command asks: the pointer's line, then the screen's.
				'getmouselocation) [ -n "$POINTER" ] || exit 1; echo "x:${POINTER% *} y:${POINTER#* } screen:0 window:77"',
				'\t[ "$2" != getdisplaygeometry ] || echo "1600 1000" ;;',
				'*) echo "$*" >>"$ASKED" ;;',
				"esac",
			].join("\n"),
		);
		const desktop = (pointer, ...args) => {
			const run = spawnSync("bash", [join(repositoryRoot, "deploy/machine/desktop"), ...args], {
				encoding: "utf8",
				env: { ...process.env, PATH: `${temporary}:${process.env.PATH}`, POINTER: pointer, ASKED: asked },
			});
			assert.equal(run.status, 0, `${args.join(" ")}: ${run.stderr}`);
			const words = readFileSync(asked, "utf8").trim();
			writeFileSync(asked, "");
			return words;
		};
		writeFileSync(asked, "");
		// The pointer is elsewhere: the move is waited for, as before.
		assert.equal(desktop("100 100", "click", "640", "400"), "mousemove --sync 640 400 click 1");
		assert.equal(desktop("100 100", "double", "640", "400"), "mousemove --sync 640 400 click --repeat 2 --delay 80 1");
		assert.equal(desktop("100 100", "move", "640", "400"), "mousemove --sync 640 400");
		assert.equal(
			desktop("100 100", "drag", "640", "400", "900", "600"),
			"mousemove --sync 640 400 mousedown 1 sleep 0.1 mousemove --sync 900 600 sleep 0.1 mouseup 1",
		);
		// The pointer is there already: the move is still sent (the click lands on X Y whatever moved the pointer since),
		// but never waited for.
		assert.equal(desktop("640 400", "click", "640", "400", "right"), "mousemove 640 400 click 3");
		assert.equal(desktop("640 400", "double", "640", "400"), "mousemove 640 400 click --repeat 2 --delay 80 1");
		assert.equal(desktop("640 400", "move", "640", "400"), "mousemove 640 400");
		// A drag, both ends: one that starts where the pointer is, and one that ends where it starts.
		assert.equal(
			desktop("640 400", "drag", "640", "400", "900", "600"),
			"mousemove 640 400 mousedown 1 sleep 0.1 mousemove --sync 900 600 sleep 0.1 mouseup 1",
		);
		assert.equal(
			desktop("100 100", "drag", "640", "400", "640", "400"),
			"mousemove --sync 640 400 mousedown 1 sleep 0.1 mousemove 640 400 sleep 0.1 mouseup 1",
		);
		assert.equal(
			desktop("640 400", "drag", "640", "400", "640", "400"),
			"mousemove 640 400 mousedown 1 sleep 0.1 mousemove 640 400 sleep 0.1 mouseup 1",
		);
		// A position past the screen's edge ends at the edge, where the pointer may already be; and a number written with
		// leading zeros is the same spot.
		assert.equal(desktop("1599 999", "move", "5000", "5000"), "mousemove 5000 5000");
		assert.equal(desktop("1599 400", "click", "1600", "400"), "mousemove 1600 400 click 1");
		assert.equal(desktop("1598 999", "move", "5000", "5000"), "mousemove --sync 5000 5000");
		assert.equal(desktop("640 400", "click", "0640", "0400"), "mousemove 0640 0400 click 1");
		assert.equal(
			desktop("100 100", "drag", "1700", "1200", "5000", "5000"),
			"mousemove --sync 1700 1200 mousedown 1 sleep 0.1 mousemove 5000 5000 sleep 0.1 mouseup 1",
		);
		// Where the pointer is cannot be read: the move is waited for, as it always was.
		assert.equal(desktop("", "click", "640", "400"), "mousemove --sync 640 400 click 1");
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
	// No other wait for a move in the command, and the image build times the actions on one spot.
	const command = read("deploy/machine/desktop");
	assert.equal(command.split("\n").filter((line) => line.includes("--sync") && !line.startsWith("#")).length, 1);
	assert.match(command, /then move=\(mousemove "\$3" "\$4"\); else move=\(mousemove --sync "\$3" "\$4"\); fi\n/);
	// One xdotool call tells where the pointer is and how large the screen is: every call is a program started.
	assert.match(command, /< <\(xdotool getmouselocation getdisplaygeometry 2>\/dev\/null\) \|\| true\n/);
	assert.equal(command.match(/getmouselocation|getdisplaygeometry/g).length, 2);
	for (const line of [
		"\tdesktop click 800 500\n\tdesktop double 800 500\n\tdesktop move 800 500\n\tdesktop drag 800 500 800 500\n",
		"\t(( ($(date +%s%N) - pointer_started) / 1000000 < 5000 )) ||\n",
	])
		assert.ok(imageScript.includes(line), line);
});

test("every machine has compressed memory from its boot on and a guard at the edge of its memory", () => {
	// deploy/machine/README.md, "Memory" (12 Nov 2026): without them a 4 GiB desktop froze past 7 tabs and nothing was
	// ended in time; with compressed memory it carried 24.
	const packager = read("scripts/package-machine-guest.mjs");
	const units = [...packager.match(/const units = \[([^\]]+)\]/)[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
	for (const unit of ["qorpera-machine-memory.service", "qorpera-machine-memory-guard.service"]) assert.ok(units.includes(unit), unit);
	// Files only: the guest helper, whose sha-256 the executor pins, is not part of it.
	assert.doesNotMatch(read("packages/runtime/src/cloud-machine-guest.ts"), /zram|earlyoom|machine-memory/);

	// Compressed memory: at every boot, before basic.target (the executor counts a boot as usable after it), and never
	// in a boot's way: no default dependencies to fail on, only wanted, ended after 20 s at the latest.
	const swap = read("deploy/machine/qorpera-machine-memory.service");
	for (const line of [
		"DefaultDependencies=no",
		"Before=basic.target shutdown.target",
		"Type=oneshot",
		"RemainAfterExit=yes",
		"ExecStart=/opt/qorpera-machine/machine-memory swap",
		"TimeoutStartSec=20",
		"WantedBy=basic.target",
	])
		assert.ok(swap.includes(`\n${line}\n`), line);
	assert.doesNotMatch(swap, /^(Requires|RequiredBy|Requisite|BindsTo|OnFailure)=/m);
	const script = read("deploy/machine/machine-memory");
	const code = script
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("#"))
		.join("\n");
	// Through sysfs as measured: zstd, as large as the memory, priority 100, the measured settings; the device is
	// waited for (zramctl --find right after modprobe failed once), never with udevadm settle, which a boot waits on.
	assert.match(code, /\nSWAPPINESS=150\nPAGE_CLUSTER=0\n/);
	assert.match(code, /\n\t\tmodprobe zram \|\| exit 1\n/);
	assert.match(code, /for _ in \$\(seq 1 60\); do \[\[ -b \$DEVICE && -e \$BLOCK\/disksize \]\] && break; sleep 0\.05; done\n/);
	assert.match(code, /echo zstd >"\$BLOCK\/comp_algorithm" \|\| true\n\t\t\techo "\$\{total\}K" >"\$BLOCK\/disksize" \|\| exit 1\n\t\t\tmkswap "\$DEVICE" >\/dev\/null \|\| exit 1\n/);
	assert.match(code, /\n\t\tswapon -p 100 "\$DEVICE" \|\| exit 1\n/);
	assert.match(code, /sysctl -q -w vm\.swappiness="\$SWAPPINESS" vm\.page-cluster="\$PAGE_CLUSTER"/);
	assert.doesNotMatch(code, /zramctl|udevadm|mem_limit/);
	// It always ends well, with one line either way; run again on a machine that has it, it only says so.
	const body = code.slice(code.indexOf("\nswap() {"), code.indexOf("\nguard_limits() {"));
	assert.match(body, /\tif on; then\n\t\ttune \|\| true\n\t\techo "compressed memory is already on [^\n]+\n\t\treturn 0\n\tfi\n/);
	assert.match(body, /echo "compressed memory is OFF on this machine, which runs without it as machines did before: /);
	assert.match(body, /\n\tfi\n\treturn 0\n\}\n/);
	assert.doesNotMatch(body, /\n\t(exit|return) [1-9]/);
	assert.doesNotMatch(code, /^set -[a-z]*e/m);

	// The guard: earlyoom from our own unit, beside the commands' slice, the last to be ended, started again with the
	// swap unit (its limits depend on whether the reserve is on).
	const guard = read("deploy/machine/qorpera-machine-memory-guard.service");
	for (const line of [
		"After=qorpera-machine-memory.service",
		"PartOf=qorpera-machine-memory.service",
		"ConditionPathExists=/usr/bin/earlyoom",
		"ExecStart=/opt/qorpera-machine/machine-memory guard",
		"Slice=qorpera-control.slice",
		"Restart=always",
		"OOMScoreAdjust=-1000",
		"WantedBy=multi-user.target",
	])
		assert.ok(guard.includes(`\n${line}\n`), line);
	// Late enough that compressed memory is used first (both limits must hold), ended at once (each pair is one number:
	// SIGKILL), by the kernel's own score (no --sort-by-rss, no process group, root's processes too).
	assert.match(code, /\n\texec \/usr\/bin\/earlyoom -r 0 \$\(guard_limits\)\n/);
	assert.doesNotMatch(code, /--sort-by-rss|--ignore-root-user|--prefer|--avoid| -g /);
	// The limit aims at an amount still available (about 300 MiB, 8 % of the memory on a large machine), turned into
	// earlyoom's share with what programs hold in memory at the edge: the measured machines keep their measured limits.
	const limits = (kib, reserve) => {
		const run = spawnSync("bash", [join(repositoryRoot, "deploy/machine/machine-memory"), "limits", String(kib), reserve], {
			encoding: "utf8",
		});
		assert.equal(run.status, 0, run.stderr);
		return run.stdout.trim();
	};
	assert.equal(limits(3925220, "on"), "-m 17,17 -s 10,10", "4 GiB, as measured past the edge");
	assert.equal(limits(1930216, "on"), "-m 29,29 -s 10,10", "2 GiB, as measured past the edge");
	assert.equal(limits(8047616, "on"), "-m 17,17 -s 10,10");
	assert.equal(limits(67108864, "on"), "-m 17,17 -s 10,10");
	assert.equal(limits(973000, "on"), "-m 45,45 -s 10,10");
	// Never over half, however small the machine; and a machine without the reserve is judged on memory alone, later.
	assert.equal(limits(500000, "on"), "-m 50,50 -s 10,10");
	assert.equal(limits(3925220, "off"), "-m 9,9");
	assert.equal(limits(1930216, "off"), "-m 16,16");
	const none = spawnSync("bash", [join(repositoryRoot, "deploy/machine/machine-memory")], { encoding: "utf8" });
	assert.equal(none.status, 2);
	assert.match(none.stderr, /^machine-memory swap\|guard\|status\|limits \[KiB\] \[on\|off\]\n$/);

	// Who is never the one ended, by the guard or by the kernel's own killer.
	for (const unit of ["qorpera-machine-desktop.service", "qorpera-machine-folder.service", "qorpera-machine-watchdog.service"])
		assert.match(read(`deploy/machine/${unit}`), /\nOOMScoreAdjust=-900\n/, unit);
	assert.match(read("deploy/machine/lxd-agent-memory.conf"), /\n\[Service\]\nOOMScoreAdjust=-900\n$/);
	// The XFCE session, and what is started from its menus, gets a milder protection than the X server keeps.
	assert.match(
		read("deploy/machine/desktop-session"),
		/\n\(\n\tprintf %s -100 2>\/dev\/null >\/proc\/self\/oom_score_adj \|\| true\n\texec startxfce4\n\) &\n/,
	);
	// Programs an agent starts are units of their own, with nothing of that.
	assert.doesNotMatch(read("deploy/machine/desktop"), /OOMScoreAdjust/);
	assert.doesNotMatch(read("deploy/machine/qorpera-machine.slice"), /OOMScoreAdjust|ManagedOOM/);

	// The image: earlyoom from apt with its own unit off for good, and the build refuses a kernel without zram, a unit
	// that fails where it cannot be set up, a guard that is not earlyoom in the control slice, and a desktop whose
	// screen is not protected or whose tabs would not go first.
	const apt = words(imageScript.match(/apt-get install -y --no-install-recommends((?:[^\n]*\\\n)*[^\n]*)/)[1]);
	assert.ok(apt.includes("earlyoom"));
	for (const line of [
		"\tsystemctl disable --now earlyoom.service\n\tsystemctl mask earlyoom.service\n",
		"\tinstall -d -o root -g root -m 0755 /etc/systemd/system/lxd-agent.service.d\n",
		"\tsystemctl enable qorpera-machine-watchdog.timer qorpera-machine-memory.service qorpera-machine-memory-guard.service\n",
		'\tfor kernel in /lib/modules/*; do\n\t\tmodinfo -k "$(basename "$kernel")" zram >/dev/null ||\n',
		'\t[[ -n ${swap_kb:-} ]] && (( memory_kb - swap_kb >= 0 && memory_kb - swap_kb <= 64 )) && [[ $swap_priority == 100 ]] ||\n',
		'\tgrep -q "\\[zstd\\]" /sys/block/zram0/comp_algorithm ||',
		"\tswapoff /dev/zram0\n\techo 1 >/sys/block/zram0/reset\n\trmmod zram\n",
		'\tmkdir -p /run/modprobe.d && echo "install zram /bin/false" >/run/modprobe.d/qorpera-image-check.conf\n',
		'\t\t{ echo "the memory unit fails where compressed memory cannot be set up: a boot would show a failed unit" >&2; exit 1; }\n',
		'\t\t{ echo "the journal does not say in one line that compressed memory is off" >&2; exit 1; }\n',
		'\t[[ $(cat "/proc/$guard/comm") == earlyoom && $(cat "/proc/$guard/oom_score_adj") == -1000 ]] ||\n',
		'\tgrep -q "/qorpera-control.slice/" "/proc/$guard/cgroup" ||',
		'\tif systemctl is-active --quiet earlyoom.service systemd-oomd.service; then echo "another memory guard runs" >&2; exit 1; fi\n',
		"\tfor unit in lxd-agent qorpera-machine-folder qorpera-machine-watchdog qorpera-machine-desktop; do\n",
		'\t[[ $(scores $(pgrep -u desktop -x Xvnc)) == "-900 " && $(scores $(pgrep -u desktop -x xfwm4)) == "-100 " ]] ||\n',
		'\t[[ $(scores $(pgrep -u desktop -o -x chrome)) == "0 " && $(scores $(pgrep -u desktop -f -- "--type=renderer")) == "300 " ]] ||\n',
		"\tsystemd-analyze verify /etc/systemd/system/qorpera-machine-memory.service /etc/systemd/system/qorpera-machine-memory-guard.service\n",
	])
		assert.ok(imageScript.includes(line), line);

	// The proof makes its own throwaway machine in a build space that holds nothing else, never uses another, and
	// deletes it by its exact name on every exit path; its pieces are whole.
	const proof = read("scripts/prove-machine-memory.sh");
	assert.match(proof, /\nheld=\$\(names\) \|\| exit 1\n\[\[ -z \$held \]\] \|\| fail "the build space \$PROJECT is in use: prove when it is empty"\n/);
	assert.match(proof, /\n\[\[ \$PROJECT != default && \$PROJECT != machines \]\] \|\| fail /);
	assert.match(proof, /\nMACHINE="qorpera-machine-build-memory-proof-\$\$"\n/);
	assert.match(proof, /\ntrap cleanup EXIT\n/);
	assert.match(proof, /\n\t\tlx delete --force "\$MACHINE" >\/dev\/null 2>&1\n/);
	assert.equal([...proof.matchAll(/\blx(?:c --project "\$PROJECT")? (?:delete|stop|restart)\b[^\n]*/g)].every(([line]) => line.includes('"$MACHINE"')), true);
	assert.doesNotMatch(proof, /lxc (?!--project "\$PROJECT" )/);
	assert.match(proof, /-c user\.qorpera\.image_builder=true -c user\.qorpera\.purpose=machine-image \|\|\n\t\tfail "the machine could not be made"\n/);
	// Past the edge the machine keeps answering: no click fails, none takes 3 s or more, and at most 1 in 100 takes 2 s
	// or more (one, under 200 clicks). The lead's bar, set on the measured runs: one click of 2.02 s in 104 is a machine
	// that answers, against the freeze before (no answer in 20 to 30 s), and a check that flaps is worth nothing.
	assert.match(proof, /\n\tallowed=\$\(\( clicks \/ 100 \)\)\n\t\(\( allowed >= 1 \)\) \|\| allowed=1\n/);
	assert.match(proof, /\n\tif \(\( clicks >= least && failed == 0 && three == 0 && two <= allowed \)\); then\n/);
	for (const file of ["guest.sh", "pages.cjs", "verdicts.cjs", "job.cjs", "app.html", "video.html", "pointer.html"])
		assert.ok(existsSync(join(repositoryRoot, "scripts/machine-memory-proof", file)), file);
	for (const file of [
		"deploy/machine/machine-memory",
		"deploy/machine/desktop",
		"deploy/machine/desktop-session",
		"deploy/machine/build-machine-image.sh",
		"scripts/prove-machine-memory.sh",
		"scripts/machine-memory-proof/guest.sh",
	])
		assert.equal(spawnSync("bash", ["-n", join(repositoryRoot, file)], { encoding: "utf8" }).status, 0, file);
});

test("a machine's desktop has the office look: one dock, the agent's backdrop, written at every start", async () => {
	// deploy/machine/README.md, "The desktop's look" (12 Nov 2026; Jonas on the first desktop computers: "what happened
	// to the agent wallpapers? the docker has 4 settings icons instead of file explorer and terminal?").
	const look = read("deploy/machine/desktop-look");
	const session = read("deploy/machine/desktop-session");
	const opener = read("deploy/machine/desktop-dock-open");
	const packager = read("scripts/package-machine-guest.mjs");
	const office = read("deploy/lxd-company-computer-guest/qorpera-screen-session");

	// The pictures: a backdrop set for every figure an agent can have, under the figure's own name, from the office's
	// files by the runtime's table; a saved ghost is drawn as the moon, as every client draws it.
	const characters = read("packages/cloud-client/src/staff-characters.ts");
	const pairs = (text) => Object.fromEntries([...text.matchAll(/(\w+): "(\w+)"/g)].map((match) => [match[1], match[2]]));
	const figures = [...characters.match(/export const STAFF_CHARACTER_IDS = Object\.freeze\(\[([^\]]+)\]/)[1].matchAll(/"([a-z]+)"/g)].map(
		(match) => match[1],
	);
	assert.equal(figures.length, 12);
	assert.deepEqual(Object.keys(BACKDROP_FILES), figures);
	const table = pairs(
		read("packages/runtime/src/cloud-company-computer-wallpapers.ts").match(
			/COMPANY_COMPUTER_WALLPAPER_BY_CHARACTER = Object\.freeze\(\{([^}]+)\}/,
		)[1],
	);
	for (const figure of figures) assert.equal(BACKDROP_FILES[figure], table[figure], figure);
	assert.deepEqual(pairs(characters.match(/RETIRED_STAFF_CHARACTERS = Object\.freeze\(\{([^}]+)\}/)[1]), { ghost: "moon" });
	assert.match(look, /\n\t\[\[ \$word != ghost \]\] \|\| word=moon\n/);
	// Every picture is there and is a PNG of its size: the nine dock icons, 24 frames a set, thirteen sets.
	assert.equal(MACHINE_DESKTOP_PICTURES.length, 9 + 13 * 24);
	assert.equal(new Set(MACHINE_DESKTOP_PICTURES.map((picture) => picture.name)).size, MACHINE_DESKTOP_PICTURES.length);
	// The colour of a frame's first pixel, which is its ground: the frames are plain RGB, so the first row's first three
	// bytes after its filter byte.
	const ground = (bytes) => {
		const data = [];
		for (let at = 8; at < bytes.length; ) {
			const length = bytes.readUInt32BE(at);
			if (bytes.subarray(at + 4, at + 8).toString("latin1") === "IDAT") data.push(bytes.subarray(at + 8, at + 8 + length));
			at += 12 + length;
		}
		return inflateSync(Buffer.concat(data)).subarray(1, 4).toString("hex");
	};
	// The ground the look paints on the bare screen for an hour is the ground of that hour's frame, in every set.
	const grounds = words(look.match(/\nGROUND=\(([^)]+)\)\n/)[1]);
	assert.equal(grounds.length, 24);
	for (const { name, source } of MACHINE_DESKTOP_PICTURES) {
		const bytes = readFileSync(join(repositoryRoot, source));
		assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", source);
		const size = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
		if (name.startsWith("dock/")) {
			assert.deepEqual(size, [112, 112], source);
			continue;
		}
		assert.deepEqual(size, [1920, 1200], source);
		assert.equal(bytes[25], 2, `${source} is plain RGB`);
		assert.equal(ground(bytes), grounds[Number(name.slice(-6, -4))], `the ground of ${name}`);
	}

	// The archive: plain ustar, root's files of mode 0644, the same bytes each time, and what tar unpacks is what went in.
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-machine-desktop-look-"));
	try {
		const entries = [
			{ name: "dock/a.png", bytes: Buffer.from("first") },
			{ name: "backdrops/star/00.png", bytes: Buffer.alloc(1300, 7) },
			{ name: "backdrops/star/01.png", bytes: Buffer.alloc(0) },
			{ name: "backdrops/neutral/23.png", bytes: Buffer.alloc(1024, 9) },
		];
		const archive = tarArchive(entries);
		assert.deepEqual(tarArchive(entries), archive);
		assert.equal(archive.length, 512 * (4 + 1 + 3 + 0 + 2) + 1024);
		assert.throws(() => tarArchive([{ name: "x".repeat(100), bytes: Buffer.alloc(0) }]), /too long/);
		await writeFile(join(temporary, "art.tar"), archive);
		await mkdir(join(temporary, "out"));
		const listed = spawnSync("tar", ["-tvf", join(temporary, "art.tar")], { encoding: "utf8" });
		assert.equal(listed.status, 0, listed.stderr);
		const lines = listed.stdout.trim().split("\n");
		assert.equal(lines.length, entries.length);
		for (const line of lines) assert.match(line, /^-rw-r--r-- +(root\/root|0\/0) /, line);
		const unpacked = spawnSync("tar", ["-xf", join(temporary, "art.tar"), "-C", join(temporary, "out"), "--no-same-owner"], {
			encoding: "utf8",
		});
		assert.equal(unpacked.status, 0, unpacked.stderr);
		assert.equal(unpacked.stderr, "");
		for (const { name, bytes } of entries) assert.deepEqual(readFileSync(join(temporary, "out", name)), bytes, name);

		// The look, written as the session writes it, with stand-ins for the display's tools and for the image's pictures:
		// one dock with three launchers whose pictures are there, the backdrop of the figure the machine names for the hour
		// in the desktop's time zone, the ground of that hour on the bare screen, and the clocks on that zone.
		const art = join(temporary, "art");
		for (const set of ["neutral", "star", "moon"]) {
			await mkdir(join(art, "backdrops", set), { recursive: true });
			for (let hour = 0; hour < 24; hour++) await writeFile(join(art, "backdrops", set, `${String(hour).padStart(2, "0")}.png`), "");
		}
		await mkdir(join(art, "dock"));
		for (const icon of DOCK_ICONS) await writeFile(join(art, "dock", `${icon}.png`), "png");
		const tools = join(temporary, "tools");
		await mkdir(tools);
		const asked = join(temporary, "asked");
		const tool = (name, body) => writeFile(join(tools, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
		await tool("xsetroot", 'echo "xsetroot $*" >>"$ASKED"');
		await tool("xrandr", 'echo "Screen 0: minimum 32 x 32, current 1600 x 1000"; echo "VNC-0 connected primary 1600x1000+0+0 0mm x 0mm"');
		const home = join(temporary, "home");
		const run = join(temporary, "run");
		const ask = join(temporary, "ask");
		const figureFile = join(temporary, "desktop-figure");
		for (const folder of [home, run, ask]) await mkdir(folder);
		const env = {
			...process.env,
			PATH: `${tools}:${process.env.PATH}`,
			HOME: home,
			XDG_RUNTIME_DIR: run,
			XDG_CONFIG_HOME: "",
			DISPLAY: ":1",
			ASKED: asked,
			QORPERA_DESKTOP_ART: art,
			QORPERA_DESKTOP_FIGURE: figureFile,
			QORPERA_DESKTOP_ASK: ask,
		};
		const lookRun = (...args) => spawnSync("bash", [join(repositoryRoot, "deploy/machine/desktop-look"), ...args], { encoding: "utf8", env });
		const config = join(home, ".config");
		const channel = (name) => readFileSync(join(config, "xfce4/xfconf/xfce-perchannel-xml", `${name}.xml`), "utf8");
		const hourIn = (zone) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: zone }).format(new Date());
		const written = (figure, zone) => {
			writeFileSync(asked, "");
			const before = hourIn(zone);
			const result = lookRun("write");
			assert.equal(result.status, 0, result.stderr);
			// The hour may turn while the look is written: either side of it is right.
			const hours = new Set([before, hourIn(zone)]);
			const frame = channel("xfce4-desktop").match(/<property name="last-image" type="string" value="([^"]+)"\/>/)[1];
			assert.ok([...hours].some((hour) => frame === `${art}/backdrops/${figure}/${hour}.png`), `${frame} for ${figure} in ${zone}`);
			assert.ok(
				[...hours].some((hour) => readFileSync(asked, "utf8") === `xsetroot -solid #${grounds[Number(hour)]}\n`),
				readFileSync(asked, "utf8"),
			);
			assert.equal(channel("xfce4-panel").match(/<property name="timezone" type="string" value="([^"]+)"\/>/g).length, 2);
			assert.ok(channel("xfce4-panel").includes(`<property name="timezone" type="string" value="${zone}"/>`), zone);
		};
		// No figure named: the neutral backdrop, on UTC.
		written("neutral", "UTC");
		assert.match(channel("xfce4-desktop"), /<property name="monitorVNC-0" type="empty">/);
		for (const [plugin, app] of [
			[4, "terminal"],
			[5, "files"],
			[6, "browser"],
		]) {
			const entry = readFileSync(join(config, `xfce4/panel/launcher-${plugin}/qorpera-${app}.desktop`), "utf8");
			assert.match(entry, new RegExp(`\\nExec=/opt/qorpera-machine/desktop-look press ${app}\\n`));
			const icon = entry.match(/\nIcon=([^\n]+)\n/)[1];
			assert.equal(icon, `${art}/dock/${app}-idle.png`);
			assert.ok(existsSync(icon), icon);
		}
		assert.deepEqual(
			spawnSync("ls", [join(config, "qorpera-dock")], { encoding: "utf8" }).stdout.trim().split("\n"),
			[
				"qorpera-browser-failed.desktop",
				"qorpera-browser-launching-2.desktop",
				"qorpera-browser-launching.desktop",
				"qorpera-browser-running.desktop",
				"qorpera-browser.desktop",
				"qorpera-files-running.desktop",
				"qorpera-files.desktop",
				"qorpera-terminal-running.desktop",
				"qorpera-terminal.desktop",
			],
		);
		for (const file of ["gtk-3.0/gtk.css", "gtk-3.0/settings.ini", "qorpera-bashrc", "xfce4/terminal/terminalrc"])
			assert.ok(readFileSync(join(config, file), "utf8").length > 0, file);
		for (const name of ["xfwm4", "xfce4-terminal", "xsettings"]) assert.match(channel(name), new RegExp(`<channel name="${name}" version="1\\.0">`));
		// The figure the machine names, a saved ghost as the moon, a word the image has no set for as the neutral one; and
		// the zone `desktop start --tz` keeps in the desktop's runtime folder.
		writeFileSync(figureFile, "star\n");
		written("star", "UTC");
		writeFileSync(figureFile, "ghost");
		written("moon", "UTC");
		writeFileSync(join(run, "tz"), "Pacific/Auckland");
		written("moon", "Pacific/Auckland");
		writeFileSync(figureFile, "../../etc\n");
		written("neutral", "Pacific/Auckland");
		writeFileSync(figureFile, "planet\n");
		written("neutral", "Pacific/Auckland");
		writeFileSync(join(run, "tz"), "No/Such_Zone");
		written("neutral", "UTC");
		// Written anew every time: what was changed or removed in the account is put back.
		await rm(config, { recursive: true, force: true });
		written("neutral", "UTC");
		writeFileSync(join(config, "xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml"), "someone changed the dock");
		written("neutral", "UTC");

		// A press: the window the program already has is brought back and nothing is asked; with none, an empty file named
		// for the program asks root for it, its window is shown when it comes, and its icon gets its mark.
		await tool(
			"xprop",
			[
				'case "$*" in',
				'"-root _NET_CLIENT_LIST") if [ -n "$WINDOWS" ] || [ -e "$QORPERA_DESKTOP_ASK/$COMES" ]; then echo "_NET_CLIENT_LIST(WINDOW): window id # 0xa00003, 0x1200007"; else echo "_NET_CLIENT_LIST(WINDOW): window id # 0xa00003"; fi ;;',
				'"-id 0xa00003 WM_CLASS") echo "WM_CLASS(STRING) = \\"xfce4-panel\\", \\"Xfce4-panel\\"" ;;',
				'"-id 0x1200007 WM_CLASS") echo "WM_CLASS(STRING) = $WINDOW_IS" ;;',
				"esac",
			].join("\n"),
		);
		await tool("xdotool", 'echo "xdotool $*" >>"$ASKED"');
		await tool("xfconf-query", 'echo "xfconf-query $*" >>"$ASKED"');
		await tool("sleep", "exit 0");
		const press = (app, more) => {
			writeFileSync(asked, "");
			const result = spawnSync("bash", [join(repositoryRoot, "deploy/machine/desktop-look"), "press", app], {
				encoding: "utf8",
				env: { ...env, WINDOWS: "", COMES: "", WINDOW_IS: "", ...more },
			});
			return { status: result.status, asked: readFileSync(asked, "utf8"), stderr: result.stderr };
		};
		// (A variable named like one of the script's own tables, handed in by the environment, changes nothing.)
		const there = press("files", { WINDOWS: "yes", WINDOW_IS: '"thunar", "Thunar"', WINDOW_CLASS: "x", PANEL_PLUGIN: "y" });
		assert.equal(there.status, 0, there.stderr);
		assert.equal(there.asked, "xdotool windowmap 0x1200007\nxdotool windowactivate 0x1200007\n");
		assert.deepEqual(spawnSync("ls", ["-A", ask], { encoding: "utf8" }).stdout, "");
		const opened = press("terminal", { COMES: "terminal", WINDOW_IS: '"xfce4-terminal", "Xfce4-terminal"' });
		assert.equal(opened.status, 0, opened.stderr);
		assert.equal(spawnSync("ls", ["-A", ask], { encoding: "utf8" }).stdout, "terminal\n");
		assert.equal(readFileSync(join(ask, "terminal")).length, 0);
		assert.equal(
			opened.asked,
			`xdotool windowmap 0x1200007\nxdotool windowactivate 0x1200007\nxfconf-query -c xfce4-panel -p /plugins/plugin-4/items -n -a -t string -s ${config}/qorpera-dock/qorpera-terminal-running.desktop\n`,
		);
		assert.equal(readFileSync(join(run, "dock-terminal.shows"), "utf8"), "running\n");
		// The browser's window is a Chrome for Testing one; its icon shows that it is being opened, then that it is open.
		const browser = press("browser", { COMES: "browser", WINDOW_IS: '"chromium-browser", "Chromium-browser"' });
		assert.equal(browser.status, 0, browser.stderr);
		assert.deepEqual(browser.asked.trim().split("\n"), [
			`xfconf-query -c xfce4-panel -p /plugins/plugin-6/items -n -a -t string -s ${config}/qorpera-dock/qorpera-browser-launching.desktop`,
			"xdotool windowmap 0x1200007",
			"xdotool windowactivate 0x1200007",
			`xfconf-query -c xfce4-panel -p /plugins/plugin-6/items -n -a -t string -s ${config}/qorpera-dock/qorpera-browser-running.desktop`,
		]);
		assert.equal(existsSync(join(run, "dock-browser.launching")), false, "the press let go of the browser's icon");
		// Only the three programs can be asked for.
		for (const args of [[], ["press"], ["press", "editor"], ["press", "browser", "more"], ["start"]]) {
			const refused = lookRun(...args);
			assert.equal(refused.status, 64, args.join(" "));
		}
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}

	// The package carries the pictures as one archive beside the look's files, and the dock's two units; the guest helper,
	// whose sha-256 the executor pins, has nothing of it.
	assert.match(packager, /\nimport \{ MACHINE_DESKTOP_PICTURES, tarArchive \} from "\.\/machine-desktop-art\.mjs";\n/);
	assert.match(packager, /\n\tfile: "desktop-art\.tar",\n\tsource: [^\n]+\n\tinstalledPath: "\/usr\/share\/qorpera-desktop",\n/);
	assert.ok(packager.indexOf('file: "cloud-machine-guest.mjs"') < packager.indexOf('file: "desktop-art.tar"'));
	assert.doesNotMatch(read("packages/runtime/src/cloud-machine-guest.ts"), /desktop-look|desktop-dock|qorpera-desktop\b/);
	const units = [...packager.match(/const units = \[([^\]]+)\]/)[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
	for (const unit of ["qorpera-machine-desktop-dock.path", "qorpera-machine-desktop-dock.service"]) assert.ok(units.includes(unit), unit);
	const required = words(imageScript.match(/for file in ([^;]+); do\n\t\[\[ -f \$PACKAGE\/\$file \]\]/)[1]);
	assert.ok(required.includes("desktop-art.tar"));

	// The image: the pictures unpacked root-owned, each one checked by the build's own lists (every dock icon, every
	// figure and the neutral set, every hour), the icon set the programs draw their own pictures from, the dock's unit on
	// from every boot, and no layout or look kept in the account: the session writes it.
	const apt = words(imageScript.match(/apt-get install -y --no-install-recommends((?:[^\n]*\\\n)*[^\n]*)/)[1]);
	assert.ok(apt.includes("adwaita-icon-theme"));
	assert.deepEqual(
		words(imageScript.match(/\n\tfor icon in ([^;]+); do\n\t\t\[\[ \$\(file -b "\/usr\/share\/qorpera-desktop\/dock\/\$icon\.png"\)/)[1]).toSorted(),
		[...DOCK_ICONS].toSorted(),
	);
	assert.deepEqual(words(imageScript.match(/\n\tfor figure in ([^;]+); do\n\t\tfor hour in \$\(seq -w 0 23\); do\n/)[1]), [
		...figures,
		NEUTRAL_BACKDROP,
	]);
	assert.ok(!imageScript.includes("/etc/xdg/xfce4/panel/default.xml"), "the stock panel layout is not the desktop's");
	for (const line of [
		'lx file push "$PACKAGE/desktop-art.tar" "$BUILDER/tmp/desktop-art.tar" --uid 0 --gid 0 --mode 0644\n',
		"\tinstall -d -o root -g root -m 0755 /opt/qorpera-machine /opt/qorpera-folder /usr/share/qorpera-desktop\n",
		"\tinstall -d -o root -g root -m 0755 /etc/qorpera-machine\n",
		"\ttar -xf /tmp/desktop-art.tar -C /usr/share/qorpera-desktop --no-same-owner\n\trm /tmp/desktop-art.tar\n",
		"\tsystemctl enable qorpera-machine-desktop-dock.path\n",
		"\tsystemd-tmpfiles --create /etc/tmpfiles.d/qorpera-machine-desktop.conf\n",
		'\t[[ $(find /usr/share/qorpera-desktop -type f | wc -l) == $(( 9 + 13 * 24 )) ]] ||\n',
		"\t[[ -z $(find /usr/share/qorpera-desktop ! -user root -o ! -group root -o -perm /022) ]] ||\n",
		'\t[[ $(stat -c "%U:%G %a %F" /run/qorpera-desktop-dock) == "root:desktop 730 directory" ]] ||\n',
		'\tdock_whole || { echo "the dock is not one bar with the browser, the files and a terminal: ',
		'\tbackdrop_is neutral || { echo "a machine that names no figure does not show the neutral backdrop: $(shown)" >&2; exit 1; }\n',
		"\tfor figure in star:star ghost:moon nonsense:neutral; do\n",
		"\tdesktop start --tz Pacific/Auckland >/dev/null\n",
		"\tdesktop click 880 960\n",
		"\tdesktop click 800 960\n",
		"\tdesktop click 720 960\n",
		'\t[[ $(scores "$browser") == "0 " ]] && tr "\\0" " " <"/proc/$browser/cmdline" | grep -q -- " --start-maximized .* chrome://newtab/ *$" ||\n',
		'\t\t{ echo "a second press on the dock browser icon started a second browser" >&2; exit 1; }\n',
		"\tfor round in 1 2 3 4 5 6 7 8; do\n\t\tDISPLAY=:1 wmctrl -c Terminal\n",
		'\t\tif desktop windows | grep -q " Terminal$"; then echo "the terminal did not close in round $round" >&2; exit 1; fi\n',
		'\t\t{ echo "the dock unit did not survive a program opened and closed in a row" >&2; exit 1; }\n',
		"\trm -rf /home/desktop/.config\n\tdesktop start >/dev/null\n\tdock_whole && backdrop_is neutral ||",
		"\tfind /home/desktop -mindepth 1 -maxdepth 1 ! -name .bashrc ! -name .profile ! -name .bash_logout -exec rm -rf -- {} +\n",
		'\t[[ $(ls -A /home/desktop | sort | tr "\\n" " ") == ".bash_logout .bashrc .profile " && -z $(ls -A /etc/qorpera-machine) ]] ||\n',
		"\tsystemd-analyze verify /etc/systemd/system/qorpera-machine-desktop-dock.path /etc/systemd/system/qorpera-machine-desktop-dock.service\n",
	])
		assert.ok(imageScript.includes(line), line);

	// The session: the look is written once the display answers (it tells the screen's name) and before XFCE starts,
	// XFCE starts whatever came of it, and the watcher is none of the jobs whose end ends the desktop.
	const at = (text) => {
		const found = session.indexOf(text);
		assert.ok(found > 0, text);
		return found;
	};
	assert.ok(at('xdpyinfo >/dev/null 2>&1 || { echo "the display did not start"') < at("\n/opt/qorpera-machine/desktop-look write || echo "));
	assert.ok(at("\n/opt/qorpera-machine/desktop-look write || echo ") < at("\texec startxfce4\n"));
	assert.ok(at("\texec startxfce4\n") < at("\n(/opt/qorpera-machine/desktop-look watch >/dev/null 2>&1 &)\n"));
	assert.ok(at("\n(/opt/qorpera-machine/desktop-look watch >/dev/null 2>&1 &)\n") < at("\nwait -n\n"));

	// The look is the office dock's, carried over, not drawn anew: the same bar and the same look of it (the clocks'
	// zone is the one line more), the same windows and terminal.
	const between = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));
	const panel = between(look, '<channel name="xfce4-panel"', "\nPANEL\n");
	assert.equal(
		panel.replaceAll('      <property name="timezone" type="string" value="@ZONE@"/>\n', ""),
		between(office, '<channel name="xfce4-panel"', "\nPANEL\n"),
	);
	assert.equal(between(look, "@keyframes qorpera-dock-jump", "\nCSS\n"), between(office, "@keyframes qorpera-dock-jump", "\nCSS\n"));
	assert.equal(panel.match(/<property name="panel-\d+" type="empty">/g).length, 1);
	assert.deepEqual(
		[...panel.matchAll(/<property name="plugin-(\d)" type="string" value="(\w+)">/g)].map((match) => `${match[1]} ${match[2]}`).toSorted(),
		["1 separator", "2 separator", "3 clock", "4 launcher", "5 launcher", "6 launcher", "7 clock"],
	);
	const officeXfce = read("deploy/lxd-company-computer-guest/qorpera-screen-xfce");
	const carried = [
		...officeXfce.matchAll(/\n\s*set_(?:cosmetic|xfce)_property (xfwm4|xfce4-terminal) \/(?:general\/)?([a-z_-]+) (bool|int|string) "?([^"\n]+)"?(?=\n)/g),
	].filter(([, , path]) => !["run-custom-command", "custom-command", "color-palette"].includes(path));
	assert.equal(carried.length, 22);
	for (const [, channelName, path, type, value] of carried)
		assert.ok(look.includes(`<property name="${path}" type="${type}" value="${value}"/>`), `${channelName} ${path}`);
	const palette = office.match(/\nColorPalette=([#0-9a-f;]+)\n/)[1];
	assert.ok(look.includes(`<property name="color-palette" type="string" value="${palette}"/>`));
	assert.ok(look.includes(`\nColorPalette=${palette}\n`));
	for (const line of [
		'<property name="style" type="int" value="0"/>',
		'<property name="image-style" type="int" value="5"/>',
		'<property name="IconThemeName" type="string" value="Adwaita"/>',
		'<property name="title-mode" type="string" value="TERMINAL_TITLE_HIDE"/>',
	])
		assert.ok(look.includes(line), line);
	for (const line of [
		"\nART=${QORPERA_DESKTOP_ART:-/usr/share/qorpera-desktop}\n",
		"\nFIGURE=${QORPERA_DESKTOP_FIGURE:-/etc/qorpera-machine/desktop-figure}\n",
		"\nASK=${QORPERA_DESKTOP_ASK:-/run/qorpera-desktop-dock}\n",
		"\nSELF=/opt/qorpera-machine/desktop-look\n",
	])
		assert.ok(look.includes(line), line);

	// A press reaches root only as a name in root's folder, and root starts one of three fixed programs with the image's
	// own `desktop` command, in the company folder when the machine has it and the desktop's account may read it.
	assert.match(opener, /\nASK=\/run\/qorpera-desktop-dock\nDESKTOP=\/usr\/local\/bin\/desktop\n/);
	assert.match(opener, /\ncd -P -- "\$ASK" 2>\/dev\/null \|\| exit 0\n\[\[ \$\(pwd -P\) == "\$ASK" \]\] \|\| exit 0\n/);
	assert.match(opener, /\nif mountpoint -q \/company && runuser -u desktop -- test -r \/company -a -x \/company; then folder=\/company; fi\n/);
	assert.match(
		opener,
		/\n\tbrowser\) "\$DESKTOP" open "\$PAGE" ;;\n\tfiles\) "\$DESKTOP" run \/usr\/bin\/thunar "\$folder" ;;\n\tterminal\) "\$DESKTOP" run \/usr\/bin\/xfce4-terminal --working-directory="\$folder" ;;\n/,
	);
	assert.doesNotMatch(opener, /systemd-run|chrome --/);
	const pathUnit = read("deploy/machine/qorpera-machine-desktop-dock.path");
	assert.match(pathUnit, /\n\[Path\]\nDirectoryNotEmpty=\/run\/qorpera-desktop-dock\n/);
	// Presses are a person's: neither unit has a limit that, once hit, would leave the dock dead until the next boot.
	assert.match(pathUnit, /\nTriggerLimitIntervalSec=0\n/);
	assert.match(pathUnit, /\n\[Install\]\nWantedBy=multi-user\.target\n$/);
	const serviceUnit = read("deploy/machine/qorpera-machine-desktop-dock.service");
	assert.doesNotMatch(serviceUnit, /^\[Install\]/m);
	assert.match(serviceUnit, /\nType=oneshot\n/);
	assert.match(serviceUnit.slice(0, serviceUnit.indexOf("\n[Service]\n")), /\nStartLimitIntervalSec=0\n/);
	assert.match(serviceUnit, /\nSlice=qorpera-control\.slice\n/);
	assert.match(serviceUnit, /\nExecStart=\/opt\/qorpera-machine\/desktop-dock-open\n/);
	assert.match(read("deploy/machine/qorpera-machine-desktop.tmpfiles"), /\nd \/run\/qorpera-desktop-dock 0730 root desktop -\n$/);

	// The first look at a started desktop shows it whole: `desktop start` waits for XFCE's desktop to have drawn the
	// backdrop, which it draws last. And the memory proof's probe clicks an empty spot of the dock, not the top of the
	// screen, where the browser's tabs now are.
	const command = read("deploy/machine/desktop");
	assert.match(
		command,
		/\n\t\t\t\[\[ \$\(xprop -root _XROOTPMAP_ID 2>\/dev\/null\) == \*"pixmap id # 0x"\* \]\] &&\n\t\t\t\tscrot --overwrite --silent -- "\$drawn" 2>\/dev\/null &&\n/,
	);
	assert.match(read("scripts/prove-machine-memory.sh"), / -- desktop click 400 960 <\/dev\/null >\/dev\/null 2>&1 \|\| status=\$\?\n/);
	for (const file of ["deploy/machine/desktop-look", "deploy/machine/desktop-dock-open", "deploy/machine/backdrops-source/render.sh"])
		assert.equal(spawnSync("bash", ["-n", join(repositoryRoot, file)], { encoding: "utf8" }).status, 0, file);
});
