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
import { BACKDROP_SOURCE_FIGURES, backdropEyes, productFaces } from "../deploy/lxd-company-computer-guest/backdrops-source/eyes.mjs";
import {
	BACKDROP_FILES,
	DOCK_ICONS,
	DOCK_ICONS_LIGHT,
	MACHINE_DESKTOP_PICTURES,
	NEUTRAL_BACKDROP,
	tarArchive,
} from "./machine-desktop-art.mjs";

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

test("the image has Blender pinned, a starter set fetched by its pinned list, and renders one frame before it is published", () => {
	// deploy/machine/README.md, "Renders" (13 Nov 2026). Agents fetched Blender onto every machine by themselves and lit
	// boxes against a black world: the image brings the renderer, real light, materials and furniture, and the picture
	// tools a frame goes through afterwards.
	assert.match(imageScript, /\nBLENDER_VERSION=4\.3\.2\nBLENDER_SHA256=[0-9a-f]{64}\n/);
	// The official build from its version's own folder, checked before it is unpacked, and unpacked as root's.
	assert.ok(
		imageScript.includes(
			'\tcurl -fsSLo /tmp/blender.tar.xz "https://download.blender.org/release/Blender${BLENDER_VERSION%.*}/blender-${BLENDER_VERSION}-linux-x64.tar.xz"\n' +
				'\techo "${BLENDER_SHA256}  /tmp/blender.tar.xz" | sha256sum -c -\n' +
				"\ttar -xJf /tmp/blender.tar.xz -C /opt --no-same-owner\n",
		),
	);
	assert.ok(imageScript.includes('\tln -sfn "/opt/blender-${BLENDER_VERSION}-linux-x64" /opt/blender\n\tln -sf /opt/blender/blender /usr/local/bin/blender\n'));
	// Both blocks that name the version are handed it.
	assert.match(imageScript, /PLAYWRIGHT_VERSION="\$PLAYWRIGHT_VERSION" BLENDER_VERSION="\$BLENDER_VERSION" BLENDER_SHA256="\$BLENDER_SHA256" \\\n\tbash -euo pipefail -c '/);
	assert.match(imageScript, /PLAYWRIGHT_VERSION="\$PLAYWRIGHT_VERSION" BLENDER_VERSION="\$BLENDER_VERSION" bash -euo pipefail -c '\n\tsystemctl daemon-reload/);
	// The six libraries Blender's build asks the system for, and the picture tools beside ffmpeg.
	const apt = words(imageScript.match(/apt-get install -y --no-install-recommends((?:[^\n]*\\\n)*[^\n]*)/)[1]);
	for (const name of ["libxrender1", "libxxf86vm1", "libxi6", "libsm6", "libice6", "libgl1", "libxfixes3", "libxkbcommon0"])
		assert.ok(apt.includes(name), `apt installs ${name}, which Blender needs to start`);
	for (const name of ["imagemagick", "webp", "python3-pil", "python3-numpy", "ffmpeg"]) assert.ok(apt.includes(name), `apt installs ${name}`);
	// What agents installed onto their machines again and again besides: the font and PDF tools, each used in the build's checks.
	for (const name of ["python3-fonttools", "python3-brotli", "poppler-utils", "python3-pypdf"]) assert.ok(apt.includes(name), `apt installs ${name}`);
	assert.ok(imageScript.includes('font.flavor = \\"woff2\\"') && imageScript.includes("[[ $(head -c 4 /tmp/font-check.woff2) == wOF2 ]]"));
	assert.ok(imageScript.includes("pypdf.PdfReader(") && imageScript.includes("\tpdftotext /tmp/pdf-check.pdf /tmp/pdf-check.txt\n"));

	// The starter set's list: a path inside the set, Poly Haven's own address for that very file, a sha-256 and a size;
	// each path once, in order; 10 lights, 14 materials and 10 things at 2k, under 256 MiB together.
	const text = read("deploy/machine/render-assets.tsv");
	assert.ok(text.endsWith("\n") && !text.includes("\r") && !text.includes("\n\n"));
	const rows = text.slice(0, -1).split("\n").map((line) => line.split("\t"));
	for (const row of rows) {
		assert.equal(row.length, 4, row[0]);
		const [path, url, sha256, bytes] = row;
		assert.match(path, /^(hdris|textures|models)\/[A-Za-z0-9_/.-]+\.(exr|gltf|bin|jpg)$/);
		assert.ok(!path.includes(".."), path);
		assert.match(url, /^https:\/\/dl\.polyhaven\.org\/file\/ph-assets\/(HDRIs|Textures|Models)\/[A-Za-z0-9_/.-]+$/);
		assert.equal(url.split("/").at(-1), path.split("/").at(-1), path);
		assert.match(sha256, /^[0-9a-f]{64}$/);
		assert.match(bytes, /^[1-9][0-9]*$/);
	}
	const paths = rows.map(([path]) => path);
	assert.deepEqual(paths, [...new Set(paths)].sort());
	const names = (kind) => [...new Set(paths.filter((path) => path.startsWith(`${kind}/`)).map((path) => path.split("/")[1]))];
	const lights = names("hdris").map((file) => file.replace(/_2k\.exr$/, ""));
	const materials = names("textures");
	const things = names("models");
	assert.deepEqual([lights.length, materials.length, things.length], [10, 14, 10]);
	for (const name of [...materials, ...things])
		assert.ok(paths.includes(`${paths.find((path) => path.split("/")[1] === name).split("/")[0]}/${name}/${name}_2k.gltf`), name);
	const total = rows.reduce((sum, row) => sum + Number(row[3]), 0);
	assert.ok(total > 128 * 1024 * 1024 && total < 256 * 1024 * 1024, `the starter set is ${total} bytes`);
	// The guide an agent reads names every light, material and thing of the list, and where the set is.
	const guide = read("deploy/machine/render-assets.md");
	for (const name of [...lights, ...materials, ...things]) assert.ok(guide.includes(`\`${name}\``), `the guide names ${name}`);
	for (const said of ["/opt/qorpera-assets/hdris/", "/opt/qorpera-assets/textures/", "/opt/qorpera-assets/models/", "CC0", "`SOURCES.tsv`", "`preview.jpg`"])
		assert.ok(guide.includes(said), said);
	// The picture of the set is a JPEG small enough to look at.
	const preview = readFileSync(join(repositoryRoot, "deploy/machine/render-assets-preview.jpg"));
	assert.deepEqual([...preview.subarray(0, 3)], [0xff, 0xd8, 0xff]);
	assert.ok(preview.length < 2 * 1024 * 1024, `the preview is ${preview.length} bytes`);

	// The build fetches every row from where the list says and refuses another sha-256; nothing lies beside the list,
	// the guide and the picture; root owns the set and Blender, and nobody else can change them.
	for (const line of [
		'\twhile IFS=$(printf "\\t") read -r path url sha256 bytes; do\n',
		'\t\t\t$bytes =~ ^[0-9]+$ && $url == https://dl.polyhaven.org/file/ph-assets/* ]] ||\n',
		'\t\tcurl -fsSL --retry 3 -o "/opt/qorpera-assets/$path" "$url"\n',
		'\t\techo "$sha256  /opt/qorpera-assets/$path" | sha256sum -c --quiet - ||\n',
		"\tdone </opt/qorpera-assets/SOURCES.tsv\n",
		"\t[[ $(find /opt/qorpera-assets -type f | wc -l) == $(( $(wc -l </opt/qorpera-assets/SOURCES.tsv) + 3 )) ]] ||\n",
		"\t[[ -z $(find /opt/qorpera-assets /opt/blender/ ! -user root -o ! -group root -o ! -type l -perm /022) ]] ||\n",
		// Blender is the pinned build and renders one frame of the set, which the picture tools then open.
		'\t[[ $(HOME=/tmp/render-home blender --version | head -1) == "Blender ${BLENDER_VERSION}" ]] || { echo "blender is not ${BLENDER_VERSION}" >&2; exit 1; }\n',
		"\tHOME=/tmp/render-home blender -b --factory-startup --python-exit-code 1 -P /opt/qorpera-machine/render-check.py -- /opt/qorpera-assets /tmp/render-check.png\n",
		'\t[[ $(file -b /tmp/render-check.png) == "PNG image data, 320 x 180,"* ]] || { echo "the render check left no frame" >&2; exit 1; }\n',
		"\tconvert /tmp/render-check.png /tmp/render-check.webp\n",
		"\tcwebp -quiet /tmp/render-check.png -o /tmp/render-check-2.webp\n",
		// Python opens the WebP ImageMagick wrote, decoded in full, not the PNG it came from (review r1 of #1765, F1).
		'\tpython3 -c "from PIL import Image; import numpy; picture = Image.open(\\"/tmp/render-check.webp\\"); picture.load(); assert picture.size == (320, 180) and numpy.asarray(picture).shape[:2] == (180, 320)"\n',
		// The smallest machine has the builder's 10 GiB: an image that leaves it under 1.5 GiB is refused.
		'\t(( free_mib >= 1536 )) || { echo "the image leaves the smallest machine only $free_mib MiB free: too little to work in" >&2; exit 1; }\n',
	])
		assert.ok(imageScript.includes(line), line);
	// The fetch runs before the image's last clean-up, which empties /tmp of the check's frames.
	assert.ok(imageScript.indexOf("done </opt/qorpera-assets/SOURCES.tsv") < imageScript.indexOf("rm -rf /var/lib/apt/lists/* /tmp/*"));
	// The free room is measured after that clean-up and before the builder stops: it is what a machine gets, without
	// the packages apt downloaded and the build's caches (the second build on a node measured before it and refused).
	assert.ok(imageScript.indexOf("rm -rf /var/lib/apt/lists/* /tmp/*") < imageScript.indexOf("free_mib=$(df -BM --output=avail / | tail -1 | tr -dc 0-9)"));
	assert.ok(imageScript.indexOf("(( free_mib >= 1536 ))") < imageScript.indexOf('lx stop "$BUILDER"'));
	assert.equal(imageScript.split("free_mib=$(df").length, 2);

	// The render check asks what a render needs: the pinned version, Cycles on the processors with OpenImageDenoise, a
	// light, a material and a thing of the set at its real size, and a frame that is neither black nor flat.
	const check = read("deploy/machine/render-check.py");
	for (const asked of [
		'EXPECTED = os.environ.get("BLENDER_VERSION", "")',
		'scene.render.engine = "CYCLES"',
		'scene.cycles.device = "CPU"',
		'scene.cycles.denoiser = "OPENIMAGEDENOISE"',
		'os.path.join(assets, "hdris", "photo_studio_loft_hall_2k.exr")',
		'os.path.join(assets, "textures", "laminate_floor_02", "textures")',
		'os.path.join(assets, "models", "wooden_table_02", "wooden_table_02_2k.gltf")',
		"if not 0.6 < height < 1.0:",
		// A script that raises still ends Blender well: the check turns any error into its own failure.
		"except Exception as error:\n\tfail(",
		"if not 0.08 < mean < 0.9 or spread < 0.03:",
	])
		assert.ok(check.includes(asked), asked);
	for (const file of ["hdris/photo_studio_loft_hall_2k.exr", "textures/laminate_floor_02/textures/laminate_floor_02_diff_2k.jpg", "textures/laminate_floor_02/textures/laminate_floor_02_rough_2k.jpg", "models/wooden_table_02/wooden_table_02_2k.gltf"])
		assert.ok(paths.includes(file), `the list has what the render check loads: ${file}`);
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
		{ file: "desktop-files", installedPath: "/opt/qorpera-machine/desktop-files", mode: "0555" },
		{
			file: "qorpera-machine-desktop.tmpfiles",
			installedPath: "/etc/tmpfiles.d/qorpera-machine-desktop.conf",
			mode: "0644",
		},
		// The render tools (13 Nov 2026): the build's render check, and the starter set's list, guide and picture.
		{ file: "render-check.py", installedPath: "/opt/qorpera-machine/render-check.py", mode: "0444" },
		{ file: "render-assets.tsv", installedPath: "/opt/qorpera-assets/SOURCES.tsv", mode: "0444" },
		{ file: "render-assets.md", installedPath: "/opt/qorpera-assets/README.md", mode: "0444" },
		{ file: "render-assets-preview.jpg", installedPath: "/opt/qorpera-assets/preview.jpg", mode: "0444" },
		{ file: "qorpera-agent.sudoers", installedPath: "/etc/sudoers.d/qorpera-agent", mode: "0440" },
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
	// No pointer is drawn on the agent's screen, so none shows in a member's live picture (14 Nov 2026).
	assert.match(session, /Xvnc :1 [^\n]*\n?[^\n]*-nocursor /);
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
	assert.match(command, /start \| stop \| open \| run \| dock\)\n\texec 9>\/run\/qorpera-desktop\.lock\n\tflock 9\n/);
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
	for (const line of [
		'\tprintf "%s\\n" "#!/bin/sh" "[ \\"\\$(id -u)\\" = 0 ] || exec sudo -n /opt/qorpera-folder/qorpera-folder data \\"\\$@\\"" \\\n',
		'\t\t"exec /opt/qorpera-folder/qorpera-folder data \\"\\$@\\"" >/usr/local/bin/data\n',
		"\tdata >/dev/null 2>&1 && exit 1 || [[ $? == 2 ]]\n",
		"\tdata describe >/dev/null 2>&1 && exit 1 || [[ $? == 3 ]]\n",
		'\t[[ $(runuser -u qorpera-agent -- data --view-file /root/no-view.json describe 2>&1 >/dev/null; echo "exit $?") == \\\n',
		'\t\t*"has no company folder"*"exit 3" ]] ||\n',
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
	// page is served on the machine's loopback only. The desktop's own account does it (desktop-files, the test "root
	// follows no link" below).
	const files = read("deploy/machine/desktop-files");
	assert.match(files, /\n\t\t\t\tos\.symlink\(path, place\)\n\t\t\t\tbreak\n/);
	// Nothing on the desktop is ever replaced: the same link is used again, and a taken name gets a number (review r1 F1).
	assert.doesNotMatch(command, /rm -rf -- "\$place"/);
	assert.match(files, /\n\t\t\texcept FileExistsError:\n\t\t\t\tif os\.path\.islink\(place\) and os\.readlink\(place\) == path:\n\t\t\t\t\tbreak\n/);
	assert.match(
		files,
		/\n\tfor candidate in names\(name, folder\):\n\t\tplace = os\.path\.join\(DESK, candidate\)\n\t\tif rename\(-100, os\.fsencode\(on_its_way\), -100, os\.fsencode\(place\), 1\) == 0:\n\t\t\treturn place\n\t\tif ctypes\.get_errno\(\) != errno\.EEXIST:\n\t\t\traise OSError\(/,
	);
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
	assert.match(command, /--setenv=DBUS_SESSION_BUS_ADDRESS="unix:path=\$SESSION\/bus"/);
	// Text beyond plain ASCII is pasted (xdotool types a capital Å small), on both selections.
	assert.match(command, /if \[\[ \$text == \*\[!\[:ascii:\]\]\* \|\| \$text == \*\[\[:cntrl:\]\]\* \]\]; then\n/);
	assert.match(command, /xdotool key --clearmodifiers shift\+Insert\n/);
	// A picture nothing could show is refused.
	assert.match(files, /and not os\.path\.ismount\("\/company"\):\n\t\traise Stop\(\n\t\t\t"this machine has no company folder at \/company, so company_read cannot show a picture saved there"\n[^\n]*\n\t\t\t4,\n/);
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

test("the agent's home: Codex's own home folder is the agent account's, where the executor points CODEX_HOME", () => {
	// lanes/agent-box-20261113/home-lxd (14 Nov 2026): on a real machine without it the exec-server warned "could not
	// create PATH aliases" and `apply_patch` typed in its shell was "command not found"; with it, the patch applied.
	const host = read("packages/runner-orchestrator/src/company-machine-host.ts");
	assert.ok(host.includes("CODEX_HOME: `${CLOUD_MACHINE_HOME.home}/.codex`,"), "the executor's CODEX_HOME");
	assert.match(read("packages/contracts/src/cloud-machine.ts"), /\thome: "\/var\/lib\/qorpera-agent",\n/);
	// The executor runs a machine's Codex only when it is the pinned build: its sha-256 is the artifact's, the one the
	// image takes (argument 8 is checked against the same file).
	const pin = JSON.parse(read("deploy/first-node/native-codex/linux-x64-artifact.json")).artifact.sha256;
	assert.match(pin, /^[0-9a-f]{64}$/);
	assert.ok(read("packages/contracts/src/cloud-machine.ts").includes(`\tcodexSha256: "${pin}",\n`), "the executor's Codex pin");
	const made = imageScript.indexOf("\tinstall -d -o qorpera-agent -g qorpera-agent -m 0700 /var/lib/qorpera-agent/.codex\n");
	assert.ok(made > imageScript.indexOf("\tuseradd --uid 2000 --gid 2000 --home-dir /var/lib/qorpera-agent "), "made after the account");
	assert.ok(
		imageScript.includes(
			'\t[[ $(stat -c "%U:%G %a" /var/lib/qorpera-agent/.codex) == "qorpera-agent:qorpera-agent 700" ]] ||\n',
		),
		"the image's own check",
	);
});

test("the agent's home: every image carries the pinned Codex, and the desktop account keeps its uid", async () => {
	// lanes/agent-box-20261113/home-image (14 Nov 2026): with the Codex optional, an image built without it looked like
	// any other (the same bootstrapSha256) while every home on it was refused HOME_CODEX_NOT_PINNED; and the pin was read
	// from the record's top level, where it is not, so no build got past its first lines.
	const artifact = JSON.parse(read("deploy/first-node/native-codex/linux-x64-artifact.json")).artifact;
	assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
	assert.ok(Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0);
	assert.ok(imageScript.includes("\nCODEX=${8:?argument 8: the pinned Codex,"), "argument 8 is required");
	assert.ok(!imageScript.includes("${8:-"), "argument 8 has no default");
	assert.ok(imageScript.includes('json.load(open(sys.argv[1]))["artifact"];print(a["sha256"],a["bytes"])'), "the pin is read where it is");
	assert.ok(
		imageScript.includes('\nlx file push "$CODEX" "$BUILDER/opt/qorpera-machine/codex" --uid 0 --gid 0 --mode 0555\n'),
		"the Codex is always pushed, root's and 0555",
	);
	assert.ok(imageScript.includes('\t[[ $(stat -c "%U:%G %a" /opt/qorpera-machine/codex) == "root:root 555" &&\n'), "the image's own check");
	assert.ok(imageScript.includes('\t\t$(sha256sum </opt/qorpera-machine/codex | cut -d" " -f1) == "$EXPECTED_CODEX_SHA256" ]] ||\n'));
	assert.ok(imageScript.includes('EXPECTED_CODEX_SHA256="$EXPECTED_CODEX_SHA256" \\\n\tPLAYWRIGHT_VERSION='), "the checks get the pin");
	assert.ok(imageScript.includes("codexSha256: $codexSha256,"), "the build record names the Codex");
	// The desktop account first: useradd gives the next id above the highest in use, so an agent account made first
	// (2000) would move the desktop's to 2001. The build prints both and refuses a moved desktop account.
	const desktop = imageScript.indexOf("\tuseradd --create-home --shell /bin/bash --user-group desktop\n");
	assert.ok(desktop > 0 && imageScript.indexOf("\tgroupadd --gid 2000 qorpera-agent\n") > desktop, "the agent account after the desktop's");
	assert.ok(imageScript.indexOf("\tuseradd --uid 2000 --gid 2000 --home-dir /var/lib/qorpera-agent ") > desktop);
	assert.ok(imageScript.includes('\techo "accounts: desktop $(id -u desktop):$(id -g desktop), qorpera-agent $(id -u qorpera-agent):$(id -g qorpera-agent)" >&2\n'));
	assert.ok(imageScript.includes("&& $(id -u desktop) -lt 2000 ]] ||"));
	// The script itself, up to where a build would begin: it refuses before root, a builder or a package is needed.
	const work = await mkdtemp(join(tmpdir(), "machine-image-codex-"));
	try {
		const run = (...extra) =>
			spawnSync("bash", [join(repositoryRoot, "deploy/machine/build-machine-image.sh"), work, "24.21.0", "0".repeat(64), "qorpera-build", "qorpera0", "qorpera-vm", ...extra], {
				encoding: "utf8",
				env: { PATH: process.env.PATH },
			});
		const none = run("machines");
		assert.notEqual(none.status, 0);
		assert.match(none.stderr, /argument 8: the pinned Codex, the build deploy\/first-node\/native-codex\/linux-x64-artifact\.json records/);
		const missing = run("machines", join(work, "no-such-codex"));
		assert.notEqual(missing.status, 0);
		assert.match(missing.stderr, /argument 8 is not a file/);
		const other = join(work, "codex");
		await writeFile(other, "not the pinned build\n");
		const wrong = run("machines", other);
		assert.notEqual(wrong.status, 0);
		assert.ok(wrong.stderr.includes(`the Codex given is not the pinned build (${artifact.sha256}, ${artifact.bytes} bytes)`), wrong.stderr);
		assert.ok(!/no pinned Codex|Traceback/.test(`${none.stderr}${missing.stderr}${wrong.stderr}`), "the pin is read");
	} finally {
		await rm(work, { recursive: true, force: true });
	}
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
		// After the swapoff the reset and the unload are asked again while they are refused as busy (a build failed
		// there once), and the last try's failure fails the build.
		'\tpatient() {\n\t\tlocal try\n\t\tfor try in $(seq 1 50); do\n\t\t\t"$@" 2>/dev/null && return 0\n\t\t\tsleep 0.1\n\t\tdone\n\t\t"$@"\n\t}\n',
		'\tswapoff /dev/zram0\n\tpatient bash -c "echo 1 >/sys/block/zram0/reset"\n\tpatient rmmod zram\n',
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
	// Every picture is there and is a PNG of its size: the nine dock icons, the six with a mark drawn again for a light
	// ground, 24 frames a set, thirteen sets.
	assert.equal(MACHINE_DESKTOP_PICTURES.length, 9 + 6 + 13 * 24);
	assert.deepEqual(
		[...DOCK_ICONS_LIGHT].toSorted(),
		DOCK_ICONS.filter((icon) => !icon.endsWith("-idle")).toSorted(),
		"every state with a mark has its drawing for a light ground; an idle icon has no mark",
	);
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
		if (name.startsWith("dock")) {
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
		await mkdir(join(art, "dock-light"));
		for (const icon of DOCK_ICONS_LIGHT) await writeFile(join(art, "dock-light", `${icon}.png`), "png");
		const tools = join(temporary, "tools");
		await mkdir(tools);
		const asked = join(temporary, "asked");
		const tool = (name, body) => writeFile(join(tools, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
		await tool("xsetroot", 'echo "xsetroot $*" >>"$ASKED"');
		await tool("xrandr", 'echo "Screen 0: minimum 32 x 32, current 1600 x 1000"; echo "VNC-0 connected primary 1600x1000+0+0 0mm x 0mm"');
		const home = join(temporary, "home");
		const run = join(temporary, "run");
		const ask = join(temporary, "ask");
		const notes = join(temporary, "notes");
		const figureFile = join(temporary, "desktop-figure");
		for (const folder of [home, run, ask, notes]) await mkdir(folder);
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
			QORPERA_DESKTOP_NOTES: notes,
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
			// The dock stands on the wallpaper: the bar is the hour's ground, the date and the time are written in that
			// ground's ink (dark on a light ground, light on a dark one), and both are noted for the watcher and a press.
			const share = (part) => (Math.floor((Number.parseInt(part, 16) * 1000000) / 255) / 1000000).toFixed(6);
			const dock = (hour) => {
				const colour = grounds[Number(hour)];
				const light = Number.parseInt(colour.slice(0, 2), 16) >= 128;
				const ink = (colourOf, format) => `value="&lt;span foreground=&quot;#${colourOf}&quot;&gt;${format}&lt;/span&gt;"`;
				return {
					colour,
					tone: light ? "light" : "dark",
					rgba: [0, 2, 4].map((at) => `        <value type="double" value="${share(colour.slice(at, at + 2))}"/>\n`).join("") + '        <value type="double" value="1"/>\n',
					time: ink(light ? "1d2026" : "eef0f4", "%H:%M"),
					date: ink(light ? "4b515c" : "a3abba", "%a %d %b"),
				};
			};
			const panelNow = channel("xfce4-panel");
			assert.ok(
				[...hours].map(dock).some(
					(now) =>
						panelNow.includes(`      <property name="background-rgba" type="array">\n${now.rgba}      </property>\n`) &&
						panelNow.split(now.time).length === 3 &&
						panelNow.split(now.date).length === 3 &&
						readFileSync(join(run, "dock.ground"), "utf8") === `${now.colour}\n` &&
						readFileSync(join(run, "dock.tone"), "utf8") === `${now.tone}\n`,
				),
				`the dock's ground and ink in ${zone}: ${panelNow.match(/<property name="background-rgba"[\s\S]*?<\/property>/)?.[0]}`,
			);
		};
		// A zone where it is that hour now (Etc/GMT-N is N hours ahead of UTC).
		const zoneAt = (hour) => {
			const ahead = (hour - new Date().getUTCHours() + 24) % 24;
			return ahead <= 12 ? `Etc/GMT-${ahead}` : `Etc/GMT+${24 - ahead}`;
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
		// Each state is an entry; a state with a mark has a second one for a light ground, with the dark mark's picture.
		assert.deepEqual(
			spawnSync("ls", [join(config, "qorpera-dock")], { encoding: "utf8" }).stdout.trim().split("\n").toSorted(),
			[
				"qorpera-browser-failed-light.desktop",
				"qorpera-browser-failed.desktop",
				"qorpera-browser-launching-2-light.desktop",
				"qorpera-browser-launching-2.desktop",
				"qorpera-browser-launching-light.desktop",
				"qorpera-browser-launching.desktop",
				"qorpera-browser-running-light.desktop",
				"qorpera-browser-running.desktop",
				"qorpera-browser.desktop",
				"qorpera-files-running-light.desktop",
				"qorpera-files-running.desktop",
				"qorpera-files.desktop",
				"qorpera-terminal-running-light.desktop",
				"qorpera-terminal-running.desktop",
				"qorpera-terminal.desktop",
			].toSorted(),
		);
		for (const [name, folder] of [
			["qorpera-files-running.desktop", "dock"],
			["qorpera-files-running-light.desktop", "dock-light"],
		]) {
			const entry = readFileSync(join(config, "qorpera-dock", name), "utf8");
			assert.match(entry, /\nExec=\/opt\/qorpera-machine\/desktop-look press files\n/);
			assert.equal(entry.match(/\nIcon=([^\n]+)\n/)[1], `${art}/${folder}/files-running.png`);
		}
		for (const file of ["gtk-3.0/gtk.css", "gtk-3.0/settings.ini", "qorpera-bashrc", "xfce4/terminal/terminalrc"])
			assert.ok(readFileSync(join(config, file), "utf8").length > 0, file);
		for (const name of ["xfwm4", "xfce4-terminal", "xsettings"]) assert.match(channel(name), new RegExp(`<channel name="${name}" version="1\\.0">`));
		// The figure the machine names, a saved ghost as the moon, a word the image has no set for as the neutral one; and
		// the zone `desktop start --tz` keeps in root's notes. A zone named in the account's own runtime folder, where
		// root kept it before review r1 F1 of #1704, is nobody's word.
		writeFileSync(figureFile, "star\n");
		written("star", "UTC");
		writeFileSync(figureFile, "ghost");
		written("moon", "UTC");
		writeFileSync(join(run, "tz"), "Asia/Tokyo");
		written("moon", "UTC");
		writeFileSync(join(notes, "tz"), "Pacific/Auckland");
		written("moon", "Pacific/Auckland");
		writeFileSync(figureFile, "../../etc\n");
		written("neutral", "Pacific/Auckland");
		writeFileSync(figureFile, "planet\n");
		written("neutral", "Pacific/Auckland");
		writeFileSync(join(notes, "tz"), "No/Such_Zone");
		written("neutral", "UTC");
		// By day and at night, whatever the hour of this test: in a zone where it is noon the bar is the light ground and
		// what is written on it is dark; in one where it is midnight both are the other way round.
		for (const [hour, colour, tone] of [
			[12, "f1f2f3", "light"],
			[0, "0e0f11", "dark"],
		]) {
			writeFileSync(join(notes, "tz"), zoneAt(hour));
			written("neutral", zoneAt(hour));
			assert.equal(readFileSync(join(run, "dock.ground"), "utf8"), `${colour}\n`);
			assert.equal(readFileSync(join(run, "dock.tone"), "utf8"), `${tone}\n`);
		}
		writeFileSync(join(notes, "tz"), "No/Such_Zone");
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
		// The marks below are a dark ground's (the office dock's); a light ground's come after.
		writeFileSync(join(run, "dock.tone"), "dark\n");
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
		// On a light ground the same press shows the same states with the dark mark's pictures, and keeps the tone with
		// the state, so a change of tone is a change to show.
		writeFileSync(join(run, "dock.tone"), "light\n");
		for (const app of ["browser", "files", "terminal"]) await rm(join(run, `dock-${app}.shows`), { force: true });
		// (The stand-in for the display shows a window once the program was asked for: the earlier press's ask goes.)
		await rm(join(ask, "browser"), { force: true });
		const day = press("browser", { COMES: "browser", WINDOW_IS: '"chromium-browser", "Chromium-browser"' });
		assert.equal(day.status, 0, day.stderr);
		assert.deepEqual(day.asked.trim().split("\n"), [
			`xfconf-query -c xfce4-panel -p /plugins/plugin-6/items -n -a -t string -s ${config}/qorpera-dock/qorpera-browser-launching-light.desktop`,
			"xdotool windowmap 0x1200007",
			"xdotool windowactivate 0x1200007",
			`xfconf-query -c xfce4-panel -p /plugins/plugin-6/items -n -a -t string -s ${config}/qorpera-dock/qorpera-browser-running-light.desktop`,
		]);
		assert.equal(readFileSync(join(run, "dock-browser.shows"), "utf8"), "running light\n");
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
	assert.deepEqual(
		words(imageScript.match(/\n\tfor icon in ([^;]+); do\n\t\t\[\[ \$\(file -b "\/usr\/share\/qorpera-desktop\/dock-light\/\$icon\.png"\)/)[1]).toSorted(),
		[...DOCK_ICONS_LIGHT].toSorted(),
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
		'\t[[ $(find /usr/share/qorpera-desktop -type f | wc -l) == $(( 9 + 6 + 13 * 24 )) ]] ||\n',
		'\tdesktop start --tz "$(zone_at 12)" >/dev/null\n\tdock_stands_on f1f2f3 light 1d2026 4b515c || { echo "by day the dock does not stand on the wallpaper" >&2; exit 1; }\n',
		'\tdesktop start --tz "$(zone_at 0)" >/dev/null\n\tdock_stands_on 0e0f11 dark eef0f4 a3abba || { echo "at night the dock does not stand on the wallpaper" >&2; exit 1; }\n',
		'\t[[ $(pixel 798 465) == ffffff ]] || { echo "by day the figure has no eyes on the backdrop: $(pixel 798 465)" >&2; exit 1; }\n',
		'\t[[ $(marks) == "$mark $mark $mark " ]] || { echo "a dock icon does not mark its open program: $(marks)" >&2; exit 1; }\n',
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
		"\tfor round in 1 2 3 4 5 6 7 8; do\n\t\tsleep 0.5\n\t\tDISPLAY=:1 wmctrl -c Terminal\n",
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

	// The look is the office dock's, carried over, not drawn anew: the same bar and the same look of it, the same
	// windows and terminal. What a machine's dock has of its own, line for line: the clocks' zone; and since 14 Nov 2026
	// (Jonas: "the docker should also not be black - it should be transparrant/wallpapers color") its colour, which is
	// the hour's ground and not the office's fixed dark, and the ink of what is written on it, which follows that ground.
	const between = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));
	const panel = between(look, '<channel name="xfce4-panel"', "\nPANEL\n");
	const officePanel = between(office, '<channel name="xfce4-panel"', "\nPANEL\n");
	const ownLine = (line) =>
		/ name="(timezone|digital-time-format|digital-date-format|digital-format)" /.test(line) ||
		(/^ {8}<value type="double" value="/.test(line) && !line.includes('value="1"'));
	const shared = (text) => text.split("\n").filter((line) => !ownLine(line));
	assert.deepEqual(shared(panel), shared(officePanel));
	assert.deepEqual(
		panel.split("\n").filter(ownLine),
		[
			'        <value type="double" value="$(share "${ground:0:2}")"/>',
			'        <value type="double" value="$(share "${ground:2:2}")"/>',
			'        <value type="double" value="$(share "${ground:4:2}")"/>',
			'      <property name="digital-time-format" type="string" value="$time_format"/>',
			'      <property name="digital-format" type="string" value="$time_format"/>',
			'      <property name="timezone" type="string" value="$zone"/>',
			'      <property name="digital-date-format" type="string" value="$date_format"/>',
			'      <property name="digital-format" type="string" value="$date_format"/>',
			'      <property name="timezone" type="string" value="$zone"/>',
		],
	);
	// Nothing else in that file is the shell's to fill in.
	assert.deepEqual([...new Set(panel.match(/\$[({]?\w+/g))].toSorted(), ["$(share", "$date_format", "$time_format", "$zone", "${ground"]);
	// The dock's own CSS: the office's rules, but the bar has no colour of its own (the panel paints the ground it is
	// told, and a colour named there would stand over it), the highlights read on a light ground and on a dark one,
	// and the clocks' colours are in their formats.
	const css = between(look, "@keyframes qorpera-dock-jump", "\nCSS\n");
	const officeCss = between(office, "@keyframes qorpera-dock-jump", "\nCSS\n");
	const cut = (text, from, to) => text.slice(0, text.indexOf(from)) + text.slice(text.indexOf(to, text.indexOf(from)));
	const withoutOwn = (text) =>
		cut(
			cut(text, ".xfce4-panel {", ".xfce4-panel button {"),
			".xfce4-panel button:hover {",
			".xfce4-panel #clock-button:hover,",
		);
	assert.equal(withoutOwn(css), withoutOwn(officeCss));
	assert.equal(
		css.slice(css.indexOf(".xfce4-panel {"), css.indexOf(".xfce4-panel button {")),
		".xfce4-panel {\n\tbackground-image: none;\n\tborder: none;\n\tbox-shadow: none;\n}\n",
	);
	assert.doesNotMatch(css, /#[0-9a-f]{6}|rgba\(255, 255, 255/, "no colour of a dark bar is left in the dock's CSS");
	assert.match(look, /\nunset DATE_INK TIME_INK\ndeclare -A DATE_INK=\(\[dark\]=a3abba \[light\]=4b515c\) TIME_INK=\(\[dark\]=eef0f4 \[light\]=1d2026\)\n/);
	// The watcher moves the ground and the ink on with the hours, on a panel that runs: both are settings the panel
	// takes at once (xfce4-panel 4.20: background-rgba while its background-style is a colour; a clock's format, which
	// it reads as Pango markup). The tone is noted before the marks are set, so they are the tone's.
	for (const line of [
		'\txfconf-query -c xfce4-panel -p /panels/panel-1/background-rgba -n -t double -s "$(share "${1:0:2}")" \\\n',
		'\txfconf-query -c xfce4-panel -p /plugins/plugin-3/digital-time-format -n -t string -s "$(inked "${TIME_INK[$1]}" %H:%M)" >/dev/null 2>&1 &&\n',
		"\t\txfconf-query -c xfce4-panel -p /plugins/plugin-7/digital-date-format -n -t string -s \"$(inked \"${DATE_INK[$1]}\" '%a %d %b')\" >/dev/null 2>&1\n",
		'\t\tif [[ $ground != "$ground_shown" ]] && dock_ground "$ground"; then\n',
		'\t\tif [[ $tone != "$tone_shown" ]] && echo "$tone" >"$RUN/dock.tone" && dock_ink "$tone"; then tone_shown=$tone; fi\n',
		'      <property name="background-style" type="uint" value="1"/>\n',
	])
		assert.ok(look.includes(line), line);
	assert.ok(look.indexOf('dock_ink "$tone"; then tone_shown=$tone; fi') < look.indexOf('\t\t\tshow "$app" "$state"\n'));
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
		"\nNOTES=${QORPERA_DESKTOP_NOTES:-/run/qorpera-desktop}\n",
		"\nSELF=/opt/qorpera-machine/desktop-look\n",
	])
		assert.ok(look.includes(line), line);

	// A press reaches root only as a name in root's folder, and root starts one of three fixed programs with the image's
	// own `desktop` command, in the company folder when the machine has it (the test "a press on the dock can steer
	// nothing" below).
	assert.match(opener, /\nASK=\/run\/qorpera-desktop-dock\nDESKTOP=\/usr\/local\/bin\/desktop\n/);
	assert.match(opener, /\n\t"\$DESKTOP" dock "\$app" >\/dev\/null \|\| echo "the dock's \$app did not start" >&2\n/);
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

test("every figure's backdrop carries its eyes, where the product draws them (14 Nov 2026)", () => {
	// Jonas, on the first real desktops: "The eyes should stay on the wallpaper - even if we can't animate it, it makes
	// the computer feel alive". The computer window's start scene draws the figure with its eyes on the wallpaper; the
	// picture that then came had the figure without them. The sources carry the product's own eye geometry
	// (motion-model.js `faces`), written by backdrops-source/eyes.mjs, and the pictures were rendered from them.
	const faces = productFaces();
	const transform = "translate(560 200) scale(8) rotate(-4 50 50)";
	assert.deepEqual(Object.values(BACKDROP_SOURCE_FIGURES).toSorted(), Object.keys(BACKDROP_FILES).toSorted());
	for (const [source, figure] of Object.entries(BACKDROP_SOURCE_FIGURES)) assert.equal(BACKDROP_FILES[figure], source, figure);
	// One pixel of a frame: the rows up to it, unfiltered (the frames are plain 8-bit RGB, not interlaced).
	const pixel = (bytes, x, y) => {
		const data = [];
		for (let at = 8; at < bytes.length; ) {
			const length = bytes.readUInt32BE(at);
			if (bytes.subarray(at + 4, at + 8).toString("latin1") === "IDAT") data.push(bytes.subarray(at + 8, at + 8 + length));
			at += 12 + length;
		}
		const raw = inflateSync(Buffer.concat(data));
		const stride = bytes.readUInt32BE(16) * 3;
		let above = Buffer.alloc(stride);
		for (let row = 0; row <= y; row++) {
			const filter = raw[row * (stride + 1)];
			const line = Buffer.from(raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)));
			for (let at = 0; at < stride; at++) {
				const left = at >= 3 ? line[at - 3] : 0;
				const up = above[at];
				const corner = at >= 3 ? above[at - 3] : 0;
				const guess = left + up - corner;
				const [toLeft, toUp, toCorner] = [Math.abs(guess - left), Math.abs(guess - up), Math.abs(guess - corner)];
				const paeth = toLeft <= toUp && toLeft <= toCorner ? left : toUp <= toCorner ? up : corner;
				line[at] = (line[at] + [0, left, up, (left + up) >> 1, paeth][filter]) & 255;
			}
			above = line;
		}
		return above.subarray(x * 3, x * 3 + 3).toString("hex");
	};
	for (const [source, figure] of Object.entries(BACKDROP_SOURCE_FIGURES)) {
		const html = read(`deploy/lxd-company-computer-guest/backdrops-source/${source}.html`);
		const eyes = faces[figure];
		assert.equal(eyes.length, 2, figure);
		// The source: the figure's own group, then its eyes in the same frame, white, exactly the product's.
		assert.ok(html.includes(`<g id="fig" fill-rule="evenodd" transform="${transform}">`), source);
		assert.ok(html.includes(`</g>${backdropEyes(eyes, transform)}</svg>`), `${source} carries the eyes of ${figure}`);
		assert.equal(html.match(/<g id="eyes"/g).length, 1, source);
		// The pictures: the middle of each eye is white by day and at night (a frame is 1920x1200; the figure's 100-unit
		// frame is turned 4 degrees about its middle, drawn 8 times as large, 560 right and 200 down).
		for (const hour of ["00", "07", "12"]) {
			const bytes = readFileSync(join(repositoryRoot, `deploy/lxd-company-computer-guest/backdrops/qorpera-screen-${source}-${hour}.png`));
			for (const eye of eyes) {
				const turn = (-4 * Math.PI) / 180;
				const [dx, dy] = [eye.x - 50, eye.y - 50];
				const x = Math.round(560 + 8 * (50 + dx * Math.cos(turn) - dy * Math.sin(turn)));
				const y = Math.round(200 + 8 * (50 + dx * Math.sin(turn) + dy * Math.cos(turn)));
				assert.equal(pixel(bytes, x, y), "ffffff", `an eye of ${figure} at ${x},${y} in the frame of hour ${hour}`);
			}
		}
	}
	// The retired ghost has no eyes in the product, and its source none; the neutral backdrop is the wordmark.
	assert.equal(faces.ghost, undefined);
	for (const file of ["deploy/lxd-company-computer-guest/backdrops-source/wisp.html", "deploy/machine/backdrops-source/neutral.html"])
		assert.doesNotMatch(read(file), /<g id="eyes"/, file);
	// The web's copies of the figures (the start scene draws its own eyes over them) read the figure's group alone.
	assert.match(read("packages/web/scripts/desktop-backdrops.mjs"), /html\.match\(\/<g id="fig"\(\[\^>\]\*\)>\(\[\\s\\S\]\*\?\)<\\\/g>\/\)/);
});

test("root keeps its notes about the desktop where only root writes (review r1 F1 of #1704)", async () => {
	// The finding: root's `desktop` kept its notes (the language, the time zone, the idle clock, the folders it serves) in
	// the desktop account's own runtime folder and read them there. The account could make `lang` a link to a file only
	// root may read (the company folder's view, with its pass) and ask the dock for a terminal: root's launch read the file
	// and handed it to a program of the account as LANGUAGE. The same reads ran before #1704 for an agent's own
	// `desktop open`, so the hole was in the live image too.
	// What `desktop open` does in the account's Desktop folder, `--copy`, and `desktop shot`: the test "root follows no
	// link" below.
	const unit = read("deploy/machine/qorpera-machine-desktop.service");
	const command = read("deploy/machine/desktop");
	const session = read("deploy/machine/desktop-session");
	const look = read("deploy/machine/desktop-look");
	const opener = read("deploy/machine/desktop-dock-open");

	// Two folders, two owners: /run/qorpera-desktop is root's (systemd makes the way to a runtime folder as root's, and
	// the unit says so again, empties it and sets the idle clock as root); only its `session` folder is the account's.
	for (const line of [
		"Environment=HOME=/home/desktop XDG_RUNTIME_DIR=/run/qorpera-desktop/session",
		"RuntimeDirectory=qorpera-desktop/session",
		"RuntimeDirectoryMode=0700",
		"ExecStartPre=+/usr/bin/install -d -o root -g root -m 0755 /run/qorpera-desktop",
		"ExecStartPre=+/usr/bin/find /run/qorpera-desktop -mindepth 1 -maxdepth 1 ! -name session -exec /usr/bin/rm -rf -- {} +",
		"ExecStartPre=+/usr/bin/touch /run/qorpera-desktop/last-use",
		"ExecStopPost=-+/usr/bin/find /run/qorpera-desktop -mindepth 1 -maxdepth 1 ! -name session -exec /usr/bin/rm -rf -- {} +",
	])
		assert.ok(unit.includes(`\n${line}\n`), line);
	assert.doesNotMatch(unit, /^RuntimeDirectory=qorpera-desktop$/m);
	// The paths root's other programs use stay root's notes: the screen helper and the executor touch the idle clock there.
	assert.match(read("packages/runtime/src/cloud-machine-screen.ts"), /\nconst LAST_USE = "\/run\/qorpera-desktop\/last-use";\n/);
	assert.match(read("packages/runner-orchestrator/src/company-machine-host.ts"), /"touch -c \/run\/qorpera-desktop\/last-use",/);

	// The command: its notes are in root's folder, each one a name it writes itself; the account's runtime folder is only
	// ever handed to the account's programs as a path, never read.
	const code = command
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("#"))
		.join("\n");
	assert.match(code, /\nRUN=\/run\/qorpera-desktop\nSESSION=\$RUN\/session\n/);
	assert.deepEqual(
		[...new Set([...code.matchAll(/\$RUN\/([a-z-]+)/g)].map((match) => match[1]))].toSorted(),
		["drawn-", "lang", "last-use", "selftest-", "serve-", "session", "shot-", "tz"],
	);
	assert.deepEqual(
		[...code.matchAll(/\$SESSION[^\n]*/g)].map((match) => match[0]),
		['$SESSION" \\', '$SESSION/bus" "${extra[@]}" -- "$@"'],
	);
	// The session reads the idle clock where root keeps it, and the look reads the time zone there; neither writes it.
	assert.match(session, /\nLAST=\/run\/qorpera-desktop\/last-use\n/);
	assert.doesNotMatch(session, /touch "\$LAST"|XDG_RUNTIME_DIR\/last-use/);
	assert.match(look, /if \[\[ -f \$NOTES\/tz && -s \$NOTES\/tz \]\]; then read -r -n 64 name _ <"\$NOTES\/tz" \|\| true; fi\n/);
	assert.doesNotMatch(look, /\$RUN\/tz|\$RUN\/lang/);
	// The dock's root side takes a request's name alone and reads nothing of the account's.
	assert.doesNotMatch(opener, /\/run\/qorpera-desktop\/|\$\(<|\bcat\b|\bsource\b|\n\. /);

	const temporary = await mkdtemp(join(tmpdir(), "qorpera-desktop-boundary-"));
	try {
		const tools = join(temporary, "tools");
		await mkdir(tools);
		const tool = (name, body) => writeFile(join(tools, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
		// Stand-ins: the desktop runs, and its display says the size it is told to say.
		await tool("systemctl", "echo active");
		await tool("xdpyinfo", 'echo "  dimensions:    $DIMENSIONS pixels (423x264 millimeters)"');
		await tool("touch", "exit 0");
		await tool("wmctrl", "exit 0");
		const desktop = (more, ...args) =>
			spawnSync("bash", [join(repositoryRoot, "deploy/machine/desktop"), ...args], {
				encoding: "utf8",
				env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, DIMENSIONS: "1600x1000", ...more },
			});

		// What the display says of its size is only ever digits. The display is the account's program; a name in an
		// arithmetic expression runs what its index says (bash), so an unchecked size could run a command as root.
		const canary = join(temporary, "canary");
		const hostile = `a[$(id>${canary})]x1`;
		const status = desktop({ DIMENSIONS: hostile }, "status");
		assert.equal(status.status, 0, status.stderr);
		assert.equal(status.stdout.split("\n")[0], "running ()");
		assert.equal(existsSync(canary), false);
		assert.equal(desktop({ DIMENSIONS: "1280x800" }, "status").stdout.split("\n")[0], "running (1280x800)");
		assert.match(code, /\n\tif \[\[ \$dims =~ \^\[0-9\]\{1,5\}x\[0-9\]\{1,5\}\$ \]\]; then echo "\$dims"; fi\n/);
		assert.match(code, /\n\t\tdims=\$\(size\)\n\t\t\[\[ -n \$dims \]\] \|\| dims=1600x1000\n/);
		assert.equal(code.match(/xdpyinfo/g).length, 2, "the display's size is read in one place");
		// That the danger is real, with the very expression `desktop start` uses: unchecked, the index runs.
		const arithmetic = (dims) =>
			spawnSync("bash", ["-c", 'dims=$1; (( 5000 > ${dims%x*} * ${dims#*x} * 3 / 1000 + 3000 )) || true', "bash", dims], { encoding: "utf8" });
		arithmetic(hostile);
		assert.equal(existsSync(canary), true, "an unchecked size runs what it says");
		await rm(canary);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}

	// The image build proves the boundary with the two real accounts and a file only root can read: the account can put
	// nothing among root's notes; what it plants in its own folders under the notes' names is never read; a program root
	// starts, for an agent or for a press on the dock, is handed nothing of the file; a request to the dock that is a
	// link is removed, never opened.
	for (const line of [
		"\tsecret=/root/qorpera-root-only-check\n",
		'\tchmod 0600 "$secret"\n',
		'\t[[ $(stat -c "%U:%G %a" /run/qorpera-desktop) == "root:root 755" && $(stat -c "%U:%G %a" /run/qorpera-desktop/session) == "desktop:desktop 700" ]] ||\n',
		'\tfor note in lang tz last-use serve-8600 serve-8699 "drawn-$$.png" anything; do\n',
		'\t\tif runuser -u desktop -- ln -sfn "$secret" "/run/qorpera-desktop/$note" 2>/dev/null ||\n',
		'\t\t\trunuser -u desktop -- mkfifo "/run/qorpera-desktop/$note.pipe" 2>/dev/null ||\n',
		'\tfor note in lang tz last-use; do runuser -u desktop -- ln -sfn "$secret" "/run/qorpera-desktop/session/$note"; done\n',
		'\trunuser -u desktop -- sh -c ": >/run/qorpera-desktop-dock/terminal"\n',
		'\t\tif gets "$pid" | grep -q "$marker"; then echo "a program of the desktop account ($program) was handed a file only root can read" >&2; exit 1; fi\n',
		'\t\t[[ $(gets "$pid" | grep -c -x -e "TZ=Europe/Copenhagen" -e "LANGUAGE=da-DK") == 2 ]] ||\n',
		'\trunuser -u desktop -- ln -s "$secret" /run/qorpera-desktop-dock/files\n',
		'\t[[ -z $(ls -A /run/qorpera-desktop-dock) ]] && untouched || { echo "a dock request that was a link or a pipe was followed, or stayed" >&2; exit 1; }\n',
		'\t[[ -d /run/qorpera-desktop && -z $(ls -A /run/qorpera-desktop) ]] || { echo "the notes of root outlived the desktop" >&2; exit 1; }\n',
	])
		assert.ok(imageScript.includes(line), line);
});

test("a desktop started without --tz takes the company's time zone from the machine's file", async () => {
	// deploy/machine/README.md, "The desktop's look", Time (12 Nov 2026; Jonas, asked whether each company gets a time
	// zone taken from the founder's browser so the clock is right: "Yes, from the browser"). The machine's executor
	// writes the company's zone as one word into /etc/qorpera-machine/desktop-timezone (root's, 0644), as it writes the
	// figure. The word came from a browser, through SQL and the executor, which each hold it to a zone name's shape; the
	// command holds it to the same shape again, before the word is ever part of a path.
	const command = read("deploy/machine/desktop");
	const code = command
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("#"))
		.join("\n");
	assert.match(code, /\nTIMEZONE=\/etc\/qorpera-machine\/desktop-timezone\n/);
	const reader = code.match(/\ncompany_zone\(\) \{\n(?:\t[^\n]*\n)+\}\n/)?.[0];
	assert.ok(reader, "company_zone");
	// The shape: letters, digits, _, + and -, in at most three parts with a / between; no dot, so no way out of the
	// folder of zones. It is checked, and the word's length, before the word follows /usr/share/zoneinfo/.
	assert.ok(reader.includes("plain='^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+){0,2}$'\n"), "the shape of a zone's name");
	assert.ok(
		reader.includes("\n\t[[ ${#name} -le 64 && $name =~ $plain && -f /usr/share/zoneinfo/$name ]] || return 0\n"),
		"the shape is checked before the word is part of a path",
	);
	// Only a plain file of root's own is read, never a link or a pipe, and no more of it than a zone's name is long.
	assert.ok(reader.includes("\n\t[[ -f $TIMEZONE && ! -L $TIMEZONE && -O $TIMEZONE ]] || return 0\n"));
	assert.ok(reader.includes('\n\tIFS= read -r -n 65 name <"$TIMEZONE" 2>/dev/null || true\n'));
	// The file's bytes are exactly the word, or the word and one line end (review r1 F1 of #1718). The shell's read
	// skips a NUL and stops at a line end, so a file that only reads as a zone's name passed while the sizes were
	// compared: `Europe/Copen\0hagen` with no line end is one byte more than the word read, as a line end is. What was
	// read is compared with the file byte for byte, before the word is looked at.
	assert.ok(
		reader.includes(
			`\n\tprintf '%s' "$name" | cmp -s -- "$TIMEZONE" - || printf '%s\\n' "$name" | cmp -s -- "$TIMEZONE" - || return 0\n\t[[ \${#name} -le 64 && `,
		),
		"the file is compared with the word byte for byte, before the word is looked at",
	);
	assert.doesNotMatch(reader, /== size|\+ 1/);
	// The command reads the file in that one function, and names a zone's file in two places: there and where --tz is
	// checked.
	assert.equal(code.match(/\$TIMEZONE/g).length, 7);
	assert.equal(reader.match(/\$TIMEZONE/g).length, 7);
	assert.equal(code.match(/\/usr\/share\/zoneinfo\//g).length, 2);
	// Only a start that starts the desktop takes it, and only when --tz named none: --tz wins, and a desktop that runs
	// keeps the zone it has. The word then goes where --tz's goes: root's note, which the programs, the dock's clocks and
	// the backdrop's hour follow.
	assert.equal(code.match(/company_zone/g).length, 2);
	assert.ok(
		code.includes('\n\t\trm -f -- "$drawn"\n\t\t[[ -n $tz ]] || tz=$(company_zone)\n\tfi\n\ttouch "$RUN/last-use"\n'),
		"the start of a desktop takes the company's zone when --tz named none",
	);
	assert.ok(code.includes('\n\tif [[ -n $tz ]]; then printf %s "$tz" >"$RUN/tz"; fi\n'));
	assert.ok(
		code.includes(
			'\t\t--tz) tz=${2:?--tz ZONE}; [[ $tz =~ ^[A-Za-z0-9_+/-]+$ && -f /usr/share/zoneinfo/$tz ]] || fail "no such time zone: $tz" 2 ;;\n',
		),
		"--tz is checked as before",
	);
	assert.match(command, /default en-US, and the company's\n +time zone when the machine names one, else UTC\)/);

	// The reader itself, run on files in a folder of this test's: the zones are the machine's own, as on every machine.
	for (const zone of ["UTC", "Europe/Copenhagen", "America/Argentina/Buenos_Aires", "Etc/GMT+2"])
		assert.ok(existsSync(`/usr/share/zoneinfo/${zone}`), `this machine has the zone ${zone}`);
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-desktop-timezone-"));
	try {
		const file = join(temporary, "desktop-timezone");
		/** What a start without --tz would take with the file as it is now, in a language whose letters are not ASCII's. */
		const taken = () => {
			const result = spawnSync("bash", ["-euo", "pipefail", "-c", `TIMEZONE=$1${reader}company_zone`, "bash", file], {
				encoding: "utf8",
				timeout: 10_000,
				env: { ...process.env, LC_ALL: "C.UTF-8" },
			});
			assert.equal(result.status, 0, `${result.error ?? ""}${result.stderr}`);
			assert.equal(result.stderr, "");
			return result.stdout;
		};
		// No file: nothing, and the desktop is on UTC as before.
		assert.equal(taken(), "");
		// The word as the executor writes it (with a line end), and without one.
		for (const zone of ["UTC", "Europe/Copenhagen", "America/Argentina/Buenos_Aires", "Etc/GMT+2"]) {
			await writeFile(file, `${zone}\n`);
			assert.equal(taken(), zone);
			await writeFile(file, zone);
			assert.equal(taken(), zone);
		}
		// A real file somewhere else, which a word that climbed out of the folder of zones would reach.
		assert.ok(existsSync("/usr/share/zoneinfo/../../../etc/passwd"), "the way out exists");
		for (const [why, bytes] of [
			["an empty file", ""],
			["a line end alone", "\n"],
			["two line ends", "Europe/Copenhagen\n\n"],
			["two words on two lines", "Europe/Copenhagen\nEurope/Paris\n"],
			["two words on one line", "Europe/Copenhagen Europe/Paris\n"],
			["a space before", " Europe/Copenhagen\n"],
			["a space after", "Europe/Copenhagen \n"],
			["a carriage return", "Europe/Copenhagen\r\n"],
			["a zone this machine does not have", "Mars/Olympus_Mons\n"],
			["a folder of zones", "Europe\n"],
			["a way out of the folder", "../../../etc/passwd\n"],
			["a way out and back in", "Europe/../Europe/Copenhagen\n"],
			["a dot", "./Europe/Copenhagen\n"],
			["a whole path", "/usr/share/zoneinfo/Europe/Copenhagen\n"],
			["an empty part", "Europe//Copenhagen\n"],
			["a / at the end", "Europe/Copenhagen/\n"],
			["four parts", "a/b/c/d\n"],
			["a NUL in the word", "Europe/Copen\0hagen\n"],
			// Review r1 F1 of #1718: one byte that the shell's read skips or stops at, where a line end could be. Each
			// file below reads as a zone's name and is one byte longer than it, or as long.
			["a NUL in the word and no line end", "Europe/Copen\0hagen"],
			["a NUL before the word", "\0Europe/Copenhagen"],
			["a NUL after the word", "Europe/Copenhagen\0"],
			["a NUL in a short word", "U\0TC"],
			["a NUL after a short word", "UTC\0"],
			["a NUL and a line end", "UTC\0\n"],
			["a line end and a NUL", "UTC\n\0"],
			["two NULs", "UTC\0\0"],
			["a NUL where a letter was", "Europe/Copen\0agen\n"],
			["a carriage return and no line end", "Europe/Copenhagen\r"],
			["a carriage return before the word", "\rEurope/Copenhagen\n"],
			["a line end before the word", "\nEurope/Copenhagen"],
			["a line end before and after the word", "\nEurope/Copenhagen\n"],
			["a second line with no line end", "Europe/Copenhagen\nUTC"],
			["a second line that is one letter", "Europe/Copenhagen\nA"],
			["a tab after the word", "UTC\t"],
			["a space after the word and no line end", "UTC "],
			["a form feed after the word", "UTC\f"],
			["a vertical tab after the word", "UTC\v"],
			["a backslash at the end of the line", "UTC\\\n"],
			["a backslash and a second line", "UT\\\nC\n"],
			["a byte order mark before the word", Buffer.from([0xef, 0xbb, 0xbf, 0x55, 0x54, 0x43, 0x0a])],
			["a byte order mark and no line end", Buffer.from([0xef, 0xbb, 0xbf, 0x55, 0x54, 0x43])],
			["a UTF-16 word", Buffer.from("\ufeffUTC\n", "utf16le")],
			["a byte that is no ASCII after the word", Buffer.from([0x55, 0x54, 0x43, 0xff])],
			["a byte that is no ASCII in the word", Buffer.from([0x55, 0x54, 0x80, 0x43, 0x0a])],
			["a delete byte after the word", Buffer.from([0x55, 0x54, 0x43, 0x7f])],
			["a letter that is not ASCII's", "Europe/København\n"],
			["a command", "$(id)\n"],
			["a word and a command", "Europe/Copenhagen;id\n"],
			["a word of 65 letters", `${"A".repeat(65)}\n`],
			["a word of 65 letters and no line end", "A".repeat(65)],
			["a long file that begins with a zone", `Europe/Copenhagen\n${"x".repeat(4096)}`],
			["a long file of one word", "A".repeat(100_000)],
		]) {
			await writeFile(file, bytes);
			assert.equal(taken(), "", why);
		}
		// That the danger was real: the shell's own read, as the command has it, takes the finding's file for the word.
		await writeFile(file, "Europe/Copen\0hagen");
		const shell = spawnSync("bash", ["-c", 'IFS= read -r -n 65 name <"$1" || true; printf %s "$name"', "bash", file], {
			encoding: "utf8",
		});
		assert.equal(shell.stdout, "Europe/Copenhagen", "the shell's read skips a NUL");
		assert.equal(taken(), "");
		// And the word alone, or with its one line end, is still taken after all of that.
		await writeFile(file, "Europe/Copenhagen");
		assert.equal(taken(), "Europe/Copenhagen");
		await writeFile(file, "Europe/Copenhagen\n");
		assert.equal(taken(), "Europe/Copenhagen");
		await rm(file);
		// A link is not followed, though it leads to a file that names a zone; nor is a link that leads nowhere read.
		const real = join(temporary, "real");
		await writeFile(real, "Europe/Copenhagen\n");
		assert.equal(spawnSync("ln", ["-s", real, file]).status, 0);
		assert.equal(taken(), "", "a link");
		await rm(file);
		assert.equal(spawnSync("ln", ["-s", join(temporary, "nowhere"), file]).status, 0);
		assert.equal(taken(), "", "a link to nowhere");
		await rm(file);
		// A pipe is not opened (a read of it would wait for ever), and a folder is no word.
		assert.equal(spawnSync("mkfifo", [file]).status, 0);
		assert.equal(taken(), "", "a pipe");
		await rm(file);
		await mkdir(file);
		assert.equal(taken(), "", "a folder");
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}

	// The image build proves it on the image, with XFCE's own answers: a start without --tz follows the file; a desktop
	// that runs keeps its zone and the next start takes the new word; --tz wins; a link is not followed; and the image
	// keeps no such file.
	for (const line of [
		'\t\t\tdesktop status | grep "^running (.*, time zone $1)\\$" >/dev/null || return 1\n',
		'\t\telif desktop status | grep "^running (.*time zone" >/dev/null; then\n',
		'\t\tbackdrop_is neutral "${1:-UTC}" && [[ $(look -c xfce4-panel -p /plugins/plugin-3/timezone) == "${1:-UTC}" &&\n',
		"\techo Pacific/Auckland >/etc/qorpera-machine/desktop-timezone\n\tdesktop start >/dev/null\n\tzone_is Pacific/Auckland ||",
		"\techo America/New_York >/etc/qorpera-machine/desktop-timezone\n\tdesktop start >/dev/null\n\tzone_is Pacific/Auckland ||",
		"\tdesktop stop >/dev/null\n\tdesktop start >/dev/null\n\tzone_is America/New_York ||",
		"\tdesktop stop >/dev/null\n\tdesktop start --tz Asia/Tokyo >/dev/null\n\tzone_is Asia/Tokyo ||",
		"\tln -sfn /root/qorpera-zone-check /etc/qorpera-machine/desktop-timezone\n\tdesktop start >/dev/null\n\tzone_is ||",
		"\trm /etc/qorpera-machine/desktop-timezone /root/qorpera-zone-check\n",
	])
		assert.ok(imageScript.includes(line), line);
});

test("root follows no link for the desktop's account: open, --copy and shot (review r2 of #1704)", async (t) => {
	// Review r2 of #1704: `desktop open`, `--copy` and `desktop shot` worked on paths with root's rights, and a look at a
	// path before its use closed nothing (a link in the middle of a way root owns; a part of the way planted after the
	// look; a folder of root's that a group or an ACL lets others write). The rule since: root never decides by looking
	// at a path and then using the path. The work runs as the account, or root works inside folders it holds, on a way
	// of folders that root alone can change with no link on it (deploy/machine/desktop-files; README, "Root and the
	// desktop's account").
	const command = read("deploy/machine/desktop");
	const files = read("deploy/machine/desktop-files");
	const code = command
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("#"))
		.join("\n");

	// The command itself does nothing with a target's path: no look, no link, no copy, no folder, no owner. Its only
	// file tests are on root's own notes, on root's own word about the company's time zone (a file in /etc/qorpera-machine,
	// a folder of root alone: the test "a desktop started without --tz" above) and on the zone table, and its one look at
	// a mount is the company folder's fixed place (for the dock's Files and terminal).
	for (const gone of [/\brealpath\b/, /\breadlink\b/, /\bchown\b/, /\binstall\b/, /\bcp\b/, /\bln\b/, /\bmkdir\b/, /\brunuser\b/, /\bmktemp\b/, /\$DESK\b/])
		assert.doesNotMatch(code, gone);
	assert.deepEqual(code.match(/\bmountpoint\b[^\n;]*/g), ["mountpoint -q /company"]);
	assert.deepEqual(
		[...new Set([...code.matchAll(/(?:\[\[|&&|\|\|) !? ?-[efdLhrwxsSpbcOGN] (\S+)/g)].map((match) => match[1]))].toSorted(),
		["$RUN/lang", "$RUN/serve-$port", "$RUN/tz", "$TIMEZONE", "$note", "/usr/share/zoneinfo/$name", "/usr/share/zoneinfo/$tz"],
	);
	assert.match(code, /\nFILES=\/opt\/qorpera-machine\/desktop-files\n/);
	assert.match(code, /\n\tfound=\$\("\$FILES" "\$\{words\[@\]\}" -- "\$target"\) \|\| exit \$\?\n\t\{ IFS= read -r kind && IFS= read -r path && IFS= read -r shown; \} <<<"\$found" \|\| fail /);
	// A picture is taken into root's own folder, handed to desktop-files, and what is printed is read from root's own.
	assert.match(
		code,
		/\n\tlocal file=\$1 taken=\$RUN\/shot-\$\$\.png status=0\n\t\[\[ \$file == \*\.png \]\] \|\| fail "FILE must end in \.png" 2\n\tscrot --overwrite --silent -- "\$taken"\n\t"\$FILES" save "\$taken" -- "\$file" \|\| status=\$\?\n\tif \(\( status == 0 \)\); then\n\t\techo "\$file \$\(stat -c %s -- "\$taken"\) bytes \$\(file -b -- "\$taken" \|/,
	);
	assert.match(code, /\n\tpicture=\$RUN\/selftest-\$\$\.png\n/);

	// The program. Root's side opens every part of a way inside the one before, never through a link.
	assert.match(files, /^#!\/usr\/bin\/python3 -I\n/);
	assert.match(files, /\nFOLDER = os\.O_RDONLY \| os\.O_DIRECTORY \| os\.O_NOFOLLOW \| os\.O_CLOEXEC\n/);
	assert.match(files, /\nHOLD = os\.O_PATH \| os\.O_NOFOLLOW \| os\.O_CLOEXEC\n/);
	assert.match(files, /\nREAD = os\.O_RDONLY \| os\.O_NONBLOCK \| os\.O_NOCTTY \| os\.O_CLOEXEC\n/);
	assert.match(files, /\nTOP = "\/"\nOWNER = 0\n/);
	assert.equal(files.match(/\b(?:TOP|OWNER) = /g).length, 2, "nothing in the program moves where root's ways start or whose they are");
	// Every open there is: a folder entered inside the one held, a name taken hold of inside a folder held, what a
	// hold holds (through the kernel's own name for the descriptor), root's own picture, the picture's place inside
	// the folder held, and the account's new file for a copy on its way on its own desktop.
	assert.deepEqual(
		[...files.matchAll(/os\.open\(([^\n]*)/g)].map((match) => match[1]),
		[
			"TOP, FOLDER)]",
			"name, FOLDER, dir_fd=self.fd)",
			"name, HOLD, dir_fd=way.fd)",
			'f"/proc/self/fd/{hold}", READ)',
			"name, HOLD, dir_fd=fd)",
			'f"/proc/self/fd/{hold}", READ)',
			'f"/proc/self/fd/{hold}", READ), "rb") as file:',
			"name, HOLD, dir_fd=way.fd))",
			"picture, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)",
			"name, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, 0o644, dir_fd=way.fd)",
			"on_its_way, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)",
		],
	);
	// Root's side looks no name up twice and asks nothing of a path: what a thing is, the descriptor that holds it says
	// (fstat). Its only words about paths are joining, tidying and the fixed mount point.
	const roots = files.slice(files.indexOf("\n# Root's side: folders it holds.\n"), files.indexOf("\n# The account's side: its own rights, its own Desktop folder.\n"));
	assert.ok(roots.length > 5000);
	for (const gone of [/os\.l?stat\(/, /os\.access\(/, /os\.path\.(?:exists|lexists|isdir|isfile|islink|realpath|abspath)\(/, /shutil\.(?:copy|copy2|copyfile|copytree|rmtree|move)\(/, /os\.(?:rename|replace|unlink|remove|rmdir|symlink|link|chown|chmod|lchown|makedirs)\(/])
		assert.doesNotMatch(roots, gone);
	assert.deepEqual([...new Set([...roots.matchAll(/os\.path\.(\w+)\(/g)].map((match) => match[1]))].toSorted(), ["ismount", "join", "normpath"]);
	assert.deepEqual(
		[...roots.matchAll(/os\.(?:readlink|mkdir|listdir|getxattr|fchmod)\(([^\n]*)/g)].map((match) => match[1]),
		['fd, "system.posix_acl_access")', "name, 0o755, dir_fd=self.fd)", "fd)):", '"", dir_fd=hold)', "taken, 0o644)"],
	);
	// The account's side: the account's user, group and other groups, no right kept or gained, a new environment, a
	// session of its own, no descriptor but its three; and it refuses to run as root.
	assert.match(
		files,
		/\n\treturn \["\/usr\/bin\/setpriv", f"--reuid=\{ACCOUNT\}", f"--regid=\{ACCOUNT\}", "--init-groups", "--inh-caps=-all", "--no-new-privs",\n\t\t"--reset-env", "--", "\/usr\/bin\/python3", "-I", SELF, "account", \*words\]/,
	);
	// Root's wait for it has an end (the account can stop its own process, and `desktop` holds the desktop's lock).
	assert.match(files, /\nPATIENCE = \{"place": 30, "save": 30, "tidy": 30, "copy": 900, "take": 900\}\n/);
	// What the account makes in steps lies under a name of its own until it is whole, and root has the account take it
	// away when the work did not end well, whatever ended it (review r1 F1 of #1712). The taking away is not ended by
	// a stop asked of root's side (review r4 F1).
	assert.match(files, /\nSTAGE = "\.qorpera-desktop-copy\."\n/);
	assert.match(
		files,
		/\n\tmark = secrets\.token_hex\(8\)\n\ttry:\n\t\tdone = as_account\(work, \*words, mark, feed=feed\)\n\texcept BaseException:\n\t\tas_account\("tidy", mark, \*beside, heed=False\)\n\t\traise\n\tif done\[0\] != 0:\n\t\tas_account\("tidy", mark, \*beside, heed=False\)\n\treturn done\n/,
	);
	assert.deepEqual(
		[...files.matchAll(/(?:staged|as_account)\("(\w+)"/g)].map((match) => `${match[0].split("(")[0]} ${match[1]}`),
		["as_account tidy", "as_account tidy", "staged take", "staged copy", "as_account place", "staged save"],
	);

	// A signal that asks root's side to stop runs no code of it, ever (reviews r3 and r4 of #1712 each found a window
	// between a handler that raised and the bookkeeping around it; there is no handler any more). The three signals are
	// held back from the first statement of root's side on; the kernel keeps one that arrives waiting, however many
	// arrive. Root's side looks for one at three statements of `as_account` (before it starts the account's side, at
	// every tick while it waits for it, after it has collected it) and stops for one at ONE statement, its last.
	assert.match(files, /\nSTOPS = \(signal\.SIGTERM, signal\.SIGHUP, signal\.SIGINT\)\n/);
	assert.match(files, /\nHEEDED = frozenset\(\)\nSTARTED_WITH = frozenset\(\)\n/);
	assert.match(files, /\nTICK = 0\.05\n/);
	// Which of the three it heeds is decided once, from what root's side was started with (review r5 F1 of #1712): a
	// signal its caller ignores (`nohup desktop open ...`) or holds back itself is neither held back here nor read,
	// and is at the end what it was at the start. Held back, even an ignored signal would wait and be read as a stop.
	assert.match(
		files,
		/\ndef heed_stops\(\):\n\t"""[^\n]*"""\n\tglobal HEEDED, STARTED_WITH\n\tSTARTED_WITH = frozenset\(signal\.pthread_sigmask\(signal\.SIG_BLOCK, \(\)\)\)\n\tHEEDED = frozenset\(number for number in STOPS if signal\.getsignal\(number\) is not signal\.SIG_IGN and number not in STARTED_WITH\)\n\tsignal\.pthread_sigmask\(signal\.SIG_BLOCK, HEEDED\)\n/,
	);
	assert.equal(files.match(/\b(?:HEEDED|STARTED_WITH) = /g).length, 4, "decided in one place");
	assert.match(files, /\n\tif os\.geteuid\(\) != 0:\n\t\traise Stop\("desktop-files runs as root, from `desktop`"\)\n\theed_stops\(\)\n\tmatch words:\n/);
	assert.match(files, /\ndef stop_asked\(\):\n\t"""[^\n]*"""\n\treturn min\(signal\.sigpending\(\) & HEEDED, default=0\)\n/);
	const lines = files.split("\n").filter((line) => !line.trimStart().startsWith("#"));
	assert.deepEqual(
		lines.filter((line) => /stop_asked\(\)|\bleave\(/.test(line) && !line.includes('"""')).map((line) => line.trim()),
		["def stop_asked():", "def leave(number):", "if heed and stop_asked():", "if heed and stop_asked():", "if heed and stop_asked():", "if stop_asked():", "leave(stop_asked())"],
	);
	// No handler is installed and nothing waits for a signal: the only calls about signals are the deciding and
	// holding back at the start, the look, the leaving (the heeded signal's own default again, then let through), and
	// the giving of what root's side was started with to the account's processes. (The account's group is ended with
	// SIGKILL, which nothing ignores or holds back: pinned below.)
	assert.deepEqual(
		lines.filter((line) => /\bsignal\.(?!SIG[A-Z_]+\b)\w+\(/.test(line)).map((line) => line.trim()),
		[
			"STARTED_WITH = frozenset(signal.pthread_sigmask(signal.SIG_BLOCK, ()))",
			"HEEDED = frozenset(number for number in STOPS if signal.getsignal(number) is not signal.SIG_IGN and number not in STARTED_WITH)",
			"signal.pthread_sigmask(signal.SIG_BLOCK, HEEDED)",
			"return min(signal.sigpending() & HEEDED, default=0)",
			"signal.signal(number, signal.SIG_DFL)",
			"signal.pthread_sigmask(signal.SIG_UNBLOCK, {number})",
			"preexec_fn=lambda: signal.pthread_sigmask(signal.SIG_SETMASK, STARTED_WITH),",
		],
	);
	for (const gone of [/\bimport threading\b/, /KeyboardInterrupt/, /UNDER_WAY|NOTED/, /set_wakeup_fd|sigwait|sigtimedwait|siginterrupt/, /sys\.exit\(128/]) assert.doesNotMatch(files, gone);
	// It leaves BY the signal, as its last statement, whatever its work came to.
	assert.match(
		files,
		/\n\tsys\.stdout\.flush\(\)\n\tsys\.stderr\.flush\(\)\n\tsignal\.signal\(number, signal\.SIG_DFL\)\n\tsignal\.pthread_sigmask\(signal\.SIG_UNBLOCK, \{number\}\)\n\tos\._exit\(128 \+ number\)\n/,
	);
	assert.ok(
		files.endsWith(
			'if __name__ == "__main__":\n\tcode = 0\n\ttry:\n\t\tmain(sys.argv[1:])\n\texcept Stop as stop:\n\t\tprint(stop, file=sys.stderr)\n\t\tcode = stop.code\n\texcept OSError as error:\n\t\tprint(f"desktop-files: {error}", file=sys.stderr)\n\t\tcode = 1\n\texcept Stopped:\n\t\tcode = 1\n\t# The one place where root\'s side stops for a signal: here, with its work done or given up and nothing left of it.\n\tif stop_asked():\n\t\tleave(stop_asked())\n\tsys.exit(code)\n',
		),
	);

	// The whole of a piece of the account's work, pinned. Root's side is one thread and never waits blindly: it waits
	// a tick at a time, on a descriptor that says the account's side has ended (before it is collected), and looks
	// between ticks. However the side ends, all of its group that is left is ended, the side is collected, and what it
	// left behind is collected too (root's side is its subreaper), before anything else (review r2 F1: its `cp`, when
	// another ended the side itself, would else write after the cleanup). The group is only signalled before the
	// side is collected, so its number is still its own.
	const whole = files.slice(files.indexOf("\ndef as_account(*words, feed=None, heed=True):\n"), files.indexOf("\ndef end_group(process):\n"));
	const steps = whole
		.split("\n")
		.filter((line) => line.trim() && !line.trimStart().startsWith("#"))
		.join("\n");
	assert.equal(
		steps.slice(steps.indexOf("\tif heed and stop_asked():\n")),
		[
			"\tif heed and stop_asked():",
			"\t\traise Stopped()",
			"\tctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0)",
			'\tout, err = os.memfd_create("answer"), os.memfd_create("complaint")',
			"\treads, writes = os.pipe() if feed else (None, None)",
			"\tprocess = ended = fed = failure = code = None",
			"\timpatient = []",
			"\tdeadline = time.monotonic() + PATIENCE[words[0]]",
			"\tdef look():",
			"\t\tif not impatient and time.monotonic() >= deadline:",
			"\t\t\timpatient.append(True)",
			"\t\t\tend_group(process)",
			"\t\tif heed and stop_asked():",
			"\t\t\tend_group(process)",
			"\ttry:",
			"\t\ttry:",
			"\t\t\tprocess = subprocess.Popen(",
			"\t\t\t\taccount_command(words),",
			"\t\t\t\tstdin=reads if feed else subprocess.DEVNULL,",
			"\t\t\t\tstdout=out,",
			"\t\t\t\tstderr=err,",
			"\t\t\t\tclose_fds=True,",
			"\t\t\t\tstart_new_session=True,",
			'\t\t\t\tcwd="/",',
			"\t\t\t\tpreexec_fn=lambda: signal.pthread_sigmask(signal.SIG_SETMASK, STARTED_WITH),",
			"\t\t\t)",
			"\t\t\tended = os.pidfd_open(process.pid)",
			"\t\t\tif feed:",
			"\t\t\t\tos.close(reads)",
			"\t\t\t\treads = None",
			"\t\t\t\tos.set_blocking(writes, False)",
			"\t\t\t\ttry:",
			"\t\t\t\t\tfed = feed(Pipe(writes, ended, look))",
			"\t\t\t\texcept BrokenPipeError:",
			"\t\t\t\t\tpass",
			"\t\t\t\texcept Exception as error:",
			"\t\t\t\t\tfailure = error",
			"\t\t\t\tos.close(writes)",
			"\t\t\t\twrites = None",
			"\t\t\twhile not select.select([ended], [], [], TICK)[0]:",
			"\t\t\t\tlook()",
			"\t\tfinally:",
			"\t\t\tfor fd in (reads, writes, ended):",
			"\t\t\t\tif fd is not None:",
			"\t\t\t\t\tos.close(fd)",
			"\t\t\tif process is not None:",
			"\t\t\t\tend_group(process)",
			"\t\t\t\tcode = process.wait()",
			"\t\t\t\twhile True:",
			"\t\t\t\t\ttry:",
			"\t\t\t\t\t\tos.waitpid(-process.pid, 0)",
			"\t\t\t\t\texcept ChildProcessError:",
			"\t\t\t\t\t\tbreak",
			"\t\tif heed and stop_asked():",
			"\t\t\traise Stopped()",
			"\t\tif failure:",
			"\t\t\traise failure",
			"\t\tif impatient:",
			'\t\t\treturn 1, "", f"the desktop\'s user did not finish within {PATIENCE[words[0]]} seconds, and was stopped", fed',
			"\t\tif code < 0:",
			'\t\t\treturn 1, "", f"the desktop\'s user\'s side was ended before it finished (signal {-code})", fed',
			"\t\tsaid = []",
			"\t\tfor fd in (out, err):",
			"\t\t\tos.lseek(fd, 0, os.SEEK_SET)",
			'\t\t\tsaid.append(os.read(fd, 65536).decode("utf-8", "replace"))',
			'\t\treturn code, said[0], "".join(c if c.isprintable() else " " for c in said[1][:1500]).strip(), fed',
			"\tfinally:",
			"\t\tos.close(out)",
			"\t\tos.close(err)",
		].join("\n"),
	);
	// Root's copy goes down a pipe it never waits on blindly either.
	assert.match(
		files,
		/\n\tdef write\(self, data\):\n\t\tleft = memoryview\(data\)\n\t\twhile left:\n\t\t\tended, takes, _ = select\.select\(\[self\.ended\], \[self\.fd\], \[\], TICK\)\n\t\t\tif ended:\n\t\t\t\traise BrokenPipeError\(errno\.EPIPE, "the account's side has ended"\)\n\t\t\tif takes:\n\t\t\t\ttry:\n\t\t\t\t\tleft = left\[os\.write\(self\.fd, left\) :\]\n\t\t\t\texcept BlockingIOError:\n\t\t\t\t\tpass\n\t\t\tif time\.monotonic\(\) - self\.looked >= TICK:\n\t\t\t\tself\.looked = time\.monotonic\(\)\n\t\t\t\tself\.look\(\)\n\t\treturn len\(data\)\n/,
	);
	assert.match(files, /\ndef end_group\(process\):\n\t"""[^\n]*"""\n\ttry:\n\t\tos\.killpg\(process\.pid, signal\.SIGKILL\)\n\texcept ProcessLookupError:\n\t\tpass\n/);
	assert.equal(files.match(/process\.wait\(\)/g).length, 1, "the account's side is collected in one place, after its group was ended");
	assert.match(files, /\n\tif os\.geteuid\(\) != 0:\n\t\traise Stop\("desktop-files runs as root, from `desktop`"\)\n/);
	for (const file of ["deploy/machine/desktop", "deploy/machine/desktop-dock-open"])
		assert.equal(spawnSync("bash", ["-n", join(repositoryRoot, file)], { encoding: "utf8" }).status, 0, file);

	// The program's own code, walked through its cases as one account (scripts/fixtures/machine-desktop-files.py says
	// what that leaves to the image build).
	if (process.platform !== "linux") return t.skip("the program is for a Linux machine (its ACLs, its descriptors)");
	if (process.getuid() === 0) return t.skip("as root nothing is refused for want of a right: these cases need a plain account");
	const base = await mkdtemp(join(tmpdir(), "qorpera-desktop-files-"));
	let cases;
	let said;
	try {
		const run = spawnSync(
			"python3",
			["-I", "-B", join(repositoryRoot, "scripts/fixtures/machine-desktop-files.py"), join(repositoryRoot, "deploy/machine/desktop-files"), base, "cases"],
			{ encoding: "utf8" },
		);
		assert.equal(run.status, 0, run.stderr);
		cases = JSON.parse(run.stdout);
		said = run.stderr;
	} finally {
		spawnSync("chmod", ["-R", "u+rwx", base]);
		await rm(base, { recursive: true, force: true });
	}
	// Root's side asked to stop, with its signals held back as its `main` holds them: one signal and a burst of ten
	// (of the three kinds), a second into a copy, as the account's side is started, and as root's side ends what a
	// side that is gone left (its `cp`, still to write); a second signal right after root's side ended the copy for
	// the first, with the copy's staging there (review r4 F1 of #1712); and signals as the taking away is started.
	// Each time root's side gives the work up, the taking away runs to its end, three seconds later the desk holds
	// nothing, and only then does root's side end, BY the signal (the lowest that waits). The account's side and its
	// child hold no signal back.
	// Last: root's side started with SIGHUP ignored, as under nohup (review r5 F1 of #1712). It holds back and reads
	// the other two only. A copy under a burst of ten SIGHUP runs to its end and nothing waits; a second copy in the
	// same run is stopped by a SIGTERM as any is, after the cleanup. The account's side ignores SIGHUP too, as any
	// program started under nohup does, and is ended all the same (the group's end is SIGKILL).
	for (const [when, signalled, gaveUp, waits] of [
		["copying", "SIGTERM", "stopped", [15]],
		["copying:10", "SIGHUP", "stopped", [1, 2, 15]],
		["spawn", "SIGTERM", "stopped", [15]],
		["spawn:10", "SIGHUP", "stopped", [1, 2, 15]],
		["end", "SIGTERM", "stopped", [15]],
		["end:10", "SIGHUP", "stopped", [1, 2, 15]],
		["twice", "SIGHUP", "stopped", [1, 15]],
		["tidy", "SIGTERM", "the desktop's user could not put /everyone/large on the desktop", [15]],
		["tidy:10", "SIGHUP", "the desktop's user could not put /everyone/large on the desktop", [1, 2, 15]],
		["ignored", "SIGTERM", "stopped", [15]],
	]) {
		const second = await mkdtemp(join(tmpdir(), "qorpera-desktop-files-"));
		try {
			const words = ["-I", "-B", join(repositoryRoot, "scripts/fixtures/machine-desktop-files.py"), join(repositoryRoot, "deploy/machine/desktop-files"), second, `stopped:${when}`];
			const ignored = when === "ignored";
			const run = ignored
				? spawnSync("sh", ["-c", 'trap "" HUP; exec python3 "$@"', "sh", ...words], { encoding: "utf8" })
				: spawnSync("python3", words, { encoding: "utf8" });
			assert.deepEqual([run.status, run.signal], [null, signalled], `${when}: ${run.stderr}`);
			const { "its child": child, "under SIGHUP": underHangups, ...told } = JSON.parse(run.stdout);
			const copied = { large: "folder 755", "large/a.bin": "file 644" };
			assert.deepEqual(
				told,
				{
					"gave up": gaveUp,
					calls: ["copy", "tidy"],
					desk: ignored ? copied : {},
					waits,
					"held back": ignored ? [2, 15] : [1, 2, 15],
					"the account's side": { "held back": [], "ignores SIGHUP": ignored },
				},
				when,
			);
			assert.deepEqual(
				underHangups,
				ignored ? { answer: ["folder", `${second}/desk/large`, "large"], calls: ["copy"], waits: [], "on the desk": Object.keys(copied) } : undefined,
				when,
			);
			// (The child's note is there when it was not ended before it could write it.)
			if (child) assert.equal(child, "SigBlk:\t0000000000000000", when);
			if (when === "copying") assert.equal(child, "SigBlk:\t0000000000000000");
		} finally {
			spawnSync("chmod", ["-R", "u+rwx", second]);
			await rm(second, { recursive: true, force: true });
		}
	}
	const { top, desk } = cases;
	const answer = (result) => {
		assert.ok("answer" in result, JSON.stringify(result));
		return result.answer;
	};

	// The walk: part by part from the top, `..` back up the way it came, and a folder made inside the one held.
	assert.deepEqual(answer(cases.walk.plain), ["/own/tree/inner", "b.txt"]);
	assert.deepEqual(answer(cases.walk.folder), ["/own/tree", null]);
	assert.deepEqual(answer(cases.walk.up), ["/own", "file.txt"]);
	assert.deepEqual(answer(cases.walk.top), ["/", null]);
	assert.equal(cases.walk.missing.missing, "/own/nope");
	assert.deepEqual([answer(cases.walk.made), cases.walk["made mode"]], [["/own/made/deeper", "x.png"], "755"]);
	assert.equal(cases.walk.relative.stop, "not a path: 'own/x'");
	// Never through a link (review r2 F1: the link in the middle), and only through folders that root alone can change:
	// its owner, the group's and everyone's right to write, and an ACL (review r2 F2).
	assert.equal(cases.walk["link in the middle"].refused, "/own/hop is a link, or not a folder");
	assert.equal(cases.walk.group.refused, "/own/group can be written by its group or by everyone");
	assert.equal(cases.walk.everyone.refused, "/everyone can be written by its group or by everyone");
	assert.equal(cases.walk["another owner"].refused, "/ belongs to another account than root");
	assert.ok(!cases.acl.unsupported, `this file system keeps no ACL to test with: ${cases.acl.unsupported}`);
	// An ACL that lets a named account write, cut down by its mask: the folder's rights read 755, and it is refused all
	// the same. One that lets it read only is no hindrance.
	assert.deepEqual([cases.acl.mode, cases.acl.write.refused], ["755", "/own/acl-write has an ACL that lets others write"]);
	assert.deepEqual(answer(cases.acl.read), ["/own/acl-read", "x"]);
	// What root reads is a file or a folder it opened itself: no link, nothing else.
	assert.deepEqual(
		Object.fromEntries(Object.entries(cases.source).map(([name, result]) => [name, result.answer ?? result.refused ?? result.missing])),
		{
			"file.txt": "file",
			tree: "folder",
			hop: "/own/hop is a link",
			"hop-file": "/own/hop-file is a link",
			"tree/pipe": "/own/tree/pipe is neither a file nor a folder",
			nope: "/own/nope",
		},
	);

	// What root sends: a link as a link, what is neither file, folder nor link left out, and `done` last.
	assert.deepEqual(cases.archive.members, [
		["copy", "folder"],
		["copy/a.txt", "file"],
		["copy/inner", "folder"],
		["copy/inner/b.txt", "file"],
		["copy/link", "link:../file.txt"],
		["done", "file"],
	]);
	assert.equal(cases.archive["left out"], 1);
	assert.match(said, /^1 of its entries are neither file, folder nor link: left out$/m);
	// A folder in it that others can write stops root in the middle: the name the half copy held is free again (the
	// account's own copy took it, pipe and all), and nothing of root's sending stayed.
	assert.deepEqual(cases.archive["a folder others can write"], { answer: ["folder", `${desk}/tree`, "tree"], calls: ["take", "tidy", "copy"] });
	assert.equal(cases.archive["on the desk"]["tree/pipe"], "other");
	assert.deepEqual(
		Object.keys(cases.archive["on the desk"]).filter((name) => !name.startsWith("tree")),
		[],
	);

	// `desktop open --copy` on a way of root's alone: root reads, the account's side puts it on the desktop under a
	// free name, with the rights it had; nothing is replaced.
	assert.deepEqual(cases.copy.file, { answer: ["file", `${desk}/file.txt`, "file.txt"], calls: ["take"] });
	assert.deepEqual(cases.copy["file again"], { answer: ["file", `${desk}/file-2.txt`, "file-2.txt"], calls: ["take"] });
	assert.deepEqual(cases.copy.folder, { answer: ["folder", `${desk}/tree`, "tree"], calls: ["take"] });
	assert.deepEqual(cases.copy.site, { answer: ["site", `${desk}/site`, "site"], calls: ["take"] });
	assert.deepEqual(cases.copy.missing, { answer: null, calls: [] });
	assert.deepEqual(cases.copy["whole disk"], { stop: "open a file or a folder, not the whole disk", code: 2, calls: [] });
	assert.deepEqual(cases.copy.desk, {
		"file.txt": "file 600",
		"file-2.txt": "file 600",
		site: "folder 755",
		"site/index.html": "file 644",
		tree: "folder 755",
		"tree/a.txt": "file 644",
		"tree/inner": "folder 750",
		"tree/inner/b.txt": "file 640",
		"tree/link": "link:../file.txt",
	});
	assert.equal(cases.copy["file text"], "a file of root\n");
	// What is not on such a way is the account's own work, start to end: root opens none of it. The review's link (as
	// the last name, and in the middle) leads to a file the account cannot read: nothing is copied.
	assert.deepEqual(cases.account.copy, { answer: ["file", `${desk}/notes.txt`, "notes.txt"], calls: ["copy"] });
	assert.deepEqual(cases.account["a link at the end"], {
		stop: "the desktop's user cannot read /own/hop-file, and root does not read it for the desktop: /own/hop-file is a link. Root copies for the desktop only what lies on a way of folders that root alone can change, with no link on it (under /root, say).",
		code: 1,
		calls: ["copy", "tidy"],
	});
	assert.match(cases.account["a link in the middle"].stop, /^the desktop's user cannot read \/own\/hop\/hidden\.txt, and root does not read it for the desktop: \/own\/hop is a link, or not a folder\. /);
	assert.deepEqual(cases.account["a link in the middle"].calls, ["copy", "tidy"]);
	// A link on the desktop: a taken name gets a number, the same link is used again, and what the account cannot read
	// gets no link.
	assert.deepEqual(cases.account.place, { answer: ["site", `${top}/everyone/site`, "site-2"], calls: ["place"] });
	assert.deepEqual(cases.account["place again"], cases.account.place);
	assert.deepEqual(cases.account["place cannot read"], { stop: "the desktop's user cannot read /own/elsewhere/hidden.txt: open it with --copy", code: 1, calls: ["place"] });
	for (const missing of ["place missing", "place missing where root alone writes", "address"]) assert.deepEqual(cases.account[missing], { answer: null, calls: ["place"] });
	assert.equal(cases.account.desk["site-2"], `link:${top}/everyone/site`);
	assert.deepEqual(
		Object.keys(cases.account.desk).filter((name) => !(name in cases.copy.desk)).toSorted(),
		["notes.txt", "site-2"],
	);
	// A copy that did not come whole is not kept, whatever rights its folders came with.
	assert.deepEqual(cases.take["not whole"], [1, "half could not be copied to the desktop: it did not come whole", true]);
	assert.deepEqual(cases.take["bad name"], [1, 1]);
	// Nor is one that was cut off (review r1 F1 of #1712): at root's patience with a part of it written, with all of
	// it written and no name yet, by the account's process being ended by another, by a file it could not read half
	// way. Each time the account takes away what was on its way, the desk gains no name, hidden ones included, and
	// the next copy gets the plain name, not a numbered one.
	const stopped = "the desktop's user did not finish within 1 seconds, and was stopped";
	assert.deepEqual(cases.cut["a copy root sends, partly written, at root's patience"], { stop: stopped, code: 1, calls: ["take", "tidy"], "new on the desk": [] });
	assert.deepEqual(cases.cut["a copy the account makes, at root's patience"], { stop: stopped, code: 1, calls: ["copy", "tidy"], "new on the desk": [] });
	assert.deepEqual(cases.cut["a copy the account makes, its process ended by another"], {
		stop: "the desktop's user's side was ended before it finished (signal 9)",
		code: 1,
		calls: ["copy", "tidy"],
		"new on the desk": [],
	});
	// The side gone while its `cp` is still to write (review r2 F1 of #1712): ended by another, ended by its own error,
	// ended at root's patience. Three seconds later (the `cp` would have written after two) the desk has gained nothing.
	assert.deepEqual(cases.cut["a copy whose side another ends while its cp is still to write"], {
		stop: "the desktop's user's side was ended before it finished (signal 9)",
		code: 1,
		calls: ["copy", "tidy"],
		"new on the desk": [],
	});
	assert.deepEqual(
		[cases.cut["a copy whose side ends itself while its cp is still to write"].calls, cases.cut["a copy whose side ends itself while its cp is still to write"]["new on the desk"]],
		[["copy", "tidy"], []],
	);
	assert.deepEqual(cases.cut["a copy at root's patience while its cp is still to write"], { stop: stopped, code: 1, calls: ["copy", "tidy"], "new on the desk": [] });
	assert.match(cases.cut["a copy that fails half way"].stop, /^the desktop's user cannot read \/everyone\/half, and root does not read it for the desktop: \/everyone can be written by its group or by everyone\. /);
	assert.deepEqual([cases.cut["a copy that fails half way"].calls, cases.cut["a copy that fails half way"]["new on the desk"]], [["copy", "tidy"], []]);
	assert.deepEqual(cases.cut["a copy after those"], { answer: ["folder", `${desk}/large`, "large"], calls: ["copy"], "new on the desk": ["large", "large/a.bin"] });
	// A link is made in one step: cut off after it, it is there whole, and the next press for it uses it again.
	assert.deepEqual(cases.cut["a link, after it was made"], { stop: stopped, code: 1, calls: ["place"], "new on the desk": ["large-2"] });
	assert.deepEqual(cases.cut["the link again"], { answer: ["folder", `${top}/everyone/large`, "large-2"], calls: ["place"], "new on the desk": [] });
	// A picture the account saves is written beside its place and put there when whole: cut off before that, no
	// picture appears, one that was there stays as it was, and nothing is left beside.
	for (const picture of ["a picture, written and not yet in its place", "a picture over one that was there"]) {
		assert.match(cases.cut[picture].stop, /^no picture saved at \/everyone\/[a-z/]+\.png: \/everyone can be written by its group or by everyone, so root does not write there, and the desktop's user could not either \(the desktop's user did not finish within 1 seconds, and was stopped\)\. /);
		assert.deepEqual(cases.cut[picture].calls, ["save", "tidy"]);
	}
	assert.deepEqual(cases.cut.pictures, [[], "the picture that was there", []]);

	// `desktop shot`: on a way of root's alone root writes inside the folder it holds, making the folders; never
	// through a link; elsewhere the account's side saves, and root writes nothing.
	assert.deepEqual(cases.save.own, { answer: null, calls: [] });
	assert.deepEqual(cases.save["own again"], { answer: null, calls: [] });
	assert.deepEqual(cases.save["a link"], { stop: "no picture saved at /own/link.png: /own/link.png is a link", code: 1, calls: [] });
	assert.deepEqual(cases.save["a folder"], { stop: "no picture saved at /own/tree/: it is a folder", code: 1, calls: [] });
	assert.equal(cases.save.company.code, 4);
	assert.match(cases.save.company.stop, /^this machine has no company folder at \/company, /);
	assert.deepEqual(cases.save.elsewhere, { answer: null, calls: ["save"] });
	assert.deepEqual(cases.save["elsewhere, a link"], { answer: null, calls: ["save"] });
	assert.deepEqual(cases.save.written, [true, "755", "a file of root\n", true]);

	// An account's side that does not answer is ended, and the command with it.
	assert.deepEqual(cases.patience, { stop: "the desktop's user did not finish within 1 seconds, and was stopped", code: 1, calls: [] });

	// The account's answer is checked before root goes by it.
	assert.deepEqual(answer(cases.answers.good), ["site", "/home/desktop/Desktop/a b", "a b"]);
	for (const bad of ["kind", "relative", "a name with a slash", "more lines"]) assert.equal(cases.answers[bad].stop, "the desktop's user gave no answer that can be used", bad);
	assert.equal(cases.answers["a control character"].stop, "target has a name with a character that cannot be shown: not opened");
	assert.deepEqual([cases.answers.failed.stop, cases.answers["whole disk"].code], ["it said why", 2]);
	// A name that is taken gets a number: before a file's ending, after a folder's name.
	assert.deepEqual(cases.names, {
		site: ["site", "site-2", "site-3"],
		"notes.txt": ["notes.txt", "notes-2.txt", "notes-3.txt"],
		".bashrc": [".bashrc", ".bashrc-2", ".bashrc-3"],
		"a.tar.gz": ["a.tar.gz", "a.tar-2.gz", "a.tar-3.gz"],
		"x.": ["x.", "x-2.", "x-3."],
		"v1.2": ["v1.2", "v1.2-2", "v1.2-3"],
	});

	// The image build proves, with the two real accounts and a file only root can read, what one account cannot: the
	// review's two cases, the races in the account's Desktop folder, and that what an agent names is still copied.
	for (const line of [
		"\tfiles=/opt/qorpera-machine/desktop-files\n",
		'\tleaked() { grep -rqs -- "$marker" /home/desktop /run/qorpera-desktop/session /tmp/qorpera-links /srv/qorpera-links; }\n',
		'\troots_own() { [[ $(ls -A "$mine/folder") == keep && -z $(find "$mine" /etc/qorpera-machine ! -user root) ]] && untouched; }\n',
		'\tln -s /home/desktop/input "$mine/input" && ln -s /home/desktop/input /srv/qorpera-links/input && ln -s /home/desktop/way "$mine/way"\n',
		'\tfor target in "$mine/input" /srv/qorpera-links/input /home/desktop/input "$mine/way/file.txt" /home/desktop/way/file.txt; do\n',
		'\t\tif desktop open "$target" --copy >/dev/null 2>&1 || desktop open "$target" >/dev/null 2>&1; then\n',
		'\tswapping /home/desktop "echo mine >input.new; mv -f input.new input; ln -sfn $secret input"\n',
		'\tfor _ in $(seq 1 25); do "$files" open --copy -- /srv/qorpera-links/input >/dev/null 2>&1 || true; done\n',
		'\trunuser -u desktop -- ln -s "$mine/folder" /tmp/qorpera-links/capture\n',
		'\trunuser -u desktop -- ln -s "$secret" /tmp/qorpera-links/frame.png\n',
		"\tif desktop shot /tmp/qorpera-links/capture/frame.png >/dev/null 2>&1; then\n",
		"\tdesktop shot /tmp/qorpera-links/frame.png >/dev/null 2>&1 || true\n\t[[ ! -L /tmp/qorpera-links/frame.png ]] && untouched ||\n",
		"\tdesktop shot /srv/qorpera-links/group/planted.png >/dev/null 2>&1 || true\n\t[[ ! -L /srv/qorpera-links/group/planted.png ]] && untouched ||\n",
		'\tswapping /tmp/qorpera-links "rm -rf capture; mkdir capture; rm -rf capture; ln -s $mine/folder capture"\n',
		"\tfor _ in $(seq 1 25); do desktop shot /tmp/qorpera-links/capture/frame.png >/dev/null 2>&1 || true; done\n",
		'\tdesktop shot "$mine/pictures/new/a.png" | grep -q " 1600 x 1000$" &&\n',
		"\tchgrp desktop /srv/qorpera-links/group && chmod 0775 /srv/qorpera-links/group\n",
		'\t[[ $refused == *"/srv/qorpera-links/acl has an ACL that lets others write"* && ! -e /srv/qorpera-links/acl/a.png ]] ||\n',
		'\trunuser -u desktop -- sh -c "rm -rf /home/desktop/Desktop && ln -s /etc/qorpera-machine /home/desktop/Desktop"\n',
		'\tfor words in "/tmp/site-links" "/tmp/site-links --copy" "$mine/agent.txt --copy"; do\n',
		'\tswapping /home/desktop/Desktop "for name in site-links site-links-2 site-links-3 agent.txt agent-2.txt tree tree-2; do ln -sfn $mine/folder \\$name 2>/dev/null; rm -rf \\$name; ln -sfn $secret \\$name 2>/dev/null; rm -rf \\$name; done"\n',
		'\t\tfor words in "-- /tmp/site-links" "--copy -- /tmp/site-links" "--copy -- $mine/agent.txt" "--copy -- $mine/tree"; do\n',
		'\tdesktop open "$mine/agent.txt" --copy | grep -q "(on the desktop as agent.txt)$" && "$files" open --copy -- "$mine/tree" >/dev/null\n',
		'\t\t$(readlink /home/desktop/Desktop/tree/to-the-file) == "$secret" && -z $(find /home/desktop/Desktop ! -user desktop) ]] ||\n',
		'\tif "$files" open --copy -- "$mine/tree" >/dev/null 2>&1; then echo "root read a folder that others can write, for the desktop account" >&2; exit 1; fi\n',
		'\t"$files" open --copy -- "$mine/large" >/dev/null 2>&1 &\n',
		'\tpkill -KILL -u desktop -f "desktop-files account take" || true\n',
		'\t[[ ! -e /home/desktop/Desktop/large ]] || diff -r "$mine/large" /home/desktop/Desktop/large >/dev/null ||\n',
		'\t[[ -z $(find /home/desktop/Desktop -maxdepth 1 -name ".qorpera-desktop-copy.*") ]] ||\n',
		'\t"$files" open --copy -- /tmp/large-links >/dev/null 2>&1 &\n\tfor _ in $(seq 1 500); do pkill -STOP -u desktop -x cp && break; sleep 0.01; done\n',
		'\tpkill -KILL -u desktop -f "desktop-files account copy" || true\n\twait || true\n\tleft=$(pgrep -u desktop -x cp || true)\n\tpkill -CONT -u desktop -x cp || true\n',
		'\t[[ -z $left ]] || { echo "the cp of a copy whose side was ended was still there when root had the copy taken away" >&2; exit 1; }\n',
		'\tblocked=$(awk "/^SigBlk:/ { print \\$2 }" "/proc/$(pgrep -u desktop -x cp | head -1)/status" 2>/dev/null || true)\n',
		'\t[[ -z $blocked || $blocked == 0000000000000000 ]] || { echo "the cp of the desktop account holds signals back: $blocked" >&2; exit 1; }\n',
		'\tkill -TERM "$asked" && kill -HUP "$asked" || true\n\tstatus=0\n\twait "$asked" || status=$?\n\t[[ $status == 129 || $status == 143 || $status == 0 ]] ||',
		'\t[[ -z $(pgrep -u desktop -f "desktop-files account" || true) && -z $(pgrep -u desktop -x cp || true) ]] ||\n',
		'\t(trap "" HUP; exec "$files" open --copy -- /tmp/large-links >/dev/null 2>&1) &\n',
		'\tfor _ in $(seq 1 10); do kill -HUP "$asked" 2>/dev/null || true; done\n',
		'\t[[ $status == 0 ]] && diff -r /tmp/large-links /home/desktop/Desktop/large-links >/dev/null ||\n',
		'\tif leaked; then echo "bytes of a file only root can read are in the desktop account folders" >&2; exit 1; fi\n',
	])
		assert.ok(imageScript.includes(line), line);
});

test("a press on the dock can steer nothing but which of three programs starts (review r3 F1 of #1704)", () => {
	// The finding: the broker ran `desktop open chrome://newtab/` from the request folder, which the desktop's account
	// may put any name into. With a folder `chrome:/newtab` planted there, `desktop open` took the address for that
	// folder and did its work for a file: with the account's Desktop folder made a link to a folder of root's (/etc),
	// root put a link into that folder, under a name the account chose (measured on the candidate before the fix; the
	// folder's owner stayed root's on this image). The fix is not a better look at the address: no launch of the dock
	// passes through code that looks a word up as a file or works in the account's Desktop folder.
	const opener = read("deploy/machine/desktop-dock-open");
	const command = read("deploy/machine/desktop");
	const unit = read("deploy/machine/qorpera-machine-desktop-dock.service");
	const lines = (text) =>
		text
			.split("\n")
			.filter((line) => !line.trimStart().startsWith("#"))
			.join("\n");

	// The broker never works in the request folder: the unit starts it in `/`, it goes there itself, and it sets its own
	// environment before anything else (nothing of PATH, HOME, XDG or the locale is taken from its caller).
	assert.match(unit, /\n\[Service\]\n(?:[^\n]*\n)*WorkingDirectory=\/\n(?:[^\n]*\n)*ExecStart=\/opt\/qorpera-machine\/desktop-dock-open\n/);
	const broker = lines(opener);
	assert.ok(
		broker.startsWith(
			'if [[ ${QORPERA_DOCK_ENVIRONMENT:-} != set ]]; then\n\texec /usr/bin/env -i QORPERA_DOCK_ENVIRONMENT=set PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \\\n\t\tHOME=/root LANG=C.UTF-8 /bin/bash "${BASH_SOURCE[0]}"\nfi\nset -uo pipefail\ncd / || exit 1\n',
		),
		broker.slice(0, 300),
	);
	assert.deepEqual(broker.match(/\bcd [^\n]*/g), ["cd / || exit 1"]);
	// It takes from the folder only which of the three names are there (read without following or opening any), removes
	// names, and hands `desktop dock` one of its own three words. It looks at nothing else and starts nothing else.
	assert.match(broker, /\nasked=\$\(find "\$ASK" -mindepth 1 -maxdepth 1 \\\( -name browser -o -name files -o -name terminal \\\) -printf "%f\\n" 2>\/dev\/null\)\n/);
	assert.match(
		broker,
		/\nfor app in browser files terminal; do\n\t\[\[ \$'\\n'\$asked\$'\\n' == \*\$'\\n'\$app\$'\\n'\* \]\] \|\| continue\n\trm -rf -- "\$ASK\/\$app"\n\t"\$DESKTOP" dock "\$app" >\/dev\/null \|\| echo "the dock's \$app did not start" >&2\ndone\n/,
	);
	assert.match(broker, /\nfind "\$ASK" -mindepth 1 -maxdepth 1 ! -name browser ! -name files ! -name terminal -exec rm -rf -- \{\} \+\nexit 0\n$/);
	for (const gone of [/\$\(</, /\bcat\b/, /\bsource\b/, /\n\. /, /\[\[ -[a-zA-Z] /, /\brunuser\b/, /\bmountpoint\b/, /"\$DESKTOP" (?:open|run)\b/, /\bpwd\b/, /\/run\/qorpera-desktop\//])
		assert.doesNotMatch(broker, gone);
	assert.deepEqual([...new Set(broker.match(/"\$ASK[^"]*"/g))].toSorted(), ['"$ASK"', '"$ASK/$app"']);

	// `desktop dock`: every word its program gets is written in it; nothing is taken from the caller but which of the
	// three; it is under the desktop's lock like every launch, and it is no command of the help.
	const code = lines(command);
	assert.match(
		code,
		/\ndock\)\n\tneed\n\tfolder=\/home\/desktop\n\tif mountpoint -q \/company; then folder=\/company; fi\n\tcase \$\{1:-\} in\n\tbrowser\) browser chrome:\/\/newtab\/ ;;\n\tfiles\) launch \/usr\/bin\/thunar "\$folder" ;;\n\tterminal\) launch \/usr\/bin\/xfce4-terminal --working-directory="\$folder" ;;\n\t\*\) fail "desktop dock browser\|files\|terminal" 2 ;;\n\tesac\n\techo "started \$1"\n\t;;\n/,
	);
	assert.match(code, /\ncase \$command in\nstart \| stop \| open \| run \| dock\)\n\texec 9>\/run\/qorpera-desktop\.lock\n\tflock 9\n\t;;\nesac\n/);
	const help = command.slice(command.indexOf("usage() {"), command.indexOf("\nEOF\n"));
	assert.doesNotMatch(help, /desktop dock/);
	// What that entry reaches looks at nothing the account can shape as a path: the desktop's unit and display, root's
	// own notes, the mount point of the company folder. (`need`, `running`, `browser` and `launch` are pinned whole.)
	assert.match(code, /\nrunning\(\) \{ \[\[ \$\(systemctl is-active "\$UNIT" 2>\/dev\/null \|\| true\) == active \]\] && xdpyinfo >\/dev\/null 2>&1; \}\nneed\(\) \{\n\trunning \|\| fail "the desktop is not running: desktop start"\n\ttouch "\$RUN\/last-use"\n\}\n/);
	assert.match(
		code,
		/\nlaunch\(\) \{\n\tlocal extra=\(\)\n\t\[\[ -s \$RUN\/tz \]\] && extra\+=\(--setenv=TZ="\$\(<"\$RUN\/tz"\)"\)\n\t\[\[ -s \$RUN\/lang \]\] && extra\+=\(--setenv=LANGUAGE="\$\(<"\$RUN\/lang"\)"\)\n\tsystemd-run --quiet --collect --expand-environment=no --slice=qorpera-machine\.slice --uid=desktop --gid=desktop \\\n\t\t-p WorkingDirectory=\/home\/desktop -p Requisite="\$UNIT" -p BindsTo="\$UNIT" -p After="\$UNIT" \\\n\t\t--setenv=HOME=\/home\/desktop --setenv=DISPLAY=:1 --setenv=XDG_RUNTIME_DIR="\$SESSION" \\\n\t\t--setenv=DBUS_SESSION_BUS_ADDRESS="unix:path=\$SESSION\/bus" "\$\{extra\[@\]\}" -- "\$@"\n\}\n/,
	);
	assert.match(
		code,
		/\nbrowser\(\) \{\n\tlocal flags=\(--start-maximized --no-first-run --no-default-browser-check --password-store=basic --disable-infobars\n\t\t--enable-unsafe-swiftshader\)\n\t\[\[ -s \$RUN\/lang \]\] && flags\+=\(--lang="\$\(<"\$RUN\/lang"\)"\)\n\tlaunch "\$CHROME" "\$\{flags\[@\]\}" "\$@"\n\}\n/,
	);
	for (const file of ["deploy/machine/desktop", "deploy/machine/desktop-dock-open"])
		assert.equal(spawnSync("bash", ["-n", join(repositoryRoot, file)], { encoding: "utf8" }).status, 0, file);

	// The image build presses each icon while the account keeps planting: the address as a folder and as a link to a
	// folder it named, the shapes of the folders and programs root names, and programs named like the tools root runs,
	// with its Desktop folder a link to a folder of root's. Each program starts, no planted program runs, and the
	// folder of root's keeps its owner and rights and stays empty.
	for (const line of [
		"\tguarded=/etc/qorpera-dock-check\n",
		'\tmkdir "$guarded" && chmod 0755 "$guarded"\n',
		'\tcat >/tmp/qorpera-dock-planted/plant.sh <<"PLANT"\n',
		"cd /run/qorpera-desktop-dock || exit 1\n",
		"\tmkdir -p chrome: home/desktop company usr/bin usr/local/bin opt/qorpera-machine\n",
		'\tif [ "$1" = link ]; then ln -sfn /home/desktop/planted/a-name-the-account-chose chrome:/newtab; else mkdir -p chrome:/newtab; fi\n',
		"\tfor tool in desktop bash env find rm systemctl xdpyinfo flock touch mountpoint systemd-run usr/bin/thunar usr/bin/xfce4-terminal usr/local/bin/desktop; do\n",
		'\trunuser -u desktop -- sh -c "rm -rf /home/desktop/Desktop && ln -s $guarded /home/desktop/Desktop"\n',
		"\tfor shape in folder link; do\n\t\tfor app in browser files terminal; do\n",
		'\t\t\trunuser -u desktop -- sh /tmp/qorpera-dock-planted/plant.sh "$shape" &\n',
		'\t\t\trunuser -u desktop -- sh -c ": >/run/qorpera-desktop-dock/$app"\n',
		'\t\t\t[[ $(stat -c "%U:%G %a" "$guarded") == "root:root 755" && -z $(ls -A "$guarded") ]] ||\n',
		"\t\t\t[[ ! -e /tmp/qorpera-dock-planted/ran ]] ||\n",
		'\t\t\t[[ $started == yes ]] || { echo "a press on the dock $app icon started nothing beside planted names ($shape)" >&2; exit 1; }\n',
	])
		assert.ok(imageScript.includes(line), line);
});
