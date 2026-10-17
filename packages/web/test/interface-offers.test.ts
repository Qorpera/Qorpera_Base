// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyInterfaceOffers, type InterfaceOffersState } from "../src/app/interface-offers.ts";
import { type Cloud, CloudRpcError } from "../src/cloud/client.ts";
import {
	type InterfaceOfferCalls,
	interfaceOfferCalls,
	type MemberInterfaceOffers,
} from "../src/cloud/interface-offers.ts";
import {
	type InterfaceSupervisionCalls,
	interfaceSupervisionCalls,
	type MemberInterfaceSupervision,
} from "../src/cloud/interface-supervisions.ts";
import { CloudShapeError } from "../src/cloud/parse.ts";
import { id, timestamp } from "./fixtures.ts";

/* Interfaces step I9c (supabase/CLIENT-CONTRACT.md "Offers of a claimed cell"): the four offer calls as the web client
 * sends and reads them, and the company's offers reader that pages draw from; with step I9b's consent calls
 * ("Supervision consent"), whose live consents the reader reads beside the offers. */

const TABLE = "86b0c3e9-2d4f-4a6b-b1e8-5c7d9f0a3b62";
const ENVIRONMENT = id(60);
const row = {
	id: id(901),
	table: TABLE,
	folder: "tables/cards",
	key: [id(701)],
	column: "holder",
	from: id(42),
	was: null,
	to: id(43),
	state: "open",
	agent: null,
	at: timestamp,
	closedAt: null,
};
const offer = {
	id: row.id,
	table: TABLE,
	folder: "tables/cards",
	key: [id(701)],
	column: "holder",
	from: id(42),
	was: null,
	to: id(43),
	state: "open",
	agent: null,
	at: timestamp,
};
const supervision: MemberInterfaceSupervision = {
	id: id(911),
	table: TABLE,
	folder: "tables/areas",
	key: ["Sales"],
	user: id(42),
	state: "live",
	at: timestamp,
	endedAt: null,
};

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("the offer calls (I9c)", () => {
	const cloudOf = (answer: unknown) => {
		const rpc = vi.fn(async () => answer);
		return { rpc, calls: interfaceOfferCalls({ rpc } as unknown as Cloud, ENVIRONMENT) };
	};

	it("lists the open offers, keeping the typed key", async () => {
		const { rpc, calls } = cloudOf({ schema: "qorpera.member-interface-offers/v1", offers: [row], truncated: false });
		await expect(calls.list()).resolves.toEqual({ offers: [offer], truncated: false });
		expect(rpc).toHaveBeenCalledExactlyOnceWith("qorpera_member_interface_offers", { p_environment_id: ENVIRONMENT });
		// A key of a number, a yes or no, a list or an empty value comes as it is.
		const typed = cloudOf({
			schema: "qorpera.member-interface-offers/v1",
			offers: [{ ...row, key: [3, true, ["a", "b"], null] }],
			truncated: true,
		});
		await expect(typed.calls.list()).resolves.toEqual({
			offers: [{ ...offer, key: [3, true, ["a", "b"], null] }],
			truncated: true,
		});
		// An agent's offer to an area's supervisor (I9b) names the agent; an answer from before it has none.
		const agent = cloudOf({
			schema: "qorpera.member-interface-offers/v1",
			offers: [
				{ ...row, folder: "tables/areas", key: ["Sales"], column: "agents", agent: id(81) },
				{ ...row, agent: undefined },
			],
			truncated: false,
		});
		await expect(agent.calls.list()).resolves.toEqual({
			offers: [{ ...offer, folder: "tables/areas", key: ["Sales"], column: "agents", agent: id(81) }, offer],
			truncated: false,
		});
	});

	it("refuses an answer of another shape", async () => {
		for (const answer of [
			{ schema: "qorpera.member-interface-offers/v2", offers: [], truncated: false },
			{ schema: "qorpera.member-interface-offers/v1", offers: [] },
			{ schema: "qorpera.member-interface-offers/v1", offers: [{ ...row, table: "cards" }], truncated: false },
			{ schema: "qorpera.member-interface-offers/v1", offers: [{ ...row, key: [{ a: 1 }] }], truncated: false },
			{ schema: "qorpera.member-interface-offers/v1", offers: [{ ...row, state: "maybe" }], truncated: false },
			{ schema: "qorpera.member-interface-offers/v1", offers: [{ ...row, agent: "agent-b" }], truncated: false },
		])
			await expect(cloudOf(answer).calls.list()).rejects.toBeInstanceOf(CloudShapeError);
	});

	it("makes an offer with the cell as the page read it, and reads a refusal as words to show", async () => {
		const made = cloudOf({ schema: "qorpera.interface-offer/v1", ok: true, created: true, offer: row });
		const request = { table: TABLE, key: [id(701)], column: "holder", was: null, to: id(43) };
		await expect(made.calls.offer(request)).resolves.toEqual({ ok: true, offer });
		expect(made.rpc).toHaveBeenCalledExactlyOnceWith("qorpera_offer_interface_cell", {
			p_environment_id: ENVIRONMENT,
			p_request: request,
		});
		const refused = cloudOf({
			schema: "qorpera.interface-offer/v1",
			ok: false,
			reason: "write",
			message: "They can't change the rows of this table.",
		});
		await expect(refused.calls.offer(request)).resolves.toEqual({
			ok: false,
			reason: "write",
			message: "They can't change the rows of this table.",
		});
		await expect(cloudOf({ ok: true, offer: row }).calls.offer(request)).rejects.toBeInstanceOf(CloudShapeError);
	});

	it("declines and withdraws by the offer's id", async () => {
		const closed = {
			schema: "qorpera.interface-offer/v1",
			ok: true,
			changed: true,
			offer: { ...row, state: "declined" },
		};
		const { rpc, calls } = cloudOf(closed);
		await calls.decline(row.id);
		await calls.withdraw(row.id);
		expect(rpc.mock.calls).toEqual([
			["qorpera_decline_interface_offer", { p_environment_id: ENVIRONMENT, p_offer: row.id }],
			["qorpera_withdraw_interface_offer", { p_environment_id: ENVIRONMENT, p_offer: row.id }],
		]);
		await expect(cloudOf({ schema: "qorpera.interface-offer/v1", ok: false }).calls.decline(row.id)).rejects.toThrow(
			CloudShapeError,
		);
	});
});

describe("the supervision consent calls (I9b)", () => {
	const cloudOf = (answer: unknown) => {
		const rpc = vi.fn(async () => answer);
		return { rpc, calls: interfaceSupervisionCalls({ rpc } as unknown as Cloud, ENVIRONMENT) };
	};
	const answered = (value: MemberInterfaceSupervision) => ({
		schema: "qorpera.interface-supervision/v1",
		ok: true,
		created: true,
		supervision: value,
	});

	it("lists the live consents, keeping the typed key", async () => {
		const ended = { ...supervision, id: id(912), key: null, state: "released", endedAt: timestamp };
		const { rpc, calls } = cloudOf({
			schema: "qorpera.member-interface-supervisions/v1",
			supervisions: [supervision, { ...supervision, id: id(913), key: [3, true, null] }, ended],
			truncated: false,
		});
		await expect(calls.list()).resolves.toEqual({
			supervisions: [supervision, { ...supervision, id: id(913), key: [3, true, null] }, ended],
			truncated: false,
		});
		expect(rpc).toHaveBeenCalledExactlyOnceWith("qorpera_member_interface_supervisions", {
			p_environment_id: ENVIRONMENT,
		});
	});

	it("refuses an answer of another shape", async () => {
		const schema = "qorpera.member-interface-supervisions/v1";
		for (const answer of [
			{ schema: "qorpera.member-interface-supervisions/v2", supervisions: [], truncated: false },
			{ schema, supervisions: [] },
			{ schema, supervisions: [{ ...supervision, table: "areas" }], truncated: false },
			{ schema, supervisions: [{ ...supervision, key: [{ a: 1 }] }], truncated: false },
			{ schema, supervisions: [{ ...supervision, user: "bea" }], truncated: false },
			{ schema, supervisions: [{ ...supervision, state: "maybe" }], truncated: false },
		])
			await expect(cloudOf(answer).calls.list()).rejects.toBeInstanceOf(CloudShapeError);
	});

	it("consents by the row's key, and reads a refusal as words to show", async () => {
		const made = cloudOf(answered(supervision));
		await expect(made.calls.consent(["Sales"])).resolves.toEqual({ ok: true, supervision });
		expect(made.rpc).toHaveBeenCalledExactlyOnceWith("qorpera_consent_interface_supervision", {
			p_environment_id: ENVIRONMENT,
			p_request: { key: ["Sales"] },
		});
		const refusal = {
			schema: "qorpera.interface-supervision/v1",
			ok: false,
			reason: "not_yours",
			message: "The area's supervisor cell names someone else.",
		};
		await expect(cloudOf(refusal).calls.consent(["Sales"])).resolves.toEqual({
			ok: false,
			reason: "not_yours",
			message: "The area's supervisor cell names someone else.",
		});
		await expect(cloudOf({ ok: true, supervision }).calls.consent(["Sales"])).rejects.toBeInstanceOf(CloudShapeError);
	});

	it("withdraws by the consent's id", async () => {
		const { rpc, calls } = cloudOf({ ...answered({ ...supervision, state: "withdrawn" }), changed: true });
		await calls.withdraw(supervision.id);
		expect(rpc).toHaveBeenCalledExactlyOnceWith("qorpera_withdraw_interface_supervision", {
			p_environment_id: ENVIRONMENT,
			p_supervision: supervision.id,
		});
		const refused = { schema: "qorpera.interface-supervision/v1", ok: false, reason: "gone", message: "Gone." };
		await expect(cloudOf(refused).calls.withdraw(supervision.id)).rejects.toBeInstanceOf(CloudShapeError);
	});
});

describe("the company's offers reader (I9c)", () => {
	const listed = (...ids: number[]): MemberInterfaceOffers => ({
		offers: ids.map((n) => ({ ...offer, id: id(n) }) as MemberInterfaceOffers["offers"][number]),
		truncated: false,
	});
	/** What the reader publishes for these offers, beside the live consents. */
	const shown = (
		ids: readonly number[],
		supervisions: readonly MemberInterfaceSupervision[] | null = [],
	): InterfaceOffersState => ({ ...listed(...ids), supervisions });
	function reader(
		list: InterfaceOfferCalls["list"],
		supervised: InterfaceSupervisionCalls["list"] = async () => ({ supervisions: [], truncated: false }),
	) {
		const calls = {
			list: vi.fn(list),
			offer: vi.fn(async () => ({ ok: false as const, reason: "gone", message: "Gone." })),
			decline: vi.fn(async () => {}),
			withdraw: vi.fn(async () => {}),
		};
		const consents = {
			list: vi.fn(supervised),
			consent: vi.fn<InterfaceSupervisionCalls["consent"]>(async () => ({ ok: true, supervision })),
			withdraw: vi.fn<InterfaceSupervisionCalls["withdraw"]>(async () => {}),
		};
		const published: (InterfaceOffersState | undefined)[] = [];
		const stop = new AbortController();
		const offers = new CompanyInterfaceOffers(calls, consents, (state) => published.push(state), stop.signal);
		return { calls, consents, published, offers, stop };
	}

	it("publishes what it reads, and nothing again while it stays the same", async () => {
		vi.useFakeTimers();
		const { calls, published, offers, stop } = reader(async () => listed(901));
		offers.open();
		await vi.waitFor(() => expect(published).toEqual([shown([901])]));
		await offers.refresh();
		expect(calls.list).toHaveBeenCalledTimes(2);
		expect(published).toHaveLength(1);
		// Each minute, and when the window comes back.
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls.list).toHaveBeenCalledTimes(3);
		window.dispatchEvent(new Event("focus"));
		await vi.waitFor(() => expect(calls.list).toHaveBeenCalledTimes(4));
		// Stopped with the company: no more reads.
		stop.abort();
		await vi.advanceTimersByTimeAsync(120_000);
		window.dispatchEvent(new Event("focus"));
		await offers.refresh();
		expect(calls.list).toHaveBeenCalledTimes(4);
	});

	it("leaves out the offers of agents to an area's supervisor, which the pages don't draw (I9b)", async () => {
		const agent = {
			...offer,
			id: id(905),
			folder: "tables/areas",
			key: ["Sales"],
			column: "agents",
			agent: id(81),
		} as MemberInterfaceOffers["offers"][number];
		let answer: MemberInterfaceOffers = { offers: [agent, ...listed(901).offers], truncated: false };
		const { published, offers } = reader(async () => answer);
		await offers.refresh();
		expect(published).toEqual([shown([901])]);
		// Only an agent's offer changed: nothing new to publish.
		answer = { offers: [{ ...agent, id: id(906) }, ...listed(901).offers], truncated: false };
		await offers.refresh();
		expect(published).toEqual([shown([901])]);
	});

	it("publishes no offers where the calls aren't there or don't answer the member, and keeps them on a failure", async () => {
		let answer: () => Promise<MemberInterfaceOffers> = async () => listed(901);
		const { published, offers } = reader(() => answer());
		await offers.refresh();
		answer = async () => {
			throw new Error("The network is down.");
		};
		await offers.refresh();
		expect(published).toEqual([shown([901])]);
		answer = async () => {
			throw new CloudRpcError("qorpera_member_interface_offers", { message: "not found", code: "PGRST202" }, 404);
		};
		await offers.refresh();
		expect(published).toEqual([shown([901]), undefined]);
		answer = async () => listed(902);
		await offers.refresh();
		answer = async () => {
			throw new CloudRpcError("qorpera_member_interface_offers", { message: "denied", code: "42501" }, 403);
		};
		await offers.refresh();
		expect(published).toEqual([shown([901]), undefined, shown([902]), undefined]);
	});

	it("reads once more after a read on its way, for every call meanwhile, each settling when that read is in", async () => {
		const answers: ((value: MemberInterfaceOffers) => void)[] = [];
		const { calls, published, offers } = reader(
			() =>
				new Promise<MemberInterfaceOffers>((resolve) => {
					answers.push(resolve);
				}),
		);
		const first = offers.refresh();
		let settled = 0;
		const again = [offers.refresh(), offers.refresh()].map((each) => each.then(() => settled++));
		expect(calls.list).toHaveBeenCalledTimes(1);
		answers[0]?.(listed(901));
		await first;
		expect(published).toEqual([shown([901])]);
		await vi.waitFor(() => expect(calls.list).toHaveBeenCalledTimes(2));
		expect(settled).toBe(0);
		answers[1]?.(listed(902));
		await Promise.all(again);
		expect(settled).toBe(2);
		expect(published).toEqual([shown([901]), shown([902])]);
		expect(calls.list).toHaveBeenCalledTimes(2);
	});

	it("reads again after each offer, decline and withdraw, failed or not, and settles once that is published", async () => {
		let open = listed(901);
		const { calls, published, offers } = reader(async () => open);
		await offers.refresh();
		calls.decline.mockImplementationOnce(async () => {
			open = listed();
		});
		await offers.decline(id(901));
		expect(calls.decline).toHaveBeenCalledExactlyOnceWith(id(901));
		expect(published.at(-1)).toEqual(shown([]));
		open = listed(903);
		calls.withdraw.mockRejectedValueOnce(new Error("The network is down."));
		await expect(offers.withdraw(id(903))).rejects.toThrow("The network is down.");
		expect(published.at(-1)).toEqual(shown([903]));
		open = listed(904);
		const request = { table: TABLE, key: [id(701)], column: "holder", was: null, to: id(43) };
		await expect(offers.offer(request)).resolves.toEqual({ ok: false, reason: "gone", message: "Gone." });
		expect(calls.offer).toHaveBeenCalledExactlyOnceWith(request);
		expect(published.at(-1)).toEqual(shown([904]));
	});

	it("publishes the live consents beside the offers, none where their calls don't answer, and keeps them on a failure (I9b)", async () => {
		let consents: InterfaceSupervisionCalls["list"] = async () => ({ supervisions: [supervision], truncated: false });
		const { published, offers } = reader(
			async () => listed(901),
			() => consents(),
		);
		await offers.refresh();
		expect(published).toEqual([shown([901], [supervision])]);
		consents = async () => {
			throw new Error("The network is down.");
		};
		await offers.refresh();
		expect(published).toEqual([shown([901], [supervision])]);
		// A cloud without the consents' calls, or that doesn't answer them for the member, still draws its offers.
		consents = async () => {
			throw new CloudRpcError(
				"qorpera_member_interface_supervisions",
				{ message: "not found", code: "PGRST202" },
				404,
			);
		};
		await offers.refresh();
		expect(published).toEqual([shown([901], [supervision]), shown([901], null)]);
		consents = async () => {
			throw new CloudRpcError("qorpera_member_interface_supervisions", { message: "denied", code: "42501" }, 403);
		};
		await offers.refresh();
		expect(published).toHaveLength(2);
	});

	it("reads again after a consent and a withdrawn one, failed or not, and settles once that is published (I9b)", async () => {
		let live: MemberInterfaceSupervision[] = [];
		const { consents, published, offers } = reader(
			async () => listed(901),
			async () => ({ supervisions: live, truncated: false }),
		);
		await offers.refresh();
		consents.consent.mockImplementationOnce(async () => {
			live = [supervision];
			return { ok: true, supervision };
		});
		await expect(offers.consent(["Sales"])).resolves.toEqual({ ok: true, supervision });
		expect(consents.consent).toHaveBeenCalledExactlyOnceWith(["Sales"]);
		expect(published.at(-1)).toEqual(shown([901], [supervision]));
		consents.withdraw.mockImplementationOnce(async () => {
			live = [];
		});
		await offers.withdrawSupervision(supervision.id);
		expect(consents.withdraw).toHaveBeenCalledExactlyOnceWith(supervision.id);
		expect(published.at(-1)).toEqual(shown([901]));
		live = [{ ...supervision, id: id(914) }];
		consents.withdraw.mockRejectedValueOnce(new Error("The network is down."));
		await expect(offers.withdrawSupervision(id(914))).rejects.toThrow("The network is down.");
		expect(published.at(-1)).toEqual(shown([901], [{ ...supervision, id: id(914) }]));
	});
});
