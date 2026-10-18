import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type PackReading, SaveChecks, type StoredForm, storedForm } from "../src/folder-service/git-objects.ts";
import { CARRIES, SecretRefusal, type SecretSet, UNCHECKED } from "../src/folder-service/secret-scan.ts";
import { looseObject, noSecrets, secretsOf } from "./folder-service-fixtures.ts";

/** The save check of what git stores (5j-5 (a)): a loose object inflated, a pack as git reads it, each in its scratch
 * repository, and what cannot be read whole refused as not checked. Packs are made and read by the node's own git. */

/** A test value, not a secret. */
const VALUE = "test-value-0001";
const GIT = "/usr/bin/git";
const CHECKED = "checked";

/** What checking `bytes` as `form` ends in, given in chunks of `chunk` as the staging gives them: "checked", or the
 * refusal's message. A check that fails is aborted, as the staging aborts it. */
async function outcome(
	checks: SaveChecks,
	bytes: Buffer,
	form: StoredForm,
	secrets: SecretSet = secretsOf(VALUE),
	chunk = 64 * 1024,
): Promise<string> {
	const check = checks.start(secrets, bytes.length, form);
	try {
		for (let at = 0; at < bytes.length; at += chunk) await check.push(bytes.subarray(at, at + chunk));
		await check.end();
		return CHECKED;
	} catch (error) {
		await check.abort();
		if (error instanceof SecretRefusal) return error.message;
		throw error;
	}
}

/** Runs the node's git in `dir`, with no configuration but its own. */
function git(dir: string, args: readonly string[], input?: string | Buffer): Buffer {
	const run = spawnSync(GIT, ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
		cwd: dir,
		input,
		env: { PATH: "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" },
		maxBuffer: 256 * 1024 ** 2,
	});
	if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr.toString()}`);
	return run.stdout;
}

/** A repository whose commits, in order, each write `files`. */
async function repository(root: string, name: string, commits: readonly Record<string, string>[], sha256 = false) {
	const dir = join(root, name);
	await mkdir(dir);
	git(dir, ["init", "-q", `--object-format=${sha256 ? "sha256" : "sha1"}`]);
	for (const [n, files] of commits.entries()) {
		for (const [path, text] of Object.entries(files)) await writeFile(join(dir, path), text);
		git(dir, ["add", "-A"]);
		git(dir, ["commit", "-q", "-m", `change ${n + 1}`]);
	}
	return dir;
}

/** The pack of what `revs` name, as `git pack-objects` writes it. */
function packOf(dir: string, revs = "HEAD\n", thin = false): Buffer {
	return git(dir, ["pack-objects", "--revs", "--stdout", "-q", ...(thin ? ["--thin"] : [])], revs);
}

/** The settings file of the delta pack: `v1` holds the value; `v2`, git's base for it, is longer and has the value's
 * ninth byte changed, so the value is whole only in `v1` rebuilt (its delta copies around the one byte it inserts). */
const LINES = Array.from({ length: 300 }, (_, i) => `setting_${i} = the value of setting number ${i}\n`);
const V1 = [...LINES.slice(0, 150), `key = ${VALUE}\n`, ...LINES.slice(150)].join("");
const V2 = [
	...LINES.slice(0, 150),
	`key = ${VALUE.slice(0, 8)}X${VALUE.slice(9)}\n`,
	...LINES.slice(150),
	...LINES.slice(0, 20).map((line) => `more_${line}`),
].join("");

describe("the stored form of a saved file", () => {
	it("goes by its name's shape alone, anywhere", () => {
		const sha1 = "0123456789abcdef0123456789abcdef01234567";
		const sha256 = `${sha1}${"89abcdef".repeat(3)}`;
		expect(storedForm(`objects/${sha1.slice(0, 2)}/${sha1.slice(2)}`)).toBe("loose");
		expect(storedForm(`work/.git/objects/${sha1.slice(0, 2)}/${sha1.slice(2)}`)).toBe("loose");
		expect(storedForm(`repo.git/objects/${sha256.slice(0, 2)}/${sha256.slice(2)}`)).toBe("loose");
		expect(storedForm(`repo.git/objects/pack/pack-${sha1}.pack`)).toBe("pack");
		expect(storedForm(`.git/objects/pack/pack-${sha256}.pack`)).toBe("sha256-pack");
		for (const plain of [
			`repo.git/objects/pack/pack-${sha1}.idx`,
			`repo.git/objects/pack/pack-${sha1}.rev`,
			"repo.git/objects/pack/tmp_pack_Ab12Cd",
			"repo.git/objects/01/tmp_obj_Ab12Cd",
			"repo.git/objects/info/packs",
			`repo.git/objects/${sha1.slice(0, 2)}/${sha1.slice(2).toUpperCase()}`,
			`repo.git/objects/${sha1.slice(0, 2)}/${sha1.slice(3)}`,
			`repo.git/objects/${sha1.slice(0, 3)}/${sha1.slice(3)}`,
			`myobjects/${sha1.slice(0, 2)}/${sha1.slice(2)}`,
			`repo.git/objects/pack/pack-${sha1}.pack.old`,
			"notes.md",
		])
			expect(storedForm(plain)).toBe("plain");
	});
});

describe("a loose object's check", () => {
	const checks = new SaveChecks({ git: "/nonexistent/git" });
	const header = (text: string) => deflateSync(Buffer.from(text));

	it("refuses a value in the content git compressed, its stored bytes not holding it", async () => {
		const blob = looseObject("blob", `password = ${VALUE}\n`);
		expect(blob.data.includes(VALUE)).toBe(false);
		expect(await outcome(checks, blob.data, "loose")).toBe(CARRIES);
		// One byte at a time: the stream and the value both cross every chunk.
		expect(await outcome(checks, blob.data, "loose", undefined, 1)).toBe(CARRIES);
		// A tree entry's name and a commit's message are contents as well.
		const tree = looseObject("tree", Buffer.concat([Buffer.from(`100644 ${VALUE}.txt\0`), Buffer.alloc(20, 7)]));
		expect(await outcome(checks, tree.data, "loose")).toBe(CARRIES);
		const commit = looseObject(
			"commit",
			`tree ${"0".repeat(40)}\nauthor T <t@example.com> 0 +0000\ncommitter T <t@example.com> 0 +0000\n\nUse ${VALUE}\n`,
		);
		expect(await outcome(checks, commit.data, "loose")).toBe(CARRIES);
		// Stored as it is (zlib's level 0), it is in the stored bytes too.
		expect(await outcome(checks, deflateSync(`blob 15\0${VALUE}`, { level: 0 }), "loose")).toBe(CARRIES);
	});

	it("saves an honest object, whole or in single bytes, and an empty blob", async () => {
		const blob = looseObject("blob", `${"line of an honest file\n".repeat(5000)}`);
		expect(await outcome(checks, blob.data, "loose")).toBe(CHECKED);
		const small = looseObject("blob", "test-valXe-0001\n");
		expect(await outcome(checks, small.data, "loose", undefined, 1)).toBe(CHECKED);
		expect(await outcome(checks, looseObject("blob", "").data, "loose")).toBe(CHECKED);
	});

	it("refuses as not checked what is not one whole object", async () => {
		const blob = looseObject("blob", "an honest line\n").data;
		const cases: Record<string, Buffer> = {
			"not zlib": Buffer.from("this is not a zlib stream at all\n"),
			empty: Buffer.alloc(0),
			"bytes after the stream": Buffer.concat([blob, Buffer.from("x")]),
			"a second stream after it": Buffer.concat([blob, blob]),
			"a cut-off stream": blob.subarray(0, blob.length - 4),
			"no header": header("an honest line with no header\n"),
			"a header that never ends": header("a".repeat(100)),
			"an unknown type": header("blub 3\0abc"),
			"a size with a leading zero": header("blob 03\0abc"),
			"less content than its size": header("blob 99\0abc"),
			"more content than its size": header("blob 2\0abc"),
			"a size past 1 GiB": header(`blob ${1024 ** 3 + 1}\0abc`),
		};
		for (const [what, bytes] of Object.entries(cases)) {
			expect.soft(await outcome(checks, bytes, "loose"), what).toBe(UNCHECKED);
			expect.soft(await outcome(checks, bytes, "loose", undefined, 1), `${what}, in single bytes`).toBe(UNCHECKED);
		}
	});

	it("reads nothing on a machine with no values", async () => {
		expect(await outcome(checks, Buffer.from("not zlib"), "loose", noSecrets())).toBe(CHECKED);
		expect(await outcome(checks, Buffer.from("not a pack"), "pack", noSecrets())).toBe(CHECKED);
		expect(await outcome(checks, Buffer.from("not a pack"), "sha256-pack", noSecrets())).toBe(CHECKED);
	});
});

describe("a pack's check", () => {
	let root: string;
	let scratch: string;
	let settings: string;
	let honest: string;
	let reading: PackReading;

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "git-objects-test-"));
		scratch = join(root, "scratch");
		await mkdir(scratch);
		reading = { scratch };
		settings = await repository(root, "settings", [{ "settings.conf": V1 }, { "settings.conf": V2 }]);
		honest = await repository(root, "honest", [
			{ "a.md": "an honest file\n", "b.md": `${"more honest text\n".repeat(400)}` },
			{ "a.md": "an honest file, changed\n" },
		]);
	});

	afterAll(async () => {
		await rm(root, { recursive: true, force: true });
	});

	/** Every check has removed its scratch repository, whatever its end. */
	async function scratchIsEmpty(): Promise<void> {
		expect(await readdir(scratch)).toEqual([]);
	}

	it("refuses a value that is whole only in an object rebuilt from its delta (e)", async () => {
		const pack = packOf(settings);
		expect(pack.includes(VALUE)).toBe(false);
		// git stored the value's object as a delta against the other.
		const file = join(root, "settings.pack");
		await writeFile(file, pack);
		git(settings, ["index-pack", file]);
		const v1 = git(settings, ["rev-parse", "HEAD~1:settings.conf"]).toString().trim();
		const v2 = git(settings, ["rev-parse", "HEAD:settings.conf"]).toString().trim();
		const line = git(settings, ["verify-pack", "-v", join(root, "settings.idx")])
			.toString()
			.split("\n")
			.find((l) => l.startsWith(v1));
		expect(line?.trim().split(/\s+/).at(-1)).toBe(v2);
		expect(await outcome(new SaveChecks(reading), pack, "pack")).toBe(CARRIES);
		expect(await outcome(new SaveChecks(reading), pack, "pack", undefined, 1000)).toBe(CARRIES);
		await scratchIsEmpty();
		// The pack without the commit that holds the value is honest.
		expect(await outcome(new SaveChecks(reading), packOf(settings, "HEAD\n^HEAD~1\n"), "pack")).toBe(CHECKED);
		await scratchIsEmpty();
	});

	it("saves honest packs, in any chunks, and an honest sha256 pack; a sha256 pack's value is refused", async () => {
		const checks = new SaveChecks(reading);
		const pack = packOf(honest);
		expect(await outcome(checks, pack, "pack")).toBe(CHECKED);
		expect(await outcome(checks, pack, "pack", undefined, 7)).toBe(CHECKED);
		const settings256 = await repository(
			root,
			"settings256",
			[{ "settings.conf": V1 }, { "settings.conf": V2 }],
			true,
		);
		expect(await outcome(checks, packOf(settings256), "sha256-pack")).toBe(CARRIES);
		const honest256 = await repository(root, "honest256", [{ "a.md": "an honest file\n" }], true);
		expect(await outcome(checks, packOf(honest256), "sha256-pack")).toBe(CHECKED);
		// Read as the other object format, a pack is not read whole.
		expect(await outcome(checks, packOf(honest256), "pack")).toBe(UNCHECKED);
		expect(await outcome(checks, pack, "sha256-pack")).toBe(UNCHECKED);
		await scratchIsEmpty();
	});

	it("refuses as not checked a pack git cannot read whole: broken, thin, followed by more bytes, or empty (f)", async () => {
		const checks = new SaveChecks(reading);
		const pack = packOf(honest);
		const flipped = Buffer.from(pack);
		flipped[Math.floor(pack.length / 2)] ^= 0xff;
		const thin = packOf(settings, "HEAD\n^HEAD~1\n", true);
		// The thin pack is whole once the repository it came from gives it its base, the object holding the value.
		const fixed = git(settings, ["index-pack", "--stdin", "--fix-thin"], thin).toString().trim().split(/\s+/).at(-1);
		const completed = await readFile(join(settings, ".git/objects/pack", `pack-${fixed}.pack`));
		const cases: Record<string, Buffer> = {
			"a changed byte": flipped,
			"a cut-off pack": pack.subarray(0, pack.length - 10),
			"its header alone": pack.subarray(0, 12),
			"a thin pack": thin,
			"bytes after the pack's end": Buffer.concat([pack, Buffer.from("more bytes after the pack\n")]),
			"a second pack after it": Buffer.concat([pack, pack]),
			"no bytes": Buffer.alloc(0),
			"not a pack": Buffer.from("this is not a pack\n"),
		};
		for (const [what, bytes] of Object.entries(cases))
			expect.soft(await outcome(checks, bytes, "pack"), what).toBe(UNCHECKED);
		expect(await outcome(checks, completed, "pack")).toBe(CARRIES);
		expect(await outcome(checks, completed, "pack", secretsOf("an-honest-value-1"))).toBe(CHECKED);
		await scratchIsEmpty();
	});

	it("refuses as not checked a pack over the bounds: its size, and what it rebuilds to", async () => {
		const big = await repository(root, "big", [{ "big.txt": "the same line again and again\n".repeat(40_000) }]);
		const pack = packOf(big);
		const rebuilt = 30 * 40_000;
		expect(pack.length * 64).toBeLessThan(rebuilt);
		expect(await outcome(new SaveChecks({ ...reading, packMax: pack.length - 1 }), pack, "pack")).toBe(UNCHECKED);
		expect(await outcome(new SaveChecks({ ...reading, packMax: pack.length }), pack, "pack")).toBe(CHECKED);
		const bound = (rebuiltFactor: number, rebuiltFloor: number, rebuiltMax: number) =>
			outcome(new SaveChecks({ ...reading, rebuiltFactor, rebuiltFloor, rebuiltMax }), pack, "pack");
		expect(await bound(64, 0, 1024 ** 3)).toBe(UNCHECKED);
		expect(await bound(64, 2 * rebuilt, 1024 ** 3)).toBe(CHECKED);
		expect(await bound(1_000_000, 0, rebuilt / 2)).toBe(UNCHECKED);
		// The node's own bounds read it.
		expect(await outcome(new SaveChecks(reading), pack, "pack")).toBe(CHECKED);
		await scratchIsEmpty();
	});

	it("takes turns: a pack's check waits while another holds the node's one turn", async () => {
		const checks = new SaveChecks({ ...reading, atOnce: 1 });
		const pack = packOf(honest);
		const first = checks.start(secretsOf(VALUE), pack.length, "pack");
		await first.push(pack.subarray(0, 20));
		const second = checks.start(secretsOf(VALUE), pack.length, "pack");
		let started = false;
		const waiting = second.push(pack.subarray(0, 20)).then(() => {
			started = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(started).toBe(false);
		expect(await readdir(scratch)).toHaveLength(1);
		await first.push(pack.subarray(20));
		await first.end();
		await waiting;
		expect(started).toBe(true);
		await second.push(pack.subarray(20));
		await second.end();
		await scratchIsEmpty();
	});

	it("refuses as not checked now a pack's check past the waiting bound, by count or by bytes (d)", async () => {
		const pack = packOf(honest);
		const secrets = secretsOf(VALUE);
		for (const bound of [
			{ waitingMax: 2, waitingBytes: 1024 ** 3 },
			{ waitingMax: 100, waitingBytes: 2 * pack.length + 1 },
		]) {
			const checks = new SaveChecks({ ...reading, atOnce: 1, ...bound });
			const holding = checks.start(secrets, pack.length, "pack");
			await holding.push(pack.subarray(0, 20));
			// Two wait their turn; the third is refused at once, for the node's load, not for its bytes.
			const waiting = [checks.start(secrets, pack.length, "pack"), checks.start(secrets, pack.length, "pack")];
			const pushed = waiting.map((check) => check.push(pack.subarray(0, 20)));
			const third = checks.start(secrets, pack.length, "pack");
			const refusal = await Promise.race([
				third.push(pack.subarray(0, 20)).then(
					() => "given a turn",
					(error: unknown) => error,
				),
				new Promise((resolve) => setTimeout(resolve, 300, "waiting")),
			]);
			expect(refusal, JSON.stringify(bound)).toBeInstanceOf(SecretRefusal);
			await third.abort();
			expect((refusal as SecretRefusal).message).toBe(UNCHECKED);
			expect((refusal as SecretRefusal).again).toBe(true);
			// The ones waiting are checked in their turn, and the bound is free again.
			await holding.push(pack.subarray(20));
			await holding.end();
			for (const [n, check] of waiting.entries()) {
				await pushed[n];
				await check.push(pack.subarray(20));
				await check.end();
			}
			expect(await outcome(checks, pack, "pack")).toBe(CHECKED);
			await scratchIsEmpty();
		}
		// The bound is on checks waiting, not on one that has a turn; a refusal for a pack's bytes is not for the load.
		expect(await outcome(new SaveChecks({ ...reading, waitingMax: 0, waitingBytes: 0 }), pack, "pack")).toBe(CHECKED);
		for (const [checks, bytes] of [
			[new SaveChecks(reading), packOf(settings)],
			[new SaveChecks({ ...reading, packMax: 10 }), pack],
			[new SaveChecks(reading), pack.subarray(0, 12)],
		] as const) {
			const check = checks.start(secrets, bytes.length, "pack");
			const error = await (async () => {
				await check.push(bytes);
				await check.end();
			})().catch((e: unknown) => e);
			await check.abort();
			expect(error).toBeInstanceOf(SecretRefusal);
			expect((error as SecretRefusal).again).toBe(false);
		}
		await scratchIsEmpty();
	});

	it("gives its turn back and removes its scratch repository when aborted, or when git cannot start", async () => {
		const pack = packOf(honest);
		const checks = new SaveChecks({ ...reading, atOnce: 1 });
		const aborted = checks.start(secretsOf(VALUE), pack.length, "pack");
		await aborted.push(pack.subarray(0, 20));
		expect(await readdir(scratch)).toHaveLength(1);
		await aborted.abort();
		await aborted.abort();
		await scratchIsEmpty();
		expect(await outcome(checks, pack, "pack")).toBe(CHECKED);
		// A failure that is not the pack's is a plain error (the file waits), never a refusal; the turn comes back, so the
		// next check fails the same way rather than waiting for it. (A directory passes the access check, and cannot run.)
		for (const broken of [
			{ git: "/nonexistent/git" },
			{ prlimit: "/nonexistent/prlimit" },
			{ prlimit: root },
			{ scratch: join(root, "nonexistent") },
		]) {
			const failing = new SaveChecks({ ...reading, atOnce: 1, ...broken });
			for (const bytes of [pack, Buffer.alloc(0), pack]) {
				const error = await outcome(failing, bytes, "pack").catch((e: unknown) => e);
				expect(error, JSON.stringify(broken)).toBeInstanceOf(Error);
				expect(error, JSON.stringify(broken)).not.toBeInstanceOf(SecretRefusal);
				await scratchIsEmpty();
			}
		}
	});

	it("runs git with no configuration but the scratch repository's, under its memory limit, in its own group, and stops it in time", async () => {
		const seen = join(root, "seen");
		const fake = join(root, "fake-git");
		await writeFile(
			fake,
			[
				"#!/bin/sh",
				"{",
				'  echo "args $*"',
				'  echo "limit $(ulimit -v)"',
				"  echo \"group $(awk '{print $5}' /proc/$$/stat) $$\"",
				"  env | sort | sed 's/^/env /'",
				`  sed 's/^/config /' "$GIT_DIR/config"`,
				`} >> ${seen}`,
				"cat > /dev/null",
				"exit 1",
				"",
			].join("\n"),
		);
		await chmod(fake, 0o755);
		const checks = new SaveChecks({ ...reading, git: fake, memoryBytes: 512 * 1024 ** 2 });
		expect(await outcome(checks, packOf(honest), "pack")).toBe(UNCHECKED);
		await scratchIsEmpty();
		const lines = (await readFile(seen, "utf8")).split("\n");
		expect(lines).toContain("args index-pack --stdin --threads=1");
		expect(lines).toContain(`limit ${(512 * 1024 ** 2) / 1024}`);
		const [group, pid] = (lines.find((l) => l.startsWith("group "))?.split(" ") ?? []).slice(1);
		expect(group).toBe(pid);
		const env = Object.fromEntries(
			lines
				.filter((l) => l.startsWith("env "))
				.map((l) => l.slice(4).split("=", 2) as [string, string])
				.filter(([key]) => !["PWD", "OLDPWD", "SHLVL", "_"].includes(key)),
		);
		const dir = env.GIT_DIR as string;
		expect(dir.startsWith(join(scratch, "qorpera-save-check-"))).toBe(true);
		expect(env).toEqual({
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_DIR: dir,
			GIT_NO_REPLACE_OBJECTS: "1",
			GIT_TERMINAL_PROMPT: "0",
			HOME: dir,
			LC_ALL: "C",
			PATH: "/usr/local/bin:/usr/bin:/bin",
			XDG_CONFIG_HOME: dir,
		});
		const config = lines.filter((l) => l.startsWith("config ")).map((l) => l.slice(7).trim());
		expect(config).toContain("hooksPath = /dev/null");
		expect(config.some((l) => /remote|url|alternates|include/i.test(l))).toBe(false);

		// A git that never ends is stopped at the time bound, its whole group with it, and the turn comes back.
		const pidFile = join(root, "sleeping");
		const sleeper = join(root, "sleeping-git");
		await writeFile(sleeper, `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 600\n`);
		await chmod(sleeper, 0o755);
		const slow = new SaveChecks({ ...reading, git: sleeper, timeoutMs: 500, atOnce: 1 });
		const began = Date.now();
		expect(await outcome(slow, packOf(honest), "pack")).toBe(UNCHECKED);
		expect(Date.now() - began).toBeLessThan(10_000);
		const sleeping = Number((await readFile(pidFile, "utf8")).trim());
		expect(() => process.kill(sleeping, 0)).toThrow();
		await scratchIsEmpty();
		// The time bound counts from the turn, and it is the check's own: one left waiting is ended too.
		const left = slow.start(secretsOf(VALUE), 100, "pack");
		await left.push(Buffer.alloc(10));
		await new Promise((resolve) => setTimeout(resolve, 1500));
		await scratchIsEmpty();
		await expect(left.end()).rejects.toThrow(UNCHECKED);
		expect(await outcome(slow, Buffer.from("not a pack"), "pack", noSecrets())).toBe(CHECKED);
	});
});
