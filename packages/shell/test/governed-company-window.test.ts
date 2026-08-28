import { pathToFileURL } from "node:url";
import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CloudMemberCompanyCommand, CloudMemberCompanyFileClient } from "../src/cloud-member-company-editor.ts";
import { openGovernedCompanyWindow } from "../src/governed-company-window.ts";

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
	const dialogs = { showMessageBox: vi.fn(async () => ({ response: 0 })), showMessageBoxSync: vi.fn(() => 0) };
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
			this.webContents.mainFrame.url = `file://${path}`;
		}
		show() {}
	}
	return {
		Window,
		partition,
		dialogs,
		session: { fromPartition: vi.fn((_name: string, _options: unknown) => partition) },
	};
});
vi.mock("electron", () => ({ BrowserWindow: electron.Window, session: electron.session, dialog: electron.dialogs }));

const companyId = "29500000-0000-4000-8000-000000000010";
const environmentId = "29500000-0000-4000-8000-000000000020";
const commandId = "29500000-0000-4000-8000-000000000030";
const version = "29500000-0000-4000-8000-000000000050";
const target: CloudMemberCompanyCommand = {
	commandId,
	companyId,
	environmentId,
	planSha256: "b".repeat(64),
	state: "review_required",
	expiresAt: "2099-01-01T00:00:00Z",
	result: null,
	plan: {
		schema: "qorpera.company-path-mutation/v1",
		operationKey: "delete-file",
		path: "decision.md",
		expectedVersion: version,
		entry: null,
	},
};
beforeEach(() => {
	vi.clearAllMocks();
	electron.dialogs.showMessageBox.mockResolvedValue({ response: 0 });
});

async function fixture(canWrite = true) {
	const client = new CloudMemberCompanyFileClient({
		companyId,
		environmentId,
		supabaseUrl: "https://control.test",
		objectGatewayUrl: "https://gateway.test",
		publishableKey: "public",
		accessToken: async () => "member-jwt",
		fetch: async () => {
			throw new Error("Unexpected network request");
		},
	});
	const read = vi.spyOn(client, "read").mockResolvedValue({
		path: "decision.md",
		version,
		kind: "file",
		executable: false,
		text: "The current decision",
	});
	const edits = vi.spyOn(client, "edits").mockResolvedValue({ items: [target], nextAfter: null });
	const pending = vi.spyOn(client, "pendingText").mockResolvedValue("");
	const review = vi.spyOn(client, "review").mockResolvedValue({ ...target, state: "rejected" });
	const state = { current: true };
	const window = (await openGovernedCompanyWindow({
		owner: {} as BrowserWindow,
		directory: "/synthetic-userland",
		title: "Company",
		client,
		canWrite,
		current: () => state.current,
	})) as unknown as InstanceType<typeof electron.Window>;
	const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
	const handler = window.handlers.get("company-file:governed");
	if (!handler) throw new Error("Missing File IPC handler");
	return {
		window,
		client,
		read,
		edits,
		pending,
		review,
		state,
		event,
		request: (value: unknown, source: Parameters<typeof handler>[0] = event) => handler(source, value),
	};
}

describe("governed human File window", () => {
	it("uses an isolated sandbox and permits only the three fixed display resources", async () => {
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
		expect(electron.session.fromPartition.mock.calls[0]?.[0]).toMatch(/^qorpera-company-file-/);
		const check = electron.partition.webRequest.onBeforeRequest.mock.calls[0][0];
		for (const [url, allowed] of [
			[pathToFileURL("/synthetic-userland/company-file.html").href, true],
			["https://cloud.test", false],
			["file:///private/secret", false],
			["file:///synthetic-userland/renderer.js", false],
		] as const) {
			const callback = vi.fn();
			check({ url }, callback);
			expect(callback).toHaveBeenCalledWith({ cancel: !allowed });
		}
	});
	it("rejects foreign windows, subframes, changed pages and revoked membership before work", async () => {
		const { request, event, read, state } = await fixture();
		for (const source of [
			{ ...event, sender: {} },
			{ ...event, senderFrame: { ...event.senderFrame } },
		])
			expect(await request({ method: "read", path: "decision.md" }, source)).toMatchObject({ ok: false });
		event.senderFrame.url = "https://attacker.test";
		expect(await request({ method: "read", path: "decision.md" })).toMatchObject({ ok: false });
		event.senderFrame.url = "file:///synthetic-userland/company-file.html";
		state.current = false;
		expect(await request({ method: "read", path: "decision.md" })).toMatchObject({ ok: false });
		expect(read).not.toHaveBeenCalled();
	});
	it("drops a result if the member changes while cloud I/O is pending", async () => {
		const { request, read, state } = await fixture();
		read.mockImplementationOnce(async () => {
			state.current = false;
			return { path: "decision.md", version, kind: "file", executable: false, text: "PRIVATE_TEXT" };
		});
		expect(JSON.stringify(await request({ method: "read", path: "decision.md" }))).not.toContain("PRIVATE_TEXT");
	});
	it("requires preview of the exact stored plan and explicit native confirmation", async () => {
		const { request, review } = await fixture();
		await request({ method: "reviews", kind: "edits", after: null });
		const choice = { method: "review", key: `edit:${commandId}`, planSha256: target.planSha256, decision: "approve" };
		expect(await request(choice)).toMatchObject({
			ok: false,
			error: "Preview this exact change before approving it",
		});
		expect(review).not.toHaveBeenCalled();
		await request({ ...choice, method: "preview" });
		expect(await request(choice)).toEqual({ ok: true, cancelled: true });
		expect(review).not.toHaveBeenCalled();
		electron.dialogs.showMessageBox.mockResolvedValueOnce({ response: 1 });
		expect(await request(choice)).toMatchObject({ ok: true });
		expect(review).toHaveBeenCalledWith(target, "approve", expect.any(AbortSignal));
	});
	it("treats skip as a decline and rejects a substituted digest", async () => {
		const { request, review } = await fixture();
		await request({ method: "reviews", kind: "edits", after: null });
		const choice = { method: "review", key: `edit:${commandId}`, planSha256: "a".repeat(64), decision: "skip" };
		expect(await request(choice)).toMatchObject({ ok: false });
		expect(review).not.toHaveBeenCalled();
		expect(await request({ ...choice, planSha256: target.planSha256 })).toMatchObject({ ok: true });
		expect(review).toHaveBeenCalledWith(target, "skip", expect.any(AbortSignal));
		expect(electron.dialogs.showMessageBox).not.toHaveBeenCalled();
	});
	it("does not approve after an account change during the confirmation", async () => {
		const { request, review, state } = await fixture();
		await request({ method: "reviews", kind: "edits", after: null });
		await request({ method: "preview", key: `edit:${commandId}`, planSha256: target.planSha256 });
		electron.dialogs.showMessageBox.mockImplementationOnce(async () => {
			state.current = false;
			return { response: 1 };
		});
		expect(
			await request({
				method: "review",
				key: `edit:${commandId}`,
				planSha256: target.planSha256,
				decision: "approve",
			}),
		).toMatchObject({ ok: false });
		expect(review).not.toHaveBeenCalled();
	});
	it("keeps read-only members from editing or deciding proposals", async () => {
		const { request, review } = await fixture(false);
		expect(await request({ method: "edit", intent: {} })).toMatchObject({ ok: false });
		await request({ method: "reviews", kind: "edits", after: null });
		expect(
			await request({ method: "review", key: `edit:${commandId}`, planSha256: target.planSha256, decision: "skip" }),
		).toMatchObject({ ok: false });
		expect(review).not.toHaveBeenCalled();
	});
	it("aborts the window's cloud requests when destroyed", async () => {
		const { request, read, window } = await fixture();
		await request({ method: "read", path: "decision.md" });
		const signal = read.mock.calls[0][1];
		window.destroy();
		expect(signal.aborted).toBe(true);
		expect(await request({ method: "info" })).toMatchObject({ ok: false });
	});
});
