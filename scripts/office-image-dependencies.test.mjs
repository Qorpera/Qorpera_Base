import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guest = join(repositoryRoot, "deploy/lxd-company-computer-guest");
const recipePath = join(guest, "office-image-dependencies.json");
const recipe = JSON.parse(readFileSync(recipePath, "utf-8"));
const installer = readFileSync(join(guest, "install-office-image-dependencies.sh"), "utf-8");

// QORPERA-RUNTIME-CONTRACT.md, the 2026-10-14 amendment's item 7: what every computer's shell runs.
// Adding a tool needs no founder decision; dropping one of these does.
const CONTRACT_TOOLBOX = ["bash", "git", "node", "npm", "npx", "tsc", "tsx", "python3", "pip", "uv", "gcc", "make", "mise",
	"rg", "fd", "jq", "sqlite3", "curl", "zip", "unzip", "soffice"];

test("the office image recipe pins every download and names its base", () => {
	assert.deepEqual(Object.keys(recipe), ["schema", "base", "packages", "downloads", "npm", "toolbox"]);
	assert.equal(recipe.schema, "qorpera.office-image-dependencies/v1");
	assert.match(recipe.base.fingerprint, /^[0-9a-f]{64}$/);
	assert.equal(recipe.base.architecture, "x86_64");
	assert.deepEqual(recipe.downloads.map((download) => download.name), ["node", "chromium", "uv", "mise"]);
	for (const download of recipe.downloads) {
		assert.deepEqual(Object.keys(download), ["name", "version", "url", "sha256"]);
		assert.match(download.sha256, /^[0-9a-f]{64}$/);
		assert.ok(download.url.startsWith("https://") && download.url.includes(download.version), download.url);
	}
	for (const pkg of recipe.npm) assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
});

test("the image has Node.js 24 and the Chromium build its Playwright drives", () => {
	const node = recipe.downloads.find((download) => download.name === "node");
	assert.match(node.version, /^24\.\d+\.\d+$/);
	assert.equal(node.url, `https://nodejs.org/dist/v${node.version}/node-v${node.version}-linux-x64.tar.xz`);
	const browsers = JSON.parse(readFileSync(join(repositoryRoot, "node_modules/playwright-core/browsers.json"), "utf-8"));
	const chromium = recipe.downloads.find((download) => download.name === "chromium");
	assert.equal(
		chromium.version,
		browsers.browsers.find((browser) => browser.name === "chromium").browserVersion,
		"playwright-core moved: pin its Chrome for Testing build and that zip's sha256",
	);
});

test("apt installs each package once, and the toolbox covers the contract's list", () => {
	const packages = Object.values(recipe.packages).flat();
	assert.deepEqual(Object.keys(recipe.packages), ["office", "browser", "folder", "toolbox"]);
	assert.equal(new Set(packages).size, packages.length);
	for (const group of Object.values(recipe.packages)) assert.deepEqual(group, [...group].sort());
	for (const name of packages) assert.match(name, /^[a-z0-9][a-z0-9.+-]+$/);
	const commands = recipe.toolbox.map(([command]) => command);
	assert.equal(new Set(commands).size, commands.length);
	for (const command of CONTRACT_TOOLBOX) assert.ok(commands.includes(command), `${command} is missing from the toolbox`);
	// FUSE is root's: a computer's shell can mount nothing, and AppArmor's fusermount3 profile takes its output there.
	assert.ok(!commands.includes("fusermount3"));
	for (const [command, ...args] of recipe.toolbox) {
		assert.match(command, /^[a-z][a-z0-9]*$/);
		assert.ok(args.length === 1 && /^--?[a-z]+$/.test(args[0]), `${command} ${args.join(" ")}`);
	}
});

test("the in-guest installer reads the recipe the way the recipe is written", () => {
	const program = installer.match(/python3 - "\$recipe" "\$1" <<'EOF'\n([\s\S]*?)\nEOF\n/)[1];
	const query = (name) => execFileSync("python3", ["-", recipePath, name], { input: program, encoding: "utf8", timeout: 5000 }).trimEnd();
	const file = (download) => download.url.slice(download.url.lastIndexOf("/") + 1);
	assert.equal(query("sha256sums"), recipe.downloads.map((download) => `${download.sha256}  ${file(download)}`).join("\n"));
	assert.equal(query("packages"), Object.values(recipe.packages).flat().join("\n"));
	assert.equal(query("npm"), recipe.npm.map((pkg) => `${pkg.name}@${pkg.version}`).join("\n"));
	assert.equal(query("toolbox"), recipe.toolbox.map((check) => check.join(" ")).join("\n"));
	for (const download of recipe.downloads) {
		assert.equal(query(`${download.name}.file`), file(download));
		assert.equal(query(`${download.name}.version`), download.version);
	}
	assert.throws(() => execFileSync("python3", ["-", recipePath, "other"], { input: program, stdio: "pipe", timeout: 5000 }));
});

test("the in-guest installer stays offline and leaves swap off", () => {
	assert.match(installer, /sha256sum --check --strict/);
	assert.match(installer, /apt-get install --yes --no-install-recommends --no-download -o DPkg::Lock::Timeout=600 /);
	// --no-download refuses a deb named on the command line unless it already sits in apt's archive cache.
	assert.match(installer, /-o Dir::Cache::Archives="\$dir\/debs\/" -o DPkg::Options::=--force-confold "\$dir"\/debs\/\*\.deb/);
	assert.match(installer, /npm install --global --prefix \/usr --offline /);
	assert.match(installer, /systemctl mask swap\.target/);
	assert.match(installer, /wc -l <\/proc\/swaps\) == 1/);
	assert.match(installer, /out=\$\(fusermount3 --version 2>&1\)/);
	assert.doesNotMatch(installer, /\b(apt-get update|curl|wget)\b/);
});

test("the candidate builder copies every confinement key of the office unit and stays offline", () => {
	const builder = join(repositoryRoot, "scripts/build-office-image-candidate.sh");
	execFileSync("bash", ["-n", builder]);
	const source = readFileSync(builder, "utf-8");
	const keys = source.match(/grep -E '\^\(([A-Za-z|]+)\)='\)/)[1].split("|");
	const unit = readFileSync(join(guest, "qorpera-company-computer.service"), "utf-8").split("\n");
	const copied = unit.filter((line) => keys.includes(line.split("=", 1)[0]));
	assert.equal(Number(source.match(/\(\(\$\{#properties\[@\]\} == (\d+)\)\)/)[1]), copied.length * 2);
	for (const key of keys) assert.ok(copied.some((line) => line.startsWith(`${key}=`)), `${key} is not in the office unit`);
	for (const key of ["User", "NoNewPrivileges", "CapabilityBoundingSet", "MemoryMax", "TasksMax", "CPUQuota"])
		assert.ok(keys.includes(key), key);
	assert.match(source, /--vm --no-profiles /);
	assert.match(source, /fail "nested VM unexpectedly has a NIC"/);
	assert.match(source, /\[\[ \$\(hostname\) == qorpera-testvm-node01 \]\]/);
	// A command whose output descriptor AppArmor replaced exits 0 and prints nothing: such a denial fails the build.
	assert.match(source, /journalctl -o cat --no-pager --since "@\$since" \| \{ grep 'apparmor="DENIED"' \|\| true; \}/);
	assert.match(source, /! grep -q 'operation="file_inherit"' "\$work\/apparmor-denials" \|\|\n\tfail /);
});

test("the candidate carries the pinned folder program and leaves the folder's units stopped", () => {
	const source = readFileSync(join(repositoryRoot, "scripts/build-office-image-candidate.sh"), "utf-8");
	assert.match(source, /node scripts\/build-folder-program\.mjs --out "\$work\/qorpera-folder"/);
	assert.match(source, /package-company-computer\.mjs --out "\$push\/package" --folder-program "\$work\/qorpera-folder"/);
	for (const unit of ["helper.service", "helper.socket", "mount@.service"])
		assert.match(source, new RegExp(`qorpera-office-folder-${unit.replace(".", "\\.")} static`));
	assert.match(source, /sha256sum \/opt\/qorpera-folder\/qorpera-folder/);
});
