import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Session } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	isRendererRequestAllowed,
	lockDownRendererSession,
	lockDownRendererWebContents,
} from "../src/renderer-boundary.ts";

const root = join(tmpdir(), `qorpera-renderer-boundary-${process.pid}`);

afterEach(() => {
	if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("renderer request boundary", () => {
	it("allows only the exact company backend origin during runtime", () => {
		const options = { backendOrigin: "http://127.0.0.1:4700", trustedFileRoot: root };
		expect(isRendererRequestAllowed("http://127.0.0.1:4700/api/state", options)).toBe(true);
		expect(isRendererRequestAllowed("blob:http://127.0.0.1:4700/asset", options)).toBe(true);
		expect(isRendererRequestAllowed("https://example.com/collect", options)).toBe(false);
		expect(isRendererRequestAllowed("ws://127.0.0.1:4700/socket", options)).toBe(false);
		expect(isRendererRequestAllowed("http://localhost:4700/api/state", options)).toBe(false);
		expect(isRendererRequestAllowed("blob:https://example.com/asset", options)).toBe(false);
	});

	it("limits hub file reads to physical files under the trusted userland", () => {
		const trusted = join(root, "trusted");
		const outsideDirectory = join(root, "outside");
		const outside = join(outsideDirectory, "outside.txt");
		mkdirSync(trusted, { recursive: true });
		mkdirSync(outsideDirectory, { recursive: true });
		writeFileSync(join(trusted, "index.html"), "trusted", "utf-8");
		writeFileSync(outside, "outside", "utf-8");
		symlinkSync(outsideDirectory, join(trusted, "linked"), process.platform === "win32" ? "junction" : "dir");
		const options = { trustedFileRoot: trusted };
		expect(isRendererRequestAllowed(pathToFileURL(join(trusted, "index.html")).href, options)).toBe(true);
		expect(isRendererRequestAllowed(pathToFileURL(outside).href, options)).toBe(false);
		expect(isRendererRequestAllowed(pathToFileURL(join(trusted, "linked", "outside.txt")).href, options)).toBe(false);
	});

	it("default-denies renderer permissions, devices, capture, downloads, and direct WebRTC", () => {
		let permissionCheck: (() => boolean) | undefined;
		let permissionRequest: ((callback: (allowed: boolean) => void) => void) | undefined;
		let devicePermission: (() => boolean) | undefined;
		let displayRequest: ((callback: (streams: object) => void) => void) | undefined;
		let download: ((event: { preventDefault: () => void }, item: { cancel: () => void }) => void) | undefined;
		const fake = {
			setPermissionCheckHandler: (handler: () => boolean) => {
				permissionCheck = handler;
			},
			setPermissionRequestHandler: (
				handler: (_contents: unknown, _permission: unknown, callback: (allowed: boolean) => void) => void,
			) => {
				permissionRequest = (callback) => handler(undefined, undefined, callback);
			},
			setDevicePermissionHandler: (handler: () => boolean) => {
				devicePermission = handler;
			},
			setDisplayMediaRequestHandler: (handler: (_request: unknown, callback: (streams: object) => void) => void) => {
				displayRequest = (callback) => handler(undefined, callback);
			},
			on: (_event: string, handler: typeof download) => {
				download = handler;
				return fake;
			},
		};
		lockDownRendererSession(fake as unknown as Session);
		expect(permissionCheck?.()).toBe(false);
		let permissionAllowed = true;
		permissionRequest?.((allowed) => {
			permissionAllowed = allowed;
		});
		expect(permissionAllowed).toBe(false);
		expect(devicePermission?.()).toBe(false);
		let displayStreams: object | undefined;
		displayRequest?.((streams) => {
			displayStreams = streams;
		});
		expect(displayStreams).toEqual({});
		let webRtcPolicy: string | undefined;
		lockDownRendererWebContents({
			setWebRTCIPHandlingPolicy: (policy) => {
				webRtcPolicy = policy;
			},
		});
		expect(webRtcPolicy).toBe("disable_non_proxied_udp");
		const preventDefault = vi.fn();
		const cancel = vi.fn();
		download?.({ preventDefault }, { cancel });
		expect(preventDefault).toHaveBeenCalledOnce();
		expect(cancel).toHaveBeenCalledOnce();
	});
});
