// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import type { SessionModel } from "../src/cloud/session-model.ts";
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

async function setup() {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({ team, staff: [staff], sessions: [{ ...session, staffAgentId: staff.id }], loading: false });
	const models = new Map<string, SessionModel>();
	const read = vi.fn(
		async (sessionId: string) => models.get(sessionId) ?? { sessionId, modelId: "gpt-6-astra", version: 0 },
	);
	const set = vi.fn(async (sessionId: string, modelId: string, version: number, _signal: AbortSignal) => {
		const value = { sessionId, modelId, version: version + 1 };
		models.set(sessionId, value);
		return value;
	});
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
async function open(view: ConversationView, label = "Model: GPT-6 Astra"): Promise<HTMLElement> {
	button(view.el, "Chat settings and more").click();
	button(view.el, label).click();
	await settle();
	return view.el.querySelector<HTMLElement>(".composer-models")!;
}

describe("composer model selector", () => {
	it("opens from More with the current model selected and supports keyboard return", async () => {
		const f = await setup();
		button(f.view.el, "Chat settings and more").click();
		const attach = button(f.view.el, "Attach files");
		expect(document.activeElement).toBe(attach);
		attach.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		expect(document.activeElement).toBe(button(f.view.el, "Model: GPT-6 Astra"));
		document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
		await settle();
		const panel = f.view.el.querySelector<HTMLElement>(".composer-models")!;
		expect(panel.hidden).toBe(false);
		expect(document.activeElement).toBe(button(panel, "GPT-6 Astra"));
		expect(button(panel, "GPT-6 Astra").getAttribute("aria-checked")).toBe("true");
		expect(panel.textContent).toContain("Only this conversation");
		panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(panel.hidden).toBe(true);
		expect(document.activeElement).toBe(button(f.view.el, "Model: GPT-6 Astra"));
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
		button(panel, "GPT-5.6 Sol").click();
		expect(f.set).toHaveBeenCalledWith(session.sessionId, "gpt-5.6-sol", 0, expect.any(AbortSignal));
		expect(button(f.view.el, "Send message").disabled).toBe(true);
		expect(panel.textContent).toContain("Saving model");
		const value = { sessionId: session.sessionId, modelId: "gpt-5.6-sol", version: 1 };
		f.models.set(session.sessionId, value);
		saved.resolve(value);
		await settle();
		expect(button(f.view.el, "Send message").disabled).toBe(false);
		expect(button(panel, "GPT-5.6 Sol").getAttribute("aria-checked")).toBe("true");
		expect(f.updateAgent).not.toHaveBeenCalled();
		expect(f.company.staffById(staff.id)?.model).toBeUndefined();
		const otherSession = { ...session, sessionId: id(80), staffAgentId: staff.id };
		f.company.store.set({ sessions: [{ ...session, staffAgentId: staff.id }, otherSession] });
		f.view.dispose();
		const other = new ConversationView(f.company, otherSession.sessionId, f.actions);
		cleanups.push(() => other.dispose());
		await settle();
		expect(button(other.el, "Model: GPT-6 Astra")).toBeTruthy();
		other.dispose();
		const restored = new ConversationView(f.company, session.sessionId, f.actions);
		cleanups.push(() => restored.dispose());
		await settle();
		expect(button(restored.el, "Model: GPT-5.6 Sol")).toBeTruthy();
		expect(f.company.conversation(session.sessionId).get().draft).toBe("Continue");
	});
	it("recovers an uncertain write by reading, never replaying the mutation", async () => {
		const f = await setup();
		f.set.mockImplementationOnce(async (sessionId, modelId) => {
			f.models.set(sessionId, { sessionId, modelId, version: 1 });
			throw new Error("lost response");
		});
		f.company.conversation(session.sessionId).set({ draft: "Continue" });
		const panel = await open(f.view);
		button(panel, "GPT-5.6 Terra").click();
		await settle();
		expect(panel.textContent).toContain("The change could not be confirmed");
		expect(button(f.view.el, "Send message").disabled).toBe(true);
		expect(button(panel, "GPT-6 Astra").getAttribute("aria-checked")).toBe("true");
		button(panel, "Refresh model").click();
		await settle();
		expect(f.set).toHaveBeenCalledTimes(1);
		expect(button(f.view.el, "Send message").disabled).toBe(false);
		expect(button(panel, "GPT-5.6 Terra").getAttribute("aria-checked")).toBe("true");
	});
	it("allows contributors but cancels pending changes on write revocation", async () => {
		const f = await setup();
		f.company.store.set({ team: { ...team, capabilities: { ...team.capabilities, authorize: false } } });
		await settle();
		expect(button(f.view.el, "Model: GPT-6 Astra").disabled).toBe(false);
		const saved = deferred<SessionModel>();
		f.set.mockReturnValueOnce(saved.promise);
		const panel = await open(f.view);
		button(panel, "GPT-5.6 Sol").click();
		const signal = f.set.mock.calls[0]![3];
		f.company.store.set({ team: { ...team, capabilities: { ...team.capabilities, write: false } } });
		await settle();
		expect(signal.aborted).toBe(true);
		saved.resolve({ sessionId: session.sessionId, modelId: "gpt-5.6-sol", version: 1 });
		await settle();
		expect(button(f.view.el, "Model: GPT-6 Astra").disabled).toBe(true);
	});
	it("preserves unlisted models and disables choices when loading fails", async () => {
		const f = await setup();
		f.models.set(session.sessionId, { sessionId: session.sessionId, modelId: "custom-model", version: 3 });
		const panel = await open(f.view);
		expect(button(f.view.el, "Model: custom-model")).toBeTruthy();
		expect(panel.querySelector('[aria-checked="true"]')).toBeNull();
		expect(f.set).not.toHaveBeenCalled();
		button(f.view.el, "Chat settings and more").click();
		f.read.mockRejectedValueOnce(new Error("offline"));
		await open(f.view, "Model: custom-model");
		expect(button(panel, "GPT-6 Astra").disabled).toBe(true);
		expect(panel.textContent).toContain("model is unavailable");
	});
});
