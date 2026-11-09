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
	const files = [...packager.matchAll(/\{ file: "([^"]+)", installedPath: "([^"]+)", mode: "(\d{4})" \}/g)].map(
		([, file, installedPath, mode]) => ({ file, installedPath, mode }),
	);
	assert.deepEqual(files, [
		{ file: "desktop-session", installedPath: "/opt/qorpera-machine/desktop-session", mode: "0555" },
		{ file: "desktop", installedPath: "/usr/local/bin/desktop", mode: "0555" },
		{ file: "qorpera-chromium.apparmor", installedPath: "/etc/apparmor.d/qorpera-chromium", mode: "0644" },
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
	for (const command of ["start", "stop", "status", "shot", "open", "run", "click", "double", "move", "drag", "type", "key", "scroll", "windows"])
		assert.match(cli.stdout, new RegExp(`^desktop ${command}\\b`, "m"), command);
	const unknown = spawnSync("bash", [join(repositoryRoot, "deploy/machine/desktop"), "fly"], { encoding: "utf8" });
	assert.equal(unknown.status, 2);
});
