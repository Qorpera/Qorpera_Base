// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { CloudApi } from "../src/cloud/api.ts";
import type { Cloud } from "../src/cloud/client.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import { fixture, profileA, session, settle, staff, team, userA } from "./fixtures.ts";

const NOTICE = "Out of computer hours. New work waits and starts by itself once hours are added.";
let dispose: (() => void) | undefined;

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function setup() {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({ team, staff: [staff], sessions: [{ ...session, staffAgentId: staff.id }], loading: false });
	const view = new ConversationView(company, session.sessionId, { sendMessage: async () => true });
	document.body.append(view.el);
	view.update();
	dispose = () => {
		view.dispose();
		company.stop();
	};
	const shown = () => view.el.textContent?.includes(NOTICE) ?? false;
	return { ...f, company, view, shown };
}

describe("a company out of computer hours", () => {
	it("asks the cloud for one company", async () => {
		const rpc = vi.fn(async () => true);
		const api = new CloudApi({ rpc } as unknown as Cloud);
		expect(await api.companyWaitingForHours(profileA.profileId)).toBe(true);
		expect(rpc).toHaveBeenCalledWith("qorpera_company_waiting_for_hours", { p_profile_id: profileA.profileId });
		rpc.mockResolvedValueOnce(null as never);
		expect(await api.companyWaitingForHours(profileA.profileId)).toBe(false);
	});

	it("says in the thread that new work waits, and stops saying it once hours are added", async () => {
		const f = setup();
		await f.company.refreshHoursWait();
		f.view.update();
		expect(f.shown()).toBe(false);
		vi.mocked(f.api.companyWaitingForHours).mockResolvedValue(true);
		await f.company.refreshHoursWait();
		f.view.update();
		expect(f.shown()).toBe(true);
		// Read out by screen readers as a status, not an alert.
		const status = [...f.view.el.querySelectorAll<HTMLElement>("[role=status]")].find((element) =>
			element.textContent?.includes(NOTICE),
		);
		expect(status).toBeDefined();
		// An archived conversation takes no new work: it says only that it is archived.
		f.company.store.set({ sessions: [{ ...session, staffAgentId: staff.id, status: "closed" }] });
		f.view.update();
		expect(f.shown()).toBe(false);
		f.company.store.set({ sessions: [{ ...session, staffAgentId: staff.id }] });
		f.view.update();
		expect(f.shown()).toBe(true);
		vi.mocked(f.api.companyWaitingForHours).mockResolvedValue(false);
		await f.company.refreshHoursWait();
		f.view.update();
		expect(f.shown()).toBe(false);
	});

	it("reads it again with the company's other periodic reads", async () => {
		const f = setup();
		vi.mocked(f.api.companyWaitingForHours).mockClear().mockResolvedValue(true);
		await f.company.start();
		await settle();
		const first = vi.mocked(f.api.companyWaitingForHours).mock.calls.length;
		expect(first).toBeGreaterThan(0);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(vi.mocked(f.api.companyWaitingForHours).mock.calls.length).toBeGreaterThan(first);
		f.view.update();
		expect(f.shown()).toBe(true);
	});

	it("stops asking a cloud that cannot say yet", async () => {
		const f = setup();
		vi.mocked(f.api.companyWaitingForHours)
			.mockClear()
			.mockRejectedValue(
				new CloudRpcError("qorpera_company_waiting_for_hours", { message: "missing", code: "PGRST202" }, 404),
			);
		await f.company.refreshHoursWait();
		await f.company.refreshHoursWait();
		expect(f.api.companyWaitingForHours).toHaveBeenCalledTimes(1);
		expect(f.company.store.get().hoursWaitUnavailable).toBe(true);
		f.view.update();
		expect(f.shown()).toBe(false);
	});

	it("asks nothing before the member's access to the company is known", async () => {
		const f = setup();
		f.company.store.set({ team: undefined });
		vi.mocked(f.api.companyWaitingForHours).mockClear();
		await f.company.refreshHoursWait();
		expect(f.api.companyWaitingForHours).not.toHaveBeenCalled();
	});
});
