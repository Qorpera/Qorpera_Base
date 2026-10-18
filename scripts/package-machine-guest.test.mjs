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
