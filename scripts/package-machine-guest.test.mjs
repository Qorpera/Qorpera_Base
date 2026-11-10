import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

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
