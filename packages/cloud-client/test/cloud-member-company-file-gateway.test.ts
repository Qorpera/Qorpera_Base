import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudContentAddressedStore } from "@qorpera/cloud-client/node/cloud-object-store";
import { afterEach, expect, it, vi } from "vitest";
import { FileSystemObjectStore } from "../../object-gateway/src/object-store.ts";
import { createObjectGatewayHandler } from "../../object-gateway/src/service.ts";
import { SupabaseObjectAuthority } from "../../object-gateway/src/supabase-authority.ts";
import { CloudMemberCompanyFileReader } from "../src/cloud-member-company-file.ts";

const companyId = "31000000-0000-4000-8000-000000000010";
const environmentId = "31000000-0000-4000-8000-000000000020";
const version = "31000000-0000-4000-8000-000000000030";
const path = "documents/strategy.md";
const token = "synthetic-member-token";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(content = Buffer.from("A live company, without a model-account dependency.")) {
	const objects = new Map<string, Uint8Array>();
	const store = new CloudContentAddressedStore({
		put: async (objectPath, bytes) => {
			objects.set(objectPath.split("/")[1]!, Uint8Array.from(bytes));
			return "stored";
		},
		get: async (objectPath) => objects.get(objectPath.split("/")[1]!)!,
	});
	const file = await store.putFile(companyId, content, "application/octet-stream");
	const descriptor = {
		path,
		version,
		companyId,
		entry: { path, kind: "file", executable: false, file },
		manifestBytes: objects.get(file.manifestSha256)!.length,
	};
	const state = {
		status: 200,
		descriptor: descriptor as Record<string, unknown>,
		beforeDescribe: () => {},
		afterObject: (_hash: string) => {},
	};
	const rpc = vi.fn<typeof fetch>(async (input, init) => {
		const request = new Request(input, init);
		expect(request.redirect).toBe("error");
		expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
		expect(request.headers.get("apikey")).toBe("sb_publishable_fixture");
		const pathname = new URL(request.url).pathname;
		const args = (await request.json()) as Record<string, unknown>;
		if (pathname === "/rest/v1/rpc/qorpera_read_company_path") {
			expect(args).toEqual({ p_environment_id: environmentId, p_binding: null, p_path: path });
			state.beforeDescribe();
			return state.status === 200
				? Response.json(state.descriptor)
				: new Response("PRIVATE_BACKEND_ERROR", { status: state.status });
		}
		if (pathname === "/rest/v1/rpc/qorpera_authorize_member_company_path_object") {
			expect(Object.keys(args).sort()).toEqual(["p_environment_id", "p_path", "p_sha256", "p_version"]);
			const hash = args.p_sha256 as string;
			if (
				state.status !== 200 ||
				args.p_environment_id !== environmentId ||
				args.p_path !== path ||
				args.p_version !== version ||
				!objects.has(hash)
			)
				return Response.json({}, { status: 403 });
			return Response.json({
				schema: "qorpera.member-company-object/v2",
				companyId,
				actorUserId: "31000000-0000-4000-8000-000000000001",
				resourceId: "31000000-0000-4000-8000-000000000041",
				resourceVersion: "31000000-0000-4000-8000-000000000042",
				environmentId,
				path,
				version,
				sha256: hash,
				bytes: objects.get(hash)!.length,
				backend: "nas-object-gateway",
			});
		}
		throw new Error("Unexpected RPC in member-only fixture");
	});
	const request = vi.fn<typeof fetch>(async (input, init) => {
		const call = new Request(input, init);
		expect(call.redirect).toBe("error");
		expect(call.cache).toBe("no-store");
		const url = new URL(call.url);
		if (url.origin === "https://cloud.test") return rpc(input, init);
		expect(url.origin).toBe("https://objects.test");
		expect(call.method).toBe("GET");
		expect(call.headers.get("authorization")).toBe(`Bearer ${token}`);
		expect(call.headers.get("apikey")).toBeNull();
		// The shared, browser-safe reader never sets its own user agent.
		expect(call.headers.get("user-agent")).toBeNull();
		expect(call.headers.get("x-qorpera-company-path")).toBe(Buffer.from(path).toString("base64url"));
		const parts = url.pathname.split("/");
		expect(parts.slice(0, -1)).toEqual(["", "v1", "member-company-objects", environmentId, version]);
		const hash = parts.at(-1)!;
		const bytes = objects.get(hash);
		if (state.status !== 200 || !bytes) return Response.json({}, { status: 403 });
		state.afterObject(hash);
		return new Response(Uint8Array.from(bytes), {
			headers: { "x-qorpera-access-mode": "live-path-authority", "content-length": String(bytes.length) },
		});
	});
	const options = {
		companyId,
		environmentId,
		supabaseUrl: "https://cloud.test",
		objectGatewayUrl: "https://objects.test",
		publishableKey: "sb_publishable_fixture",
		accessToken: vi.fn(async (_signal: AbortSignal) => token),
		fetch: request,
	};
	return {
		content,
		objects,
		file,
		descriptor,
		state,
		rpc,
		request,
		options,
		reader: new CloudMemberCompanyFileReader(options),
	};
}

it("restores a file with only member authority and checks the path again before delivery", async () => {
	const f = await fixture();
	const result = await f.reader.read(path, new AbortController().signal);
	expect(result).toEqual({ path, version, kind: "file", executable: false, bytes: Uint8Array.from(f.content) });
	expect(f.rpc).toHaveBeenCalledTimes(2);
	expect(f.request).toHaveBeenCalledTimes(4);
	expect(f.options.accessToken).toHaveBeenCalledOnce();
});

it("uses the real member gateway over HTTP rather than the raw-hash route", async () => {
	const f = await fixture();
	const root = await mkdtemp(join(tmpdir(), "qorpera-member-reader-"));
	const store = new FileSystemObjectStore(root);
	for (const [hash, bytes] of f.objects) await store.put(companyId, hash, bytes);
	const authority = new SupabaseObjectAuthority({
		projectUrl: "https://cloud.test",
		publishableKey: "sb_publishable_fixture",
		secretKey: "sb_secret_fixture",
		fetch: f.rpc,
	});
	const server = createServer(
		createObjectGatewayHandler({
			store,
			authority,
			memberObjects: authority,
			controlToken: "synthetic-control",
			verifierToken: "synthetic-verifier",
		}),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing member gateway fixture");
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	});
	const objectGatewayUrl = `http://127.0.0.1:${address.port}`;
	const reader = new CloudMemberCompanyFileReader({
		...f.options,
		objectGatewayUrl,
		fetch: async (input, init) =>
			new URL(String(input)).origin === objectGatewayUrl ? fetch(input, init) : f.rpc(input, init),
	});
	expect((await reader.read(path, new AbortController().signal)).bytes).toEqual(Uint8Array.from(f.content));
	expect(f.rpc).toHaveBeenCalledTimes(6);
});

it("checks the final version even after successfully downloading multiple immutable chunks", async () => {
	const f = await fixture(Buffer.alloc(4 * 1024 * 1024 + 3, 65));
	f.state.afterObject = (hash) => {
		if (hash !== f.file.manifestSha256) f.state.descriptor = { ...f.descriptor, version: companyId };
	};
	await expect(f.reader.read(path, new AbortController().signal)).rejects.toThrow("changed during read");
	expect(f.request).toHaveBeenCalledTimes(5);
});

it.each(["before", "during", "after"])(
	"denies %s-read membership revocation without returning cached bytes",
	async (phase) => {
		const f = await fixture();
		if (phase === "before") f.state.status = 403;
		else
			f.state.afterObject = (hash) => {
				if (phase === "during" || hash !== f.file.manifestSha256) f.state.status = 403;
			};
		await expect(f.reader.read(path, new AbortController().signal)).rejects.toThrow("(403)");
		const count = f.request.mock.calls.length;
		await expect(f.reader.read(path, new AbortController().signal)).rejects.toThrow("(403)");
		expect(f.request).toHaveBeenCalledTimes(count + 1);
	},
);

it.each(["absent", "directory"] as const)(
	"returns an authorized %s without asking for immutable bytes",
	async (kind) => {
		const f = await fixture();
		f.state.descriptor = { ...f.descriptor, entry: kind === "absent" ? null : { path, kind }, manifestBytes: null };
		expect(await f.reader.read(path, new AbortController().signal)).toEqual({
			path,
			version,
			kind,
			executable: false,
			bytes: null,
		});
		expect(f.request).toHaveBeenCalledOnce();
	},
);

it("handles an empty file without inventing a zero-length chunk", async () => {
	const f = await fixture(Buffer.alloc(0));
	expect((await f.reader.read(path, new AbortController().signal)).bytes).toEqual(new Uint8Array());
	expect(f.request).toHaveBeenCalledTimes(3);
});

it("bounds text preview before downloading any object", async () => {
	const f = await fixture(Buffer.alloc(32 * 1024 + 1, 65));
	await expect(f.reader.read(path, new AbortController().signal, 32 * 1024)).rejects.toThrow(
		"viewer\u0027s size limit",
	);
	expect(f.request).toHaveBeenCalledOnce();
});

it.each([
	{ companyId: environmentId },
	{ path: "members/other/private.md" },
	{ version: null },
	{ version: "not-a-version" },
	{ manifestBytes: 0 },
	{ manifestBytes: 8 * 1024 * 1024 + 1 },
	{ entry: { path, kind: "symlink", target: "private" } },
	{ readLease: "not-supported" },
])("rejects changed descriptor identity or schema before object access: %j", async (overrides) => {
	const f = await fixture();
	f.state.descriptor = { ...f.descriptor, ...overrides };
	await expect(f.reader.read(path, new AbortController().signal)).rejects.toThrow();
	expect(f.request).toHaveBeenCalledOnce();
});

it.each([
	{ bytes: -1 },
	{ bytes: 256 * 1024 * 1024 + 1 },
	{ bytes: 1.5 },
	{ manifestSha256: "invalid" },
	{ fileSha256: "invalid" },
	{ mediaType: "text/html" },
	{ url: "https://untrusted.test" },
])("rejects invalid file references before following any object: %j", async (overrides) => {
	const f = await fixture();
	f.state.descriptor = { ...f.descriptor, entry: { ...f.descriptor.entry, file: { ...f.file, ...overrides } } };
	await expect(f.reader.read(path, new AbortController().signal)).rejects.toThrow();
	expect(f.request).toHaveBeenCalledOnce();
});

it.each(["manifest", "chunk"])("verifies %s bytes instead of trusting a successful gateway status", async (object) => {
	const f = await fixture();
	const hash = object === "manifest" ? f.file.manifestSha256 : createHash("sha256").update(f.content).digest("hex");
	f.objects.set(hash, Buffer.from("CORRUPTED_CONTENT"));
	await expect(f.reader.read(path, new AbortController().signal)).rejects.toThrow("integrity verification");
});

it.each(["token", "headers", "body", "error-body"])(
	"bounds stalled %s without retry or raw fallback",
	async (stage) => {
		const f = await fixture();
		const request = vi.fn<typeof fetch>(async () => {
			if (stage === "headers") return new Promise<Response>(() => {});
			return new Response(new ReadableStream({ cancel: () => new Promise<void>(() => {}) }), {
				status: stage === "error-body" ? 403 : 200,
			});
		});
		const reader = new CloudMemberCompanyFileReader({
			...f.options,
			timeoutMs: 20,
			fetch: request,
			accessToken: stage === "token" ? async () => new Promise<string>(() => {}) : f.options.accessToken,
		});
		await expect(reader.read(path, new AbortController().signal)).rejects.toThrow(
			stage === "error-body" ? "(403)" : "request deadline",
		);
		expect(request).toHaveBeenCalledTimes(stage === "token" ? 0 : 1);
	},
);

it("does not start a late request when token acquisition finishes after cancellation", async () => {
	const f = await fixture();
	let resolveToken: (value: string) => void = () => {};
	const reader = new CloudMemberCompanyFileReader({
		...f.options,
		timeoutMs: 10,
		accessToken: () =>
			new Promise<string>((resolve) => {
				resolveToken = resolve;
			}),
	});
	await expect(reader.read(path, new AbortController().signal)).rejects.toThrow("request deadline");
	resolveToken(token);
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(f.request).not.toHaveBeenCalled();
});

it.each(["", "token\nprivate", "a".repeat(8193)])(
	"rejects malformed member credentials before requests",
	async (badToken) => {
		const f = await fixture();
		const reader = new CloudMemberCompanyFileReader({ ...f.options, accessToken: async () => badToken });
		await expect(reader.read(path, new AbortController().signal)).rejects.toThrow("sign-in is unavailable");
		expect(f.request).not.toHaveBeenCalled();
	},
);

it.each([
	"http://cloud.test",
	"https://user:password@cloud.test",
	"https://cloud.test/?token=private",
	"https://cloud.test/path",
])("rejects unapproved control or object origins: %s", async (badUrl) => {
	const f = await fixture();
	expect(() => new CloudMemberCompanyFileReader({ ...f.options, supabaseUrl: badUrl })).toThrow("endpoint");
	expect(() => new CloudMemberCompanyFileReader({ ...f.options, objectGatewayUrl: badUrl })).toThrow("endpoint");
	expect(f.request).not.toHaveBeenCalled();
});

it.each(["../private", "documents/%2e%2e", "documents\\private", "documents/plan. "])(
	"rejects path aliases before token acquisition: %s",
	async (badPath) => {
		const f = await fixture();
		expect(() => f.reader.read(badPath, new AbortController().signal)).toThrow("path");
		expect(f.options.accessToken).not.toHaveBeenCalled();
	},
);

it.each([{ "content-length": "32769" }, { "content-length": "-1" }, { "content-length": "1" }])(
	"rejects oversized, invalid or truncated control bodies: %j",
	async (headers) => {
		const f = await fixture();
		const reader = new CloudMemberCompanyFileReader({
			...f.options,
			fetch: async () => new Response("{}", { headers }),
		});
		await expect(reader.read(path, new AbortController().signal)).rejects.toThrow();
	},
);

it.each(["delegated", "raw", ""])("refuses non-live-path object responses: %s", async (mode) => {
	const f = await fixture();
	const reader = new CloudMemberCompanyFileReader({
		...f.options,
		fetch: async (input, init) =>
			String(input).startsWith("https://cloud.test")
				? f.rpc(input, init)
				: new Response(Uint8Array.from(f.objects.get(f.file.manifestSha256)!), {
						headers: { "x-qorpera-access-mode": mode },
					}),
	});
	await expect(reader.read(path, new AbortController().signal)).rejects.toThrow("access is unavailable");
});

it("does not expose private token-acquisition or backend error text", async () => {
	const f = await fixture();
	const reader = new CloudMemberCompanyFileReader({
		...f.options,
		accessToken: async () => {
			throw new Error("PRIVATE_BACKEND_ERROR");
		},
	});
	await expect(reader.read(path, new AbortController().signal)).rejects.toThrow("Member sign-in is unavailable");
	f.state.status = 503;
	await expect(f.reader.read(path, new AbortController().signal)).rejects.toThrow(
		"Company File access is unavailable (503)",
	);
});
