// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import type { SessionModel, SessionModelSelection } from "../src/cloud/session-model.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import { deferred, fixture, id, profileA, session, settle, staff, team, userA } from "./fixtures.ts";

const cleanups: (() => void)[] = [];
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function setup(groupChat = false) {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({
		team,
		staff: [staff],
		sessions: [
			groupChat ? { ...session, executionScope: { roomId: id(190) } } : { ...session, staffAgentId: staff.id },
		],
		loading: false,
	});
	const models = new Map<string, SessionModel>();
	const read = vi.fn(
		async (sessionId: string): Promise<SessionModel> =>
			models.get(sessionId) ?? { sessionId, modelId: "gpt-6-astra", reasoningEffort: "low", version: 0 },
	);
	const set = vi.fn(
		async (
			sessionId: string,
			selection: SessionModelSelection,
			version: number,
			_signal: AbortSignal,
		): Promise<SessionModel> => {
			const previous = models.get(sessionId);
			const serviceTier = selection.serviceTier ?? previous?.serviceTier;
			const value = {
				sessionId,
				modelId: selection.modelId ?? previous?.modelId ?? "gpt-6-astra",
				reasoningEffort: selection.reasoningEffort ?? previous?.reasoningEffort ?? "low",
				...(serviceTier ? { serviceTier } : {}),
				version: version + 1,
			};
			models.set(sessionId, value);
			return value;
		},
	);
	const sendMessage = vi.fn().mockResolvedValue(true);
	const updateAgent = vi.fn();
	const actions = { sessionModel: { read, set }, sendMessage, updateAgent };
	const view = new ConversationView(company, session.sessionId, actions);
	document.body.append(view.el);
	cleanups.push(() => {
		view.dispose();
		company.stop();
	});
	await settle();
	return { ...f, company, view, actions, models, read, set, updateAgent, sendMessage };
}
function button(root: ParentNode, label: string): HTMLButtonElement {
	const result = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
		(item) => item.getAttribute("aria-label") === label || item.textContent === label,
	);
	if (!result) throw new Error(`Missing button: ${label}`);
	return result;
}
async function open(view: ConversationView, label = "Model: GPT-6 Astra, Low effort"): Promise<HTMLElement> {
	button(view.el, "Chat settings and more").click();
	button(view.el, label).click();
	await settle();
	return view.el.querySelector<HTMLElement>(".composer-models")!;
}

describe("composer model selector", () => {
	it("names each agent's own model in a group chat where none was chosen", async () => {
		const f = await setup(true);
		f.read.mockImplementation(async (sessionId: string) => ({ sessionId, reasoningEffort: "low", version: 0 }));
		// Opening the menu reads the conversation again.
		const panel = await open(f.view);
		expect(button(f.view.el, "Model: Each agent's own, Low effort").textContent).toContain("Each agent's own");
		expect(panel.querySelectorAll('[role="menuitemradio"][aria-checked="true"]').length).toBe(1);
		expect(button(panel, "Low").getAttribute("aria-checked")).toBe("true");
		for (const name of ["GPT-6 Astra", "GPT-6 Sol", "GPT-6 Luna"])
			expect(button(panel, name).getAttribute("aria-checked")).toBe("false");
	});
	it("offers a group chat's speed with no model chosen, for every agent in it", async () => {
		const f = await setup(true);
		f.read.mockImplementation(async (sessionId: string) => ({
			sessionId,
			reasoningEffort: "low",
			serviceTier: "fast",
			version: 0,
		}));
		const panel = await open(f.view);
		expect(button(f.view.el, "Model: Each agent's own, Low effort, Fast").textContent).toContain(
			"Each agent's own · Low · Fast",
		);
		const fast = panel.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!;
		expect(fast.getAttribute("aria-checked")).toBe("true");
		// With no one model, the caption names no speed-up of its own.
		expect(fast.textContent).toBe("FastFaster replies");
		expect(panel.textContent).toContain("Every agent in this group chat. Applies from your next message.");
		fast.click();
		await settle();
		expect(f.set).toHaveBeenLastCalledWith(
			session.sessionId,
			{ serviceTier: "standard" },
			0,
			expect.any(AbortSignal),
		);
	});
	it("gives a group chat one model and effort, for every agent in it", async () => {
		const f = await setup(true);
		const panel = await open(f.view);
		expect(panel.textContent).toContain("Every agent in this group chat. Applies from your next message.");
		button(panel, "GPT-6 Sol").click();
		await settle();
		expect(f.set).toHaveBeenCalledWith(session.sessionId, { modelId: "gpt-6-sol" }, 0, expect.any(AbortSignal));
		button(panel, "High").click();
		await settle();
		expect(f.set).toHaveBeenLastCalledWith(
			session.sessionId,
			{ reasoningEffort: "high" },
			1,
			expect.any(AbortSignal),
		);
		expect(button(f.view.el, "Model: GPT-6 Sol, High effort")).toBeTruthy();
	});
	it("before the cloud honours thread effort, offers only GPT-6 Astra and skips hidden choices", async () => {
		const f = await setup();
		f.read.mockImplementation(async (sessionId: string) => {
			const { reasoningEffort: _, ...value } = f.models.get(sessionId) ?? {
				sessionId,
				modelId: "gpt-6-astra",
				version: 0,
			};
			return value;
		});
		f.set.mockImplementation(async (sessionId, selection, version) => {
			const value = { sessionId, modelId: selection.modelId ?? "gpt-6-astra", version: version + 1 };
			f.models.set(sessionId, value);
			return value;
		});
		// Opening the menu re-reads the conversation from the older cloud.
		const panel = await open(f.view);
		expect(button(f.view.el, "Model: GPT-6 Astra").textContent).toContain("GPT-6 Astra");
		expect(panel.querySelector<HTMLElement>('[role="group"][aria-label="Effort"]')?.hidden).toBe(true);
		expect(panel.querySelector<HTMLElement>('[role="group"][aria-label="Speed"]')?.hidden).toBe(true);
		expect(panel.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')?.disabled).toBe(true);
		expect(button(panel, "GPT-6 Sol").disabled).toBe(true);
		expect(button(panel, "GPT-6 Luna").disabled).toBe(true);
		expect(button(panel, "High").disabled).toBe(true);
		// Arrow keys wrap over the usable choices only: Back and GPT-6 Astra.
		button(panel, "GPT-6 Astra").focus();
		panel.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
		expect(document.activeElement).toBe(button(panel, "GPT-6 Astra"));
		panel.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		expect(document.activeElement).toBe(button(panel, "Model"));
		button(panel, "GPT-6 Astra").click();
		await settle();
		expect(f.set).toHaveBeenCalledWith(session.sessionId, { modelId: "gpt-6-astra" }, 0, expect.any(AbortSignal));
	});
	it("opens from More with the current model selected and supports keyboard return", async () => {
		const f = await setup();
		button(f.view.el, "Chat settings and more").click();
		const attach = button(f.view.el, "Attach files");
		expect(document.activeElement).toBe(attach);
		attach.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		expect(document.activeElement).toBe(button(f.view.el, "Model: GPT-6 Astra, Low effort"));
		document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
		await settle();
		const panel = f.view.el.querySelector<HTMLElement>(".composer-models")!;
		expect(panel.hidden).toBe(false);
		expect(document.activeElement).toBe(button(panel, "GPT-6 Astra"));
		expect(button(panel, "GPT-6 Astra").getAttribute("aria-checked")).toBe("true");
		expect(panel.textContent).toContain("Only this conversation");
		expect([...panel.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent)).toEqual([
			"GPT-6 Astra",
			"GPT-6 Sol",
			"GPT-6 Luna",
			"Low",
			"Medium",
			"High",
		]);
		expect(button(panel, "Low").getAttribute("aria-checked")).toBe("true");
		panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(panel.hidden).toBe(true);
		expect(document.activeElement).toBe(button(f.view.el, "Model: GPT-6 Astra, Low effort"));
		document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(f.view.el.querySelector<HTMLElement>(".composer-menu")?.hidden).toBe(true);
		expect(document.activeElement).toBe(button(f.view.el, "Chat settings and more"));
	});
	it("persists only this conversation, holds sends until confirmed, and survives navigation", async () => {
		const f = await setup();
		const saved = deferred<SessionModel>();
		f.set.mockReturnValueOnce(saved.promise);
		f.company.conversation(session.sessionId).set({ draft: "Continue" });
		const panel = await open(f.view);
		button(panel, "GPT-6 Sol").focus();
		button(panel, "GPT-6 Sol").click();
		expect(f.set).toHaveBeenCalledWith(session.sessionId, { modelId: "gpt-6-sol" }, 0, expect.any(AbortSignal));
		expect(button(f.view.el, "Send message").disabled).toBe(true);
		expect(panel.textContent).toContain("Saving model");
		expect(panel.contains(document.activeElement)).toBe(true);
		const value = { sessionId: session.sessionId, modelId: "gpt-6-sol", reasoningEffort: "low", version: 1 };
		f.models.set(session.sessionId, value);
		saved.resolve(value);
		await settle();
		expect(button(f.view.el, "Send message").disabled).toBe(false);
		expect(button(panel, "GPT-6 Sol").getAttribute("aria-checked")).toBe("true");
		expect(document.activeElement).toBe(button(panel, "GPT-6 Sol"));
		button(panel, "High").focus();
		button(panel, "High").click();
		await settle();
		expect(f.set).toHaveBeenLastCalledWith(
			session.sessionId,
			{ reasoningEffort: "high" },
			1,
			expect.any(AbortSignal),
		);
		expect(button(panel, "High").getAttribute("aria-checked")).toBe("true");
		expect(document.activeElement).toBe(button(panel, "High"));
		expect(button(panel, "GPT-6 Sol").getAttribute("aria-checked")).toBe("true");
		expect(f.updateAgent).not.toHaveBeenCalled();
		expect(f.company.staffById(staff.id)?.model).toBeUndefined();
		const otherSession = { ...session, sessionId: id(80), staffAgentId: staff.id };
		f.company.store.set({ sessions: [{ ...session, staffAgentId: staff.id }, otherSession] });
		f.view.dispose();
		const other = new ConversationView(f.company, otherSession.sessionId, f.actions);
		cleanups.push(() => other.dispose());
		await settle();
		expect(button(other.el, "Model: GPT-6 Astra, Low effort")).toBeTruthy();
		other.dispose();
		const restored = new ConversationView(f.company, session.sessionId, f.actions);
		cleanups.push(() => restored.dispose());
		await settle();
		expect(button(restored.el, "Model: GPT-6 Sol, High effort")).toBeTruthy();
		expect(button(restored.el, "Model: GPT-6 Sol, High effort").textContent).toContain("GPT-6 Sol · High");
		expect(f.company.conversation(session.sessionId).get().draft).toBe("Continue");
	});
	it("runs Fast by default and turns it off for this conversation only", async () => {
		const f = await setup();
		f.models.set(session.sessionId, {
			sessionId: session.sessionId,
			modelId: "gpt-6-astra",
			reasoningEffort: "low",
			serviceTier: "fast",
			version: 0,
		});
		// Opening the menu re-reads the conversation.
		const panel = await open(f.view);
		expect(button(f.view.el, "Model: GPT-6 Astra, Low effort, Fast").textContent).toContain(
			"GPT-6 Astra · Low · Fast",
		);
		expect(panel.querySelector<HTMLElement>('[role="group"][aria-label="Speed"]')?.hidden).toBe(false);
		const fast = panel.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!;
		expect(fast.getAttribute("aria-checked")).toBe("true");
		expect(fast.textContent).toBe("Fast2x speed, uses more of your plan");
		fast.focus();
		fast.click();
		await settle();
		expect(f.set).toHaveBeenLastCalledWith(
			session.sessionId,
			{ serviceTier: "standard" },
			0,
			expect.any(AbortSignal),
		);
		expect(fast.getAttribute("aria-checked")).toBe("false");
		expect(document.activeElement).toBe(fast);
		expect(button(f.view.el, "Model: GPT-6 Astra, Low effort").textContent).toContain("GPT-6 Astra · Low");
		// A model pick keeps the speed, and the caption follows the model.
		button(panel, "GPT-6 Sol").click();
		await settle();
		expect(f.set).toHaveBeenLastCalledWith(session.sessionId, { modelId: "gpt-6-sol" }, 1, expect.any(AbortSignal));
		expect(fast.getAttribute("aria-checked")).toBe("false");
		expect(fast.textContent).toBe("Fast1.5x speed");
		fast.click();
		await settle();
		expect(f.set).toHaveBeenLastCalledWith(session.sessionId, { serviceTier: "fast" }, 2, expect.any(AbortSignal));
		expect(fast.getAttribute("aria-checked")).toBe("true");
		expect(button(f.view.el, "Model: GPT-6 Sol, Low effort, Fast")).toBeTruthy();
		// Danish writes the factor with a decimal comma.
		setLanguagePreference("da");
		try {
			button(panel, "GPT-6 Luna").click();
			await settle();
			expect(fast.querySelector("small")?.textContent).toBe("1,5x hastighed");
		} finally {
			setLanguagePreference("system");
			localStorage.clear();
		}
		// Another conversation keeps its own speed.
		const otherSession = { ...session, sessionId: id(80), staffAgentId: staff.id };
		f.models.set(otherSession.sessionId, {
			sessionId: otherSession.sessionId,
			modelId: "gpt-6-astra",
			reasoningEffort: "low",
			serviceTier: "standard",
			version: 4,
		});
		f.company.store.set({ sessions: [{ ...session, staffAgentId: staff.id }, otherSession] });
		const other = new ConversationView(f.company, otherSession.sessionId, f.actions);
		cleanups.push(() => other.dispose());
		await settle();
		expect(button(other.el, "Model: GPT-6 Astra, Low effort")).toBeTruthy();
	});
	it("recovers an uncertain write by reading, never replaying the mutation", async () => {
		const f = await setup();
		f.set.mockImplementationOnce(async (sessionId, selection) => {
			f.models.set(sessionId, {
				sessionId,
				modelId: selection.modelId ?? "gpt-6-astra",
				reasoningEffort: "low",
				version: 1,
			});
			throw new Error("lost response");
		});
		f.company.conversation(session.sessionId).set({ draft: "Continue" });
		const panel = await open(f.view);
		button(panel, "GPT-6 Luna").click();
		await settle();
		expect(panel.textContent).toContain("The change could not be confirmed");
		expect(button(f.view.el, "Send message").disabled).toBe(true);
		expect(button(panel, "GPT-6 Astra").getAttribute("aria-checked")).toBe("true");
		button(panel, "Refresh model").click();
		await settle();
		expect(f.set).toHaveBeenCalledTimes(1);
		expect(button(f.view.el, "Send message").disabled).toBe(false);
		expect(button(panel, "GPT-6 Luna").getAttribute("aria-checked")).toBe("true");
	});
	it("allows contributors but cancels pending changes on write revocation", async () => {
		const f = await setup();
		f.company.store.set({ team: { ...team, capabilities: { ...team.capabilities, authorize: false } } });
		await settle();
		expect(button(f.view.el, "Model: GPT-6 Astra, Low effort").disabled).toBe(false);
		const saved = deferred<SessionModel>();
		f.set.mockReturnValueOnce(saved.promise);
		const panel = await open(f.view);
		button(panel, "GPT-6 Sol").click();
		const signal = f.set.mock.calls[0]![3];
		f.company.store.set({ team: { ...team, capabilities: { ...team.capabilities, write: false } } });
		await settle();
		expect(signal.aborted).toBe(true);
		saved.resolve({ sessionId: session.sessionId, modelId: "gpt-6-sol", reasoningEffort: "low", version: 1 });
		await settle();
		expect(button(f.view.el, "Model: GPT-6 Astra, Low effort").disabled).toBe(true);
	});
	it("preserves unlisted models and disables choices when loading fails", async () => {
		const f = await setup();
		f.models.set(session.sessionId, {
			sessionId: session.sessionId,
			modelId: "custom-model",
			reasoningEffort: "medium",
			version: 3,
		});
		const panel = await open(f.view);
		expect(button(f.view.el, "Model: custom-model, Medium effort")).toBeTruthy();
		expect([...panel.querySelectorAll('[aria-checked="true"]')].map((item) => item.textContent)).toEqual(["Medium"]);
		expect(button(panel, "GPT-6 Astra").disabled).toBe(false);
		expect(f.set).not.toHaveBeenCalled();
		// An effort pick keeps the unlisted model: the cloud keeps what is not sent.
		button(panel, "High").click();
		await settle();
		expect(f.set).toHaveBeenCalledWith(session.sessionId, { reasoningEffort: "high" }, 3, expect.any(AbortSignal));
		expect(button(f.view.el, "Model: custom-model, High effort")).toBeTruthy();
		button(f.view.el, "Chat settings and more").click();
		f.read.mockRejectedValueOnce(new Error("offline"));
		await open(f.view, "Model: custom-model, High effort");
		expect(button(panel, "GPT-6 Astra").disabled).toBe(true);
		expect(panel.textContent).toContain("model is unavailable");
	});
});
