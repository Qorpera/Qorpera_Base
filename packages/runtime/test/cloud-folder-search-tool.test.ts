import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@qorpera/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CloudCompanyFolderClient,
	CloudCompanyFolderError,
	type CloudCompanyFolderRelease,
} from "../src/cloud-company-folder-client.ts";
import { CloudFolderSearch, cloudFolderSearchTool, folderSearchText } from "../src/cloud-folder-search-tool.ts";
import {
	CloudToolArgumentRefusal,
	type CloudToolContext,
	CloudToolRefusal,
	redactCloudWebhookSecrets,
} from "../src/cloud-native-tool-boundary.ts";
import { fitsOneResult } from "../src/cloud-worker-tools.ts";

const RUN = "81100000-0000-4000-8000-000000000001";
const ENV = "81100000-0000-4000-8000-000000000002";
const VIEW = "81100000-0000-4000-8000-0000000000a1";
const PASS = "p".repeat(43);
const VERSION = "81100000-0000-4000-8000-0000000000b1";
const RECEIPT = {
	resourceId: "81100000-0000-4000-8000-0000000000c1",
	resourceRevision: 2,
	grantId: null,
	grantRevision: null,
};
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const done of cleanup.splice(0).reverse()) await done();
});

type Answer = (search: Record<string, unknown>, hellos: number) => { kind: number; body: unknown };
const found = (body: Record<string, unknown>) => ({
	kind: 0x73,
	body: { hits: [], searched: 0, binary: 0, reads: [], next: null, ...body },
});
const refused = (code: string) => ({ kind: 0x65, body: { code, message: "no" } });

/** A stand-in node folder service on a Unix socket: hellos (saying `search` when given, as a node of keyholes S4 does),
 * then search pages as the test says. */
async function node(answer: Answer, search?: { version: number; regex: boolean }) {
	const root = await mkdtemp(join(tmpdir(), "folder-search-"));
	const path = join(root, "relay.sock");
	const hellos: Record<string, unknown>[] = [];
	const searches: Record<string, unknown>[] = [];
	const frame = (kind: number, body: unknown) => {
		const payload = Buffer.from(JSON.stringify(body));
		const head = Buffer.alloc(5);
		head.writeUInt32BE(payload.byteLength + 1, 0);
		head[4] = kind;
		return Buffer.concat([head, payload]);
	};
	const server: Server = await new Promise((resolve) => {
		const s = createServer((socket: Socket) => {
			let buffer = Buffer.alloc(0);
			socket.on("data", (data: Buffer) => {
				buffer = Buffer.concat([buffer, data]);
				while (buffer.byteLength >= 5 && buffer.byteLength >= 4 + buffer.readUInt32BE(0)) {
					const length = buffer.readUInt32BE(0);
					const kind = buffer[4];
					const body = JSON.parse(buffer.subarray(5, 4 + length).toString("utf8")) as Record<string, unknown>;
					buffer = buffer.subarray(4 + length);
					if (kind === 0x48) {
						hellos.push(body);
						socket.write(
							frame(0x68, {
								protocol: body.protocol,
								viewId: body.viewId,
								asOfSeq: 1,
								readOnly: true,
								...(search ? { search } : {}),
							}),
						);
					} else {
						searches.push(body);
						const reply = answer(body, hellos.length);
						socket.write(frame(reply.kind, reply.body));
					}
				}
			});
			socket.on("error", () => undefined);
		});
		s.listen(path, () => resolve(s));
	});
	cleanup.push(async () => {
		server.close();
		await rm(root, { recursive: true, force: true });
	});
	return { path, hellos, searches };
}

function folder(failure?: CloudCompanyFolderError) {
	const releases: { id: string; reads: readonly CloudCompanyFolderRelease[]; sha: string }[] = [];
	let views = 0;
	const client = {
		async openRunView() {
			views++;
			return { viewId: VIEW, pass: PASS };
		},
		async release(id: string, reads: readonly CloudCompanyFolderRelease[], sha: string) {
			if (failure) throw failure;
			releases.push({ id, reads, sha });
			return { releaseId: id, reads: reads.length, replay: false };
		},
	} as unknown as CloudCompanyFolderClient;
	return { client, releases, views: () => views };
}

function tool(path: string, client: CloudCompanyFolderClient) {
	return cloudFolderSearchTool({
		search: new CloudFolderSearch({ socketPath: path, folder: client, environmentId: ENV }),
		folder: client,
		runId: RUN,
	});
}

function context(callId = "call-1"): CloudToolContext {
	return {
		companyId: "81100000-0000-4000-8000-000000000003",
		runId: RUN,
		callId,
		argumentSha256: "a".repeat(64),
		signal: new AbortController().signal,
	};
}

const hit = (path: string, line: number, text: string, offset = 0, kind: "file" | "folder" = "file") => ({
	path,
	kind,
	line,
	text,
	version: VERSION,
	offset,
});
const link = (path: string, target: string) => ({ ...hit(path, 0, ""), kind: "symlink" as const, target });
const read = (path: string, authority: unknown = RECEIPT) => ({ path, kind: "file", version: VERSION, authority });

describe("company_search", () => {
	it("searches the run's own view on the node, releases what the page drew on, cites it, and keeps the connection", async () => {
		const n = await node(() =>
			found({
				hits: [hit("docs/plan.md", 3, "the plan"), hit("plans", 0, "", 0, "folder")],
				searched: 2,
				binary: 1,
				reads: [read("docs/plan.md"), { path: "docs", kind: "folder", version: VERSION }],
			}),
		);
		const { client, releases, views } = folder();
		const search = tool(n.path, client);
		const args = search.parseArguments({ query: "plan", glob: "*.md" } as JsonValue);
		expect(args).toEqual({
			query: "plan",
			path: "",
			glob: "*.md",
			regex: false,
			context: 0,
			files_only: false,
			names_only: false,
			case_sensitive: false,
			cursor: null,
		});
		const content = await search.execute(args, context());
		expect(content.value).toBe(
			"docs/plan.md:3: the plan\nplans/\n\n2 files searched, 1 binary passed over. Nothing more.",
		);
		expect(n.hellos).toEqual([{ protocol: 4, environmentId: ENV, viewId: VIEW, pass: PASS, role: "io" }]);
		expect(n.searches[0]).toEqual({
			query: "plan",
			path: "",
			glob: "*.md",
			namesOnly: false,
			caseSensitive: false,
			after: null,
		});
		expect(releases).toHaveLength(1);
		expect(releases[0]!.sha).toBe(
			createHash("sha256")
				.update(content.value as string)
				.digest("hex"),
		);
		// A read without a receipt goes with the nil-uuid stand-in, which the core checks again.
		expect(releases[0]!.reads).toEqual([
			{ path: "docs/plan.md", version: VERSION, authority: RECEIPT },
			{
				path: "docs",
				version: VERSION,
				authority: {
					resourceId: "00000000-0000-0000-0000-000000000000",
					resourceRevision: 0,
					grantId: null,
					grantRevision: null,
				},
			},
		]);
		expect(content.companyReadId).toBe(releases[0]!.id);
		await search.execute(search.parseArguments({ query: "other" }), context("call-2"));
		expect(views()).toBe(1);
		expect(n.hellos).toHaveLength(1);
		// No reads, no release and no citation.
		const empty = await node(() => found({}));
		const quiet = folder();
		const none = await tool(empty.path, quiet.client).execute(
			{ ...(args as Record<string, JsonValue>), query: "zzz" },
			context(),
		);
		expect(none.value).toBe("No matches here.\n\n0 files searched. Nothing more.");
		expect(none.companyReadId).toBeUndefined();
		expect(quiet.releases).toEqual([]);
	});

	it("releases an answer with a token in a line under the hash of the text the boundary shows, the token cut out", async () => {
		const token = `ghp_${"A".repeat(36)}`;
		const n = await node(() =>
			found({
				hits: [hit("ops/deploy.md", 2, `the deploy token is ${token}`)],
				searched: 1,
				reads: [read("ops/deploy.md")],
			}),
		);
		const { client, releases } = folder();
		const search = tool(n.path, client);
		const content = await search.execute(search.parseArguments({ query: "deploy token" }), context());
		expect(content.value).toBe(
			"ops/deploy.md:2: the deploy token is ghp_[REDACTED]\n\n1 file searched. Nothing more.",
		);
		// The boundary cuts it again (a no-op) and hashes what it shows: the context view cites that hash, which must be
		// the release's (qorpera_folder_record_context_view refuses any other).
		expect(redactCloudWebhookSecrets(content.value as string)).toBe(content.value);
		expect(releases[0]!.sha).toBe(
			createHash("sha256")
				.update(content.value as string)
				.digest("hex"),
		);
		expect(content.companyReadId).toBe(releases[0]!.id);
	});

	it("shows a link found by its name with what it names, exactly, and releases the link's read with the page", async () => {
		const n = await node(() =>
			found({
				hits: [
					link("docs/latest", "../reports/q3 final.csv"),
					link("docs/latest-odd", "two\nlines "),
					hit("docs/latest.md", 0, ""),
				],
				reads: [
					{ path: "docs", kind: "folder", version: VERSION, authority: RECEIPT },
					{ path: "docs/latest", kind: "symlink", version: VERSION, authority: RECEIPT },
					{ path: "docs/latest-odd", kind: "symlink", version: VERSION },
					read("docs/latest.md"),
				],
			}),
		);
		const f = folder();
		const search = tool(n.path, f.client);
		const content = await search.execute(search.parseArguments({ query: "latest", names_only: true }), context());
		// The target as the core keeps it: quoted, so its spaces and line breaks show, on the link's one line.
		expect(content.value).toBe(
			'docs/latest -> "../reports/q3 final.csv"\ndocs/latest-odd -> "two\\nlines "\ndocs/latest.md\n\n' +
				"0 files searched. Nothing more.",
		);
		expect(n.searches[0]).toMatchObject({ query: "latest", namesOnly: true });
		expect(f.releases).toHaveLength(1);
		expect(f.releases[0]!.sha).toBe(
			createHash("sha256")
				.update(content.value as string)
				.digest("hex"),
		);
		expect(f.releases[0]!.reads).toEqual([
			{ path: "docs", version: VERSION, authority: RECEIPT },
			{ path: "docs/latest", version: VERSION, authority: RECEIPT },
			{
				path: "docs/latest-odd",
				version: VERSION,
				authority: {
					resourceId: "00000000-0000-0000-0000-000000000000",
					resourceRevision: 0,
					grantId: null,
					grantRevision: null,
				},
			},
			{ path: "docs/latest.md", version: VERSION, authority: RECEIPT },
		]);
		expect(content.companyReadId).toBe(f.releases[0]!.id);

		// A target of 4,095 bytes is the longest a link has.
		const longest = `${"é".repeat(2047)}x`;
		const ok = await node(() => found({ hits: [link("a", longest)], reads: [read("a")] }));
		const shown = await tool(ok.path, folder().client).execute(search.parseArguments({ query: "a" }), context());
		expect(shown.value).toBe(`a -> "${longest}"\n\n0 files searched. Nothing more.`);
		// Anything else is not the node's answer, and nothing is shown or released.
		for (const odd of [
			{ ...link("a", "x"), target: undefined },
			{ ...link("a", "x"), target: "" },
			{ ...link("a", "x"), target: "é".repeat(2048) },
			{ ...link("a", "x"), line: 1, text: "x" },
			{ ...hit("a", 1, "x"), target: "x" },
		]) {
			const bad = await node(() => found({ hits: [odd], reads: [read("a")] }));
			const g = folder();
			await expect(
				tool(bad.path, g.client).execute(search.parseArguments({ query: "a" }), context()),
			).rejects.toThrow(/^COMPANY_FOLDER_UNAVAILABLE/);
			expect(g.releases).toEqual([]);
		}
	});

	it("gives an opaque cursor to go on with, and passes back where the node said, never a path the model sent", async () => {
		const next = { path: "docs/big.md", version: VERSION, offset: 4096, line: 80 };
		// A first page that shows enough for one answer (about 20 KiB): the call asks for no other.
		const full = Array.from({ length: 6 }, (_, i) => hit(`a${i}.md`, 1, "x".repeat(3500)));
		const n = await node((search) => (search.after === null ? found({ hits: full, next }) : found({})));
		const search = tool(n.path, folder().client);
		const first = (await search.execute(search.parseArguments({ query: "x" }), context())).value as string;
		const cursor = /call again with cursor (\S+)$/.exec(first)?.[1] ?? "";
		expect(cursor).toMatch(/^[A-Za-z0-9_-]{16}$/);
		expect(first).not.toContain("big.md");
		await search.execute(search.parseArguments({ query: "x", cursor }), context("call-2"));
		expect(n.searches[1]!.after).toEqual(next);
		expect(() => search.parseArguments({ query: "x", cursor: "not-a-cursor" })).toThrow(CloudToolArgumentRefusal);
		// A token this run never gave (another run's, or made up) reaches nothing.
		await expect(
			search.execute(search.parseArguments({ query: "x", cursor: "A".repeat(16) }), context("call-3")),
		).rejects.toThrow(/^CURSOR_UNKNOWN/);
		// A token goes on only with the search that gave it.
		await expect(
			search.execute(search.parseArguments({ query: "other", cursor }), context("call-4")),
		).rejects.toThrow(/^CURSOR_OTHER_SEARCH/);
		expect(n.searches).toHaveLength(2);
	});

	it("fits a page to one tool result, and goes on from the first hit it left out", () => {
		const hits = Array.from({ length: 40 }, (_, i) =>
			hit("page.html", i + 1, `<td>&amp;${"<>".repeat(80)}</td>`, i * 300),
		);
		const sealed: unknown[] = [];
		const seal = (cursor: unknown): string => {
			sealed.push(cursor);
			return `token${sealed.length}`;
		};
		const text = folderSearchText({ hits, searched: 1, binary: 0, reads: [], next: null }, seal);
		expect(fitsOneResult(text)).toBe(true);
		// One token per page, however many layouts were tried.
		expect(sealed).toHaveLength(1);
		const shown = text.split("\n").filter((line) => line.startsWith("page.html:")).length;
		expect(shown).toBeGreaterThan(0);
		expect(shown).toBeLessThan(40);
		const token = /cursor (\S+)$/.exec(text)![1]!;
		expect(sealed[Number(token.slice(5)) - 1]).toEqual({
			path: "page.html",
			version: VERSION,
			offset: shown * 300,
			line: shown,
		});
		// A page cut short counts nothing: the next page searches those files again.
		expect(text).toContain("Part of the answer");
		// Lines a pattern passed over before the cut are still named: the next call goes on after the cut and would never
		// name them (review r5 F1).
		const skipped = folderSearchText({ hits, searched: 2, binary: 0, longLines: 1, reads: [], next: null }, seal);
		expect(fitsOneResult(skipped)).toBe(true);
		expect(skipped).toMatch(
			/\n\nPart of the answer; 1 line over 1 MiB not searched by the pattern \(search them as text, or read them\)\. More: call again with cursor \S+$/,
		);
		expect(skipped.split("\n").filter((line) => line.startsWith("page.html:")).length).toBeLessThan(40);
		// One hit too long for a result is still shown, cut, and the search goes on after it.
		const long = folderSearchText(
			{
				hits: [hit(`${"<".repeat(4000)}.md`, 1, "&".repeat(2000)), hit("next.md", 1, "x")],
				searched: 2,
				binary: 0,
				reads: [],
				next: null,
			},
			seal,
		);
		expect(fitsOneResult(long)).toBe(true);
		expect(long.startsWith("<<<<")).toBe(true);
		expect(sealed.at(-1)).toMatchObject({ path: "next.md" });
		// So is a link whose target is too long for it: the target is cut, and says so.
		const far = folderSearchText(
			{
				hits: [link(`${"<".repeat(1500)}/l`, "&".repeat(4095)), hit("next.md", 1, "x")],
				searched: 0,
				binary: 0,
				reads: [],
				next: null,
			},
			seal,
		);
		expect(fitsOneResult(far)).toBe(true);
		expect(far).toMatch(/^<{1500}\/l -> "&+"… \(target cut\)\n/);
		expect(sealed.at(-1)).toMatchObject({ path: "next.md" });
	});

	it("opens the view again once when the node closed it, and says when the folder cannot be searched", async () => {
		const n = await node((_search, hellos) => (hellos === 1 ? refused("VIEW_CLOSED") : found({})));
		const f = folder();
		const search = tool(n.path, f.client);
		await search.execute(search.parseArguments({ query: "x" }), context());
		expect(f.views()).toBe(2);
		const closed = await node(() => refused("VIEW_CLOSED"));
		const g = folder();
		const never = tool(closed.path, g.client);
		await expect(never.execute(never.parseArguments({ query: "x" }), context())).rejects.toThrow(
			/^COMPANY_FOLDER_UNAVAILABLE/,
		);
		expect(g.views()).toBe(2);
		const missing = tool("/nonexistent/relay.sock", folder().client);
		await expect(missing.execute(missing.parseArguments({ query: "x" }), context())).rejects.toBeInstanceOf(
			CloudToolRefusal,
		);
	});

	it("answers a path the view does not have, and keeps the connection", async () => {
		const n = await node((search) => (search.path === "nowhere" ? refused("NOT_FOUND") : found({})));
		const search = tool(n.path, folder().client);
		await expect(search.execute(search.parseArguments({ query: "x", path: "nowhere" }), context())).rejects.toThrow(
			/^NOT_FOUND/,
		);
		await search.execute(search.parseArguments({ query: "x" }), context("call-2"));
		expect(n.hellos).toHaveLength(1);
	});

	it("withholds a page whose reads may no longer be made, or could not be recorded", async () => {
		const n = await node(() => found({ hits: [hit("a.md", 1, "x")], reads: [read("a.md")] }));
		const revoked = tool(n.path, folder(new CloudCompanyFolderError("read_revoked")).client);
		await expect(revoked.execute(revoked.parseArguments({ query: "x" }), context())).rejects.toThrow(/^READ_REVOKED/);
		const down = tool(n.path, folder(new CloudCompanyFolderError("unavailable")).client);
		await expect(down.execute(down.parseArguments({ query: "x" }), context())).rejects.toThrow(
			/^COMPANY_FOLDER_UNAVAILABLE/,
		);
	});

	it("takes pages in turn, with one view, when calls come at once", async () => {
		const n = await node((search) => found({ hits: [hit(`${search.query as string}.md`, 1, "x")] }));
		const f = folder();
		const search = tool(n.path, f.client);
		const answers = await Promise.all(
			["a", "b", "c"].map((query, i) => search.execute(search.parseArguments({ query }), context(`call-${i}`))),
		);
		expect(answers.map((a) => (a.value as string).split(":")[0])).toEqual(["a.md", "b.md", "c.md"]);
		expect(f.views()).toBe(1);
		expect(n.hellos).toHaveLength(1);
	});

	it("sends nothing for a call already cancelled, and nothing once the run's search is closed", async () => {
		const n = await node(() => found({}));
		const f = folder();
		const search = new CloudFolderSearch({ socketPath: n.path, folder: f.client, environmentId: ENV });
		const t = cloudFolderSearchTool({ search, folder: f.client, runId: RUN });
		await t.execute(t.parseArguments({ query: "x" }), context());
		const cancelled = new AbortController();
		cancelled.abort();
		await expect(
			t.execute(t.parseArguments({ query: "y" }), { ...context("call-2"), signal: cancelled.signal }),
		).rejects.toThrow(/abort/i);
		search.close();
		await expect(t.execute(t.parseArguments({ query: "z" }), context("call-3"))).rejects.toThrow(
			/^COMPANY_FOLDER_UNAVAILABLE/,
		);
		// Give the stand-in node a moment to see anything that was sent.
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(n.searches.map((s) => s.query)).toEqual(["x"]);
	});

	it("checks its arguments closely, and says why", () => {
		const search = tool("/x", folder().client);
		for (const bad of [
			{},
			{ query: "" },
			{ query: "a\nb" },
			{ query: "x".repeat(257) },
			{ query: "x", extra: 1 },
			{ query: "x", path: "../up" },
			{ query: "x", path: "docs/" },
			{ query: "x", path: "/" },
			{ query: "x", names_only: "yes" },
			{ query: "x", glob: "" },
			{ path: "docs" },
			{ glob: "*.md", regex: true },
			{ glob: "*.md", files_only: true },
			{ glob: "*.md", context: 1 },
			{ query: "x", context: 6 },
			{ query: "x", context: 1.5 },
			{ query: "x", context: "2" },
			{ query: "x", files_only: true, names_only: true },
			{ query: "x", context: 2, files_only: true },
			{ query: "x", context: 2, names_only: true },
			{ query: "x", regex: "yes" },
		])
			expect(() => search.parseArguments(bad as JsonValue), JSON.stringify(bad)).toThrow(CloudToolArgumentRefusal);
		// A glob alone is a find, of names.
		expect(search.parseArguments({ glob: "**/*.csv" })).toMatchObject({
			query: null,
			glob: "**/*.csv",
			names_only: true,
		});
		expect(search.parseArguments({ query: "x", path: "docs", names_only: true, case_sensitive: true })).toMatchObject(
			{
				path: "docs",
				names_only: true,
				case_sensitive: true,
			},
		);
	});

	it("asks a node that speaks search 2 for its version, pages on until the answer is full, and releases every page's reads once", async () => {
		const V2 = { version: 2, regex: true };
		const pageOf = (n: number) =>
			found({
				hits: [hit(`p${n}.md`, n + 1, `plan ${n}`)],
				searched: 1,
				reads: [read(`p${n}.md`)],
				next: n < 3 ? { path: `p${n + 1}.md`, version: "", offset: 0, line: 0 } : null,
			});
		const n = await node(
			(search) => pageOf(search.after === null ? 0 : Number((search.after as { path: string }).path[1])),
			V2,
		);
		const f = folder();
		const search = tool(n.path, f.client);
		const content = await search.execute(search.parseArguments({ query: "pl.n", regex: true }), context());
		expect(content.value).toBe(
			"p0.md:1: plan 0\np1.md:2: plan 1\np2.md:3: plan 2\np3.md:4: plan 3\n\n4 files searched. Nothing more.",
		);
		expect(n.searches[0]).toEqual({
			version: 2,
			query: "pl.n",
			regex: true,
			path: "",
			glob: null,
			namesOnly: false,
			filesOnly: false,
			caseSensitive: false,
			context: 0,
			after: null,
		});
		expect(n.searches.map((s) => (s.after as { path: string } | null)?.path ?? null)).toEqual([
			null,
			"p1.md",
			"p2.md",
			"p3.md",
		]);
		expect(f.releases).toHaveLength(1);
		expect(f.releases[0]!.reads.map((r) => r.path)).toEqual(["p0.md", "p1.md", "p2.md", "p3.md"]);
		// An endless search answers after six pages, with a cursor.
		const endless = await node(
			(search) =>
				found({
					hits: [hit("e.md", 1, "x")],
					next: {
						path: "e.md",
						version: VERSION,
						offset: ((search.after as { offset: number } | null)?.offset ?? 0) + 2,
						line: 1,
					},
				}),
			V2,
		);
		const e = tool(endless.path, folder().client);
		const answer = (await e.execute(e.parseArguments({ query: "x" }), context())).value as string;
		expect(endless.searches).toHaveLength(6);
		expect(answer).toMatch(/More: call again with cursor [A-Za-z0-9_-]{16}$/);
	});

	it("shows lines around each hit as rg does, and counts files with files_only, a file two pages counted being one", async () => {
		const V2 = { version: 2, regex: true };
		const ctx = (line: number, text: string, before: string[], after: string[], from = 0) => ({
			...hit("a.md", line, text, from + 10),
			before,
			after,
			from,
		});
		const n = await node(
			() =>
				found({
					hits: [
						ctx(4, "line 4 plan", ["line 2", "line 3"], []),
						ctx(5, "line 5 plan", [], ["line 6"]),
						ctx(10, "line 10 plan", ["line 9"], []),
						{ ...hit("b.md", 1, "plan b"), before: [], after: [], from: 0 },
					],
					searched: 2,
				}),
			V2,
		);
		const search = tool(n.path, folder().client);
		const shown = await search.execute(search.parseArguments({ query: "plan", context: 2 }), context());
		expect(shown.value).toBe(
			[
				"a.md-2- line 2",
				"a.md-3- line 3",
				"a.md:4: line 4 plan",
				"a.md:5: line 5 plan",
				"a.md-6- line 6",
				"--",
				"a.md-9- line 9",
				"a.md:10: line 10 plan",
				"--",
				"b.md:1: plan b",
				"",
				"2 files searched. Nothing more.",
			].join("\n"),
		);
		expect(n.searches[0]).toMatchObject({ context: 2 });
		// Files only: a file the first page ended inside, counted on by the second, shows once with its whole count.
		const counts = await node(
			(search) =>
				search.after === null
					? found({
							files: [
								{ path: "a.md", version: VERSION, count: 2 },
								{ path: "big.md", version: VERSION, count: 40, partial: true },
							],
							searched: 1,
							next: { path: "big.md", version: VERSION, offset: 900, line: 80 },
						})
					: found({
							files: [{ path: "big.md", version: VERSION, count: 2 }],
							searched: 1,
							reads: [read("big.md")],
						}),
			V2,
		);
		const c = tool(counts.path, folder().client);
		expect((await c.execute(c.parseArguments({ query: "plan", files_only: true }), context())).value).toBe(
			"a.md: 2\nbig.md: 42\n\n2 files searched. Nothing more.",
		);
		expect(counts.searches[0]).toMatchObject({ filesOnly: true });
		// A glob alone finds paths: names, with no query.
		const finds = await node(() => found({ hits: [hit("docs/q3.csv", 0, ""), hit("docs", 0, "", 0, "folder")] }), V2);
		const g = tool(finds.path, folder().client);
		expect((await g.execute(g.parseArguments({ glob: "**/*.csv" }), context())).value).toBe(
			"docs/q3.csv\ndocs/\n\n0 files searched. Nothing more.",
		);
		expect(finds.searches[0]).toMatchObject({ query: null, glob: "**/*.csv", namesOnly: true });
	});

	it("asks a node that has not said search 2 only what it takes, and says so for the rest without sending it", async () => {
		const n = await node(() => found({}));
		const search = tool(n.path, folder().client);
		const asks: JsonValue[] = [
			{ query: "a+", regex: true },
			{ query: "a", files_only: true },
			{ query: "a", context: 1 },
			{ glob: "*.md" },
		];
		for (const args of asks)
			await expect(search.execute(search.parseArguments(args), context())).rejects.toThrow(/^SEARCH_NOT_HERE_YET: /);
		expect(n.searches).toEqual([]);
		await search.execute(search.parseArguments({ query: "a", names_only: true }), context());
		expect(n.searches).toEqual([
			{ query: "a", path: "", glob: null, namesOnly: true, caseSensitive: false, after: null },
		]);
		// A node of search 2 without the linear engine (the unit as it ships since v240) takes no pattern, and the
		// description says so before the model asks: a pattern only where the search runs them.
		const plain = await node(() => found({}), { version: 2, regex: false });
		const p = tool(plain.path, folder().client);
		await expect(p.execute(p.parseArguments({ query: "a+", regex: true }), context())).rejects.toThrow(
			/^REGEX_OFF: this node's folder search runs no regular expressions yet; search for text$/,
		);
		expect(plain.searches).toEqual([]);
		expect(p.description).toContain(
			"if the folder's search runs them; REGEX_OFF means it does not, so search for text.",
		);
	});

	it("says what the node said of a pattern it does not run, or of being full, and keeps the connection", async () => {
		const V2 = { version: 2, regex: true };
		const n = await node(
			(search) =>
				search.query === "(a)\\1"
					? {
							kind: 0x65,
							body: {
								code: "BAD_REQUEST",
								message: "REGEX_BACKREFERENCE: a back-reference cannot run in linear time; search without it",
							},
						}
					: search.query === "busy"
						? {
								kind: 0x65,
								body: {
									code: "UNAVAILABLE",
									message: "SEARCH_BUSY: the node's folder search is busy; try again shortly",
								},
							}
						: search.query === "odd"
							? { kind: 0x65, body: { code: "BAD_REQUEST", message: "Bad query\nsecond line" } }
							: found({}),
			V2,
		);
		const search = tool(n.path, folder().client);
		await expect(search.execute(search.parseArguments({ query: "(a)\\1", regex: true }), context())).rejects.toThrow(
			/^REGEX_BACKREFERENCE: a back-reference cannot run in linear time/,
		);
		await expect(search.execute(search.parseArguments({ query: "busy" }), context())).rejects.toThrow(
			/^COMPANY_FOLDER_BUSY: /,
		);
		// Any other message is not the search's own words: it is not passed on.
		await expect(search.execute(search.parseArguments({ query: "odd" }), context())).rejects.toThrow(
			/^BAD_REQUEST: the folder search refused the request$/,
		);
		await search.execute(search.parseArguments({ query: "x" }), context());
		expect(n.hellos).toHaveLength(1);
	});

	it("answers with what came when a later page fails, and goes on from where that page began", async () => {
		const next = { path: "b.md", version: VERSION, offset: 0, line: 0 };
		const n = await node(
			(search) =>
				search.after === null
					? found({ hits: [hit("a.md", 1, "plan")], reads: [read("a.md")], searched: 1, next })
					: refused("UNAVAILABLE"),
			{ version: 2, regex: true },
		);
		const f = folder();
		const search = tool(n.path, f.client);
		const first = (await search.execute(search.parseArguments({ query: "plan" }), context())).value as string;
		expect(first).toMatch(/^a\.md:1: plan\n\n1 file searched\. More: call again with cursor [A-Za-z0-9_-]{16}$/);
		expect(f.releases[0]!.reads.map((r) => r.path)).toEqual(["a.md"]);
		const cursor = /cursor (\S+)$/.exec(first)![1]!;
		await expect(search.execute(search.parseArguments({ query: "plan", cursor }), context("call-2"))).rejects.toThrow(
			/^COMPANY_FOLDER_UNAVAILABLE/,
		);
		expect(n.searches.at(-1)!.after).toEqual(next);
	});

	it("closes a count a page carried when the file ends with nothing more, and carries it across calls", async () => {
		const V2 = { version: 2, regex: true };
		const mid = (offset: number) => ({ path: "big.md", version: VERSION, offset, line: 9 });
		// Within one call: a count of 0 at the file's end closes the count the first page left going on.
		const within = await node(
			(search) =>
				search.after === null
					? found({ files: [{ path: "big.md", version: VERSION, count: 2, partial: true }], next: mid(900) })
					: found({
							files: [{ path: "big.md", version: VERSION, count: 0 }],
							searched: 1,
							reads: [read("big.md")],
						}),
			V2,
		);
		const w = tool(within.path, folder().client);
		expect((await w.execute(w.parseArguments({ query: "plan", files_only: true }), context())).value).toBe(
			"big.md: 2\n\n1 file searched. Nothing more.",
		);
		// Across calls: a call that ends inside the file shows its count as going on, and the next call shows the whole.
		let t = 0;
		const clock = () => {
			t += 20_000;
			return t;
		};
		const across = await node(
			(search) =>
				search.after === null
					? found({ files: [{ path: "big.md", version: VERSION, count: 40, partial: true }], next: mid(900) })
					: found({
							files: [{ path: "big.md", version: VERSION, count: 2 }],
							searched: 1,
							reads: [read("big.md")],
						}),
			V2,
		);
		const f = folder();
		const search = new CloudFolderSearch({
			socketPath: across.path,
			folder: f.client,
			environmentId: ENV,
			now: clock,
		});
		const a = cloudFolderSearchTool({ search, folder: f.client, runId: RUN });
		const first = (await a.execute(a.parseArguments({ query: "plan", files_only: true }), context())).value as string;
		expect(first).toMatch(
			/^big\.md: 40 so far \(the count goes on with the cursor\)\n\n0 files searched\. More: call again with cursor /,
		);
		expect(across.searches).toHaveLength(1);
		const cursor = /cursor (\S+)$/.exec(first)![1]!;
		expect(
			(await a.execute(a.parseArguments({ query: "plan", files_only: true, cursor }), context("call-2"))).value,
		).toBe("big.md: 42\n\n1 file searched. Nothing more.");
		// A line a pattern could not search is named, not left out silently.
		const longs = await node(() => found({ hits: [hit("a.md", 3, "plan")], searched: 1, longLines: 2 }), V2);
		const l = tool(longs.path, folder().client);
		expect((await l.execute(l.parseArguments({ query: "pl.n", regex: true }), context())).value).toBe(
			"a.md:3: plan\n\n1 file searched; 2 lines over 1 MiB not searched by the pattern (search them as text, or read them). Nothing more.",
		);
	});

	it("never shows two versions of a file: one replaced between two pages of a call shows as it is now, and only that is released (release review r1 of #1731)", async () => {
		const V2 = { version: 2, regex: true };
		const NEW = "81100000-0000-4000-8000-0000000000b2";
		const inside = (version: string, offset: number) => ({ path: "big.md", version, offset, line: 40 });
		const readAt = (path: string, version: string) => ({ path, kind: "file", version, authority: RECEIPT });
		const released = (f: ReturnType<typeof folder>) => f.releases.flatMap((r) => r.reads);
		// Files only: page one counts 40 lines of the old version and ends inside it; the file is replaced, so the node
		// counts the new version from its start (2), and the old count, unfinished, is not shown.
		const counts = await node(
			(search) =>
				search.after === null
					? found({
							files: [{ path: "big.md", version: VERSION, count: 40, partial: true }],
							reads: [read("big.md")],
							next: inside(VERSION, 900),
						})
					: found({
							files: [{ path: "big.md", version: NEW, count: 2 }],
							searched: 1,
							reads: [readAt("big.md", NEW)],
						}),
			V2,
		);
		const c = folder();
		const ct = tool(counts.path, c.client);
		expect((await ct.execute(ct.parseArguments({ query: "plan", files_only: true }), context())).value).toBe(
			"big.md: 2\n\n1 file searched. Nothing more.",
		);
		expect(counts.searches[1]).toMatchObject({ after: inside(VERSION, 900) });
		expect(released(c)).toEqual([{ path: "big.md", version: NEW, authority: RECEIPT }]);
		// Lines: what page one showed of the old version is left out with its read; the new version shows from line 1.
		const lines = await node(
			(search) =>
				search.after === null
					? found({
							hits: [hit("a.md", 2, "plan a"), hit("big.md", 3, "plan one"), hit("big.md", 7, "plan two")],
							searched: 1,
							reads: [read("a.md"), read("big.md")],
							next: inside(VERSION, 400),
						})
					: found({
							hits: [{ ...hit("big.md", 1, "plan, new"), version: NEW }],
							searched: 1,
							reads: [readAt("big.md", NEW)],
						}),
			V2,
		);
		const l = folder();
		const lt = tool(lines.path, l.client);
		expect((await lt.execute(lt.parseArguments({ query: "plan" }), context())).value).toBe(
			"a.md:2: plan a\nbig.md:1: plan, new\n\n2 files searched. Nothing more.",
		);
		expect(released(l)).toEqual([
			{ path: "a.md", version: VERSION, authority: RECEIPT },
			{ path: "big.md", version: NEW, authority: RECEIPT },
		]);
		// Version 1 pages (an old node) go the same way.
		const old = await node((search) =>
			search.after === null
				? found({ hits: [hit("big.md", 3, "plan one")], reads: [read("big.md")], next: inside(VERSION, 400) })
				: found({
						hits: [{ ...hit("big.md", 1, "plan, new"), version: NEW }],
						searched: 1,
						reads: [readAt("big.md", NEW)],
					}),
		);
		const ot = tool(old.path, folder().client);
		expect((await ot.execute(ot.parseArguments({ query: "plan" }), context())).value).toBe(
			"big.md:1: plan, new\n\n1 file searched. Nothing more.",
		);
	});

	it("leaves out what it showed of a file gone between two pages of a call, and its read (release review r1 of #1731)", async () => {
		const gone = await node(
			(search) =>
				search.after === null
					? found({
							hits: [hit("a.md", 2, "plan a"), hit("big.md", 3, "plan one")],
							searched: 1,
							reads: [read("a.md"), read("big.md")],
							next: { path: "big.md", version: VERSION, offset: 400, line: 3 },
						})
					: // The walk goes on at the next path: big.md is gone, or no longer the run's to read.
						found({ hits: [hit("c.md", 5, "plan c")], searched: 1, reads: [read("c.md")] }),
			{ version: 2, regex: true },
		);
		const g = folder();
		const gt = tool(gone.path, g.client);
		expect((await gt.execute(gt.parseArguments({ query: "plan" }), context())).value).toBe(
			"a.md:2: plan a\nc.md:5: plan c\n\n2 files searched. Nothing more.",
		);
		expect(g.releases.flatMap((r) => r.reads).map((r) => r.path)).toEqual(["a.md", "c.md"]);
	});

	it("shows and releases nothing when the search's own path went away between two pages of a call (review r9 of #1698)", async () => {
		const V2 = { version: 2, regex: true };
		// The path searched is the file itself, or a folder holding it; it is deleted (or no longer the run's to read)
		// after the first page, so the node finds no such path for the next one.
		for (const [path, first] of [
			["big.md", [hit("big.md", 3, "plan one"), hit("big.md", 7, "plan two")]],
			["docs", [hit("docs/a.md", 2, "plan a"), hit("docs/big.md", 3, "plan one")]],
		] as const) {
			const n = await node(
				(search) =>
					search.after === null
						? found({
								hits: [...first],
								searched: 1,
								reads: first.map((h) => read(h.path)),
								next: { path: first.at(-1)!.path, version: VERSION, offset: 400, line: 3 },
							})
						: refused("NOT_FOUND"),
				V2,
			);
			const f = folder();
			const t = tool(n.path, f.client);
			await expect(t.execute(t.parseArguments({ query: "plan", path }), context())).rejects.toThrow(
				/^NOT_FOUND: no such path in the folder you may read$/,
			);
			expect(n.searches).toHaveLength(2);
			expect(f.releases).toEqual([]);
		}
	});

	it("says so when the file the last answer ended inside changed or went away before the next call", async () => {
		const V2 = { version: 2, regex: true };
		const NEW = "81100000-0000-4000-8000-0000000000b2";
		const inside = { path: "big.md", version: VERSION, offset: 400, line: 3 };
		const twice = async (next: Record<string, unknown>) => {
			const n = await node(
				(search) =>
					search.after === null
						? found({ hits: [hit("big.md", 3, "plan one")], reads: [read("big.md")], next: inside })
						: found(next),
				V2,
			);
			// One page a call: the clock passes a call's 10 s at each look.
			let t = 0;
			const f = folder();
			const search = new CloudFolderSearch({
				socketPath: n.path,
				folder: f.client,
				environmentId: ENV,
				now: () => {
					t += 20_000;
					return t;
				},
			});
			const s = cloudFolderSearchTool({ search, folder: f.client, runId: RUN });
			const first = (await s.execute(s.parseArguments({ query: "plan" }), context())).value as string;
			const cursor = /cursor (\S+)$/.exec(first)![1]!;
			return (await s.execute(s.parseArguments({ query: "plan", cursor }), context("call-2"))).value;
		};
		expect(
			await twice({
				hits: [{ ...hit("big.md", 1, "plan, new"), version: NEW }],
				searched: 1,
				reads: [{ ...read("big.md"), version: NEW }],
			}),
		).toBe(
			"big.md:1: plan, new\n\nbig.md changed since the last answer: it is searched again from its start.\n\n1 file searched. Nothing more.",
		);
		expect(await twice({ hits: [hit("c.md", 5, "plan c")], searched: 1, reads: [read("c.md")] })).toBe(
			"c.md:5: plan c\n\nbig.md is not as the last answer saw it (changed, emptied, gone, or no longer yours to read): what that answer showed of it may not hold.\n\n1 file searched. Nothing more.",
		);
		// Unchanged, it simply goes on.
		expect(await twice({ hits: [hit("big.md", 9, "plan three")], searched: 1, reads: [read("big.md")] })).toBe(
			"big.md:9: plan three\n\n1 file searched. Nothing more.",
		);
	});

	// Release review r2 of #1731: a cursor inside a file is no proof an answer showed any of it. A search tool whose clock
	// the test moves (20 s at each look while `slow`, so one page a call; none after), and a file's changed version.
	const CHANGED = "81100000-0000-4000-8000-0000000000b2";
	const changed = (path: string) =>
		found({
			hits: [{ ...hit(path, 1, "plan, new"), version: CHANGED }],
			searched: 1,
			reads: [{ path, kind: "file", version: CHANGED, authority: RECEIPT }],
		});
	const inBig = (offset: number) => ({ path: "big.md", version: VERSION, offset, line: offset / 10 });
	const cursorOf = (text: string) => /cursor (\S+)$/.exec(text)![1]!;
	const searching = (n: Awaited<ReturnType<typeof node>>) => {
		let t = 0;
		const clock = { slow: true };
		const f = folder();
		const search = new CloudFolderSearch({
			socketPath: n.path,
			folder: f.client,
			environmentId: ENV,
			now: () => {
				if (clock.slow) t += 20_000;
				return t;
			},
		});
		const s = cloudFolderSearchTool({ search, folder: f.client, runId: RUN });
		const call = async (cursor: string | null, id: string) =>
			(await s.execute(s.parseArguments({ query: "plan", ...(cursor ? { cursor } : {}) }), context(id)))
				.value as string;
		return { call, clock };
	};

	it("says nothing of a changed file whose first hit the fitting left out, though the cursor was inside it (release review r2 of #1731)", async () => {
		// The answer shows a.md's hit; b.md's first hit (line 5) does not fit with it, so the cursor is inside b.md.
		const n = await node(
			(search) =>
				search.after === null
					? found({
							hits: [hit("a.md", 1, "<".repeat(4096)), hit("b.md", 5, `plan ${"<".repeat(4090)}`, 400)],
							searched: 2,
							reads: [read("a.md"), read("b.md")],
						})
					: changed("b.md"),
			{ version: 2, regex: true },
		);
		const s = searching(n);
		const first = await s.call(null, "call-1");
		expect(first).toMatch(/^a\.md:1: <+\n\nPart of the answer\. More: call again with cursor \S+$/);
		expect(first).not.toContain("b.md");
		const next = await s.call(cursorOf(first), "call-2");
		expect(n.searches[1]!.after).toEqual({ path: "b.md", version: VERSION, offset: 400, line: 4 });
		expect(next).toBe("b.md:1: plan, new\n\n1 file searched. Nothing more.");
	});

	it("says nothing of a changed file the search ran out of time inside before a hit, at a call's start or between its pages (release review r2 of #1731)", async () => {
		for (const between of [false, true]) {
			const n = await node(
				(search) =>
					search.after === null
						? found({ hits: [hit("a.md", 2, "plan a")], searched: 1, reads: [read("a.md")], next: inBig(900) })
						: between && (search.after as { offset: number }).offset === 900
							? // The next call goes on in big.md at that version, still without a hit, and then it changes.
								found({ reads: [read("big.md")], next: inBig(1800) })
							: changed("big.md"),
				{ version: 2, regex: true },
			);
			const s = searching(n);
			const first = await s.call(null, "call-1");
			expect(first).toMatch(/^a\.md:2: plan a\n\n1 file searched\. More: call again with cursor \S+$/);
			s.clock.slow = false;
			expect(await s.call(cursorOf(first), "call-2")).toBe("big.md:1: plan, new\n\n1 file searched. Nothing more.");
			expect(n.searches.map((x) => (x.after as { offset: number } | null)?.offset ?? null)).toEqual(
				between ? [null, 900, 1800] : [null, 900],
			);
		}
	});

	it("says so of a changed file while the cursor stays in the version an answer showed part of, through a call that shows nothing more of it", async () => {
		let pages = 0;
		const n = await node(
			() => {
				pages++;
				return pages === 1
					? found({ hits: [hit("big.md", 3, "plan one")], reads: [read("big.md")], next: inBig(900) })
					: pages === 2
						? found({ reads: [read("big.md")], next: inBig(1800) })
						: changed("big.md");
			},
			{ version: 2, regex: true },
		);
		const s = searching(n);
		const one = await s.call(null, "call-1");
		const two = await s.call(cursorOf(one), "call-2");
		expect(two).toMatch(/^No matches here\.\n\n0 files searched\. More: call again with cursor \S+$/);
		expect(await s.call(cursorOf(two), "call-3")).toBe(
			"big.md:1: plan, new\n\nbig.md changed since the last answer: it is searched again from its start.\n\n1 file searched. Nothing more.",
		);
	});
});
