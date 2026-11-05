import { webcrypto } from "node:crypto";
import { cloudFileBytesSha256 } from "@qorpera/cloud-client/cloud-file-bytes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memberRouteTarget } from "../src/cloud/deployment-config.ts";
import { createWebSessionAttachments } from "../src/cloud/session-attachments.ts";
import { fixture, id, userA } from "./fixtures.ts";

/* Chat images take the member company gateway (the public bridge) as Company File does, once the build names it: on a
 * member's tailnet machine the object gateway's name resolves to a private address the browser won't call (4 Nov
 * 2026). The upload and the read keep the member's own token; nothing falls back to the gateway itself. */

beforeEach(() => {
	vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const image = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

async function setup(useBridge: boolean) {
	const f = fixture();
	f.cloud.config.objectGatewayUrl = "https://objects.fixture.invalid";
	const bridge = `${f.cloud.config.projectUrl}/functions/v1/member-company-gateway`;
	if (useBridge) f.cloud.config.memberCompanyGatewayUrl = bridge;
	const sha256 = await cloudFileBytesSha256(image);
	const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input));
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token");
		if (url.pathname.includes("/v1/member-session-attachments/upload/"))
			return Response.json({ sha256, bytes: image.byteLength, mediaType: "image/png" });
		if (url.pathname.includes("/v1/member-session-attachments/input/")) return new Response(Uint8Array.from(image));
		throw new Error(`Unexpected fixture endpoint: ${url.pathname}`);
	});
	vi.stubGlobal("fetch", fetch);
	const attachments = createWebSessionAttachments(f.cloud, userA.id, new AbortController().signal, () => {});
	const signal = new AbortController().signal;
	const reference = await attachments.upload(id(1), id(2), image, "image/png", signal);
	const bytes = await attachments.read(id(1), id(3), reference, signal);
	return { f, bridge, sha256, bytes, called: fetch.mock.calls.map(([url]) => String(url)) };
}

describe("chat image transport", () => {
	it("uploads and reads through the bridge once it is configured", async () => {
		const { f, bridge, sha256, bytes, called } = await setup(true);
		expect(bytes).toEqual(image);
		expect(called).toEqual([
			`${bridge}/v1/member-session-attachments/upload/${id(1)}/${id(2)}/${sha256}`,
			`${bridge}/v1/member-session-attachments/input/${id(1)}/${id(3)}/${sha256}`,
		]);
		expect(called.some((url) => url.startsWith(f.cloud.config.objectGatewayUrl))).toBe(false);
	});

	it("keeps the configured direct object gateway until the bridge is activated", async () => {
		const { f, called } = await setup(false);
		expect(called).toHaveLength(2);
		expect(called.every((url) => url.startsWith(`${f.cloud.config.objectGatewayUrl}/v1/member-session-`))).toBe(true);
	});
});

describe("memberRouteTarget", () => {
	const config = {
		projectUrl: "https://api.fixture.invalid",
		publishableKey: "sb_publishable_fixture",
		objectGatewayUrl: "https://objects.fixture.invalid",
		memberCompanyGatewayUrl: "https://api.fixture.invalid/functions/v1/member-company-gateway",
	};
	it("bridges only the object gateway's member routes", () => {
		expect(memberRouteTarget(config, "https://objects.fixture.invalid/v1/member-message-erases/a/b?x=1")).toBe(
			"https://api.fixture.invalid/functions/v1/member-company-gateway/v1/member-message-erases/a/b?x=1",
		);
		for (const other of [
			"https://objects.fixture.invalid/v1/folder-objects/a/b",
			"https://elsewhere.fixture.invalid/v1/member-folder-objects/a/b",
			"https://api.fixture.invalid/rest/v1/rpc/qorpera_member_folder_read",
		])
			expect(memberRouteTarget(config, other)).toBe(other);
		const { memberCompanyGatewayUrl: _, ...direct } = config;
		const route = "https://objects.fixture.invalid/v1/member-folder-objects/a/b";
		expect(memberRouteTarget(direct, route)).toBe(route);
	});
});
