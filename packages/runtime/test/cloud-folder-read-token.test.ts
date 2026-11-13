import { createHash } from "node:crypto";
import { cloudCompanyFolderRelease } from "@qorpera/runtime/cloud-company-folder-client";
import { cloudFolderFileTools, released, releaseId } from "@qorpera/runtime/cloud-folder-file-tools";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import {
	CloudNativeToolBoundary,
	type CloudToolResult,
	redactCloudWebhookSecrets,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import { CloudRuntimeObservability } from "@qorpera/runtime/cloud-runtime-observability";
import { fitsOneResult } from "@qorpera/runtime/cloud-worker-tools";
import { afterEach, describe, expect, it } from "vitest";
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";

/*
 * A read whose answer shows a token-shaped string (13 November 2026). The boundary cuts a secret out of every answer
 * and hashes what is left (`content.sha256`); the context view cites the read's release under that hash, and SQL
 * refuses a citation whose hash is not the release's (`Context read provenance differs`), which stopped the run at its
 * next model request. `released()` now releases, and returns, the answer as the model is shown it. Every token here is
 * made up, built from parts so that no token-shaped literal is in the source.
 */

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const digits = (label: string, n: number) => `${label}${"0123456789".repeat(Math.ceil(n / 10))}`.slice(0, n);
/** One made-up string of each shape the boundary cuts, and what the cut shows in its place. */
const TOKENS = [
	[["whsec", digits("FakeWhsec", 40)].join("_"), "whsec_[REDACTED]"],
	[["npm", digits("FakeNpm", 36)].join("_"), "npm_[REDACTED]"],
	[["ghp", digits("FakeGhp", 36)].join("_"), "ghp_[REDACTED]"],
	[["github", "pat", digits("FakeGithubPat_", 82)].join("_"), "github_pat_[REDACTED]"],
	[["sk", "test", digits("FakeSkTest", 24)].join("_"), "sk_[REDACTED]"],
	[["rk", "live", digits("FakeRkLive", 24)].join("_"), "rk_[REDACTED]"],
	[["re", "FakeRe12", digits("FakeResend", 20)].join("_"), "re_[REDACTED]"],
	// As other tools print them: URL-encoded, and JSON-escaped in the file's own text.
	[`whsec%5F${digits("FakeWhsecUrl", 40)}`, "whsec_[REDACTED]"],
	[`npm\\u005F${digits("FakeNpmJson", 36)}`, "npm_[REDACTED]"],
] as const;
const KEYS = `# Keys\n\n${TOKENS.map(([token], n) => `${n}: the deploy reads ${token} from the vault`).join("\n")}\n`;

async function fixture(seed: Parameters<typeof folderWriterFixture>[0]) {
	const f = await folderWriterFixture(seed);
	runs.push(f.run);
	return f;
}

describe("a read that shows a token", () => {
	it("is released under the hash of the text the boundary shows, the token cut out, and that text is what it returns", async () => {
		const f = await fixture({ files: { "ops/keys.md": KEYS } });
		const { entry } = await f.folder.read("ops/keys.md", f.context.signal);
		const observability = new CloudRuntimeObservability({
			assignmentId: f.binding.assignmentId,
			publish: async () => {},
		});
		const span = observability.start("company_read");
		const content = await released(f.folder, f.identity.runId, { ...f.context, observation: span }, KEYS, [
			cloudCompanyFolderRelease(entry!),
		]);
		const shown = String(content.value);
		expect(shown).toBe(redactCloudWebhookSecrets(KEYS));
		for (const [token, cut] of TOKENS) {
			expect(shown).not.toContain(token);
			expect(shown).toContain(`the deploy reads ${cut} from`);
		}
		// The boundary cuts it again and changes nothing, so its envelope's hash is the release's.
		expect(redactCloudWebhookSecrets(shown)).toBe(shown);
		expect(f.releases).toHaveLength(1);
		expect(f.releases[0]).toMatchObject({ p_release_id: content.companyReadId, p_output_sha256: sha(shown) });
		expect(content.companyReadId).toBe(releaseId(f.identity.runId, f.context.callId, sha(shown)));
		// What the observation counts is what the model is shown.
		span.finish("succeeded");
		expect(span.result?.outputBytes).toBe(Buffer.byteLength(shown));
		await observability.close();
	});

	it("leaves an answer without a token as it was", async () => {
		const f = await fixture({ files: { "ops/plain.md": "nothing to cut" } });
		const { entry } = await f.folder.read("ops/plain.md", f.context.signal);
		const text = '{"text":"the re_render step and sk_ prefixes are not keys"}';
		const content = await released(f.folder, f.identity.runId, f.context, text, [cloudCompanyFolderRelease(entry!)]);
		expect(content.value).toBe(text);
		expect(f.releases[0]?.p_output_sha256).toBe(sha(text));
	});

	it("through the boundary: company_read and company_list cite a release whose hash is the envelope's, as SQL checks", async () => {
		const target = `vault/${TOKENS[5]![0]}`;
		const f = await fixture({
			files: { "ops/keys.md": KEYS },
			folders: ["ops/links"],
			links: { "ops/links/deploy": target },
		});
		const tools = cloudFolderFileTools({ folder: f.folder, operations: f.operations(), identity: f.identity });
		const boundary = new CloudNativeToolBoundary({
			companyId: f.identity.companyId,
			runId: f.identity.runId,
			identity: f.identity,
			tools,
			assertActive: async () => undefined,
			signal: new AbortController().signal,
		});
		const envelope = async (callId: string, tool: string, args: Record<string, unknown>) =>
			JSON.parse(
				(await boundary.invoke(callId, "qorpera", tool, args)).contentItems[0]?.text ?? "null",
			) as CloudToolResult;
		const answers = [
			await envelope("read-keys", "company_read", { path: "ops/keys.md", offset: 0, limit: 32768 }),
			await envelope("list-links", "company_list", { path: "ops/links", after: null, limit: 50 }),
			await envelope("read-link", "company_read", { path: "ops/links/deploy", offset: 0, limit: 4096 }),
		];
		boundary.close();
		expect(f.releases).toHaveLength(3);
		for (const [index, answer] of answers.entries()) {
			expect(answer.status).toBe("ok");
			expect(answer.content.truncated).toBe(false);
			// The context view's readSha256 is content.sha256: SQL compares it with the release's output hash.
			expect(answer.provenance.companyReadId).toBe(f.releases[index]?.p_release_id);
			expect(answer.content.sha256).toBe(f.releases[index]?.p_output_sha256);
			expect(answer.content.sha256).toBe(sha(answer.content.text));
			for (const [token] of TOKENS) expect(answer.content.text).not.toContain(token);
		}
		expect(JSON.parse(answers[0]!.content.text).text).toBe(redactCloudWebhookSecrets(KEYS));
		expect(JSON.parse(answers[1]!.content.text).entries[0]).toMatchObject({ target: "vault/rk_[REDACTED]" });
		expect(JSON.parse(answers[2]!.content.text)).toMatchObject({ kind: "symlink", target: "vault/rk_[REDACTED]" });
	});

	it("still fits one result after the cut, read from a window the fitting filled", async () => {
		const line = `the deploy key is ${TOKENS[2]![0]} here\n`;
		const f = await fixture({ files: { "ops/long.md": line.repeat(2000) } });
		const [read] = cloudFolderFileTools({ folder: f.folder, operations: f.operations(), identity: f.identity });
		const content = await read!.execute(
			read!.parseArguments({ path: "ops/long.md", offset: 0, limit: 32768 }),
			f.context,
		);
		const answer = JSON.parse(String(content.value));
		expect(fitsOneResult(String(content.value))).toBe(true);
		expect(answer.bytesRead).toBeGreaterThan(30_000);
		// The window is of the file's bytes (nextOffset goes on from them); what is shown of it is cut.
		expect(answer.nextOffset).toBe(answer.bytesRead);
		expect(answer.text).toBe(redactCloudWebhookSecrets(line.repeat(2000).slice(0, answer.bytesRead)));
		expect(f.releases[0]?.p_output_sha256).toBe(sha(String(content.value)));
	});
});

describe("the boundary's cut", () => {
	it("never lengthens a text and changes nothing when it cuts again", () => {
		// Fragments that make tokens, near-tokens, encodings and their neighbours in any order: a seeded walk, the same
		// strings every run.
		const fragments = [
			"whsec",
			"npm",
			"ghp",
			"github",
			"pat",
			"sk",
			"rk",
			"re",
			"test",
			"live",
			"_",
			"%5F",
			"%5f",
			"\\u005F",
			"\\\\u005F",
			"\\/",
			"+",
			"/",
			"=",
			"%2B",
			'"',
			" ",
			"\n",
			"[REDACTED]",
			digits("A", 6),
			digits("B", 16),
			digits("C", 24),
			digits("D", 36),
			digits("E_", 82),
			...TOKENS.map(([token]) => token),
		];
		let seed = 0x2f6e2b1;
		const next = () => {
			seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
			return seed;
		};
		let changed = 0;
		for (let n = 0; n < 4000; n++) {
			let text = "";
			const parts = 2 + (next() % 9);
			for (let part = 0; part < parts; part++) text += fragments[next() % fragments.length];
			const cut = redactCloudWebhookSecrets(text);
			if (cut !== text) changed++;
			expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(Buffer.byteLength(text));
			expect(redactCloudWebhookSecrets(cut)).toBe(cut);
			// A JSON text stays JSON, and its answer still fits where the uncut one did.
			const json = JSON.stringify({ text });
			const cutJson = redactCloudWebhookSecrets(json);
			expect(() => JSON.parse(cutJson)).not.toThrow();
			expect(redactCloudWebhookSecrets(cutJson)).toBe(cutJson);
			if (fitsOneResult(json)) expect(fitsOneResult(cutJson)).toBe(true);
		}
		// The walk does reach the cut: most strings hold something it takes out.
		expect(changed).toBeGreaterThan(1000);
	});
});
