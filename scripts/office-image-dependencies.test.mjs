import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guest = join(repositoryRoot, "deploy/lxd-company-computer-guest");
const recipe = JSON.parse(readFileSync(join(guest, "office-image-dependencies.json"), "utf-8"));

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
	for (const [command, ...args] of recipe.toolbox) {
		assert.match(command, /^[a-z][a-z0-9]*$/);
		assert.ok(args.length === 1 && /^--?[a-z]+$/.test(args[0]), `${command} ${args.join(" ")}`);
	}
});
