import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPANY_POLICY, parseCompanyPolicy, updateCompanyPolicySource } from "../src/cloud/company-policy.ts";
import { PolicyApi } from "../src/cloud/policy-api.ts";
import { SettingsApi, sha256 } from "../src/cloud/settings-api.ts";
import { deferred, fixture, id, profileA, userA, userB } from "./fixtures.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
function settings() {
	const f = fixture(),
		controller = new AbortController();
	f.cloud.config.objectGatewayUrl = "https://objects.example.invalid";
	return { ...f, controller, api: new SettingsApi(f.cloud, profileA, userA.id, controller.signal) };
}
async function policyFixture(source = '[policy]\nspending = "ask"\n') {
	const f = settings();
	const bytes = new TextEncoder().encode(source),
		digest = await sha256(bytes);
	const manifest = new TextEncoder().encode(
		JSON.stringify({
			schema: "qorpera.cloud-file-manifest/v1",
			fileSha256: digest,
			bytes: bytes.length,
			mediaType: "application/octet-stream",
			chunks: [{ sha256: digest, bytes: bytes.length }],
		}),
	);
	const manifestDigest = await sha256(manifest);
	const descriptor = {
		path: "authority.toml",
		companyId: profileA.profileId,
		version: id(50),
		manifestBytes: manifest.length,
		entry: {
			path: "authority.toml",
			kind: "file",
			executable: false,
			file: {
				manifestSha256: manifestDigest,
				fileSha256: digest,
				bytes: bytes.length,
				mediaType: "application/octet-stream",
			},
		},
	};
	vi.mocked(f.cloud.rpc).mockResolvedValue(descriptor);
	const fetcher = vi.fn(
		async (url: string) =>
			new Response(url.endsWith(manifestDigest) ? manifest : bytes, {
				headers: { "x-qorpera-access-mode": "live-path-authority" },
			}),
	);
	vi.stubGlobal("fetch", fetcher);
	return { ...f, descriptor, bytes, manifest, fetcher, policy: new PolicyApi(f.api) };
}

describe("browser policy contract", () => {
	it("reads only the authorized policy path, verifies bytes, and rechecks its version", async () => {
		const f = await policyFixture();
		expect((await f.policy.read()).policy.spending).toBe("ask");
		expect(f.cloud.rpc).toHaveBeenCalledTimes(2);
		expect(f.cloud.rpc).toHaveBeenCalledWith("qorpera_read_company_path", {
			p_environment_id: profileA.environmentId,
			p_binding: null,
			p_path: "authority.toml",
		});
		expect(
			f.fetcher.mock.calls.every(([url]) =>
				url.startsWith(
					`https://objects.example.invalid/v1/member-company-objects/${profileA.environmentId}/${id(50)}/`,
				),
			),
		).toBe(true);
	});
	it("refuses corrupted bytes and a version that changes while reading", async () => {
		const f = await policyFixture();
		f.fetcher
			.mockResolvedValueOnce(
				new Response(f.manifest, { headers: { "x-qorpera-access-mode": "live-path-authority" } }),
			)
			.mockResolvedValueOnce(
				new Response("tampered", { headers: { "x-qorpera-access-mode": "live-path-authority" } }),
			);
		await expect(f.policy.read()).rejects.toThrow("integrity");
		vi.mocked(f.cloud.rpc)
			.mockResolvedValueOnce(f.descriptor)
			.mockResolvedValueOnce({ ...f.descriptor, version: id(51) });
		await expect(f.policy.read()).rejects.toThrow("changed while loading");
	});
	it("saves an exact version and requires a matching content receipt", async () => {
		const f = settings();
		const source = '# keep\n[other]\nvalue = 42\n[policy]\nspending = "ask" # note\n';
		const policy = { ...DEFAULT_COMPANY_POLICY, spending: "act" as const };
		const request = vi.spyOn(f.api, "request").mockImplementation(async (_url, body) => {
			const edit = body as { operationKey: string; expectedVersion: string; text: string };
			const bytes = new TextEncoder().encode(edit.text);
			return {
				commandId: id(52),
				companyId: profileA.profileId,
				environmentId: profileA.environmentId,
				planSha256: "a".repeat(64),
				state: "review_required",
				expiresAt: "2099-01-01T00:00:00Z",
				result: null,
				plan: {
					schema: "qorpera.company-path-mutation/v1",
					operationKey: edit.operationKey,
					expectedVersion: edit.expectedVersion,
					path: "authority.toml",
					entry: {
						path: "authority.toml",
						kind: "file",
						executable: false,
						file: {
							manifestSha256: "b".repeat(64),
							fileSha256: await sha256(bytes),
							bytes: bytes.length,
							mediaType: "application/octet-stream",
						},
					},
				},
			};
		});
		const api = new PolicyApi(f.api),
			command = await api.save({ source, version: id(50), policy: DEFAULT_COMPANY_POLICY }, policy, "save-1");
		expect(command.state).toBe("review_required");
		expect(request).toHaveBeenCalledExactlyOnceWith(
			`https://objects.example.invalid/v1/member-company-file/${profileA.environmentId}/edits`,
			expect.objectContaining({
				operationKey: "save-1",
				expectedVersion: id(50),
				text: expect.stringContaining('spending = "act" # note'),
			}),
		);
		request.mockResolvedValueOnce({
			commandId: command.id,
			companyId: profileA.profileId,
			environmentId: profileA.environmentId,
			planSha256: "c".repeat(64),
			state: "review_required",
			expiresAt: command.expiresAt,
			result: null,
			plan: command.plan,
		});
		await expect(api.review(command, "approve")).rejects.toThrow("review changed");
	});
	it("preserves TOML comments and refuses a misleading policy header inside a multiline string", async () => {
		const source =
			'# keep\r\n[policy]\r\n"spending" = "ask" # keep too\r\ncustom = true\r\n[authority]\r\nowner = "unchanged"\r\n';
		const updated = updateCompanyPolicySource(source, { ...DEFAULT_COMPANY_POLICY, spending: "act" });
		expect(updated).toContain('"spending" = "act" # keep too\r\ncustom = true');
		expect(updated).toContain('[authority]\r\nowner = "unchanged"');
		expect(parseCompanyPolicy(updated).spending).toBe("act");
		const f = settings(),
			request = vi.spyOn(f.api, "request");
		await expect(
			new PolicyApi(f.api).save(
				{
					source: 'text = """\n[policy]\nspending = "ask"\n"""\n',
					version: id(50),
					policy: DEFAULT_COMPANY_POLICY,
				},
				{ ...DEFAULT_COMPANY_POLICY, spending: "auto" },
				"save-2",
			),
		).rejects.toThrow();
		expect(request).not.toHaveBeenCalled();
	});
});

describe("browser connection boundaries", () => {
	it("does not continue a provider login after settings closes", async () => {
		const f = settings(),
			pending = deferred<unknown>();
		vi.mocked(f.cloud.rpc).mockReturnValue(pending.promise);
		const request = f.api.beginLogin("openai");
		f.controller.abort();
		pending.resolve({ compute_identity: null, connections: [] });
		await expect(request).rejects.toThrow();
		expect(f.cloud.rpc).toHaveBeenCalledTimes(1);
	});
	it("rejects another member’s compute identity", async () => {
		const f = settings();
		vi.mocked(f.cloud.rpc).mockResolvedValue({
			compute_identity: { compute_identity_id: id(60), ownership_kind: "member", owner_user_id: userB.id },
			connections: [],
		});
		await expect(f.api.connections()).rejects.toThrow("another member");
	});
	it.each(["javascript:alert(1)", "https://user:password@example.invalid/login"])(
		"refuses unsafe provider login URL %s",
		async (url) => {
			const f = settings();
			vi.mocked(f.cloud.rpc)
				.mockResolvedValueOnce({
					compute_identity: { compute_identity_id: id(60), ownership_kind: "member", owner_user_id: userA.id },
					connections: [],
				})
				.mockResolvedValueOnce({
					login_id: id(61),
					compute_identity_id: id(60),
					compute_identity_ownership_kind: "member",
					compute_identity_owner_user_id: userA.id,
					compute_identity_owner_scope_key: null,
					provider: "openai",
					native_harness: "codex-cli",
					expires_at: "2099-01-01T00:00:00Z",
				});
			vi.spyOn(f.api, "request").mockResolvedValue({
				schema: "qorpera.native-provider-login-result/v1",
				login_id: id(61),
				status: "awaiting_member",
				interaction_url: url,
			});
			await expect(f.api.beginLogin("openai")).rejects.toThrow("login URL");
		},
	);
	it("does not send a previous account’s request using the new account’s token", async () => {
		const f = settings(),
			fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		f.auth(userB);
		await expect(f.api.request("https://objects.example.invalid/path", {})).rejects.toThrow("Sign in again");
		expect(fetcher).not.toHaveBeenCalled();
	});
});
