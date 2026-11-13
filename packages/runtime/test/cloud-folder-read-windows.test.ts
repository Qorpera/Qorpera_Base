import { createHash } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";
import { cloudFolderFileTools } from "@qorpera/runtime/cloud-folder-file-tools";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import {
	type CloudNativeTool,
	type CloudToolContent,
	cloudSecretSpans,
	redactCloudWebhookSecrets,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import { fitsOneResult } from "@qorpera/runtime/cloud-worker-tools";
import { afterEach, describe, expect, it } from "vitest";
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";

/*
 * Reads and secrets (keyholes S3, 13 November 2026, after #1721). The boundary cuts a secret out of an answer only when
 * the answer holds it whole. So a read of several files releases what it shows under the hash of the cut text, as
 * released() does since #1721, and no window of a file, a link's target or a listed target starts or ends inside a
 * secret: each secret is in one window whole, where the cut finds it. Every token here is made up, built from parts so
 * that no token-shaped literal is in the source.
 */

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const digits = (label: string, n: number) => `${label}${"0123456789".repeat(Math.ceil(n / 10))}`.slice(0, n);
const ghp = (body: string) => ["ghp", body].join("_");
const npm = (body: string) => ["npm", body].join("_");
/** A file of numbered lines, a made-up token on each. */
function lined(label: string, make: (body: string) => string, lines: number) {
	const tokens = Array.from({ length: lines }, (_, n) => make(digits(`${label}${String(n).padStart(4, "0")}x`, 36)));
	return { tokens, text: tokens.map((token, n) => `line ${n}: the deploy key is ${token} here.\n`).join("") };
}
/** Where each token lies in a text (all ASCII, so bytes and characters agree). */
function spans(text: string, tokens: readonly string[]) {
	const found: { start: number; end: number }[] = [];
	for (const token of tokens) {
		const start = text.indexOf(token, found.at(-1)?.end ?? 0);
		found.push({ start, end: start + token.length });
	}
	return found;
}
const inside = (found: readonly { start: number; end: number }[], at: number) =>
	found.some((span) => span.start < at && at < span.end);

async function fixture(seed: Parameters<typeof folderWriterFixture>[0]) {
	const f = await folderWriterFixture(seed);
	runs.push(f.run);
	const tools = cloudFolderFileTools({ folder: f.folder, operations: f.operations(), identity: f.identity });
	const tool = (name: string) => tools.find((candidate) => candidate.name === name) as CloudNativeTool;
	const call = async (name: string, value: JsonValue) =>
		tool(name).execute(tool(name).parseArguments(value), f.context);
	return { ...f, call };
}
const parse = (content: CloudToolContent) => JSON.parse(String(content.value));

/** Reads a file through from `offset` in windows of `limit`, each from the nextOffset before it. */
async function readThrough(f: Awaited<ReturnType<typeof fixture>>, path: string, limit: number, offset = 0) {
	const windows: { offset: number; bytesRead: number; text: string; nextOffset: number | null; secretRun?: string }[] =
		[];
	let at: number | null = offset;
	while (at !== null && windows.length < 10_000) {
		const window = parse(await f.call("company_read", { path, offset: at, limit }));
		windows.push(window);
		at = window.nextOffset;
	}
	return windows;
}

describe("cloudSecretSpans", () => {
	it("finds each secret the cut takes out, overlapping ones as one span, and nothing in plain text", () => {
		const one = ghp(digits("FakeGhp", 36));
		const two = npm(digits("FakeNpm", 36));
		const text = `a ${one} b ${two}`;
		expect(cloudSecretSpans(text)).toEqual([
			{ start: 2, end: 2 + one.length },
			{ start: 5 + one.length, end: 5 + one.length + two.length },
		]);
		// A Stripe key inside a fine-grained GitHub token: one span, the outer one.
		const pat = ["github", "pat", digits("FakePat_", 30), "sk", "test", digits("FakeSk", 52)].join("_");
		expect(cloudSecretSpans(pat)).toEqual([{ start: 0, end: pat.length }]);
		expect(cloudSecretSpans("the deploy runs at nine; re_render_component_tree")).toEqual([]);
		for (const { start, end } of cloudSecretSpans(text))
			expect(redactCloudWebhookSecrets(text.slice(start, end))).not.toBe(text.slice(start, end));
	});
});

describe("a read of several files that shows a token", () => {
	it("is released under the hash of the text the boundary shows, each file's release too", async () => {
		const token = ghp(digits("FakeDeploy", 36));
		const f = await fixture({
			files: {
				"keys/deploy.md": `The deploy reads ${token} from the vault.\n`,
				"docs/plain.md": "Nothing secret.\n",
			},
		});
		const content = await f.call("company_read", { paths: ["docs/plain.md", "keys/deploy.md"] });
		const shown = String(content.value);
		expect(shown).not.toContain(token);
		expect(shown).toContain("The deploy reads ghp_[REDACTED] from the vault.");
		expect(redactCloudWebhookSecrets(shown)).toBe(shown);
		expect(f.releases.map((release) => release.p_output_sha256)).toEqual([sha(shown), sha(shown)]);
		expect(content.companyReadId).toBe(f.releases[0]?.p_release_id);
	});
});

describe("a window of a file", () => {
	it("never ends inside a token, whatever its size: every token is cut in the window that holds it", async () => {
		const short = lined("FakeGhpLine", ghp, 40);
		const long = lined("FakeGhpLine", ghp, 1200);
		const f = await fixture({ files: { "notes/short.md": short.text, "notes/long.md": long.text } });
		for (const [path, { tokens, text }, limit] of [
			...[4, 9, 37, 41, 100].map((limit) => ["notes/short.md", short, limit] as const),
			...[1000, 4096, 32 * 1024].map((limit) => ["notes/long.md", long, limit] as const),
		]) {
			const found = spans(text, tokens);
			const bytes = Buffer.from(text, "utf8");
			const windows = await readThrough(f, path, limit);
			let at = 0;
			for (const window of windows) {
				expect(window.offset).toBe(at);
				expect(inside(found, window.offset + window.bytesRead)).toBe(false);
				expect(window.text).toBe(
					redactCloudWebhookSecrets(
						bytes.subarray(window.offset, window.offset + window.bytesRead).toString("utf8"),
					),
				);
				for (const token of tokens) expect(window.text).not.toContain(token.slice(4, 30));
				expect(window.secretRun).toBeUndefined();
				at = window.offset + window.bytesRead;
			}
			expect(at).toBe(bytes.byteLength);
		}
	});

	it("asked to start inside a token, starts where the token does; asked for less than a token, takes it whole", async () => {
		const { tokens, text } = lined("FakeGhpLine", ghp, 20);
		const found = spans(text, tokens);
		const f = await fixture({ files: { "notes/long.md": text } });
		const into = parse(
			await f.call("company_read", { path: "notes/long.md", offset: found[5]!.start + 7, limit: 100 }),
		);
		expect(into.offset).toBe(found[5]!.start);
		expect(into.text.startsWith("ghp_[REDACTED]")).toBe(true);
		const small = parse(await f.call("company_read", { path: "notes/long.md", offset: found[6]!.start, limit: 4 }));
		expect(small).toMatchObject({
			offset: found[6]!.start,
			bytesRead: tokens[6]!.length,
			text: "ghp_[REDACTED]",
			nextOffset: found[6]!.end,
		});
	});

	it("ends before a token-shaped run longer than any window, then shows what it read of it cut and says the read goes on inside it", async () => {
		const run = ghp(digits("FakeOverlongRun", 40_000));
		const text = `# Blob\n\n${run}\nend\n`;
		const f = await fixture({ files: { "notes/blob.md": text } });
		const before = parse(await f.call("company_read", { path: "notes/blob.md" }));
		expect(before).toMatchObject({ offset: 0, bytesRead: 8, text: "# Blob\n\n", nextOffset: 8 });
		const cut = parse(await f.call("company_read", { path: "notes/blob.md", offset: 8 }));
		expect(cut).toMatchObject({ offset: 8, text: "ghp_[REDACTED]", bytesRead: 32 * 1024 + 1024 });
		expect(cut.nextOffset).toBe(8 + cut.bytesRead);
		expect(cut.secretRun).toBe(
			"A secret-shaped run starts at offset 8 and goes on past nextOffset: what was read of it is shown cut, and reading on shows the rest of it, which cannot be cut on its own.",
		);
		// A small window at the run is taken as far as the read goes, and says so too.
		const small = parse(await f.call("company_read", { path: "notes/blob.md", offset: 8, limit: 4 }));
		expect(small).toMatchObject({ offset: 8, text: "ghp_[REDACTED]", bytesRead: 4 + 1024 });
		expect(small.secretRun).toContain("starts at offset 8");
		// A run of %-escapes or \u escapes whose read ends inside an escape (review r6 of #1700): its match stops short of
		// the read's end, and the window still says it goes on.
		for (const [path, unit] of [
			["notes/url.md", "%2B"],
			["notes/json.md", "\\u002B"],
		] as const) {
			const g = await fixture({ files: { [path]: `${["whsec", unit.repeat(600)].join("_")}\nend\n` } });
			const escaped = parse(await g.call("company_read", { path, offset: 0, limit: 4 }));
			expect(escaped.text.startsWith("whsec_[REDACTED]")).toBe(true);
			expect(escaped).toMatchObject({ offset: 0, bytesRead: 4 + 1024, nextOffset: 4 + 1024 });
			expect(escaped.secretRun).toContain("starts at offset 0");
		}
		// A read asked to start deep inside such a run, further in than a read takes before its start, cannot see where the
		// run began: it shows what follows as it is and says nothing. Only the window that ends in the run can say so.
		expect(parse(await f.call("company_read", { path: "notes/blob.md", offset: 40_000 })).secretRun).toBeUndefined();
	});

	it("of several files cut alike ends each outside its tokens, with its own nextOffset", async () => {
		const a = lined("FakeGhpLine", ghp, 600);
		const b = lined("FakeNpmLine", npm, 600);
		const f = await fixture({ files: { "notes/a.md": a.text, "notes/b.md": b.text } });
		const content = await f.call("company_read", { paths: ["notes/a.md", "notes/b.md"] });
		expect(fitsOneResult(String(content.value))).toBe(true);
		const files = parse(content).files;
		for (const [index, file] of [a, b].entries()) {
			const shown = files[index];
			expect(inside(spans(file.text, file.tokens), shown.bytesRead)).toBe(false);
			expect(shown.text).toBe(redactCloudWebhookSecrets(file.text.slice(0, shown.bytesRead)));
			expect(shown.nextOffset).toBe(shown.bytesRead);
			for (const token of file.tokens) expect(shown.text).not.toContain(token.slice(4, 30));
		}
	});
});

describe("a link's target", () => {
	it("is read and listed in parts that never end inside a token", async () => {
		const token = ghp(digits("FakeLinkToken", 36));
		// The listing shows a target's first 512 bytes: the token straddles that edge.
		const target = `${"v".repeat(500)}/${token}`;
		const f = await fixture({
			files: { "notes/links/readme.md": "Links.\n" },
			links: { "notes/links/deploy": target },
		});
		const listed = String((await f.call("company_list", { path: "notes/links" })).value);
		expect(listed).toContain(`-> ${JSON.stringify(target.slice(0, 501))} (cut; company_read shows all)`);
		expect(listed).not.toContain("FakeLinkToken");
		const read = parse(await f.call("company_read", { path: "notes/links/deploy", offset: 495, limit: 10 }));
		expect(read).toMatchObject({ offset: 495, target: "vvvvv/", nextOffset: 501 });
		const on = parse(await f.call("company_read", { path: "notes/links/deploy", offset: 501, limit: 10 }));
		expect(on).toMatchObject({ offset: 501, target: "ghp_[REDACTED]", bytesRead: token.length, nextOffset: null });
	});
});
