import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CloudMemberFileExports } from "../src/cloud-member-file-exports.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fixture(size = 6) {
	const bytes = new Uint8Array(size).fill(128),
		selection = { realm: "object_storage" as const, assetId: id(3), sha256: sha(bytes) };
	const asset = {
		schema: "qorpera.file-transfer-asset/v1",
		assetId: id(3),
		sha256: sha(bytes),
		bytes: size,
		mediaType: "application/octet-stream",
		source: { realm: "company_computer", companyComputerId: id(4), screenId: id(5), path: "reports/æble.bin" },
		destination: { realm: "object_storage" },
	};
	const state = {
		revoked: false,
		corrupt: false,
		changed: false,
		sourceReads: 0,
		objectReads: 0,
		afterRead: () => {},
		page: { items: [asset], nextAfter: null as string | null },
	};
	const request = vi.fn<typeof fetch>(async (url, init) => {
		const headers = new Headers(init?.headers);
		expect(headers.get("authorization")).toBe("Bearer member");
		expect(headers.has("user-agent")).toBe(false);
		expect(new Request(url, init).cache).toBe("no-store");
		expect(init?.redirect).toBe("error");
		if (state.revoked) return new Response(null, { status: 403 });
		if (String(url).includes("/rest/v1/rpc/")) {
			expect(headers.get("apikey")).toBe("public");
			if (String(url).endsWith("qorpera_list_member_file_exports")) return Response.json(state.page);
			state.sourceReads++;
			expect(JSON.parse(init!.body as string)).toEqual({ p_environment_id: id(2), p_source: selection });
			return Response.json({
				companyId: id(1),
				environmentId: id(2),
				asset: state.changed ? { ...asset, mediaType: "text/html" } : asset,
			});
		}
		state.objectReads++;
		expect(String(url)).toBe(`https://objects.test/v1/member-file-exports/${id(2)}/${id(3)}/${selection.sha256}`);
		expect(headers.has("apikey")).toBe(false);
		state.afterRead();
		return new Response(state.corrupt ? new Uint8Array(size) : bytes, {
			headers: {
				"content-type": "application/octet-stream",
				"content-length": String(size),
				"x-qorpera-access-mode": "live-export-authority",
			},
		});
	});
	const accessToken = vi.fn(async () => "member");
	const client = new CloudMemberFileExports({
		companyId: id(1),
		environmentId: id(2),
		supabaseUrl: "https://control.test",
		objectGatewayUrl: "https://objects.test",
		publishableKey: "public",
		accessToken,
		fetch: request,
	});
	return { client, bytes, selection, asset, state, request, accessToken };
}
describe("shared member export client", () => {
	it.each([0, 6, 8388608])(
		"downloads %i exact bytes with immutable source identity and final membership check",
		async (size) => {
			const f = fixture(size),
				result = await f.client.download(f.selection, new AbortController().signal);
			expect(Buffer.from(result.bytes).equals(Buffer.from(f.bytes))).toBe(true);
			expect({ ...result, bytes: undefined }).toEqual({
				bytes: undefined,
				asset: f.asset,
				source: { ...f.selection, companyId: id(1), environmentId: id(2) },
			});
			expect(f.state.sourceReads).toBe(2);
			expect(f.state.objectReads).toBe(1);
			expect(f.accessToken).toHaveBeenCalledOnce();
		},
	);
	it.each(["revoked", "corrupt", "changed"])("refuses %s data before release", async (mode) => {
		const f = fixture();
		if (mode === "corrupt") f.state.corrupt = true;
		else
			f.state.afterRead = () => {
				if (mode === "revoked") f.state.revoked = true;
				else f.state.changed = true;
			};
		await expect(f.client.download(f.selection, new AbortController().signal)).rejects.toThrow();
	});
	it("lists immutable metadata and permits advancing over unavailable rows", async () => {
		const f = fixture();
		f.state.page.nextAfter = id(6);
		expect(await f.client.list(new AbortController().signal)).toEqual(f.state.page);
		f.state.page = { items: [], nextAfter: id(7) };
		expect(await f.client.list(new AbortController().signal, id(6))).toEqual(f.state.page);
		expect(f.state.objectReads).toBe(0);
	});
	it.each(["backwards", "duplicate", "oversize"])("rejects a %s export page", async (kind) => {
		const f = fixture();
		if (kind === "backwards") f.state.page.nextAfter = id(2);
		if (kind === "duplicate") f.state.page.items = [f.asset, f.asset];
		if (kind === "oversize") f.state.page.items = Array(51).fill(f.asset);
		await expect(f.client.list(new AbortController().signal)).rejects.toThrow();
	});
	it("refuses arbitrary paths, realms and extra fields before requesting a token", async () => {
		const f = fixture();
		for (const value of [
			{ ...f.selection, path: "/private" },
			{ ...f.selection, realm: "company_computer" },
			{ ...f.selection, sha256: "bad" },
		])
			expect(() => f.client.download(value as typeof f.selection, new AbortController().signal)).toThrow();
		expect(f.accessToken).not.toHaveBeenCalled();
	});
	it("copies the selection before asynchronous token work and observes caller cancellation", async () => {
		const f = fixture(),
			selection = { ...f.selection },
			controller = new AbortController();
		f.accessToken.mockImplementationOnce(async () => {
			selection.assetId = id(9);
			return "member";
		});
		await f.client.download(selection, controller.signal);
		controller.abort();
		await expect(f.client.list(controller.signal)).rejects.toThrow();
		expect(f.accessToken).toHaveBeenCalledOnce();
	});
});
