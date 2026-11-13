import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudMemberData, CloudMemberDataError, parseCloudMemberDataAnswer } from "../src/cloud-member-data.ts";

const env = "63000000-0000-4000-8000-000000000020";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const question =
	"-- What the shop sold since a day.\nselect count(*) as orders from orders where placed_at >= :since;\n";
const answer = {
	columns: ["orders", "total"],
	rows: [[23, 4100.5]],
	more: false,
	etag: "0123456789abcdef0123456789abcdef",
	asOf: "2026-11-13T10:00:00.000Z",
};

interface Sent {
	readonly url: string;
	readonly init: RequestInit;
	readonly body: Record<string, unknown>;
}

/** A fetch that answers each call with the next of `answers`: a status and a JSON value, or a function of the call. */
function fakeFetch(answers: (readonly [number, unknown] | ((sent: Sent) => Promise<Response>))[]) {
	const sent: Sent[] = [];
	const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const call = {
			url: String(input),
			init: init ?? {},
			body: JSON.parse(String(init?.body)) as Record<string, unknown>,
		};
		sent.push(call);
		const next = answers.shift();
		if (!next) throw new Error("no answer");
		if (typeof next === "function") return next(call);
		return new Response(typeof next[1] === "string" ? next[1] : JSON.stringify(next[1]), {
			status: next[0],
			headers: { "content-type": "application/json" },
		});
	});
	return { fetch: fetch as unknown as typeof globalThis.fetch, sent };
}

function client(
	fetch: typeof globalThis.fetch,
	files: Record<string, string> = { "data/shop/queries/sales-since.sql": question },
	readSha?: (text: string) => string,
) {
	const reads: string[] = [];
	return {
		reads,
		data: new CloudMemberData({
			environmentId: env,
			gatewayUrl: "https://project.supabase.co/functions/v1/member-company-gateway",
			accessToken: async () => "aaa.bbb.ccc",
			fetch,
			readText: async (path, maximum) => {
				reads.push(path);
				const text = files[path];
				expect(maximum).toBe(16 * 1024);
				return text === undefined ? null : { text, sha256: readSha ? readSha(text) : sha(text) };
			},
		}),
	};
}

const asked = { database: "shop", question: "sales-since", params: { since: "2026-11-01" } };
const signal = () => new AbortController().signal;

afterEach(() => {
	vi.useRealTimers();
});

describe("a member's questions to the company's databases", () => {
	it("asks a question as the member, with a closed answer", async () => {
		const { fetch, sent } = fakeFetch([[200, answer]]);
		expect(await client(fetch).data.query(asked, signal())).toEqual(answer);
		expect(sent).toHaveLength(1);
		const [call] = sent;
		expect(call?.url).toBe(
			`https://project.supabase.co/functions/v1/member-company-gateway/v1/company-data/${env}/query`,
		);
		expect(call?.init).toMatchObject({
			method: "POST",
			headers: { authorization: "Bearer aaa.bbb.ccc", "content-type": "application/json" },
			credentials: "omit",
			redirect: "error",
		});
		expect(call?.body).toEqual(asked);
		// Parameters named `__proto__` and `constructor` reach the gateway as given.
		const odd = fakeFetch([[200, answer]]);
		const params = JSON.parse('{"__proto__":"x","constructor":"y"}') as Record<string, string>;
		await client(odd.fetch).data.query({ database: "shop", question: "sales-since", params }, signal());
		expect(String(odd.sent[0]?.init.body)).toBe(
			'{"database":"shop","question":"sales-since","params":{"__proto__":"x","constructor":"y"}}',
		);
	});

	it("sends a question's text when the gateway asks for it, and only the right one", async () => {
		const hash = sha(question);
		const need = { need: [{ path: "data/shop/queries/sales-since.sql", sha256: hash }] };
		const right = fakeFetch([
			[200, need],
			[200, answer],
		]);
		const one = client(right.fetch);
		expect(await one.data.query(asked, signal())).toEqual(answer);
		expect(one.reads).toEqual(["data/shop/queries/sales-since.sql"]);
		expect(right.sent[1]?.body).toEqual({ ...asked, texts: { [hash]: question } });

		// A file whose bytes are not the ones the gateway named is not sent.
		const changed = fakeFetch([[200, need]]);
		await expect(
			client(changed.fetch, { "data/shop/queries/sales-since.sql": `${question} ` }).data.query(asked, signal()),
		).rejects.toThrow("data/shop/queries/sales-since.sql changed while it was asked: try again");
		expect(changed.sent).toHaveLength(1);
		// Nor one whose reader says another hash than its bytes have.
		const lying = fakeFetch([
			[200, { need: [{ path: "data/shop/queries/sales-since.sql", sha256: "f".repeat(64) }] }],
		]);
		await expect(client(lying.fetch, undefined, () => "f".repeat(64)).data.query(asked, signal())).rejects.toThrow(
			"changed while it was asked",
		);

		// A path that is not this call's question is never read.
		const other = fakeFetch([[200, { need: [{ path: "data/hr/queries/total.sql", sha256: hash }] }]]);
		const stranger = client(other.fetch, { "data/hr/queries/total.sql": question });
		await expect(stranger.data.query(asked, signal())).rejects.toThrow("not this call's question");
		expect(stranger.reads).toEqual([]);
		for (const path of [
			"data/shop/tables/001-orders.sql",
			"notes/secret.md",
			"data/shop/queries/sales-since.sql/..",
		]) {
			const odd = fakeFetch([[200, { need: [{ path, sha256: hash }] }]]);
			await expect(client(odd.fetch).data.query(asked, signal()), path).rejects.toThrow(CloudMemberDataError);
		}

		// A file the member may not read is not sent either.
		const gone = fakeFetch([[200, need]]);
		await expect(client(gone.fetch, {}).data.query(asked, signal())).rejects.toThrow("can't be read");

		// Two rounds at most.
		const again = fakeFetch([
			[200, need],
			[200, need],
			[200, need],
		]);
		await expect(client(again.fetch).data.query(asked, signal())).rejects.toThrow(
			"could not take the question's text",
		);
		expect(again.sent).toHaveLength(3);
	});

	it("holds a watch, sends what it holds, and reads the changed answers by their place", async () => {
		const watches = [
			{ ...asked, etag: "old" },
			{ database: "shop", question: "by-status", params: {}, etag: "e2" },
		];
		const { fetch, sent } = fakeFetch([
			[200, { changed: [{ index: 0, answer }] }],
			[200, { same: true }],
		]);
		const data = client(fetch).data;
		expect(await data.watch(watches, signal())).toEqual({ changed: [{ index: 0, answer }] });
		expect(await data.watch(watches, signal())).toEqual({ same: true });
		expect(sent[0]?.url).toBe(
			`https://project.supabase.co/functions/v1/member-company-gateway/v1/company-data/${env}/watch`,
		);
		expect(sent[0]?.body).toEqual({ watches, wait: 20 });
		// A text it needs, for any of its questions.
		const by = "select status from orders;\n";
		const need = fakeFetch([
			[200, { need: [{ path: "data/shop/queries/by-status.sql", sha256: sha(by) }] }],
			[200, { same: true }],
		]);
		expect(await client(need.fetch, { "data/shop/queries/by-status.sql": by }).data.watch(watches, signal())).toEqual(
			{
				same: true,
			},
		);
		expect(need.sent[1]?.body).toEqual({ watches, wait: 20, texts: { [sha(by)]: by } });
		// At most 24 questions, and an answer about a question it did not hold is no answer.
		await expect(data.watch([], signal())).rejects.toThrow("A watch holds 1 to 24 questions");
		await expect(
			data.watch(
				Array.from({ length: 25 }, () => watches[0]!),
				signal(),
			),
		).rejects.toThrow("1 to 24");
		for (const odd of [
			{ changed: [{ index: 2, answer }] },
			{ changed: [] },
			{
				changed: [
					{ index: 0, answer },
					{ index: 0, answer },
				],
			},
			{ same: false },
			{ same: true, extra: 1 },
			{ same: true, partial: false },
			{ changed: [{ index: 0, answer }], partial: "yes" },
		]) {
			const bad = fakeFetch([[200, odd]]);
			await expect(client(bad.fetch).data.watch(watches, signal()), JSON.stringify(odd)).rejects.toThrow(
				"an answer this page does not know",
			);
		}
		// A call that reached its deadline before it asked every question: what it has is good, and it says so.
		const partial = fakeFetch([
			[200, { changed: [{ index: 1, answer }], partial: true }],
			[200, { same: true, partial: true }],
		]);
		const late = client(partial.fetch).data;
		expect(await late.watch(watches, signal())).toEqual({ changed: [{ index: 1, answer }], partial: true });
		expect(await late.watch(watches, signal())).toEqual({ same: true, partial: true });
	});

	it("takes a watch call's answers together up to 8 MiB, and one question's answer up to 1 MiB", async () => {
		// Five questions of about 220 KiB each that changed together: over 1 MiB in all, each well under it.
		const wide = (etag: string) => ({ ...answer, columns: ["x"], rows: [["y".repeat(220 * 1024)]], etag });
		const watches = Array.from({ length: 5 }, (_, index) => ({ ...asked, question: `q${index}`, etag: "old" }));
		const changed = watches.map((_, index) => ({ index, answer: wide(`e${index}`) }));
		expect(JSON.stringify({ changed }).length).toBeGreaterThan(1024 * 1024);
		const together = fakeFetch([[200, { changed }]]);
		const got = await client(together.fetch).data.watch(watches, signal());
		expect("changed" in got && got.changed.map((one) => one.answer.etag)).toEqual(["e0", "e1", "e2", "e3", "e4"]);
		// Past 8 MiB it is no answer.
		const huge = Array.from({ length: 24 }, (_, index) => ({ ...asked, question: `q${index}`, etag: "old" }));
		const tooMuch = huge.map((_, index) => ({
			index,
			answer: { ...answer, columns: ["x"], rows: [["y".repeat(360 * 1024)]], etag: `e${index}` },
		}));
		const over = fakeFetch([[200, { changed: tooMuch }]]);
		await expect(client(over.fetch).data.watch(huge, signal())).rejects.toThrow("The answer is larger than 8 MiB");
		// A question alone still stops at 1 MiB.
		const one = fakeFetch([[200, { ...answer, columns: ["x"], rows: [["y".repeat(1024 * 1024)]] }]]);
		await expect(client(one.fetch).data.query(asked, signal())).rejects.toThrow("The answer is larger than 1 MiB");
	});

	it("says a refusal in plain words", async () => {
		const ask = async (status: number, value: unknown) =>
			client(fakeFetch([[status, value]]).fetch)
				.data.query(asked, signal())
				.then(
					() => null,
					(error: unknown) => error as CloudMemberDataError,
				);
		expect(await ask(401, { error: "Sign in" })).toMatchObject({
			message: "Sign in again to ask the company's databases",
			status: 401,
		});
		expect(await ask(404, { error: "No question shop/sales-since that you may read" })).toMatchObject({
			message: "No question shop/sales-since that you may read",
			status: 404,
		});
		expect(await ask(400, "not json")).toMatchObject({
			message: "The company's databases refused the question (400)",
		});
		expect(await ask(503, { error: "The data store did not answer" })).toMatchObject({
			message: "The company's databases did not answer (503)",
			status: 503,
		});
		expect((await ask(200, "not json"))?.message).toBe(
			"The company's databases gave an answer this page does not know",
		);
		for (const odd of [
			{ ...answer, extra: true },
			{ ...answer, rows: [[1]] },
			{ ...answer, more: "no" },
			{ ...answer, etag: "" },
			{ ...answer, asOf: "yesterday" },
			{ same: true, etag: answer.etag },
		])
			expect((await ask(200, odd))?.message, JSON.stringify(odd)).toBe(
				"The company's databases gave an answer this page does not know",
			);
		// Over a mebibyte is no answer.
		const big = { ...answer, rows: [["x".repeat(1024 * 1024)]], columns: ["x"] };
		expect((await ask(200, big))?.message).toBe("The answer is larger than 1 MiB");
		// A question named outside the rules is not sent.
		const none = fakeFetch([]);
		for (const bad of [
			{ ...asked, database: "Shop" },
			{ ...asked, database: "1shop" },
			{ ...asked, question: "sales--since" },
			{ ...asked, question: "-sales" },
			{ ...asked, question: "a".repeat(61) },
		])
			await expect(client(none.fetch).data.query(bad, signal())).rejects.toThrow("Name a question");
		expect(none.sent).toHaveLength(0);
		// A member with no token is told to sign in, and nothing is sent.
		const unsigned = new CloudMemberData({
			environmentId: env,
			gatewayUrl: "https://api.example.com/",
			accessToken: async () => {
				throw new Error("signed out");
			},
			fetch: none.fetch,
			readText: async () => null,
		});
		await expect(unsigned.query(asked, signal())).rejects.toMatchObject({ status: 401 });
		expect(none.sent).toHaveLength(0);
		expect(
			() =>
				new CloudMemberData({
					environmentId: env,
					gatewayUrl: "http://api.example.com",
					accessToken: async () => "a",
					readText: async () => null,
				}),
		).toThrow("Invalid company data endpoint");
		expect(parseCloudMemberDataAnswer(answer)).toEqual(answer);
	});

	it("gives a held watch 35 s, and stops when its caller does", async () => {
		vi.useFakeTimers();
		const held = (sent: Sent) =>
			new Promise<Response>((_resolve, reject) => {
				sent.init.signal?.addEventListener("abort", () => reject(sent.init.signal?.reason));
			});
		const { fetch } = fakeFetch([held, held, held]);
		const data = client(fetch).data;
		const watching = data.watch([{ ...asked, etag: "e" }], signal()).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(34_000);
		let settled = false;
		void watching.then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1_001);
		expect(await watching).toMatchObject({ name: "CloudRequestTimeoutError" });
		// A question has 15 s.
		const asking = data.query(asked, signal()).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(15_001);
		expect(await asking).toMatchObject({ name: "CloudRequestTimeoutError" });
		// The caller's stop ends it at once, and an aborted signal sends nothing.
		const stop = new AbortController();
		const stopped = data.watch([{ ...asked, etag: "e" }], stop.signal).catch((error: unknown) => error);
		stop.abort(new Error("put away"));
		expect(await stopped).toMatchObject({ message: "put away" });
		const none = fakeFetch([]);
		await expect(client(none.fetch).data.query(asked, stop.signal)).rejects.toThrow("put away");
		expect(none.sent).toHaveLength(0);
	});
});
