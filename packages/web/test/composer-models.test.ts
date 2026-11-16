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
				...(previous?.providers ? { providers: previous.providers } : {}),
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
function slider(panel: HTMLElement): HTMLElement {
	return panel.querySelector<HTMLElement>('[role="slider"]')!;
}
function part(panel: HTMLElement, name: "fast" | "pick" | "provider" | "title"): HTMLElement {
	return panel.querySelector<HTMLElement>(`.composer-model-${name}`)!;
}
async function slide(panel: HTMLElement, key: string, times = 1): Promise<void> {
	for (let step = 0; step < times; step++)
		slider(panel).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
	await vi.advanceTimersByTimeAsync(450);
	await settle();
}
function listed(panel: HTMLElement): string[] {
	return [...panel.querySelectorAll<HTMLButtonElement>(".composer-model-choice:not([hidden])")].map(
		(item) => item.textContent ?? "",
	);
}
async function choose(panel: HTMLElement, name: string): Promise<void> {
	part(panel, "pick").click();
	button(panel, name).click();
	await settle();
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
		const panel = await open(f.view);
		expect(button(f.view.el, "Model: Each agent's own, Low effort").textContent).toContain("Each agent's own");
		expect(part(panel, "pick").textContent).toBe("Each agent's own");
		expect(part(panel, "title").textContent).toBe("Low");
		part(panel, "pick").click();
		expect(panel.querySelectorAll('.composer-model-choice[aria-checked="true"]').length).toBe(0);
		expect(listed(panel)).toEqual(["GPT-6 Astra", "GPT-6 Sol", "GPT-6 Luna"]);
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
		const fast = part(panel, "fast") as HTMLButtonElement;
		expect(fast.getAttribute("aria-checked")).toBe("true");
		expect(fast.title).toBe("Fast: Faster replies");
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
		await choose(panel, "GPT-6 Sol");
		expect(f.set).toHaveBeenCalledWith(session.sessionId, { modelId: "gpt-6-sol" }, 0, expect.any(AbortSignal));
		expect(part(panel, "pick").getAttribute("aria-expanded")).toBe("false");
		await slide(panel, "End");
		expect(f.set).toHaveBeenLastCalledWith(
			session.sessionId,
			{ reasoningEffort: "high" },
			1,
			expect.any(AbortSignal),
		);
		expect(button(f.view.el, "Model: GPT-6 Sol, High effort")).toBeTruthy();
	});
	it("before the cloud honours thread effort, offers only GPT-6 Astra and no slider", async () => {
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
		const panel = await open(f.view);
		expect(button(f.view.el, "Model: GPT-6 Astra").textContent).toContain("GPT-6 Astra");
		expect(slider(panel).hidden).toBe(true);
		expect(part(panel, "title").hidden).toBe(true);
		expect(part(panel, "fast").hidden).toBe(true);
		expect(document.activeElement).toBe(part(panel, "pick"));
		part(panel, "pick").click();
		expect(button(panel, "GPT-6 Sol").disabled).toBe(true);
		expect(button(panel, "GPT-6 Luna").disabled).toBe(true);
		expect(document.activeElement).toBe(button(panel, "GPT-6 Astra"));
		panel.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
		expect(document.activeElement).toBe(button(panel, "GPT-6 Astra"));
		panel.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		expect(document.activeElement).toBe(part(panel, "pick"));
		button(panel, "GPT-6 Astra").click();
		await settle();
		expect(f.set).toHaveBeenCalledWith(session.sessionId, { modelId: "gpt-6-astra" }, 0, expect.any(AbortSignal));
	});
	it("opens from More on the effort slider and goes back with Escape", async () => {
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
		expect(document.activeElement).toBe(slider(panel));
		expect(part(panel, "title").textContent).toBe("Low");
		expect(part(panel, "pick").textContent).toBe("GPT-6 Astra");
		expect(part(panel, "provider").hidden).toBe(true);
		expect(slider(panel).getAttribute("aria-valuetext")).toBe("Low");
		expect(slider(panel).getAttribute("aria-valuemax")).toBe("2");
		expect(panel.textContent).not.toContain("Only this conversation");
		part(panel, "pick").click();
		expect(listed(panel)).toEqual(["GPT-6 Astra", "GPT-6 Sol", "GPT-6 Luna"]);
		expect(button(panel, "GPT-6 Astra").getAttribute("aria-checked")).toBe("true");
		panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(part(panel, "pick").getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(part(panel, "pick"));
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
		part(panel, "pick").click();
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
		expect(part(panel, "pick").textContent).toBe("GPT-6 Sol");
		expect(document.activeElement).toBe(part(panel, "pick"));
		slider(panel).focus();
		await slide(panel, "ArrowRight", 2);
		expect(f.set).toHaveBeenCalledTimes(2);
		expect(f.set).toHaveBeenLastCalledWith(
			session.sessionId,
			{ reasoningEffort: "high" },
			1,
			expect.any(AbortSignal),
		);
		expect(part(panel, "title").textContent).toBe("High");
		expect(document.activeElement).toBe(slider(panel));
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
		const panel = await open(f.view);
		expect(button(f.view.el, "Model: GPT-6 Astra, Low effort, Fast").textContent).toContain(
			"GPT-6 Astra · Low · Fast",
		);
		const fast = part(panel, "fast") as HTMLButtonElement;
		expect(fast.hidden).toBe(false);
		expect(fast.getAttribute("aria-checked")).toBe("true");
		expect(fast.title).toBe("Fast: 2x speed, uses more of your plan");
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
		expect(fast.title).toBe("Fast");
		expect(document.activeElement).toBe(fast);
		await choose(panel, "GPT-6 Sol");
		expect(f.set).toHaveBeenLastCalledWith(session.sessionId, { modelId: "gpt-6-sol" }, 1, expect.any(AbortSignal));
		expect(fast.getAttribute("aria-checked")).toBe("false");
		fast.click();
		await settle();
		expect(f.set).toHaveBeenLastCalledWith(session.sessionId, { serviceTier: "fast" }, 2, expect.any(AbortSignal));
		expect(fast.title).toBe("Fast: 1.5x speed");
		expect(button(f.view.el, "Model: GPT-6 Sol, Low effort, Fast")).toBeTruthy();
		setLanguagePreference("da");
		try {
			await choose(panel, "GPT-6 Luna");
			expect(fast.title).toBe("Hurtig: 1,5x hastighed");
		} finally {
			setLanguagePreference("system");
			localStorage.clear();
		}
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
		await choose(panel, "GPT-6 Luna");
		expect(panel.textContent).toContain("The change could not be confirmed");
		expect(button(f.view.el, "Send message").disabled).toBe(true);
		expect(part(panel, "pick").textContent).toBe("GPT-6 Astra");
		expect(document.activeElement).toBe(button(panel, "Refresh model"));
		button(panel, "Refresh model").click();
		await settle();
		expect(f.set).toHaveBeenCalledTimes(1);
		expect(button(f.view.el, "Send message").disabled).toBe(false);
		expect(part(panel, "pick").textContent).toBe("GPT-6 Luna");
	});
	it("allows contributors but cancels pending changes on write revocation", async () => {
		const f = await setup();
		f.company.store.set({ team: { ...team, capabilities: { ...team.capabilities, authorize: false } } });
		await settle();
		expect(button(f.view.el, "Model: GPT-6 Astra, Low effort").disabled).toBe(false);
		const saved = deferred<SessionModel>();
		f.set.mockReturnValueOnce(saved.promise);
		const panel = await open(f.view);
		part(panel, "pick").click();
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
		expect(part(panel, "pick").textContent).toBe("custom-model");
		expect(part(panel, "title").textContent).toBe("Medium");
		part(panel, "pick").click();
		expect(panel.querySelectorAll('.composer-model-choice[aria-checked="true"]').length).toBe(0);
		expect(button(panel, "GPT-6 Astra").disabled).toBe(false);
		part(panel, "pick").click();
		expect(f.set).not.toHaveBeenCalled();
		await slide(panel, "ArrowRight");
		expect(f.set).toHaveBeenCalledWith(session.sessionId, { reasoningEffort: "high" }, 3, expect.any(AbortSignal));
		expect(button(f.view.el, "Model: custom-model, High effort")).toBeTruthy();
		button(f.view.el, "Chat settings and more").click();
		f.read.mockRejectedValueOnce(new Error("offline"));
		await open(f.view, "Model: custom-model, High effort");
		expect((part(panel, "pick") as HTMLButtonElement).disabled).toBe(true);
		expect(slider(panel).getAttribute("aria-disabled")).toBe("true");
		expect(panel.textContent).toContain("model is unavailable");
	});
	it("switches a conversation to Claude with one press where the cloud offers it", async () => {
		const f = await setup();
		f.models.set(session.sessionId, {
			sessionId: session.sessionId,
			modelId: "gpt-6-astra",
			reasoningEffort: "high",
			serviceTier: "fast",
			providers: ["openai", "anthropic"],
			version: 0,
		});
		const panel = await open(f.view);
		const provider = part(panel, "provider") as HTMLButtonElement;
		expect(provider.hidden).toBe(false);
		expect(provider.getAttribute("aria-label")).toBe("Switch to Claude");
		provider.click();
		await settle();
		expect(f.set).toHaveBeenLastCalledWith(
			session.sessionId,
			{ modelId: "claude-opus-5-5" },
			0,
			expect.any(AbortSignal),
		);
		expect(provider.getAttribute("aria-label")).toBe("Switch to GPT");
		expect(provider.title).toContain("GPT answers light messages. Claude Code does the work, on your Claude plan.");
		expect(part(panel, "pick").textContent).toBe("Opus 5.5");
		expect(part(panel, "fast").hidden).toBe(true);
		expect(slider(panel).getAttribute("aria-valuemax")).toBe("4");
		part(panel, "pick").click();
		expect(listed(panel)).toEqual(["Opus 5.5", "Sonnet 5.5", "Haiku 5.5"]);
		button(panel, "Sonnet 5.5").click();
		await settle();
		expect(f.set).toHaveBeenLastCalledWith(
			session.sessionId,
			{ modelId: "claude-sonnet-5-5" },
			1,
			expect.any(AbortSignal),
		);
		slider(panel).focus();
		await slide(panel, "End");
		expect(f.set).toHaveBeenLastCalledWith(session.sessionId, { reasoningEffort: "max" }, 2, expect.any(AbortSignal));
		expect(part(panel, "title").textContent).toBe("Max");
		expect(button(f.view.el, "Model: Sonnet 5.5, Max effort").textContent).toContain("Sonnet 5.5 · Max");
		provider.click();
		await settle();
		expect(f.set).toHaveBeenLastCalledWith(
			session.sessionId,
			{ modelId: "gpt-6-astra", reasoningEffort: "high" },
			3,
			expect.any(AbortSignal),
		);
		expect(button(f.view.el, "Model: GPT-6 Astra, High effort, Fast")).toBeTruthy();
	});
	it("keeps the slider's arrow keys out of the menu and moves by pointer", async () => {
		const f = await setup();
		const panel = await open(f.view);
		slider(panel).focus();
		await slide(panel, "ArrowLeft");
		expect(panel.hidden).toBe(false);
		expect(f.set).not.toHaveBeenCalled();
		vi.spyOn(slider(panel), "getBoundingClientRect").mockReturnValue({
			left: 100,
			width: 230,
			top: 0,
			height: 30,
			right: 330,
			bottom: 30,
			x: 100,
			y: 0,
			toJSON() {},
		} as DOMRect);
		slider(panel).dispatchEvent(new PointerEvent("pointerdown", { clientX: 210, button: 0, bubbles: true }));
		expect(slider(panel).getAttribute("aria-valuetext")).toBe("Medium");
		expect(part(panel, "title").textContent).toBe("Medium");
		slider(panel).dispatchEvent(new PointerEvent("pointermove", { clientX: 325, bubbles: true }));
		expect(slider(panel).getAttribute("aria-valuetext")).toBe("High");
		expect(f.set).not.toHaveBeenCalled();
		slider(panel).dispatchEvent(new PointerEvent("pointerup", { clientX: 325, bubbles: true }));
		await settle();
		expect(f.set).toHaveBeenCalledWith(session.sessionId, { reasoningEffort: "high" }, 0, expect.any(AbortSignal));
		panel.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
		expect(document.activeElement).toBe(part(panel, "pick"));
	});
});

/* jsdom has no animation engine, so the menu above closes at once. With one (ui/motion.ts looks for
 * getAnimations) it stays on the page while its leaving animation plays. */
describe("the composer menu with an animation engine", () => {
	async function animated() {
		const f = await setup();
		Element.prototype.getAnimations = () => [{ playState: "running" }] as unknown as Animation[];
		cleanups.push(() => {
			delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
		});
		const more = button(f.view.el, "Chat settings and more");
		const menu = f.view.el.querySelector<HTMLElement>(".composer-menu")!;
		return { ...f, more, menu };
	}

	it("stays on the page, out of reach, while it leaves, and is hidden when that has played", async () => {
		const { more, menu } = await animated();
		more.click();
		expect(menu.hidden).toBe(false);
		expect(more.getAttribute("aria-expanded")).toBe("true");
		more.click();
		// Closed for the "+" and the keyboard at once; only the picture of it is still there.
		expect(more.getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(more);
		expect(menu.hidden).toBe(false);
		expect(menu.inert).toBe(true);
		expect(menu.classList.contains("is-leaving")).toBe(true);
		menu.dispatchEvent(new Event("animationend"));
		expect(menu.hidden).toBe(true);
		// The menu is kept for its next opening: nothing of the leaving stays on it.
		expect(menu.inert).toBe(false);
		expect(menu.classList.contains("is-leaving")).toBe(false);
		expect(menu.style.pointerEvents).toBe("");
		expect("leaving" in menu.dataset).toBe(false);
	});

	it("stays when it is opened again while it leaves, and closes from the page it shows", async () => {
		const { view, more, menu } = await animated();
		more.click();
		more.click();
		more.click();
		expect(more.getAttribute("aria-expanded")).toBe("true");
		expect(menu.hidden).toBe(false);
		expect(menu.inert).toBe(false);
		expect(menu.classList.contains("is-leaving")).toBe(false);
		// The leaving that was cut short ends late (no animationend came: its timer): the menu is open and stays.
		vi.advanceTimersByTime(700);
		expect(menu.hidden).toBe(false);
		expect(menu.inert).toBe(false);
		button(view.el, "Model: GPT-6 Astra, Low effort").click();
		const panel = view.el.querySelector<HTMLElement>(".composer-models")!;
		expect(panel.hidden).toBe(false);
		more.click();
		// It leaves showing the Model page, and is back on its main page once hidden.
		expect(panel.hidden).toBe(false);
		expect(menu.inert).toBe(true);
		menu.dispatchEvent(new Event("animationend"));
		expect(menu.hidden).toBe(true);
		expect(panel.hidden).toBe(true);
		expect(menu.firstElementChild!.hasAttribute("hidden")).toBe(false);
	});

	it("turns to a page from the side it lies on and takes the page's height", async () => {
		const { view, menu } = await animated();
		const resize = vi.fn(
			(_keyframes: Keyframe[] | PropertyIndexedKeyframes | null, _options?: number | KeyframeAnimationOptions) =>
				({ finished: new Promise<Animation>(() => {}), cancel() {} }) as unknown as Animation,
		);
		menu.animate = resize;
		const panel = view.el.querySelector<HTMLElement>(".composer-models")!;
		Object.defineProperty(menu, "offsetHeight", { get: () => (panel.hidden ? 110 : 430) });
		await open(view);
		expect(panel.classList.contains("is-page-arriving")).toBe(true);
		expect(resize).toHaveBeenLastCalledWith(
			[{ height: "110px" }, { height: "430px" }],
			expect.objectContaining({ duration: 220 }),
		);
		panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(menu.firstElementChild!.classList.contains("is-page-returning")).toBe(true);
		expect(resize).toHaveBeenLastCalledWith(
			[{ height: "430px" }, { height: "110px" }],
			expect.objectContaining({ duration: 220 }),
		);
	});
});
