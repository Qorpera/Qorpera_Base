import { pathToFileURL } from "node:url";
import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudMemberIdentityRecoveryClient, type MemberRecoveryReview } from "../src/cloud-member-identity-recovery.ts";
import { openIdentityRecoveryWindow } from "../src/identity-recovery-window.ts";
import {
	memberRecoveryReceipt,
	memberRecoveryReview,
	recoveryCompany,
	recoveryIdentity,
	recoveryTarget,
} from "./fixtures/member-identity-recovery.ts";

const electron = vi.hoisted(() => {
	type Event = { sender: unknown; senderFrame: { url: string } | null };
	type RequestCheck = (details: { url: string }, callback: (decision: { cancel: boolean }) => void) => void;
	const partition = {
		setPermissionCheckHandler: vi.fn(),
		setPermissionRequestHandler: vi.fn(),
		setDevicePermissionHandler: vi.fn(),
		setDisplayMediaRequestHandler: vi.fn(),
		on: vi.fn(),
		webRequest: { onBeforeRequest: vi.fn<(callback: RequestCheck) => void>() },
	};
	class Window {
		readonly options: unknown;
		destroyed = false;
		readonly closed: Array<() => void> = [];
		readonly handlers = new Map<string, (event: Event, value: unknown) => Promise<unknown>>();
		readonly events = new Map<string, (event: { preventDefault(): void }) => void>();
		readonly webContents = {
			mainFrame: { url: "" },
			ipc: {
				handle: (name: string, handler: (event: Event, value: unknown) => Promise<unknown>) => {
					this.handlers.set(name, handler);
				},
			},
			setWebRTCIPHandlingPolicy: vi.fn(),
			setWindowOpenHandler: vi.fn(),
			on: (name: string, handler: (event: { preventDefault(): void }) => void) => {
				this.events.set(name, handler);
			},
		};
		constructor(options: unknown) {
			this.options = options;
		}
		once(_name: string, handler: () => void) {
			this.closed.push(handler);
		}
		isDestroyed() {
			return this.destroyed;
		}
		destroy() {
			this.destroyed = true;
			for (const handler of this.closed) handler();
		}
		async loadFile(path: string) {
			this.webContents.mainFrame.url = pathToFileURL(path).href;
		}
		show() {}
	}
	return {
		Window,
		partition,
		dialog: { showMessageBox: vi.fn(async (_window: unknown, _options: unknown) => ({ response: 0 })) },
		session: { fromPartition: vi.fn((_name: string, _options: unknown) => partition) },
	};
});
vi.mock("electron", () => ({ BrowserWindow: electron.Window, session: electron.session, dialog: electron.dialog }));

beforeEach(() => {
	vi.clearAllMocks();
	electron.dialog.showMessageBox.mockResolvedValue({ response: 0 });
});

async function fixture() {
	const client = new CloudMemberIdentityRecoveryClient({
		companyId: recoveryCompany,
		supabaseUrl: "https://control.test",
		publishableKey: "public-key",
		accessToken: async () => "member-jwt",
		fetch: async () => {
			throw new Error("Unexpected network access");
		},
	});
	const review = vi.spyOn(client, "review").mockImplementation(async () => memberRecoveryReview());
	const targets = vi.spyOn(client, "targets").mockResolvedValue({ items: [], nextAfter: null });
	const decide = vi.spyOn(client, "decide").mockResolvedValue(memberRecoveryReceipt());
	const state = { current: true };
	const owner = new electron.Window({});
	const window = (await openIdentityRecoveryWindow({
		owner: owner as unknown as BrowserWindow,
		directory: "/synthetic-userland",
		title: "Company",
		client,
		current: () => state.current,
	})) as unknown as InstanceType<typeof electron.Window>;
	const handler = window.handlers.get("identity-recovery:member");
	if (!handler) throw new Error("Missing recovery IPC");
	const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
	return {
		window,
		owner,
		client,
		review,
		targets,
		decide,
		state,
		event,
		request: (value: unknown, source: Parameters<typeof handler>[0] = event) => handler(source, value),
	};
}

const inspect = { method: "review", computeIdentityId: recoveryIdentity, targetId: recoveryTarget };
const approve = { method: "decision", reviewSha256: "a".repeat(64), decision: "request", storageSource: "nas" };

describe("isolated human recovery window", () => {
	it("permits only fixed display resources in an ephemeral sandbox", async () => {
		const { window } = await fixture();
		expect(window.options).toMatchObject({
			webPreferences: {
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				webviewTag: false,
				webSecurity: true,
			},
		});
		expect(electron.session.fromPartition.mock.calls[0][0]).toMatch(/^qorpera-identity-recovery-/);
		const check = electron.partition.webRequest.onBeforeRequest.mock.calls[0][0];
		for (const [url, allowed] of [
			["file:///synthetic-userland/identity-recovery.html", true],
			["file:///synthetic-userland/identity-recovery.js", true],
			["file:///synthetic-userland/identity-recovery.css", true],
			["file:///synthetic-userland/identity-recovery-preload.cjs", false],
			["file:///private/key", false],
			["https://control.test", false],
		] as const) {
			const callback = vi.fn();
			check({ url }, callback);
			expect(callback).toHaveBeenCalledWith({ cancel: !allowed });
		}
	});

	it("rejects foreign windows, subframes, changed pages and lost membership", async () => {
		const { request, event, review, state } = await fixture();
		for (const source of [
			{ ...event, sender: {} },
			{ ...event, senderFrame: { ...event.senderFrame } },
			{ ...event, senderFrame: null },
		])
			expect(await request(inspect, source)).toMatchObject({ ok: false });
		event.senderFrame.url = "https://attacker.test";
		expect(await request(inspect)).toMatchObject({ ok: false });
		event.senderFrame.url = "file:///synthetic-userland/identity-recovery.html";
		state.current = false;
		expect(await request(inspect)).toMatchObject({ ok: false });
		expect(review).not.toHaveBeenCalled();
	});

	it("does not decide without a matching cloud review or with extra authority fields", async () => {
		const { request, decide } = await fixture();
		expect(await request(approve)).toMatchObject({ ok: false });
		await request(inspect);
		for (const input of [
			{ ...approve, reviewSha256: "b".repeat(64) },
			{ ...approve, storageSource: null },
			{ ...approve, serviceCapability: "forged" },
			{ ...approve, decision: "consent", storageSource: null },
			{ ...approve, decision: "cancel", storageSource: null },
		])
			expect(await request(input)).toMatchObject({ ok: false });
		expect(decide).not.toHaveBeenCalled();
		expect(electron.dialog.showMessageBox).not.toHaveBeenCalled();
	});

	it("treats native dismissal as no decision, then sends only the approved host-side review", async () => {
		const { request, decide } = await fixture();
		const displayed = (await request(inspect)) as { result: MemberRecoveryReview };
		displayed.result.review.target.nodeId = recoveryIdentity;
		expect(await request(approve)).toEqual({ ok: true, cancelled: true });
		expect(decide).not.toHaveBeenCalled();
		electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
		expect(await request(approve)).toMatchObject({ ok: true, result: memberRecoveryReceipt() });
		expect(decide).toHaveBeenCalledWith(
			memberRecoveryReview(),
			{
				kind: "request",
				requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
				storageSource: "nas",
			},
			expect.any(AbortSignal),
		);
		expect(electron.dialog.showMessageBox.mock.calls[0][1]).toMatchObject({
			defaultId: 0,
			cancelId: 0,
			detail: expect.stringContaining(memberRecoveryReview().review.target.recipientKeySha256),
		});
		expect(await request(approve)).toMatchObject({ ok: false });
		expect(decide).toHaveBeenCalledTimes(1);
	});

	it("rejects consent after membership changes while confirmation is open", async () => {
		const { request, decide, state } = await fixture();
		await request(inspect);
		electron.dialog.showMessageBox.mockImplementationOnce(async () => {
			state.current = false;
			return { response: 1 };
		});
		expect(await request(approve)).toMatchObject({ ok: false });
		expect(decide).not.toHaveBeenCalled();
	});

	it("keeps uncertain decisions single-shot and hides raw failure details", async () => {
		const { request, decide } = await fixture();
		await request(inspect);
		electron.dialog.showMessageBox.mockResolvedValue({ response: 1 });
		decide.mockRejectedValueOnce(new Error("PRIVATE_KEY_AND_DATABASE_DETAIL"));
		const failed = await request(approve);
		expect(failed).toMatchObject({ ok: false });
		expect(JSON.stringify(failed)).not.toContain("PRIVATE_KEY_AND_DATABASE_DETAIL");
		expect(await request(approve)).toMatchObject({ ok: false });
		expect(decide).toHaveBeenCalledTimes(1);
		await request(inspect);
		expect(await request(approve)).toMatchObject({ ok: true });
	});

	it("allows only one confirmation or cloud operation in flight", async () => {
		const { request, decide } = await fixture();
		await request(inspect);
		let answer: ((value: { response: number }) => void) | undefined;
		electron.dialog.showMessageBox.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		);
		const first = request(approve);
		expect(await request(approve)).toMatchObject({ ok: false });
		expect(await request(inspect)).toMatchObject({ ok: false });
		answer?.({ response: 1 });
		expect(await first).toMatchObject({ ok: true });
		expect(decide).toHaveBeenCalledTimes(1);
	});

	it("invalidates a cached review when choosing another replacement list", async () => {
		const { request, targets, decide } = await fixture();
		await request(inspect);
		await request({ method: "targets", computeIdentityId: recoveryIdentity, after: null });
		expect(targets).toHaveBeenCalled();
		expect(await request(approve)).toMatchObject({ ok: false });
		expect(decide).not.toHaveBeenCalled();
	});

	it("drops cloud responses when the company changes during I/O", async () => {
		const { request, review, state } = await fixture();
		review.mockImplementationOnce(async () => {
			state.current = false;
			const response = memberRecoveryReview();
			response.review.identity.displayName = "PRIVATE_OTHER_COMPANY";
			return response;
		});
		const result = await request(inspect);
		expect(result).toMatchObject({ ok: false });
		expect(JSON.stringify(result)).not.toContain("PRIVATE_OTHER_COMPANY");
	});

	it("closes and aborts pending I/O when its parent closes", async () => {
		const { request, review, owner, window } = await fixture();
		await request(inspect);
		const signal = review.mock.calls[0][2];
		owner.destroy();
		expect(window.isDestroyed()).toBe(true);
		expect(signal.aborted).toBe(true);
		expect(await request(approve)).toMatchObject({ ok: false });
	});
});
