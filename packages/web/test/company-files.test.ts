// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { cloudFileBytesSha256 } from "@qorpera/cloud-client/cloud-file-bytes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebCompanyFiles } from "../src/cloud/company-files.ts";
import { deferred, fixture, id, profileA, timestamp, userA, userB } from "./fixtures.ts";

/* The product's member transport for the company folder (WebCompanyFiles.folder()): reads over PostgREST, bytes and
 * change sets through the object gateway's member routes, bridged through the member company gateway once that is
 * configured, always with the member's own token. The Company File page over it is company-folder.test.ts. */

const disposers: (() => void)[] = [];
beforeEach(() => {
	vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const encode = (text: string) => new TextEncoder().encode(text);

async function setup(useBridge = true) {
	const f = fixture(),
		stop = new AbortController();
	f.cloud.config.objectGatewayUrl = "https://objects.fixture.invalid";
	const bridge = `${f.cloud.config.projectUrl}/functions/v1/member-company-gateway`;
	if (useBridge) f.cloud.config.memberCompanyGatewayUrl = bridge;
	const bytes = encode("Original text");
	const hash = await cloudFileBytesSha256(bytes);
	const manifest = encode(
		JSON.stringify({
			schema: "qorpera.cloud-file-manifest/v2",
			fileSha256: hash,
			bytes: bytes.length,
			mediaType: "text/plain",
			executable: false,
			chunks: [{ sha256: hash, bytes: bytes.length }],
		}),
	);
	const manifestHash = await cloudFileBytesSha256(manifest);
	const objects = new Map([
		[hash, bytes],
		[manifestHash, manifest],
	]);
	const entry = {
		path: "notes.txt",
		kind: "file",
		version: id(40),
		seq: 3,
		updatedAt: timestamp,
		manifestSha256: manifestHash,
		fileSha256: hash,
		bytes: bytes.length,
		mediaType: "text/plain",
		executable: false,
	};
	const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input)),
			name = url.pathname.split("/").at(-1)!;
		expect(init?.redirect).toBe("error");
		expect(init?.credentials).toBe("omit");
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token");
		if (url.pathname.includes("/v1/member-")) {
			expect(url.origin).toBe(new URL(useBridge ? bridge : f.cloud.config.objectGatewayUrl).origin);
			expect(url.pathname).toMatch(
				useBridge ? /^\/functions\/v1\/member-company-gateway\/v1\/member-folder-/ : /^\/v1\/member-folder-/,
			);
		} else {
			expect(url.origin).toBe(new URL(f.cloud.config.projectUrl).origin);
			expect(url.pathname).toMatch(/^\/rest\/v1\/rpc\/qorpera_member_/);
			expect(new Headers(init?.headers).get("apikey")).toBe(f.cloud.config.publishableKey);
		}
		if (name === "qorpera_member_folder_read")
			return Response.json({ schema: "qorpera.folder-read/v1", asOfSeq: 3, found: true, entry });
		if (url.pathname.includes("/v1/member-folder-objects/")) {
			const object = objects.get(name);
			if (!object) throw new Error("Unknown fixture object");
			return new Response(Uint8Array.from(object), { headers: { "x-qorpera-access-mode": "live-path-authority" } });
		}
		if (url.pathname.endsWith(`/v1/member-folder-commits/${profileA.environmentId}`)) {
			const body = JSON.parse(String(init?.body)) as { units: { op: string; path: string }[] };
			return Response.json({
				schema: "qorpera.folder-commit/v1",
				commitId: id(41),
				seq: 4,
				replay: false,
				units: body.units.map((unit, index) => ({
					unit: index + 1,
					op: unit.op,
					path: unit.path,
					outcome: "saved",
					version: id(42),
				})),
			});
		}
		throw new Error(`Unexpected fixture endpoint: ${url.pathname}`);
	});
	vi.stubGlobal("fetch", fetch);
	const current = vi.fn();
	const company = new WebCompanyFiles(f.cloud, profileA, userA.id, "owner", stop.signal, current);
	disposers.push(() => stop.abort());
	const signal = new AbortController().signal;
	/** A read, the file's bytes and a change set, as the web's editors make them. */
	const use = async () => {
		const folder = company.folder();
		const read = await folder.read("notes.txt", signal);
		const text = new TextDecoder().decode(await folder.readFile(read.entry!.file!, signal));
		const commit = await folder.commit(
			"web:fixture:1",
			[{ op: "write", path: "notes.txt", text: "New text", expectedVersion: read.entry!.version }],
			signal,
		);
		return { text, commit };
	};
	return { ...f, stop, company, fetch, current, bridge, use, signal };
}

const urls = (fetch: { mock: { calls: unknown[][] } }) => fetch.mock.calls.map(([url]) => String(url));

describe("the product's member folder transport", () => {
	it("routes the member routes through the member company gateway once it is configured", async () => {
		const f = await setup();
		const { text, commit } = await f.use();
		expect(text).toBe("Original text");
		expect(commit.units[0]).toMatchObject({ outcome: "saved", version: id(42) });
		const called = urls(f.fetch);
		expect(called[0]).toBe(`${f.cloud.config.projectUrl}/rest/v1/rpc/qorpera_member_folder_read`);
		expect(called.filter((url) => url.startsWith(`${f.bridge}/v1/member-folder-objects/`))).toHaveLength(2);
		expect(called.at(-1)).toBe(`${f.bridge}/v1/member-folder-commits/${profileA.environmentId}`);
		expect(called.some((url) => url.startsWith(f.cloud.config.objectGatewayUrl))).toBe(false);
	});

	it("keeps the configured direct object gateway until the bridge is activated", async () => {
		const f = await setup(false);
		await f.use();
		const called = urls(f.fetch);
		expect(
			called.filter((url) => url.startsWith(`${f.cloud.config.objectGatewayUrl}/v1/member-folder-`)),
		).toHaveLength(3);
		expect(called.some((url) => url.includes("/functions/v1/member-company-gateway"))).toBe(false);
	});

	it("refuses a different member's token before anything is sent", async () => {
		const f = await setup();
		f.auth(userB);
		await expect(f.company.folder().read("notes.txt", f.signal)).rejects.toThrow("Member sign-in is unavailable");
		await expect(
			f.company.folder().commit("web:fixture:1", [{ op: "mkdir", path: "notes" }], f.signal),
		).rejects.toThrow("Member sign-in is unavailable");
		expect(f.fetch).not.toHaveBeenCalled();
	});

	it("hands out no folder once the company changed or closed", async () => {
		const f = await setup();
		f.current.mockImplementationOnce(() => {
			throw new Error("Company access changed.");
		});
		expect(() => f.company.folder()).toThrow("Company access changed.");
		f.stop.abort();
		expect(() => f.company.folder()).toThrow();
		expect(f.fetch).not.toHaveBeenCalled();
	});

	it("discards an answer that arrives after the company closes", async () => {
		const f = await setup(),
			answer = deferred<Response>();
		f.fetch.mockReturnValueOnce(answer.promise);
		const reading = f.company.folder().read("notes.txt", f.signal),
			rejected = expect(reading).rejects.toThrow();
		await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
		f.stop.abort();
		answer.resolve(Response.json({ schema: "qorpera.folder-read/v1", asOfSeq: 3, found: false, entry: null }));
		await rejected;
		expect(f.fetch).toHaveBeenCalledOnce();
	});
});
