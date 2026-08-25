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
 * Release coordination (see scripts/release-coordination.mjs): parallel agent
 * sessions must not race each other into back-to-back releases. Publishing
 * requires a clean checkout exactly at origin/master, atomically claims the
 * version via a `shell-v<version>` tag on the source repo, requires the
 * version to be newer than the latest published release, and blocks a cut
 * while a release younger than the cooling window exists.
 *
 * Usage:
 *   node scripts/publish-shell-release.mjs --title "Qorpera Base 0.18.0 — …" \
 *     (--notes "…" | --notes-file notes.md) [--dry-run]
 *     [--allow-unsynced]  # emergencies: skip the origin/master freshness guard
 *     [--allow-rapid]     # hotfix lane: ignore the release cooling window
 *
 * Run after pack-shell.mjs; reads build/shell-dist. Requires an authed `gh`.
 */

import { copyFileSync, createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	checkReleaseSpacing,
	checkSourceSynced,
	checkVersionMonotonic,
	claimDecision,
} from "./release-coordination.mjs";

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
const allowUnsynced = process.argv.includes("--allow-unsynced");
const allowRapid = process.argv.includes("--allow-rapid");
const macOnly = process.argv.includes("--mac-only");

if (!title) fail("--title is required");
if (!notes && !notesFile) fail("one of --notes or --notes-file is required");
if (notes && notesFile) fail("--notes and --notes-file are mutually exclusive");
if (notesFile && !existsSync(notesFile)) fail(`notes file not found: ${notesFile}`);

// --- Parse latest.yml (and latest-mac.yml when present) ----------------------

// Minimal line-walk of electron-builder's updater manifests: top-level version
// plus the files list's url/sha512/size triples. A yaml dependency buys
// nothing here.
function parseUpdaterManifest(path) {
	const text = readFileSync(path, "utf8");
	const version = text.match(/^version:\s*(\S+)\s*$/m)?.[1];
	if (!version) fail(`could not parse version from ${basename(path)}`);
	const entries = [];
	let inFiles = false;
	for (const line of text.split("\n")) {
		if (/^files:/.test(line)) {
			inFiles = true;
			continue;
		}
		if (inFiles && /^\S/.test(line)) inFiles = false;
		if (!inFiles) continue;
		const url = line.match(/^\s*-\s*url:\s*(\S+)\s*$/)?.[1];
		if (url) {
			entries.push({ url });
			continue;
		}
		const current = entries[entries.length - 1];
		if (!current) continue;
		const sha512 = line.match(/^\s*sha512:\s*(\S+)\s*$/)?.[1];
		if (sha512) current.sha512 = sha512;
		const size = line.match(/^\s*size:\s*(\d+)\s*$/)?.[1];
		if (size) current.size = Number(size);
	}
	if (entries.length === 0) fail(`could not parse any files entries from ${basename(path)}`);
	return { version, entries };
}

/* A release normally requires the Windows manifest so Windows auto-update
 * never silently loses its lane. --mac-only is the deliberate exception for
 * when no Windows build machine exists (the previous one was converted into
 * a Linux node, 2026-08-25): the release ships mac assets alone and Windows
 * clients stall on the previous version — visible and recoverable — until a
 * Windows pack ships again. */
const latestYmlPath = join(outDir, "latest.yml");
if (!macOnly && !existsSync(latestYmlPath)) fail(`${latestYmlPath} not found — run pack-shell.mjs first`);
if (macOnly && existsSync(latestYmlPath)) {
	fail("--mac-only was passed but latest.yml exists — drop the flag and publish the full release");
}
const windowsManifest = macOnly ? undefined : parseUpdaterManifest(latestYmlPath);
const fileEntries = windowsManifest?.entries ?? [];

// The mac manifest rides in the same outDir when a mac pack's artifacts have
// been dropped there (CI builds them; this machine cannot). Optional on
// purpose: a Windows-only cut must keep working, but when the mac files ARE
// present they are verified and published with the same rigour, under one
// release, so both updaters resolve the same version.
const latestMacYmlPath = join(outDir, "latest-mac.yml");
if (macOnly && !existsSync(latestMacYmlPath)) fail(`${latestMacYmlPath} not found — run pack-shell.mjs first`);
const macManifest = existsSync(latestMacYmlPath) ? parseUpdaterManifest(latestMacYmlPath) : undefined;
const version = windowsManifest?.version ?? macManifest?.version;
if (!version) fail("no updater manifest found in build/shell-dist");
if (windowsManifest && macManifest && macManifest.version !== version) {
	fail(`latest-mac.yml is for ${macManifest.version} but latest.yml is for ${version} — mixed-version release refused`);
}

const shellPkg = JSON.parse(readFileSync(join(repoRoot, "packages", "shell", "package.json"), "utf8"));
const productVersion = shellPkg.productVersion ?? "0.1.0";
if (version !== productVersion) {
	fail(`latest.yml is for ${version} but packages/shell says ${productVersion} — stale build/shell-dist?`);
}

// --- Release coordination (one cutter at a time) ------------------------------

function git(args) {
	const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
	if (result.error) fail(`git failed to spawn: ${result.error.message}`);
	return result;
}

function gitOk(args) {
	const result = git(args);
	if (result.status !== 0) fail(`git ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
	return result.stdout.trim();
}

gitOk(["fetch", "origin", "--quiet"]);
const synced = checkSourceSynced({
	head: gitOk(["rev-parse", "HEAD"]),
	originMaster: gitOk(["rev-parse", "origin/master"]),
	dirty: gitOk(["status", "--porcelain"]) !== "",
	allowUnsynced,
});
if (!synced.ok) fail(synced.reason);
if (synced.warning) console.warn(synced.warning);

// Latest published release (404 = first release ever, anything else is real).
let latestRelease;
{
	const result = spawnSync("gh", ["api", `repos/${releasesRepo}/releases/latest`], { encoding: "utf8" });
	if (result.error) fail(`gh failed to spawn: ${result.error.message}`);
	if (result.status === 0) {
		const parsed = JSON.parse(result.stdout);
		latestRelease = { tagName: parsed.tag_name, publishedAt: parsed.published_at };
	} else if (!/Not Found|HTTP 404/i.test(result.stderr + result.stdout)) {
		fail(`could not read the latest release from ${releasesRepo}:\n${result.stderr || result.stdout}`);
	}
}
const monotonic = checkVersionMonotonic(version, latestRelease?.tagName);
if (!monotonic.ok) fail(monotonic.reason);
const spacing = checkReleaseSpacing({
	publishedAtIso: latestRelease?.publishedAt,
	nowMs: Date.now(),
	allowRapid,
});
if (!spacing.ok) fail(spacing.reason);

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

const assets = [];
if (windowsManifest) assets.push(latestYmlPath);
if (macManifest) assets.push(latestMacYmlPath);

async function stageAndVerify(entry, manifestName) {
	// The dmg is for humans, not the updater; electron-builder does not
	// always emit a blockmap for it, and its absence breaks nothing.
	const blockmapOptional = entry.url.endsWith(".dmg");
	for (const wanted of [entry.url, `${entry.url}.blockmap`]) {
		const source = locateSource(wanted);
		if (!source) {
			if (wanted.endsWith(".blockmap") && blockmapOptional) continue;
			fail(`no file in ${outDir} matching ${wanted}`);
		}
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
			fail(`sha512 mismatch for ${entry.url}: ${manifestName} says ${entry.sha512}, file is ${actual}`);
		}
	}
	if (entry.size !== undefined && statSync(join(outDir, entry.url)).size !== entry.size) {
		fail(`size mismatch for ${entry.url} vs ${manifestName}`);
	}
	console.log(`verified ${entry.url} against ${manifestName} sha512/size`);
}

for (const entry of fileEntries) await stageAndVerify(entry, "latest.yml");
for (const entry of macManifest?.entries ?? []) await stageAndVerify(entry, "latest-mac.yml");

// --- Create the release and verify what GitHub actually named the assets -----

function gh(args) {
	const result = spawnSync("gh", args, { encoding: "utf8" });
	if (result.error) fail(`gh failed to spawn: ${result.error.message}`);
	if (result.status !== 0) fail(`gh ${args[0]} ${args[1] ?? ""} failed:\n${result.stderr || result.stdout}`);
	return result.stdout;
}

const tag = `v${version}`;
const claimTag = `shell-v${version}`;
if (dryRun) {
	console.log(`dry run: would claim ${claimTag} on the source repo, then create ${tag} on ${releasesRepo} with assets:`);
	for (const asset of assets) console.log(`  ${basename(asset)}`);
	process.exit(0);
}

// Claim the version on the SOURCE repo before the release exists. The remote
// tag push is atomic — exactly one session wins a version. Claimed after the
// asset checks (a local failure should not burn a version number) and before
// release creation (the claim is what serializes concurrent cutters).
{
	const head = gitOk(["rev-parse", "HEAD"]);
	const remoteRef = gitOk(["ls-remote", "origin", `refs/tags/${claimTag}`]);
	const decision = claimDecision({ remoteSha: remoteRef ? remoteRef.split(/\s/)[0] : undefined, head });
	if (decision.action === "conflict") fail(`${claimTag} ${decision.reason}`);
	if (decision.action === "ours") {
		console.log(`claim ${claimTag} already points at HEAD (our earlier attempt) — continuing`);
	} else {
		gitOk(["tag", "--force", claimTag, head]);
		const push = git(["push", "origin", claimTag]);
		if (push.status !== 0) {
			// Lost the race inside the ls-remote → push window: report it as the
			// coordination conflict it is, not a raw git error.
			const raced = gitOk(["ls-remote", "origin", `refs/tags/${claimTag}`]);
			const conflict = claimDecision({ remoteSha: raced ? raced.split(/\s/)[0] : undefined, head });
			if (conflict.action === "conflict") fail(`${claimTag} ${conflict.reason}`);
			fail(`could not push ${claimTag} to the source repo:\n${push.stderr || push.stdout}`);
		}
		console.log(`claimed ${claimTag} at ${head.slice(0, 9)} on the source repo`);
	}
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
