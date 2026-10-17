// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryView, type WebCompanyMemory } from "../src/app/views/settings-memory.ts";
import { CloudApi } from "../src/cloud/api.ts";
import { type Cloud, CloudRpcError } from "../src/cloud/client.ts";
import { type CompanyMemoryMode, parseCompanyMemory } from "../src/cloud/memory-mode.ts";
import { id, settle, timestamp } from "./fixtures.ts";

/** The company's memory as the cloud keeps it: the choice, the beta offer, and each run on its way in its mode. */
interface Stored {
	mode: CompanyMemoryMode;
	setAt: string | null;
	betaOffered: boolean;
	canManage: boolean;
	running: CompanyMemoryMode[];
}

/** The read's answer (PR A's test 686 pins it): new runs get the tree only while it is chosen and offered. */
function answer(stored: Stored): Record<string, unknown> {
	const effective = stored.mode === "tree" && stored.betaOffered ? "tree" : "notebooks";
	return {
		schema: "qorpera.company-memory-mode/v1",
		profileId: id(10),
		mode: stored.mode,
		setAt: stored.setAt,
		effective,
		betaOffered: stored.betaOffered,
		canManage: stored.canManage,
		runsInOtherMode: stored.running.filter((mode) => mode !== effective).length,
	};
}

const fresh: Stored = { mode: "notebooks", setAt: null, betaOffered: false, canManage: true, running: [] };

/** A cloud that answers as the RPCs do: tree is refused while not offered, the same choice changes nothing. */
function memoryCloud(start: Partial<Stored> = {}) {
	let stored: Stored = { ...fresh, ...start };
	const client = {
		read: vi.fn<WebCompanyMemory["read"]>(async () => parseCompanyMemory(answer(stored), id(10))),
		choose: vi.fn<WebCompanyMemory["choose"]>(async (mode) => {
			if (!stored.canManage) {
				throw new CloudRpcError("qorpera_set_company_memory_mode", {
					code: "42501",
					message: "Only owners and admins change the company's memory",
				});
			}
			if (mode === "tree" && !stored.betaOffered) {
				throw new CloudRpcError("qorpera_set_company_memory_mode", {
					code: "55000",
					message: "Shared context is not available for this company yet",
				});
			}
			if (mode !== stored.mode) stored = { ...stored, mode, setAt: timestamp };
			return parseCompanyMemory(answer(stored), id(10));
		}),
	};
	const change = (next: Partial<Stored>) => {
		stored = { ...stored, ...next };
	};
	return { client, change };
}

const radio = (el: HTMLElement, mode: CompanyMemoryMode) =>
	el.querySelector<HTMLInputElement>(`.settings-memory-choices input[type=radio][value=${mode}]`)!;
const notices = (el: HTMLElement) => [...el.querySelectorAll(".notice")].map((item) => item.textContent);
const notes = (el: HTMLElement) => [...el.querySelectorAll(".settings-rule-note")].map((item) => item.textContent);
/** A radio's name and description, as a screen reader reads them. */
const described = (el: HTMLElement, mode: CompanyMemoryMode) => {
	const input = radio(el, mode);
	const text = (attribute: string) => document.getElementById(input.getAttribute(attribute)!)?.textContent;
	return [text("aria-labelledby"), text("aria-describedby")];
};

let view: MemoryView | undefined;
afterEach(() => {
	view?.dispose();
	view = undefined;
	document.body.replaceChildren();
});

async function show(client: WebCompanyMemory, role: () => string | undefined = () => "owner") {
	view = new MemoryView(client, new AbortController().signal, role);
	document.body.append(view.el);
	await settle();
	return view;
}

describe("the company memory client", () => {
	it("reads and chooses through the two RPCs of its company", async () => {
		const rpc = vi.fn<Cloud["rpc"]>(async (name) => {
			const chosen = name === "qorpera_set_company_memory_mode";
			return answer({ ...fresh, betaOffered: true, mode: chosen ? "tree" : "notebooks" });
		});
		const api = new CloudApi({ rpc } as unknown as Cloud);
		expect(await api.getCompanyMemory(id(10))).toEqual({
			profileId: id(10),
			mode: "notebooks",
			setAt: null,
			effective: "notebooks",
			betaOffered: true,
			canManage: true,
			runsInOtherMode: 0,
		});
		expect(await api.setCompanyMemory(id(10), "tree")).toMatchObject({ mode: "tree", effective: "tree" });
		expect(rpc.mock.calls).toEqual([
			["qorpera_company_memory_mode", { p_profile_id: id(10) }],
			["qorpera_set_company_memory_mode", { p_profile_id: id(10), p_mode: "tree" }],
		]);
		expect(() => api.getCompanyMemory("company")).toThrow("Profile id must be a UUID");
		expect(() => api.setCompanyMemory("company", "notebooks")).toThrow("Profile id must be a UUID");
		expect(rpc).toHaveBeenCalledTimes(2);
	});

	it("takes only the answer of the company it asked about, in the pinned shape", () => {
		const good = answer({ ...fresh, mode: "tree", setAt: timestamp, running: ["tree"] });
		expect(parseCompanyMemory(good, id(10))).toEqual({
			profileId: id(10),
			mode: "tree",
			setAt: timestamp,
			effective: "notebooks",
			betaOffered: false,
			canManage: true,
			runsInOtherMode: 1,
		});
		for (const bad of [
			null,
			[],
			{ ...good, schema: "qorpera.company-memory-mode/v2" },
			{ ...good, profileId: id(11) },
			{ ...good, mode: "both" },
			{ ...good, effective: undefined },
			{ ...good, setAt: "yesterday" },
			{ ...good, betaOffered: "false" },
			{ ...good, canManage: 1 },
			{ ...good, runsInOtherMode: -1 },
			{ ...good, runsInOtherMode: 1.5 },
			{ ...good, runsInOtherMode: "2" },
		]) {
			expect(() => parseCompanyMemory(bad, id(10)), JSON.stringify(bad)).toThrow("The cloud returned an invalid");
		}
	});
});

describe("Settings → Company → Memory", () => {
	it("shows Agent notebooks as the choice, and Shared context as unavailable until the company is offered it", async () => {
		const { client } = memoryCloud();
		const el = (await show(client)).el;
		expect(el.hidden).toBe(false);
		expect(el.querySelector("h2")?.textContent).toBe("Memory");
		expect(described(el, "notebooks")).toEqual([
			"Agent notebooks",
			"Each agent keeps its own notebook of what it learns.",
		]);
		expect(described(el, "tree")).toEqual([
			"Shared context — Beta",
			"Agents share one summary of the company's conversations and work. Not available for this company yet.",
		]);
		expect(radio(el, "notebooks").checked).toBe(true);
		expect(radio(el, "notebooks").disabled).toBe(false);
		expect(radio(el, "tree").checked).toBe(false);
		expect(radio(el, "tree").disabled).toBe(true);
		expect(radio(el, "tree").closest("label")?.classList.contains("is-unavailable")).toBe(true);
		expect(notices(el)).toEqual([]);
		expect(notes(el)).toEqual([
			"A change applies to new runs. A run already started keeps its memory until it ends. Nothing is deleted or rewritten.",
		]);
		// A disabled radio takes no click: nothing is asked of the cloud.
		radio(el, "tree").click();
		await settle();
		expect(client.choose).not.toHaveBeenCalled();
	});

	it("lets an owner switch to the beta when offered, and says which runs still finish in notebooks", async () => {
		const { client } = memoryCloud({ betaOffered: true, running: ["notebooks"] });
		const el = (await show(client)).el;
		expect(radio(el, "tree").disabled).toBe(false);
		expect(described(el, "tree")[1]).toBe("Agents share one summary of the company's conversations and work.");
		radio(el, "tree").focus();
		radio(el, "tree").click();
		// While the cloud answers, the new choice stays checked and neither can change.
		expect(radio(el, "tree").checked).toBe(true);
		expect([radio(el, "notebooks").disabled, radio(el, "tree").disabled]).toEqual([true, true]);
		await settle();
		expect(client.choose).toHaveBeenCalledExactlyOnceWith("tree");
		expect(radio(el, "tree").checked).toBe(true);
		expect(radio(el, "notebooks").checked).toBe(false);
		expect(notices(el)).toEqual([
			"One run that started before the change still uses Agent notebooks until it finishes.",
			"Saved. New runs use Shared context — Beta.",
		]);
		// The keyboard is back on the choice.
		expect(document.activeElement).toBe(radio(el, "tree"));
		// And back: the run on its way still uses notebooks, which new runs now get too.
		radio(el, "notebooks").click();
		await settle();
		expect(client.choose).toHaveBeenLastCalledWith("notebooks");
		expect(radio(el, "notebooks").checked).toBe(true);
		expect(notices(el)).toEqual(["Saved. New runs use Agent notebooks."]);
		expect(client.read).toHaveBeenCalledTimes(1);
	});

	it("shows a member who does not manage the company its memory, locked", async () => {
		const { client } = memoryCloud({ mode: "tree", setAt: timestamp, betaOffered: true, canManage: false });
		const el = (await show(client, () => "viewer")).el;
		expect(radio(el, "tree").checked).toBe(true);
		expect([radio(el, "notebooks").disabled, radio(el, "tree").disabled]).toEqual([true, true]);
		expect(notes(el)[0]).toBe("Owners and admins choose the company's memory.");
		radio(el, "notebooks").click();
		await settle();
		expect(client.choose).not.toHaveBeenCalled();
	});

	it("says when the beta was withdrawn: the choice stays, new runs use notebooks, runs on their way finish in the tree", async () => {
		const { client } = memoryCloud({ mode: "tree", setAt: timestamp, running: ["tree", "tree"] });
		const el = (await show(client)).el;
		expect(radio(el, "tree").checked).toBe(true);
		expect(radio(el, "tree").disabled).toBe(true);
		expect(notices(el)).toEqual([
			"Shared context — Beta is not available now, so new runs use Agent notebooks.",
			"2 runs that started before the change still use Shared context — Beta until they finish.",
		]);
		// Back to notebooks still works; the beta can't be chosen again until it is offered.
		radio(el, "notebooks").click();
		await settle();
		expect(client.choose).toHaveBeenCalledExactlyOnceWith("notebooks");
		expect(radio(el, "notebooks").checked).toBe(true);
		expect(radio(el, "tree").disabled).toBe(true);
		expect(notices(el)).toEqual([
			"2 runs that started before the change still use Shared context — Beta until they finish.",
			"Saved. New runs use Agent notebooks.",
		]);
	});

	it("puts a refused choice back and reads the company's memory again", async () => {
		const { client, change } = memoryCloud({ betaOffered: true });
		const el = (await show(client)).el;
		// The beta is withdrawn after the read: the cloud refuses the choice.
		change({ betaOffered: false });
		radio(el, "tree").focus();
		radio(el, "tree").click();
		await settle();
		expect(client.choose).toHaveBeenCalledExactlyOnceWith("tree");
		expect(radio(el, "notebooks").checked).toBe(true);
		expect(radio(el, "tree").checked).toBe(false);
		expect(notices(el)).toEqual(["Shared context — Beta is not available for this company yet."]);
		expect(el.querySelector(".notice-danger")).not.toBeNull();
		// The read again shows why, and the beta can no longer be chosen.
		expect(client.read).toHaveBeenCalledTimes(2);
		expect(radio(el, "tree").disabled).toBe(true);
		expect(described(el, "tree")[1]).toContain("Not available for this company yet.");
		expect(document.activeElement).toBe(radio(el, "notebooks"));
	});

	it("shows the cloud's refusal as it says it, and reads again when the member's role changes", async () => {
		const { client, change } = memoryCloud({ betaOffered: true });
		let role = "admin";
		view = await show(client, () => role);
		// Demoted before the click: the cloud refuses.
		change({ canManage: false });
		radio(view.el, "tree").click();
		await settle();
		expect(notices(view.el)).toEqual(["Only owners and admins change the company's memory"]);
		expect(radio(view.el, "tree").disabled).toBe(true);
		expect(client.read).toHaveBeenCalledTimes(2);
		// The same role again reads nothing; a new one reads the memory again.
		view.update();
		await settle();
		expect(client.read).toHaveBeenCalledTimes(2);
		change({ canManage: true });
		role = "owner";
		view.update();
		await settle();
		expect(client.read).toHaveBeenCalledTimes(3);
		expect(radio(view.el, "tree").disabled).toBe(false);
	});

	it("reads again when the member's role moved while the first read was on its way", async () => {
		const { client } = memoryCloud();
		let role = "admin";
		view = new MemoryView(client, new AbortController().signal, () => role);
		document.body.append(view.el);
		role = "viewer";
		view.update();
		await settle();
		expect(client.read).toHaveBeenCalledTimes(2);
		// Once read in the role it has, nothing more.
		view.update();
		await settle();
		expect(client.read).toHaveBeenCalledTimes(2);
	});

	it("stays hidden on a cloud without the choice, and shows once a later read finds it", async () => {
		const { client } = memoryCloud();
		client.read.mockRejectedValueOnce(
			new CloudRpcError("qorpera_company_memory_mode", { message: "missing", code: "PGRST202" }, 404),
		);
		let role = "owner";
		view = await show(client, () => role);
		expect(client.read).toHaveBeenCalledTimes(1);
		expect(view.el.hidden).toBe(true);
		expect(view.el.childElementCount).toBe(0);
		role = "admin";
		view.update();
		await settle();
		expect(client.read).toHaveBeenCalledTimes(2);
		expect(view.el.hidden).toBe(false);
		expect(radio(view.el, "notebooks").checked).toBe(true);
	});

	it("says when the read failed, and tries again on Retry", async () => {
		const { client } = memoryCloud();
		client.read.mockRejectedValueOnce(new Error("The network is down."));
		const el = (await show(client)).el;
		expect(el.hidden).toBe(false);
		expect(el.querySelector("h2")?.textContent).toBe("Memory");
		expect(notices(el)).toEqual(["The network is down."]);
		expect(el.querySelector(".settings-memory-choices")).toBeNull();
		const retry = [...el.querySelectorAll("button")].find((button) => button.textContent === "Retry")!;
		retry.focus();
		retry.click();
		await settle();
		expect(client.read).toHaveBeenCalledTimes(2);
		expect(notices(el)).toEqual([]);
		expect(radio(el, "notebooks").checked).toBe(true);
		// The Retry button is gone: the keyboard moves to the choice.
		expect(document.activeElement).toBe(radio(el, "notebooks"));
	});
});
