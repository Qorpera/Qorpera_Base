/**
 * Publish the packed shell installer to Qorpera/Qorpera_Base_Releases.
 *
 * The footgun this exists for: electron-builder writes the installer as
 * "Qorpera Base Setup <version>.exe" (spaces) but latest.yml's url field uses
 * the GitHub-provider name "Qorpera-Base-Setup-<version>.exe" (dashes).
 * Uploading the space-named file with `gh release upload` renames it with
 * DOTS ("Qorpera.Base.Setup...exe"), so electron-updater 404s on the dash
 * URL from latest.yml and auto-update silently breaks — shipped broken in
 * v0.15.0/v0.16.0, hotfixed by hand on v0.17.0.
 *
 * So: parse latest.yml (never hardcode names), copy the exe + blockmap to the
 * exact dash-form names the updater will request, verify the copy's sha512
 * against latest.yml, create the release with those assets, then read the
 * release back and assert every browser_download_url basename matches.
 *
 * Usage:
 *   node scripts/publish-shell-release.mjs --title "Qorpera Base 0.18.0 — …" \
 *     (--notes "…" | --notes-file notes.md) [--dry-run]
 *
 * Run after pack-shell.mjs; reads build/shell-dist. Requires an authed `gh`.
 */

import { copyFileSync, createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "build", "shell-dist");
const releasesRepo = "Qorpera/Qorpera_Base_Releases";

// --- CLI ---------------------------------------------------------------------

function argValue(flag) {
	const i = process.argv.indexOf(flag);
	if (i === -1) return undefined;
	const value = process.argv[i + 1];
	if (value === undefined || value.startsWith("--")) fail(`${flag} needs a value`);
	return value;
}

function fail(message) {
	console.error(`publish-shell-release: ${message}`);
	process.exit(1);
}

const title = argValue("--title");
const notes = argValue("--notes");
const notesFile = argValue("--notes-file");
const dryRun = process.argv.includes("--dry-run");

if (!title) fail("--title is required");
if (!notes && !notesFile) fail("one of --notes or --notes-file is required");
if (notes && notesFile) fail("--notes and --notes-file are mutually exclusive");
if (notesFile && !existsSync(notesFile)) fail(`notes file not found: ${notesFile}`);

// --- Parse latest.yml --------------------------------------------------------

const latestYmlPath = join(outDir, "latest.yml");
if (!existsSync(latestYmlPath)) fail(`${latestYmlPath} not found — run pack-shell.mjs first`);
const latestYml = readFileSync(latestYmlPath, "utf8");

// Minimal line-walk of electron-builder's latest.yml: top-level version plus
// the files list's url/sha512/size triples. A yaml dependency buys nothing here.
const version = latestYml.match(/^version:\s*(\S+)\s*$/m)?.[1];
if (!version) fail("could not parse version from latest.yml");

const fileEntries = [];
let inFiles = false;
for (const line of latestYml.split("\n")) {
	if (/^files:/.test(line)) {
		inFiles = true;
		continue;
	}
	if (inFiles && /^\S/.test(line)) inFiles = false;
	if (!inFiles) continue;
	const url = line.match(/^\s*-\s*url:\s*(\S+)\s*$/)?.[1];
	if (url) {
		fileEntries.push({ url });
		continue;
	}
	const current = fileEntries[fileEntries.length - 1];
	if (!current) continue;
	const sha512 = line.match(/^\s*sha512:\s*(\S+)\s*$/)?.[1];
	if (sha512) current.sha512 = sha512;
	const size = line.match(/^\s*size:\s*(\d+)\s*$/)?.[1];
	if (size) current.size = Number(size);
}
if (fileEntries.length === 0) fail("could not parse any files entries from latest.yml");

const shellPkg = JSON.parse(readFileSync(join(repoRoot, "packages", "shell", "package.json"), "utf8"));
const productVersion = shellPkg.productVersion ?? "0.1.0";
if (version !== productVersion) {
	fail(`latest.yml is for ${version} but packages/shell says ${productVersion} — stale build/shell-dist?`);
}

// --- Stage assets under their exact latest.yml names -------------------------

function sha512Base64(path) {
	return new Promise((resolvePromise, reject) => {
		const hash = createHash("sha512");
		createReadStream(path)
			.on("data", (chunk) => hash.update(chunk))
			.on("end", () => resolvePromise(hash.digest("base64")))
			.on("error", reject);
	});
}

// electron-builder's GitHub provider derives the url by replacing spaces with
// dashes, so invert that to find the built file instead of hardcoding names.
function locateSource(wantedName) {
	if (existsSync(join(outDir, wantedName))) return join(outDir, wantedName);
	const match = readdirSync(outDir).find((f) => f.replace(/ /g, "-") === wantedName);
	return match ? join(outDir, match) : undefined;
}

const assets = [latestYmlPath];
for (const entry of fileEntries) {
	for (const wanted of [entry.url, `${entry.url}.blockmap`]) {
		const source = locateSource(wanted);
		if (!source) fail(`no file in ${outDir} matching ${wanted}`);
		const target = join(outDir, wanted);
		if (source !== target) {
			copyFileSync(source, target);
			console.log(`staged ${basename(source)} -> ${wanted}`);
		}
		assets.push(target);
	}
	if (entry.sha512) {
		const actual = await sha512Base64(join(outDir, entry.url));
		if (actual !== entry.sha512) {
			fail(`sha512 mismatch for ${entry.url}: latest.yml says ${entry.sha512}, file is ${actual}`);
		}
	}
	if (entry.size !== undefined && statSync(join(outDir, entry.url)).size !== entry.size) {
		fail(`size mismatch for ${entry.url} vs latest.yml`);
	}
	console.log(`verified ${entry.url} against latest.yml sha512/size`);
}

// --- Create the release and verify what GitHub actually named the assets -----

function gh(args) {
	const result = spawnSync("gh", args, { encoding: "utf8" });
	if (result.error) fail(`gh failed to spawn: ${result.error.message}`);
	if (result.status !== 0) fail(`gh ${args[0]} ${args[1] ?? ""} failed:\n${result.stderr || result.stdout}`);
	return result.stdout;
}

const tag = `v${version}`;
if (dryRun) {
	console.log(`dry run: would create ${tag} on ${releasesRepo} with assets:`);
	for (const asset of assets) console.log(`  ${basename(asset)}`);
	process.exit(0);
}

console.log(`creating ${tag} on ${releasesRepo}…`);
gh([
	"release",
	"create",
	tag,
	"--repo",
	releasesRepo,
	"--title",
	title,
	...(notesFile ? ["--notes-file", notesFile] : ["--notes", notes]),
	...assets,
]);

const uploaded = JSON.parse(gh(["release", "view", tag, "--repo", releasesRepo, "--json", "assets"])).assets;
const uploadedNames = new Set(uploaded.map((a) => a.name));
const problems = [];
for (const asset of assets) {
	const name = basename(asset);
	if (!uploadedNames.has(name)) {
		problems.push(`missing asset: ${name}`);
		continue;
	}
	const downloadUrl = uploaded.find((a) => a.name === name).url;
	if (!downloadUrl.endsWith(`/${name}`)) {
		problems.push(`asset ${name} has browser_download_url ${downloadUrl} — updater will 404`);
	}
}
if (problems.length > 0) {
	fail(`release ${tag} created but asset names are WRONG:\n  ${problems.join("\n  ")}\nfix with gh release upload --clobber before anyone updates`);
}
console.log(`release ${tag} published; all ${assets.length} asset names match latest.yml — auto-update path verified`);
