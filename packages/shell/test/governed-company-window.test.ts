import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CloudMemberCompanyComputerClient } from "@qorpera/cloud-client/cloud-member-company-computer";
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
	const dialogs = {
		showMessageBox: vi.fn(async () => ({ response: 0 })),
		showMessageBoxSync: vi.fn(() => 0),
		showSaveDialog: vi.fn(async (): Promise<{ canceled: boolean; filePath?: string }> => ({ canceled: true })),
		showOpenDialog: vi.fn(
			async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({ canceled: true, filePaths: [] }),
		),
	};
	class Window {
		static instances: Window[] = [];
		readonly options: unknown;
		destroyed = false;
		readonly closed: Array<() => void> = [];
		readonly handlers = new Map<string, (event: Event, value: unknown) => Promise<unknown>>();
		readonly events = new Map<string, (event: { preventDefault(): void }) => void>();
		readonly webContents = {
			send: vi.fn(),
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
			Window.instances.push(this);
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
	electron.Window.instances = [];
	electron.dialogs.showMessageBox.mockResolvedValue({ response: 0 });
	electron.dialogs.showSaveDialog.mockResolvedValue({ canceled: true });
	electron.dialogs.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
});

async function fixture(
	canWrite = true,
	companyComputer?: CloudMemberCompanyComputerClient,
	presence?: Parameters<typeof openGovernedCompanyWindow>[0]["presence"],
) {
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
		companyComputer,
		presence,
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
	it("keeps presence independent from file operations and clears it on account and window changes", async () => {
		let changed!: Parameters<NonNullable<Parameters<typeof openGovernedCompanyWindow>[0]["presence"]>>[1];
		let signal!: AbortSignal;
		const observer = { select: vi.fn(), close: vi.fn(async () => {}) };
		const factory = vi.fn((lifetime: AbortSignal, onChange: typeof changed) => {
			signal = lifetime;
			changed = onChange;
			return observer;
		});
		const f = await fixture(false, undefined, factory),
			handler = f.window.handlers.get("company-file:presence-select")!;
		expect(await f.request({ method: "info" })).toMatchObject({ result: { presenceAvailable: true } });
		expect(await handler(f.event, ["decision.md"])).toEqual({ ok: true });
		expect(observer.select).toHaveBeenCalledWith(["decision.md"]);
		const view = {
			schema: "qorpera.company-path-presence-view/v1" as const,
			state: "available" as const,
			observedAt: Date.now(),
			paths: [{ path: "decision.md", participants: [] }],
		};
		changed(view);
		expect(f.window.webContents.send).toHaveBeenLastCalledWith("company-file:presence", view);
		for (const paths of [["../private"], Array(9).fill("x"), { path: "decision.md" }])
			expect(await handler(f.event, paths)).toEqual({ ok: false });
		expect(await handler({ ...f.event, senderFrame: { url: f.event.senderFrame.url } }, ["decision.md"])).toEqual({
			ok: false,
		});
		expect(factory).toHaveBeenCalledOnce();
		f.state.current = false;
		changed(view);
		expect(f.window.webContents.send).toHaveBeenLastCalledWith(
			"company-file:presence",
			expect.objectContaining({ state: "unavailable", paths: [] }),
		);
		expect(await handler(f.event, ["decision.md"])).toEqual({ ok: false });
		f.window.destroy();
		expect(signal.aborted).toBe(true);
		expect(observer.close).toHaveBeenCalledOnce();
	});
	it("opens one Company Computer window through the member client and closes it with its parent", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => {
			throw new Error("Unexpected execution or network request");
		});
		const computer = new CloudMemberCompanyComputerClient({
			companyId,
			environmentId,
			supabaseUrl: "https://control.test",
			publishableKey: "public",
			accessToken: async () => "member-token",
			fetch,
		});
		const f = await fixture(true, computer);
		expect(await f.request({ method: "info" })).toMatchObject({ ok: true, result: { computerAvailable: true } });
		await Promise.all([f.request({ method: "computer" }), f.request({ method: "computer" })]);
		expect(electron.Window.instances).toHaveLength(2);
		expect(await f.request({ method: "computer" })).toEqual({ ok: true, result: { opened: true } });
		expect(electron.Window.instances).toHaveLength(2);
		f.window.destroy();
		expect(electron.Window.instances[1].isDestroyed()).toBe(true);
		expect(fetch).not.toHaveBeenCalled();
	});
	it("downloads only a discovered shared export, including for a read-only member", async () => {
		const f = await fixture(false),
			root = await mkdtemp(join(tmpdir(), "qorpera-export-window-"));
		try {
			const bytes = Uint8Array.from([0, 255, 128]);
			const asset = {
				schema: "qorpera.file-transfer-asset/v1" as const,
				assetId: commandId,
				sha256: "a".repeat(64),
				bytes: bytes.length,
				mediaType: "application/octet-stream",
				source: {
					realm: "company_computer" as const,
					path: "exports/report.bin",
					companyComputerId: version,
					screenId: version,
				},
				destination: { realm: "object_storage" as const },
			};
			const selection = { realm: "object_storage" as const, assetId: asset.assetId, sha256: asset.sha256 };
			vi.spyOn(f.client.exports, "list").mockResolvedValue({ items: [asset], nextAfter: null });
			const download = vi
				.spyOn(f.client.exports, "download")
				.mockResolvedValue({ asset, bytes, source: { ...selection, companyId, environmentId } });
			expect(await f.request({ method: "downloadExport", selection })).toMatchObject({ ok: false });
			expect(electron.dialogs.showSaveDialog).not.toHaveBeenCalled();
			expect(await f.request({ method: "exports", after: null })).toEqual({
				ok: true,
				result: { items: [asset], nextAfter: null },
			});
			expect(
				await f.request({ method: "downloadExport", selection: { ...selection, sha256: "b".repeat(64) } }),
			).toMatchObject({ ok: false });
			expect(
				await f.request({ method: "downloadExport", selection: { ...selection, destination: "/local" } }),
			).toMatchObject({ ok: false });
			expect(electron.dialogs.showSaveDialog).not.toHaveBeenCalled();
			electron.dialogs.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: join(root, "chosen.bin") });
			const saved = await f.request({ method: "downloadExport", selection });
			expect(saved).toEqual({
				ok: true,
				result: { saved: true, source: { ...selection, companyId, environmentId }, bytes: 3 },
			});
			expect(await readFile(join(root, "chosen.bin"))).toEqual(Buffer.from(bytes));
			expect(download).toHaveBeenCalledOnce();
			expect(JSON.stringify(saved)).not.toContain(root);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("previews and downloads a binary proposal by its exact plan without rendering its bytes", async () => {
		const f = await fixture(),
			root = await mkdtemp(join(tmpdir(), "qorpera-review-download-"));
		try {
			const bytes = Uint8Array.from([0, 255, 128]);
			const binary: CloudMemberCompanyCommand = {
				...target,
				plan: {
					...target.plan,
					entry: {
						path: target.plan.path,
						kind: "file",
						executable: false,
						file: {
							bytes: 3,
							fileSha256: "c".repeat(64),
							manifestSha256: "d".repeat(64),
							mediaType: "application/octet-stream",
						},
					},
				},
			};
			f.edits.mockResolvedValue({ items: [binary], nextAfter: null });
			const pending = vi.spyOn(f.client, "pendingFile").mockResolvedValue({ bytes, planSha256: target.planSha256 });
			await f.request({ method: "reviews", kind: "edits", after: null });
			const key = `edit:${commandId}`,
				planSha256 = target.planSha256;
			expect(await f.request({ method: "preview", key, planSha256 })).toMatchObject({
				ok: true,
				result: { after: expect.stringContaining("Download the proposed file") },
			});
			electron.dialogs.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: join(root, "review.bin") });
			const saved = await f.request({ method: "downloadReview", key, planSha256 });
			expect(saved).toEqual({ ok: true, result: { saved: true, bytes: 3, planSha256 } });
			expect(await readFile(join(root, "review.bin"))).toEqual(Buffer.from(bytes));
			expect(pending).toHaveBeenCalledTimes(2);
			expect(f.review).not.toHaveBeenCalled();
			expect(JSON.stringify(saved)).not.toContain(root);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("retains a native upload for an exact IPC retry without rereading the selected path", async () => {
		const f = await fixture(),
			root = await mkdtemp(join(tmpdir(), "qorpera-upload-window-"));
		try {
			const filePath = join(root, "selected.bin"),
				bytes = Uint8Array.from([0, 255, 128]);
			await writeFile(filePath, bytes);
			electron.dialogs.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [filePath] });
			const choice = (await f.request({ method: "chooseUpload" })) as {
				ok: true;
				result: { id: string; name: string; sha256: string };
			};
			const upload = vi
				.spyOn(f.client, "upload")
				.mockRejectedValueOnce(new Error("Lost response"))
				.mockImplementation(async (input) => ({
					command: target,
					source: {
						realm: "member_file",
						name: choice.result.name,
						sha256: choice.result.sha256,
						bytes: input.bytes.length,
						mediaType: input.mediaType,
					},
				}));
			const input = {
				method: "upload",
				intent: { id: choice.result.id, path: "decision.md", expectedVersion: version },
			};
			expect(await f.request(input)).toMatchObject({ ok: false });
			await writeFile(filePath, "Changed");
			expect(await f.request(input)).toMatchObject({ ok: true });
			expect(upload.mock.calls[1][0].bytes).toEqual(bytes);
			expect(electron.dialogs.showOpenDialog).toHaveBeenCalledTimes(1);
			expect(JSON.stringify(choice)).not.toContain(root);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("allows only a native upload choice for writers without renderer filesystem arguments", async () => {
		const f = await fixture(),
			upload = vi.spyOn(f.client, "upload");
		expect(await f.request({ method: "chooseUpload", path: "/private/secret" })).toMatchObject({ ok: false });
		expect(electron.dialogs.showOpenDialog).not.toHaveBeenCalled();
		expect(await f.request({ method: "chooseUpload" })).toEqual({ ok: true, result: null });
		expect(electron.dialogs.showOpenDialog).toHaveBeenCalledWith(
			f.window,
			expect.objectContaining({ properties: ["openFile", "dontAddToRecent"] }),
		);
		expect(upload).not.toHaveBeenCalled();
		const readonly = await fixture(false);
		electron.dialogs.showOpenDialog.mockClear();
		expect(await readonly.request({ method: "chooseUpload" })).toMatchObject({ ok: false });
		expect(electron.dialogs.showOpenDialog).not.toHaveBeenCalled();
	});
	it("writes through the native chooser and returns only source metadata to its isolated renderer", async () => {
		const f = await fixture(false),
			root = await mkdtemp(join(tmpdir(), "qorpera-file-window-"));
		try {
			const filePath = join(root, "chosen.bin"),
				bytes = Uint8Array.from([0, 255, 128]);
			const selection = { realm: "company_file", path: "documents/file.bin", version } as const;
			const source = {
				...selection,
				companyId,
				environmentId,
				sha256: "a".repeat(64),
				manifestSha256: "b".repeat(64),
			};
			const download = vi
				.spyOn(f.client, "download")
				.mockResolvedValue({ bytes, source, mediaType: "application/octet-stream" });
			electron.dialogs.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath });
			const response = await f.request({ method: "download", selection });
			expect(response).toEqual({ ok: true, result: { saved: true, source, bytes: 3 } });
			expect(JSON.stringify(response)).not.toContain(root);
			expect(await readFile(filePath)).toEqual(Buffer.from(bytes));
			expect(download).toHaveBeenCalledWith(selection, expect.any(AbortSignal));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("offers a native save chooser to read-only members without exposing an arbitrary destination IPC", async () => {
		const f = await fixture(false),
			download = vi.spyOn(f.client, "download");
		const selection = { realm: "company_file", path: "documents/file.bin", version };
		expect(await f.request({ method: "download", selection, destination: "/private/other" })).toMatchObject({
			ok: false,
		});
		expect(electron.dialogs.showSaveDialog).not.toHaveBeenCalled();
		expect(await f.request({ method: "download", selection })).toEqual({ ok: true, result: { saved: false } });
		expect(electron.dialogs.showSaveDialog).toHaveBeenCalledWith(
			f.window,
			expect.objectContaining({ defaultPath: "file.bin", properties: ["showOverwriteConfirmation"] }),
		);
		expect(download).not.toHaveBeenCalled();
	});
	it("refuses another chooser while a download is pending and fences account changes before fetching", async () => {
		const f = await fixture(),
			download = vi.spyOn(f.client, "download");
		let finish!: (value: { canceled: boolean; filePath: string }) => void;
		electron.dialogs.showSaveDialog.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const input = { method: "download", selection: { realm: "company_file", path: "file.bin", version } };
		const first = f.request(input);
		expect(await f.request(input)).toMatchObject({
			ok: false,
			error: "Finish the current download before starting another",
		});
		f.state.current = false;
		finish({ canceled: false, filePath: "/not-written.bin" });
		expect(await first).toMatchObject({ ok: false });
		expect(download).not.toHaveBeenCalled();
	});
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
