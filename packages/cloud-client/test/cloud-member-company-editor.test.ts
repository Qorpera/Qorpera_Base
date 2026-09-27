import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	type CloudMemberCompanyCommand,
	CloudMemberCompanyFileClient,
	CloudMemberCompanyRefusal,
	type CloudMemberCompanyUpload,
} from "../src/cloud-member-company-editor.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

describe("shared pending binary reviews", () => {
	it.each(["valid", "digest", "bytes", "type", "oversize"])(
		"verifies %s pending response identity before returning bytes",
		async (mode) => {
			const bytes = Uint8Array.from([0, 255, 128]);
			const target: CloudMemberCompanyCommand = {
				commandId: id(3),
				companyId: id(1),
				environmentId: id(2),
				planSha256: "a".repeat(64),
				state: "review_required",
				result: null,
				expiresAt: "2099-01-01T00:00:00Z",
				plan: {
					schema: "qorpera.company-path-mutation/v1",
					operationKey: "upload",
					path: "x.bin",
					expectedVersion: null,
					entry: {
						path: "x.bin",
						kind: "file",
						executable: false,
						file: {
							fileSha256: sha(bytes),
							manifestSha256: "b".repeat(64),
							bytes: bytes.length,
							mediaType: "application/octet-stream",
						},
					},
				},
			};
			const client = new CloudMemberCompanyFileClient({
				companyId: id(1),
				environmentId: id(2),
				supabaseUrl: "https://control.test",
				objectGatewayUrl: "https://gateway.test",
				publishableKey: "public",
				accessToken: async () => "member-token",
				fetch: async (url, init) => {
					expect(String(url)).toBe(`https://gateway.test/v1/member-company-file/${id(2)}/edits/${id(3)}/file`);
					expect(init?.method).toBe("GET");
					return new Response(
						mode === "oversize" ? new Uint8Array(8388609) : mode === "bytes" ? new Uint8Array(3) : bytes,
						{
							headers: {
								"content-type": mode === "type" ? "text/html" : "application/octet-stream",
								"x-qorpera-plan-sha256": mode === "digest" ? "c".repeat(64) : target.planSha256,
							},
						},
					);
				},
			});
			if (mode === "valid")
				expect(await client.pendingFile(target, new AbortController().signal)).toEqual({
					bytes,
					planSha256: target.planSha256,
				});
			else await expect(client.pendingFile(target, new AbortController().signal)).rejects.toThrow();
		},
	);
});
function fixture() {
	const requests: Request[] = [];
	const state = { status: 200, token: "member-token", alter: (_value: Record<string, unknown>) => {} };
	const accessToken = vi.fn(async () => state.token);
	const client = new CloudMemberCompanyFileClient({
		companyId: id(1),
		environmentId: id(2),
		supabaseUrl: "https://control.test",
		objectGatewayUrl: "https://gateway.test",
		publishableKey: "public",
		accessToken,
		fetch: async (url, init) => {
			const request = new Request(url, init);
			requests.push(request.clone());
			if (state.status !== 200) return new Response(null, { status: state.status });
			expect(request.url).toBe(`https://gateway.test/v1/member-company-file/${id(2)}/uploads`);
			expect(request.method).toBe("PUT");
			expect(request.headers.get("authorization")).toBe("Bearer member-token");
			expect(request.headers.get("user-agent")).toBeNull();
			expect(request.headers.get("apikey")).toBeNull();
			expect(request.headers.get("content-type")).toBe("application/octet-stream");
			expect(request.redirect).toBe("error");
			expect(request.cache).toBe("no-store");
			const header = request.headers.get("x-qorpera-company-upload")!;
			const input = JSON.parse(Buffer.from(header, "base64url").toString());
			expect(Buffer.from(JSON.stringify(input)).toString("base64url")).toBe(header);
			const bytes = Buffer.from(await request.arrayBuffer());
			expect(sha(bytes)).toBe(input.source.sha256);
			expect(bytes.length).toBe(input.source.bytes);
			let offset = 0;
			for (const chunk of input.manifest.chunks) {
				expect(sha(bytes.subarray(offset, offset + chunk.bytes))).toBe(chunk.sha256);
				offset += chunk.bytes;
			}
			expect(offset).toBe(bytes.length);
			const plan = {
				schema: "qorpera.company-path-mutation/v1",
				operationKey: input.operationKey,
				path: input.path,
				expectedVersion: input.expectedVersion,
				entry: {
					path: input.path,
					kind: "file",
					executable: false,
					file: {
						manifestSha256: sha(JSON.stringify(input.manifest)),
						fileSha256: sha(bytes),
						bytes: bytes.length,
						mediaType: "application/octet-stream",
					},
				},
			};
			const response = {
				commandId: id(3),
				companyId: id(1),
				environmentId: id(2),
				plan,
				planSha256: "a".repeat(64),
				state: "applied",
				expiresAt: "2099-01-01T00:00:00Z",
				result: {
					state: "applied",
					path: input.path,
					operationKey: input.operationKey,
					snapshotId: id(4),
					version: id(5),
				},
			};
			state.alter(response);
			return Response.json(response);
		},
	});
	return { client, requests, state, accessToken };
}
const input = (size = 6): CloudMemberCompanyUpload => ({
	operationKey: "selected-1",
	path: "documents/æble.bin",
	expectedVersion: null,
	name: "æble.bin",
	mediaType: "application/octet-stream",
	bytes: new Uint8Array(size).fill(128),
});

describe("shared member upload client", () => {
	it.each([0, 6, 4194307, 8388608])(
		"sends %s selected binary bytes with canonical chunk and source identity",
		async (size) => {
			const f = fixture(),
				selected = input(size),
				result = await f.client.upload(selected, new AbortController().signal);
			expect(result.source).toEqual({
				realm: "member_file",
				name: selected.name,
				sha256: sha(selected.bytes),
				bytes: size,
				mediaType: selected.mediaType,
			});
			expect(result.command.state).toBe("applied");
			expect(f.requests).toHaveLength(1);
		},
	);
	it("copies bytes and all intent fields before asynchronous hashing or token acquisition", async () => {
		const f = fixture(),
			selected = input(),
			bytes = Uint8Array.from(selected.bytes),
			pending = f.client.upload(selected, new AbortController().signal);
		selected.bytes.fill(1);
		selected.path = "documents/other.bin";
		selected.name = "other.bin";
		selected.operationKey = "different";
		const result = await pending;
		expect(result.source.sha256).toBe(sha(bytes));
		expect(result.source.name).toBe("æble.bin");
		expect(result.command.plan.path).toBe("documents/æble.bin");
		expect(result.command.plan.operationKey).toBe("selected-1");
	});
	it.each(["path", "name", "mediaType", "bytes", "extra", "version"])(
		"rejects invalid %s before member authentication",
		async (kind) => {
			const f = fixture(),
				selected = input();
			if (kind === "path") selected.path = "../local";
			if (kind === "name") selected.name = "/private/file";
			if (kind === "mediaType") selected.mediaType = "text/html; charset=utf8";
			if (kind === "bytes") selected.bytes = new Uint8Array(8388609);
			if (kind === "extra") Object.assign(selected, { localPath: "/private/file" });
			if (kind === "version") selected.expectedVersion = "head";
			await expect(f.client.upload(selected, new AbortController().signal)).rejects.toThrow();
			expect(f.accessToken).not.toHaveBeenCalled();
			expect(f.requests).toHaveLength(0);
		},
	);
	it.each([
		[400, true],
		[401, true],
		[403, true],
		[412, true],
		[409, false],
		[503, false],
	])("marks a %s answer as a definite refusal only when nothing was saved: %s", async (status, refused) => {
		const f = fixture();
		f.state.status = status;
		const error = await f.client.upload(input(), new AbortController().signal).catch((caught: unknown) => caught);
		expect(error instanceof CloudMemberCompanyRefusal).toBe(refused);
		if (error instanceof CloudMemberCompanyRefusal) expect(error.status).toBe(status);
	});
	it.each([401, 403, 409, 412, 503])("never retries an uncertain or denied %s response", async (status) => {
		const f = fixture();
		f.state.status = status;
		await expect(f.client.upload(input(), new AbortController().signal)).rejects.toThrow();
		expect(f.requests).toHaveLength(1);
	});
	it("rejects a substituted command file even if the response has a valid shape", async () => {
		const f = fixture();
		f.state.alter = (value) => {
			const plan = value.plan as { entry: { file: { fileSha256: string } } };
			plan.entry.file.fileSha256 = "b".repeat(64);
		};
		await expect(f.client.upload(input(), new AbortController().signal)).rejects.toThrow("upload changed");
	});
	it("checks cancellation before hashing and after token acquisition", async () => {
		const f = fixture(),
			controller = new AbortController();
		controller.abort();
		await expect(f.client.upload(input(), controller.signal)).rejects.toThrow();
		expect(f.accessToken).not.toHaveBeenCalled();
		const second = new AbortController();
		f.accessToken.mockImplementation(async () => {
			second.abort();
			return "member-token";
		});
		await expect(f.client.upload(input(), second.signal)).rejects.toThrow();
		expect(f.requests).toHaveLength(0);
	});
	it("rejects a missing token without converting it to an Authorization header", async () => {
		const f = fixture();
		f.accessToken.mockResolvedValue(undefined as unknown as string);
		await expect(f.client.upload(input(), new AbortController().signal)).rejects.toThrow("sign-in");
		expect(f.requests).toHaveLength(0);
	});
});
