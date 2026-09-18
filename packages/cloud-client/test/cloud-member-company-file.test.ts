import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { readCloudFileBytes } from "../src/cloud-file-bytes.ts";
import { CloudMemberCompanyFileReader } from "../src/index.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const signal = () => new AbortController().signal;
function fixture(size = 6, snapshot = false) {
	const bytes = new Uint8Array(size).fill(255);
	if (size) bytes[0] = 0;
	const chunks = [];
	const objects = new Map<string, Uint8Array>();
	for (let offset = 0; offset < size; offset += 4194304) {
		const chunk = bytes.slice(offset, offset + 4194304),
			sha256 = hash(chunk);
		objects.set(sha256, chunk);
		chunks.push({ sha256, bytes: chunk.length });
	}
	const manifest = {
		schema: "qorpera.cloud-file-manifest/v1",
		fileSha256: hash(bytes),
		bytes: size,
		mediaType: "application/octet-stream",
		chunks,
	};
	const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest)),
		manifestSha256 = hash(manifestBytes);
	objects.set(manifestSha256, manifestBytes);
	const file = { manifestSha256, fileSha256: hash(bytes), bytes: size, mediaType: "application/octet-stream" };
	const selection = { realm: "company_file" as const, path: "documents/æble.bin", version: id(3) };
	const state = { version: selection.version, deny: false, afterObject: () => {} };
	const request = vi.fn<typeof fetch>(async (url, init) => {
		expect(init?.redirect).toBe("error");
		expect(new Request(url, init).cache).toBe("no-store");
		const headers = new Headers(init?.headers);
		expect(headers.has("user-agent")).toBe(false);
		expect(headers.get("authorization")).toBe("Bearer member-token");
		if (state.deny) return new Response(null, { status: 403 });
		if (String(url).startsWith("https://authority.test/")) {
			expect(JSON.parse(init?.body as string)).toEqual({
				p_environment_id: id(2),
				...(snapshot ? { p_snapshot_id: selection.version } : { p_binding: null }),
				p_path: selection.path,
			});
			return Response.json({
				companyId: id(1),
				path: selection.path,
				version: state.version,
				entry: { path: selection.path, kind: "file", executable: false, file },
				manifestBytes: manifestBytes.length,
			});
		}
		expect(
			String(url).startsWith(
				`https://objects.test/v1/member-company${snapshot ? "-snapshot" : ""}-objects/${id(2)}/${selection.version}/`,
			),
		).toBe(true);
		expect(headers.get("x-qorpera-company-path")).toBe(Buffer.from(selection.path).toString("base64url"));
		const body = objects.get(String(url).split("/").at(-1)!);
		expect(body).toBeDefined();
		state.afterObject();
		return new Response(Uint8Array.from(body!), {
			headers: { "content-length": String(body!.length), "x-qorpera-access-mode": "live-path-authority" },
		});
	});
	const token = vi.fn(async () => "member-token");
	const reader = new CloudMemberCompanyFileReader({
		companyId: id(1),
		environmentId: id(2),
		supabaseUrl: "https://authority.test",
		objectGatewayUrl: "https://objects.test",
		publishableKey: "publishable",
		accessToken: token,
		fetch: request,
		snapshotId: snapshot ? selection.version : undefined,
	});
	return { reader, bytes, manifest, file, manifestBytes, objects, state, selection, request, token };
}

describe("shared member file downloads", () => {
	it("describes a binary upload destination without reading its objects", async () => {
		const f = fixture(4194305);
		expect(await f.reader.describe(f.selection.path, signal())).toMatchObject({
			path: f.selection.path,
			version: f.selection.version,
			entry: { kind: "file", file: f.file },
		});
		expect(f.request).toHaveBeenCalledOnce();
	});
	it.each([0, 6, 4194305])("downloads %i bytes with exact immutable source provenance", async (size) => {
		const f = fixture(size),
			result = await f.reader.download(f.selection, signal());
		expect(result).toEqual({
			source: {
				...f.selection,
				companyId: id(1),
				environmentId: id(2),
				sha256: f.file.fileSha256,
				manifestSha256: f.file.manifestSha256,
			},
			bytes: f.bytes,
			mediaType: "application/octet-stream",
		});
		expect(f.token).toHaveBeenCalledOnce();
	});
	it("rejects a stale member selection before immutable object reads", async () => {
		const f = fixture();
		f.state.version = id(4);
		await expect(f.reader.download(f.selection, signal())).rejects.toThrow("version changed");
		expect(f.request).toHaveBeenCalledOnce();
	});
	it.each(["version", "grant"])("rechecks %s after downloading bytes", async (kind) => {
		const f = fixture();
		f.state.afterObject = () => {
			if (kind === "version") f.state.version = id(4);
			else f.state.deny = true;
		};
		await expect(f.reader.download(f.selection, signal())).rejects.toThrow(
			kind === "version" ? "changed during read" : "403",
		);
	});
	it("copies the member selection before waiting on access tokens", async () => {
		const f = fixture(),
			selected = { ...f.selection };
		const result = f.reader.download(selected, signal());
		selected.version = id(9);
		selected.path = "private";
		expect((await result).source).toMatchObject(f.selection);
	});
	it.each([
		{ realm: "member_device" },
		{ version: null },
		{ version: "latest" },
		{ path: "../secret" },
		{ extra: true },
	])("rejects invalid selection %j before sign-in", (change) => {
		const f = fixture();
		expect(() => f.reader.download({ ...f.selection, ...change } as never, signal())).toThrow();
		expect(f.token).not.toHaveBeenCalled();
	});
	it("honors a caller size limit before object reads", async () => {
		const f = fixture();
		await expect(f.reader.download(f.selection, signal(), 5)).rejects.toThrow("size limit");
		expect(f.request).toHaveBeenCalledOnce();
	});
	it("does not release downloaded bytes after cancellation", async () => {
		const f = fixture(),
			stop = new AbortController();
		f.state.afterObject = () => stop.abort();
		await expect(f.reader.download(f.selection, stop.signal)).rejects.toThrow();
	});
});

describe("browser file manifest integrity", () => {
	it.each(["extra", "chunk-extra", "short-interior", "length", "complete-hash"])(
		"refuses %s with individually valid stored object hashes",
		async (kind) => {
			const f = fixture();
			const manifest: Record<string, unknown> = { ...f.manifest };
			const reference = { ...f.file };
			if (kind === "extra") manifest.rawPath = "/private";
			if (kind === "chunk-extra") manifest.chunks = [{ ...f.manifest.chunks[0], url: "https://private.test" }];
			if (kind === "short-interior") manifest.chunks = [f.manifest.chunks[0], f.manifest.chunks[0]];
			if (kind === "length") manifest.chunks = [];
			if (kind === "complete-hash") manifest.fileSha256 = reference.fileSha256 = "f".repeat(64);
			const raw = new TextEncoder().encode(JSON.stringify(manifest));
			reference.manifestSha256 = hash(raw);
			f.objects.set(reference.manifestSha256, raw);
			await expect(
				readCloudFileBytes(reference, raw.length, async (sha) => f.objects.get(sha)!, signal()),
			).rejects.toThrow();
		},
	);
});

describe("published snapshot reads", () => {
	it("uses only snapshot authority and preserves selected historical bytes", async () => {
		const f = fixture(6, true);
		expect((await f.reader.read(f.selection.path, signal())).bytes).toEqual(f.bytes);
		const rpc = f.request.mock.calls.filter(([url]) => String(url).startsWith("https://authority.test/"));
		expect(rpc).toHaveLength(2);
		expect(rpc.every(([url]) => String(url).endsWith("/qorpera_read_member_company_snapshot_path"))).toBe(true);
	});
	it("refuses substitution of the current head for the historical snapshot", async () => {
		const f = fixture(6, true);
		f.state.version = id(9);
		await expect(f.reader.read(f.selection.path, signal())).rejects.toThrow("scope changed");
		expect(f.request).toHaveBeenCalledOnce();
	});
	it("discards historical bytes after current membership is revoked", async () => {
		const f = fixture(6, true);
		f.state.afterObject = () => {
			f.state.deny = true;
		};
		await expect(f.reader.read(f.selection.path, signal())).rejects.toThrow("403");
	});
});

function listing(change: Record<string, unknown> = {}) {
	const entries = Array.from({ length: 101 }, (_, n) => ({
		kind: "directory",
		path: `folder${String(n).padStart(3, "0")}`,
	}));
	const request = vi.fn<typeof fetch>(async (_url, init) => {
		const body = JSON.parse(init?.body as string);
		expect(body.p_snapshot_id).toBe(id(3));
		expect(body.p_limit).toBe(100);
		const first = body.p_after === null;
		if (!first) expect(body.p_after).toBe(entries[99]!.path);
		return Response.json({
			companyId: id(1),
			environmentId: id(2),
			snapshotId: id(3),
			items: first ? entries.slice(0, 100) : entries.slice(100),
			hasMore: first,
			nextAfter: first ? entries[99]!.path : null,
			...change,
		});
	});
	const reader = new CloudMemberCompanyFileReader({
		companyId: id(1),
		environmentId: id(2),
		snapshotId: id(3),
		supabaseUrl: "https://authority.test",
		objectGatewayUrl: "https://objects.test",
		publishableKey: "publishable",
		accessToken: async () => "member-token",
		fetch: request,
	});
	return { reader, request, entries };
}
describe("filtered snapshot pagination", () => {
	it("uses UTF-8 ordering across supplementary Unicode paths", async () => {
		const items = [
			{ kind: "directory", path: "\uE000" },
			{ kind: "directory", path: "\u{10000}" },
		];
		expect(await listing({ items, hasMore: false, nextAfter: null }).reader.listSnapshotEntries(signal())).toEqual(
			items,
		);
	});
	it("collects ordered pages without fetching a tree object", async () => {
		const f = listing();
		expect(await f.reader.listSnapshotEntries(signal())).toEqual(f.entries);
		expect(f.request).toHaveBeenCalledTimes(2);
		expect(
			f.request.mock.calls.every(([url]) => String(url).endsWith("/qorpera_list_member_company_snapshot_paths")),
		).toBe(true);
	});
	it.each([
		{ snapshotId: id(9) },
		{ companyId: id(9) },
		{ environmentId: id(9) },
		{ nextAfter: "secret" },
		{ items: [], hasMore: true },
		{ hasMore: false },
		{ extra: true },
		{ items: [{ kind: "directory", path: "../private" }] },
		{
			items: [
				{ kind: "directory", path: "b" },
				{ kind: "directory", path: "a" },
			],
		},
	])("rejects malformed or scope-changing pages %j", async (change) => {
		await expect(listing(change).reader.listSnapshotEntries(signal())).rejects.toThrow();
	});
	it("discards an earlier page when access to a later page is denied", async () => {
		const f = listing();
		const original = f.request.getMockImplementation()!;
		f.request
			.mockImplementationOnce(original)
			.mockImplementationOnce(async () => new Response(null, { status: 403 }));
		await expect(f.reader.listSnapshotEntries(signal())).rejects.toThrow("403");
	});
});
