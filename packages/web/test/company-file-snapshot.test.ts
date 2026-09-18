// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { CompanyFileController } from "../src/app/views/companyfile.ts";
import { ObjectReader } from "../src/cloud/objects.ts";
import { deferred, fixture, profileA, snapshot, team, userA, userB } from "./fixtures.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const action of cleanup.splice(0)) action();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
function setup() {
	vi.stubGlobal("crypto", webcrypto);
	const f = fixture();
	f.cloud.config.objectGatewayUrl = "https://objects.fixture.invalid";
	vi.mocked(f.api.usesPathGateway).mockResolvedValue(true);
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({ team, loading: false });
	const files = new CompanyFileController(f.api, company);
	cleanup.push(() => {
		files.dispose();
		company.stop();
	});
	const bytes = new TextEncoder().encode("Historical file content");
	const manifest = new TextEncoder().encode(
		JSON.stringify({
			schema: "qorpera.cloud-file-manifest/v1",
			fileSha256: hash(bytes),
			bytes: bytes.length,
			mediaType: "application/octet-stream",
			chunks: [{ sha256: hash(bytes), bytes: bytes.length }],
		}),
	);
	const entry = {
		path: "history.txt",
		kind: "file" as const,
		executable: false,
		file: {
			manifestSha256: hash(manifest),
			fileSha256: hash(bytes),
			bytes: bytes.length,
			mediaType: "application/octet-stream",
		},
	};
	const state = { denied: false, afterObject: () => {} };
	const request = vi.fn<typeof fetch>(async (input, init) => {
		expect(init?.credentials).toBe("omit");
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token");
		if (state.denied) return new Response(null, { status: 403 });
		const url = new URL(String(input));
		if (url.pathname === "/rest/v1/rpc/qorpera_list_member_company_snapshot_paths") {
			expect(JSON.parse(init?.body as string)).toMatchObject({
				p_environment_id: profileA.environmentId,
				p_snapshot_id: snapshot.snapshotId,
			});
			return Response.json({
				companyId: profileA.profileId,
				environmentId: profileA.environmentId,
				snapshotId: snapshot.snapshotId,
				items: [entry],
				hasMore: false,
				nextAfter: null,
			});
		}
		if (url.pathname === "/rest/v1/rpc/qorpera_read_member_company_snapshot_path") {
			expect(JSON.parse(init?.body as string)).toEqual({
				p_environment_id: profileA.environmentId,
				p_snapshot_id: snapshot.snapshotId,
				p_path: entry.path,
			});
			return Response.json({
				companyId: profileA.profileId,
				path: entry.path,
				version: snapshot.snapshotId,
				entry,
				manifestBytes: manifest.length,
			});
		}
		expect(url.origin).toBe("https://objects.fixture.invalid");
		expect(
			url.pathname.startsWith(
				`/v1/member-company-snapshot-objects/${profileA.environmentId}/${snapshot.snapshotId}/`,
			),
		).toBe(true);
		const sha = url.pathname.split("/").at(-1);
		expect([hash(manifest), hash(bytes)]).toContain(sha);
		state.afterObject();
		return new Response(Uint8Array.from(sha === hash(manifest) ? manifest : bytes), {
			headers: { "x-qorpera-access-mode": "live-path-authority" },
		});
	});
	vi.stubGlobal("fetch", request);
	const rawTree = vi.spyOn(ObjectReader.prototype, "readTreeManifest");
	const rawFile = vi.spyOn(ObjectReader.prototype, "readFile");
	return { ...f, company, files, request, state, entry, rawTree, rawFile };
}
describe("governed web snapshot history", () => {
	it("lists authorized paths and displays verified historical bytes through the shared SDK", async () => {
		const f = setup();
		await f.files.openSnapshot(snapshot.snapshotId);
		expect(f.files.store.get().snapshot).toMatchObject({ loading: false, entries: [f.entry] });
		await f.files.openFile(f.entry);
		expect(f.files.store.get().snapshot?.content).toBe("Historical file content");
		expect(f.request).toHaveBeenCalledTimes(5);
		expect(f.rawTree).not.toHaveBeenCalled();
		expect(f.rawFile).not.toHaveBeenCalled();
	});
	it("keeps a governed denial closed without a legacy tree fallback", async () => {
		const f = setup();
		f.state.denied = true;
		await f.files.openSnapshot(snapshot.snapshotId);
		expect(f.files.store.get().snapshot?.error).toContain("403");
		expect(f.files.store.get().snapshot?.entries).toBeUndefined();
		expect(f.rawTree).not.toHaveBeenCalled();
	});
	it("does not show bytes after permissions are revoked during a read", async () => {
		const f = setup();
		await f.files.openSnapshot(snapshot.snapshotId);
		f.state.afterObject = () => {
			f.state.denied = true;
		};
		await f.files.openFile(f.entry);
		expect(f.files.store.get().snapshot?.content).toBeUndefined();
		expect(f.files.store.get().snapshot?.contentError).toContain("403");
		expect(f.rawFile).not.toHaveBeenCalled();
	});
	it("refuses a changed signed-in user before reading historical content", async () => {
		const f = setup();
		await f.files.openSnapshot(snapshot.snapshotId);
		f.auth(userB);
		await f.files.openFile(f.entry);
		expect(f.files.store.get().snapshot?.content).toBeUndefined();
		expect(f.request).toHaveBeenCalledOnce();
	});
	it("aborts an old listing when the selected view changes", async () => {
		const f = setup();
		const pending = deferred<Response>();
		f.request.mockReturnValueOnce(pending.promise);
		const opening = f.files.openSnapshot(snapshot.snapshotId);
		await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
		f.files.select({});
		pending.resolve(Response.json({}));
		await opening;
		expect(f.request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
		expect(f.files.store.get().snapshot).toBeUndefined();
		expect(f.rawTree).not.toHaveBeenCalled();
	});
});
