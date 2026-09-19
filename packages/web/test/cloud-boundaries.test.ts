// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudApi } from "../src/cloud/api.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import { ObjectReader } from "../src/cloud/objects.ts";
import { collectPages } from "../src/cloud/pagination.ts";
import { probeRpcs } from "../src/cloud/probe.ts";
import { figureElement } from "../src/ui/avatar.ts";
import { deferred, fixture, id, profileA, session, settle, stubFigureMotion, timestamp, userA } from "./fixtures.ts";

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
describe("cloud boundary regressions", () => {
	it.each([new TypeError("Failed to fetch"), new CloudRpcError("probe", { message: "Bad gateway" }, 502)])(
		"does not mark unreachable RPCs present (%s)",
		async (error) => {
			const { cloud } = fixture();
			vi.mocked(cloud.rpc).mockRejectedValue(error);
			const results = await probeRpcs(cloud);
			expect(results.length).toBeGreaterThan(30);
			expect(results.every((result) => result.state === "unreachable")).toBe(true);
		},
	);

	it("distinguishes permission refusal and missing signatures", async () => {
		const { cloud } = fixture();
		vi.mocked(cloud.rpc)
			.mockRejectedValueOnce(new CloudRpcError("probe", { message: "Denied", code: "42501" }, 403))
			.mockRejectedValue(new CloudRpcError("probe", { message: "Missing", code: "PGRST202" }, 404));
		const results = await probeRpcs(cloud);
		expect(results[0]?.state).toBe("denied");
		expect(results[1]?.state).toBe("missing");
	});

	it("stops probing on account disposal before sending another request", async () => {
		const { cloud } = fixture();
		const response = deferred<unknown>();
		vi.mocked(cloud.rpc).mockReturnValue(response.promise);
		const abort = new AbortController();
		const run = probeRpcs(cloud, undefined, abort.signal);
		abort.abort();
		response.resolve(null);
		await run;
		expect(cloud.rpc).toHaveBeenCalledTimes(1);
	});

	it("reads session continuation pages using the deployed cursor shape", async () => {
		const { cloud } = fixture();
		const wire = {
			session_id: session.sessionId,
			client_session_id: session.clientSessionId,
			profile_id: profileA.profileId,
			environment_id: profileA.environmentId,
			title: session.title,
			status: "open",
			audience_kind: "company",
			created_by_user_id: userA.id,
			created_at: timestamp,
			updated_at: timestamp,
		};
		vi.mocked(cloud.rpc)
			.mockResolvedValueOnce({
				items: [wire],
				has_more: true,
				next_updated_at: timestamp,
				next_id: session.sessionId,
			})
			.mockResolvedValueOnce({ items: [{ ...wire, session_id: id(99) }], has_more: false });
		const api = new CloudApi(cloud);
		const sessions = await api.listSessions(profileA.environmentId);
		expect(sessions).toHaveLength(2);
		expect(cloud.rpc).toHaveBeenLastCalledWith("qorpera_list_shared_sessions_page", {
			p_environment_id: profileA.environmentId,
			p_after_updated_at: timestamp,
			p_after_id: session.sessionId,
			p_limit: 100,
		});
	});

	it("fails incomplete or cycling pagination instead of returning a truncated complete list", async () => {
		await expect(collectPages(async () => ({ items: [1], hasMore: true }))).rejects.toThrow("without a continuation");
		const read = vi.fn(async () => ({ items: [1], hasMore: true, nextTime: timestamp, nextId: id(1) }));
		await expect(collectPages(read)).rejects.toThrow("did not advance");
		expect(read).toHaveBeenCalledTimes(2);
	});

	it("reports object authorization denial without inventing a gateway cause", async () => {
		const { api } = fixture();
		vi.spyOn(api, "authorizeObjectDownload").mockRejectedValue(
			new CloudRpcError("download", { code: "42501", message: "Denied" }, 403),
		);
		const reader = new ObjectReader(api, profileA.profileId);
		await expect(reader.read("a".repeat(64))).rejects.toMatchObject({ reason: "denied" });
		reader.dispose();
	});

	it("rejects oversized chunk declarations before downloading any chunk", async () => {
		const { api } = fixture();
		const reader = new ObjectReader(api, profileA.profileId);
		const read = vi.spyOn(reader, "read").mockResolvedValue(
			new TextEncoder().encode(
				JSON.stringify({
					schema: "qorpera.cloud-file-manifest/v1",
					fileSha256: "b".repeat(64),
					bytes: 1,
					chunks: [{ sha256: "c".repeat(64), bytes: 10_000_000 }],
				}),
			),
		);
		await expect(
			reader.readFile({
				manifestSha256: "a".repeat(64),
				fileSha256: "b".repeat(64),
				bytes: 1,
				mediaType: "text/plain",
			}),
		).rejects.toThrow("exceed");
		expect(read).toHaveBeenCalledTimes(1);
		reader.dispose();
	});

	it("disposes removed avatar rigs without requiring another mount", async () => {
		const dispose = vi.fn();
		stubFigureMotion(dispose);
		const retained = figureElement("crown");
		document.body.append(retained);
		await settle();
		expect(dispose).not.toHaveBeenCalled();
		retained.remove();
		await settle();
		expect(dispose).toHaveBeenCalledTimes(1);
		for (let i = 0; i < 6; i++) {
			const figure = figureElement("crown");
			document.body.append(figure);
			figure.remove();
		}
		await settle();
		expect(dispose).toHaveBeenCalledTimes(7);
	});
});
