// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { cloudFileBytesSha256 } from "@qorpera/cloud-client/cloud-file-bytes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebCompanyFiles } from "../src/cloud/company-files.ts";
import { deferred, fixture, id, profileA, settle, userA, userB } from "./fixtures.ts";

/* The product's member File transport (WebCompanyFiles): the governed client the web's editors still write with until
 * they write folder files (P34), and the mode they check first. The Company File page itself reads the folder
 * (company-folder.test.ts). */

const disposers: (() => void)[] = [];
beforeEach(() => {
	vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
async function setup(offerProposal = false, useBridge = true) {
	const f = fixture(),
		stop = new AbortController();
	f.cloud.config.objectGatewayUrl = "https://objects.fixture.invalid";
	if (useBridge)
		f.cloud.config.memberCompanyGatewayUrl = `${f.cloud.config.projectUrl}/functions/v1/member-company-gateway`;
	let contents = "Original text",
		version = id(40),
		exists = true;
	const objects = new Map<string, Uint8Array>();
	const proposal = {
		proposalId: id(44),
		plan: {
			schema: "qorpera.company-path-mutation/v1",
			operationKey: "fixture-proposal",
			path: "notes.txt",
			expectedVersion: version,
			entry: null,
		},
		planSha256: "b".repeat(64),
		state: "open",
		snapshotId: null,
	};
	const reference = async () => {
		const bytes = new TextEncoder().encode(contents),
			hash = await cloudFileBytesSha256(bytes);
		const manifest = new TextEncoder().encode(
			JSON.stringify({
				schema: "qorpera.cloud-file-manifest/v1",
				fileSha256: hash,
				bytes: bytes.length,
				mediaType: "application/octet-stream",
				chunks: [{ sha256: hash, bytes: bytes.length }],
			}),
		);
		const manifestHash = await cloudFileBytesSha256(manifest);
		objects.set(hash, bytes);
		objects.set(manifestHash, manifest);
		return {
			manifestBytes: manifest.length,
			file: {
				manifestSha256: manifestHash,
				fileSha256: hash,
				bytes: bytes.length,
				mediaType: "application/octet-stream",
			},
		};
	};
	const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input)),
			method = url.pathname.split("/").at(-1)!;
		if (url.pathname.includes("/v1/member-")) {
			expect(url.origin).toBe(
				new URL(useBridge ? f.cloud.config.projectUrl : f.cloud.config.objectGatewayUrl).origin,
			);
			expect(url.pathname).toMatch(
				useBridge ? /^\/functions\/v1\/member-company-gateway\/v1\/member-/ : /^\/v1\/member-/,
			);
		} else expect(url.origin).toBe(new URL(f.cloud.config.projectUrl).origin);
		expect(init?.redirect).toBe("error");
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token");
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
		if (method === "qorpera_member_company_file_mode")
			return Response.json({
				companyId: profileA.profileId,
				environmentId: profileA.environmentId,
				mode: "governed",
			});
		if (method === "qorpera_list_company_paths")
			return Response.json({
				snapshotId: id(41),
				items: exists
					? [{ path: "notes.txt", version, kind: "file", bytes: new TextEncoder().encode(contents).length }]
					: [],
				hasMore: false,
				nextAfter: null,
			});
		if (method === "qorpera_list_company_path_proposals" && offerProposal)
			return Response.json({ items: [proposal], nextAfter: null });
		if (["qorpera_list_member_company_path_commands", "qorpera_list_company_path_proposals"].includes(method))
			return Response.json({ items: [], nextAfter: null });
		if (url.pathname.endsWith(`/proposals/${proposal.proposalId}/review`)) {
			expect(body).toEqual({ planSha256: proposal.planSha256, decision: "approve" });
			offerProposal = false;
			exists = false;
			return Response.json({ ...proposal, state: "applied", snapshotId: id(41) });
		}
		if (method === "qorpera_read_company_path") {
			if (!exists || body.p_path !== "notes.txt")
				return Response.json({
					companyId: profileA.profileId,
					path: body.p_path,
					version: null,
					entry: null,
					manifestBytes: null,
				});
			const ref = await reference();
			return Response.json({
				companyId: profileA.profileId,
				path: "notes.txt",
				version,
				entry: { path: "notes.txt", kind: "file", executable: false, file: ref.file },
				manifestBytes: ref.manifestBytes,
			});
		}
		if (url.pathname.includes("/v1/member-company-objects/")) {
			const bytes = objects.get(method);
			if (!bytes) throw new Error("Unknown fixture object");
			return new Response(Uint8Array.from(bytes), { headers: { "x-qorpera-access-mode": "live-path-authority" } });
		}
		if (method === "edits" || method === "uploads") {
			const uploadHeader = new Headers(init?.headers).get("x-qorpera-company-upload");
			const intent = uploadHeader ? JSON.parse(Buffer.from(uploadHeader, "base64url").toString("utf8")) : body;
			if (method === "uploads") {
				expect(init?.method).toBe("PUT");
				expect(init?.body).toBeInstanceOf(Uint8Array);
			}
			expect(intent.expectedVersion).toBe(version);
			contents = method === "uploads" ? new TextDecoder().decode(init?.body as Uint8Array) : body.text;
			version = id(42);
			exists = body.operation !== "delete";
			const ref = await reference();
			return Response.json({
				commandId: id(43),
				companyId: profileA.profileId,
				environmentId: profileA.environmentId,
				plan: {
					schema: "qorpera.company-path-mutation/v1",
					path: intent.path,
					operationKey: intent.operationKey,
					expectedVersion: intent.expectedVersion,
					entry: exists ? { path: intent.path, kind: "file", executable: false, file: ref.file } : null,
				},
				planSha256: "a".repeat(64),
				state: "applied",
				expiresAt: "2030-01-01T00:00:00Z",
				result: {
					state: "applied",
					path: intent.path,
					operationKey: intent.operationKey,
					version,
					snapshotId: id(41),
				},
			});
		}
		throw new Error(`Unexpected fixture endpoint: ${url.pathname}`);
	});
	vi.stubGlobal("fetch", fetch);
	const current = vi.fn();
	const company = new WebCompanyFiles(f.cloud, profileA, userA.id, "owner", stop.signal, current);
	disposers.push(() => stop.abort());
	return { ...f, stop, company, fetch, current };
}
describe("the product's member File transport", () => {
	it("keeps the configured direct transport until bridge activation", async () => {
		const f = await setup(false, false);
		const client = await f.company.files();
		await client.read("notes.txt", new AbortController().signal);
		const objects = f.fetch.mock.calls.filter(([url]) => String(url).includes("/v1/member-company-objects/"));
		expect(objects.length).toBeGreaterThan(0);
		for (const [url] of objects) expect(new URL(String(url)).origin).toBe(f.cloud.config.objectGatewayUrl);
		expect(f.fetch.mock.calls.some(([url]) => String(url).includes("/functions/v1/member-company-gateway"))).toBe(
			false,
		);
	});
	it("routes member objects through the member company gateway once it is configured", async () => {
		const f = await setup();
		const client = await f.company.files();
		await client.read("notes.txt", new AbortController().signal);
		expect(
			f.fetch.mock.calls.some(([url]) =>
				String(url).includes("/functions/v1/member-company-gateway/v1/member-company-objects/"),
			),
		).toBe(true);
	});
	it("reads the mode once for the page's lifetime", async () => {
		const f = await setup();
		await f.company.files();
		await f.company.files();
		expect(
			f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/qorpera_member_company_file_mode")),
		).toHaveLength(1);
	});
	it.each(["legacy", "foreign"])("refuses %s File mode before listing or fetching objects", async (mode) => {
		const f = await setup();
		f.fetch.mockResolvedValueOnce(
			Response.json({
				companyId: profileA.profileId,
				environmentId: mode === "foreign" ? id(99) : profileA.environmentId,
				mode: mode === "legacy" ? "legacy" : "governed",
			}),
		);
		await expect(f.company.files()).rejects.toThrow("governed");
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});
	it("refuses a different member's token", async () => {
		const f = await setup();
		f.auth(userB);
		await expect(f.company.files()).rejects.toThrow();
		expect(f.fetch).not.toHaveBeenCalled();
	});
	it("discards delayed mode discovery after the company closes", async () => {
		const f = await setup(),
			result = deferred<Response>();
		f.fetch.mockReturnValueOnce(result.promise);
		const opening = f.company.files(),
			rejected = expect(opening).rejects.toThrow();
		await settle();
		f.stop.abort();
		result.resolve(
			Response.json({ companyId: profileA.profileId, environmentId: profileA.environmentId, mode: "governed" }),
		);
		await rejected;
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});
});
