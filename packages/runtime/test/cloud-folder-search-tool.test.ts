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

/** A stand-in node folder service on a Unix socket: hellos, then search pages as the test says. */
async function node(answer: Answer) {
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
						socket.write(frame(0x68, { protocol: 1, viewId: body.viewId, asOfSeq: 1, readOnly: true }));
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
			names_only: false,
			case_sensitive: false,
			cursor: null,
		});
		const content = await search.execute(args, context());
		expect(content.value).toBe(
			"docs/plan.md:3: the plan\nplans/\n\n2 files searched, 1 binary passed over. Nothing more.",
		);
		expect(n.hellos).toEqual([{ protocol: 1, environmentId: ENV, viewId: VIEW, pass: PASS, role: "io" }]);
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

	it("gives an opaque cursor to go on with, and passes back where the node said, never a path the model sent", async () => {
		const next = { path: "docs/big.md", version: VERSION, offset: 4096, line: 80 };
		const n = await node((search) =>
			search.after === null ? found({ hits: [hit("a.md", 1, "x")], next }) : found({}),
		);
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
		expect(text).toContain("Part of a page");
		// One hit too long for a result is still shown, cut, and the search goes on after it.
		const long = folderSearchText(
			{
				hits: [hit(`${"<".repeat(900)}.md`, 1, "&".repeat(1000)), hit("next.md", 1, "x")],
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
		])
			expect(() => search.parseArguments(bad as JsonValue)).toThrow(CloudToolArgumentRefusal);
		expect(search.parseArguments({ query: "x", path: "docs", names_only: true, case_sensitive: true })).toMatchObject(
			{
				path: "docs",
				names_only: true,
				case_sensitive: true,
			},
		);
	});
});
