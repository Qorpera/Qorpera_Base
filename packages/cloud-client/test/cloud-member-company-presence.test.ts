import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudMemberCompanyPresence } from "../src/cloud-member-company-presence.ts";
import type { CompanyPathPresenceView, CompanyPathPresenceWire } from "../src/company-path-presence.ts";
import { parseMemberCompanyPresenceReply } from "../src/member-company-path-presence.ts";

const id = (n: number) => `37000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const companyId = id(1),
	environmentId = id(2),
	clientId = id(3),
	path = "projects/report.md";
const clients: CloudMemberCompanyPresence[] = [];
afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
	vi.useRealTimers();
});
function wire(sequence = 1): CompanyPathPresenceWire {
	return {
		schema: "qorpera.company-path-presence/v1",
		companyId,
		environmentId,
		clientId,
		sequence,
		issuedAt: Date.now(),
		expiresAt: Date.now() + 20000,
		routes: [],
		signature: `${"A".repeat(86)}==`,
	};
}
function reply(paths = [path], sequence = 1) {
	return {
		companyId,
		environmentId,
		confirmed: [{ clientId, sequence }],
		view: {
			schema: "qorpera.company-path-presence-view/v1",
			state: "available",
			observedAt: Date.now(),
			paths: paths.map((path) => ({
				path,
				participants: [
					{
						runId: id(4),
						staffAgentId: id(5),
						activity: "writing",
						overlap: "same_object",
						expiresAt: Date.now() + 20000,
					},
				],
			})),
		},
	};
}
function fixture() {
	let sync = () => {},
		status = (_value: string) => {};
	const presenceState = vi.fn(() => ({ [clientId]: [{ ...wire(), presence_ref: "transport" }] }));
	const channel = {
		on: vi.fn((_kind: unknown, _filter: unknown, callback: () => void) => {
			sync = callback;
			return channel;
		}),
		subscribe: vi.fn((callback: (status: string) => void) => {
			status = callback;
			return channel;
		}),
		presenceState,
		track: vi.fn(),
	};
	const transport = {
		channel: vi.fn(() => channel as unknown as RealtimeChannel),
		removeChannel: vi.fn(async () => "ok" as const),
	};
	const accessToken = vi.fn(async (_signal: AbortSignal) => "member-token");
	const fetcher = vi.fn<typeof fetch>(async () => Response.json(reply()));
	const changed = vi.fn<(view: CompanyPathPresenceView) => void>();
	const stop = new AbortController();
	const client = new CloudMemberCompanyPresence({
		companyId,
		environmentId,
		client: transport as unknown as Pick<SupabaseClient, "channel" | "removeChannel">,
		objectGatewayUrl: "https://gateway.test",
		accessToken,
		fetch: fetcher,
		signal: stop.signal,
		onChange: changed,
	});
	clients.push(client);
	return {
		client,
		channel,
		transport,
		accessToken,
		fetcher,
		changed,
		stop,
		presenceState,
		sync: () => sync(),
		status: (value: string) => status(value),
		connect: async () => {
			await vi.waitFor(() => expect(channel.subscribe).toHaveBeenCalled());
			status("SUBSCRIBED");
		},
		latest: () => changed.mock.calls.at(-1)?.[0],
	};
}
describe("member native activity observer", () => {
	it("removes a failed subscription before retrying its owned channel", async () => {
		vi.useFakeTimers();
		const f = fixture();
		f.channel.subscribe.mockImplementationOnce(() => {
			throw new Error("subscription failed");
		});
		await vi.waitFor(() => expect(f.transport.removeChannel).toHaveBeenCalledOnce());
		await vi.advanceTimersByTimeAsync(6001);
		expect(f.channel.subscribe).toHaveBeenCalledTimes(2);
	});
	it("subscribes read-only and sends only bounded signed statements to the member gateway", async () => {
		const f = fixture();
		f.client.select([path]);
		await f.connect();
		await vi.waitFor(() => expect(f.latest()?.state).toBe("available"));
		expect(f.transport.channel).toHaveBeenCalledWith(`qorpera-presence-${companyId}`, {
			config: { private: true, presence: { key: expect.any(String) } },
		});
		expect(f.channel.track).not.toHaveBeenCalled();
		const [url, init] = f.fetcher.mock.calls[0];
		expect(url).toBe(`https://gateway.test/v1/member-company-presence/${companyId}/${environmentId}`);
		expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer member-token");
		expect(JSON.parse(String(init?.body))).toEqual({
			paths: [path],
			candidates: [expect.objectContaining({ clientId, sequence: 1 })],
			truncated: false,
		});
		expect(String(init?.body)).not.toContain("presence_ref");
		await f.client.close();
		expect(f.latest()?.state).toBe("unavailable");
		expect(f.transport.removeChannel).toHaveBeenCalledOnce();
	});
	it("clears immediately when selection changes and ignores late responses", async () => {
		const f = fixture();
		let resolve!: (response: Response) => void;
		f.fetcher.mockImplementationOnce(
			() =>
				new Promise((accept) => {
					resolve = accept;
				}),
		);
		f.client.select([path]);
		await f.connect();
		await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
		f.client.select(["other.md"]);
		expect(f.latest()).toMatchObject({ state: "unavailable", paths: [{ path: "other.md", participants: [] }] });
		expect(f.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
		resolve(Response.json(reply()));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(f.latest()?.state).toBe("unavailable");
	});
	it("rejects old replay after a newer nonoverlapping statement was verified", async () => {
		vi.useFakeTimers();
		const f = fixture();
		f.presenceState.mockReturnValue({ [clientId]: [{ ...wire(2), presence_ref: "new" }] });
		f.fetcher.mockImplementation(async (_url, init) => {
			const input = JSON.parse(String(init?.body));
			return Response.json({
				...reply(),
				confirmed: input.candidates.map((item: CompanyPathPresenceWire) => ({
					clientId: item.clientId,
					sequence: item.sequence,
				})),
				view: { ...reply().view, paths: [{ path, participants: [] }] },
			});
		});
		f.client.select([path]);
		await f.connect();
		await vi.waitFor(() => expect(f.latest()?.state).toBe("available"));
		f.presenceState.mockReturnValue({ [clientId]: [{ ...wire(1), presence_ref: "replay" }] });
		f.sync();
		await vi.advanceTimersByTimeAsync(2001);
		expect(f.fetcher).toHaveBeenCalledTimes(2);
		expect(JSON.parse(String(f.fetcher.mock.calls.at(-1)?.[1]?.body)).candidates).toEqual([]);
	});
	it("clears on channel loss and account abort without publishing or reclaiming native identity", async () => {
		const f = fixture();
		f.client.select([path]);
		await f.connect();
		await vi.waitFor(() => expect(f.latest()?.state).toBe("available"));
		f.status("CHANNEL_ERROR");
		expect(f.latest()).toMatchObject({ state: "unavailable", paths: [{ participants: [] }] });
		f.stop.abort();
		f.status("SUBSCRIBED");
		await f.client.close();
		expect(f.latest()?.state).toBe("unavailable");
		expect(f.channel.track).not.toHaveBeenCalled();
	});
	it("bounds stalled token acquisition and never joins with another or invalid account", async () => {
		vi.useFakeTimers();
		const f = fixture();
		f.accessToken.mockImplementation(() => new Promise(() => undefined));
		await vi.advanceTimersByTimeAsync(2001);
		expect(f.transport.channel).not.toHaveBeenCalled();
		expect(f.accessToken.mock.calls[0][0].aborted).toBe(true);
	});
	it("bounds response streams and clears expired observations", async () => {
		vi.useFakeTimers();
		const f = fixture();
		f.client.select([path]);
		await f.connect();
		await vi.waitFor(() => expect(f.latest()?.state).toBe("available"));
		const cancel = vi.fn();
		f.fetcher.mockImplementation(async () => new Response(new ReadableStream({ cancel })));
		await vi.advanceTimersByTimeAsync(10001);
		expect(cancel).toHaveBeenCalled();
		expect(f.latest()?.state).toBe("unavailable");
	});
	it("refuses mismatched confirmations, foreign scopes and oversized replies", async () => {
		for (const value of [
			{ ...reply(), companyId: id(99) },
			{ ...reply(), confirmed: [{ clientId, sequence: 99 }] },
		]) {
			const f = fixture();
			f.fetcher.mockResolvedValue(Response.json(value));
			f.client.select([path]);
			await f.connect();
			await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalled());
			await new Promise((resolve) => setTimeout(resolve, 5));
			expect(f.latest()?.state).toBe("unavailable");
			await f.client.close();
		}
		const f = fixture();
		f.fetcher.mockResolvedValue(new Response("x", { headers: { "content-length": "1048577" } }));
		f.client.select([path]);
		await f.connect();
		await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalled());
		expect(f.latest()?.state).toBe("unavailable");
	});
	it("bounds transport state and ignores unrelated member payloads", async () => {
		const f = fixture();
		f.presenceState.mockReturnValue(
			Object.fromEntries(
				Array.from({ length: 65 }, (_, n) => [
					id(n + 10),
					[{ ...wire(), clientId: id(n + 10), presence_ref: "ref" }],
				]),
			),
		);
		f.fetcher.mockImplementation(async () => Response.json({ ...reply(), confirmed: [] }));
		f.client.select([path]);
		await f.connect();
		await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalled());
		const body = JSON.parse(String(f.fetcher.mock.calls[0][1]?.body));
		expect(body.candidates).toHaveLength(32);
		expect(body.truncated).toBe(true);
	});
	it("rejects invalid selections and copies response data while expiring individual participants", () => {
		const f = fixture();
		for (const paths of [["../bad"], Array(9).fill(path), [path, path], null])
			expect(() => f.client.select(paths as string[])).toThrow();
		const value = reply();
		value.view.paths[0].participants[0].expiresAt = Date.now() - 1;
		expect(
			parseMemberCompanyPresenceReply(value, companyId, environmentId, [path]).view.paths[0].participants,
		).toEqual([]);
		for (const patch of [
			{ observedAt: Date.now() - 31000 },
			{ paths: [{ path: "other", participants: [] }] },
			{ privateKey: "secret" },
			{ state: "unavailable" },
		])
			expect(() =>
				parseMemberCompanyPresenceReply(
					{ ...reply(), view: { ...reply().view, ...patch } },
					companyId,
					environmentId,
					[path],
				),
			).toThrow();
	});
});
