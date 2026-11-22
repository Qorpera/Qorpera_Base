import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SupabaseObjectAuthority } from "../src/supabase-authority.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const environmentId = "5c1d0b8e-6d4f-4a43-9e8b-2f7a1c3d9e10";
const sha256 = "a".repeat(64);
type FetchInput = Parameters<typeof fetch>[0];

function header(request: FetchInput, init: RequestInit | undefined, name: string): string | null {
	return new Request(request, init).headers.get(name);
}

describe("Supabase object authority", () => {
	it("keeps the user JWT in Authorization and the publishable key in apikey", async () => {
		const calls: Array<{ request: FetchInput; init: RequestInit | undefined }> = [];
		const authority = new SupabaseObjectAuthority({
			projectUrl: "https://project.supabase.co",
			publishableKey: "sb_publishable_public",
			secretKey: "sb_secret_private",
			fetch: async (request, init) => {
				calls.push({ request, init });
				return Response.json({ schema: "qorpera.folder-object-download/v1", profileId, bytes: 12 });
			},
		});

		await authority.authorizeMemberFolderObject("member-jwt", environmentId, sha256);

		expect(calls).toHaveLength(1);
		expect(header(calls[0]!.request, calls[0]!.init, "apikey")).toBe("sb_publishable_public");
		expect(header(calls[0]!.request, calls[0]!.init, "authorization")).toBe("Bearer member-jwt");
	});

	it("sends modern secret keys only in apikey for privileged operations", async () => {
		const calls: Array<{ request: FetchInput; init: RequestInit | undefined }> = [];
		const authority = new SupabaseObjectAuthority({
			projectUrl: "https://project.supabase.co",
			publishableKey: "sb_publishable_public",
			secretKey: "sb_secret_private",
			fetch: async (request, init) => {
				calls.push({ request, init });
				return new Response(null, { status: 204 });
			},
		});

		await authority.confirmUpload(profileId, sha256, 12);

		expect(calls).toHaveLength(1);
		expect(header(calls[0]!.request, calls[0]!.init, "apikey")).toBe("sb_secret_private");
		expect(header(calls[0]!.request, calls[0]!.init, "authorization")).toBeNull();
	});

	it("authorizes and finalizes deletion in separate privileged calls", async () => {
		const calls: Array<{ request: FetchInput; init: RequestInit | undefined }> = [];
		const authority = new SupabaseObjectAuthority({
			projectUrl: "https://project.supabase.co",
			publishableKey: "sb_publishable_public",
			secretKey: "sb_secret_private",
			fetch: async (request, init) => {
				calls.push({ request, init });
				return Response.json(
					calls.length === 1
						? { state: "authorized", authorization_id: "83dc6943-b71c-4ba4-a38d-78da0861e0dc" }
						: true,
				);
			},
		});

		const authorization = await authority.authorizeDelete(
			profileId,
			sha256,
			12,
			"73dc6943-b71c-4ba4-a38d-78da0861e0dc",
		);
		expect(authorization).toEqual({
			state: "authorized",
			authorizationId: "83dc6943-b71c-4ba4-a38d-78da0861e0dc",
		});
		await authority.finalizeDelete("83dc6943-b71c-4ba4-a38d-78da0861e0dc", profileId, sha256, 12);

		expect(calls.map((call) => String(call.request))).toEqual([
			"https://project.supabase.co/rest/v1/rpc/qorpera_authorize_profile_object_deletion",
			"https://project.supabase.co/rest/v1/rpc/qorpera_finalize_profile_object_deletion",
		]);
		for (const call of calls) {
			expect(header(call.request, call.init, "apikey")).toBe("sb_secret_private");
			expect(header(call.request, call.init, "authorization")).toBeNull();
		}
	});

	it("does not mislabel a modern secret key as a storage bearer token", async () => {
		const calls: Array<{ request: FetchInput; init: RequestInit | undefined }> = [];
		const authority = new SupabaseObjectAuthority({
			projectUrl: "https://project.supabase.co",
			publishableKey: "sb_publishable_public",
			secretKey: "sb_secret_private",
			fetch: async (request, init) => {
				calls.push({ request, init });
				return new Response(Uint8Array.from([1, 2, 3]));
			},
		});

		await authority.readLegacyObject(profileId, sha256);

		expect(calls).toHaveLength(1);
		expect(header(calls[0]!.request, calls[0]!.init, "apikey")).toBe("sb_secret_private");
		expect(header(calls[0]!.request, calls[0]!.init, "authorization")).toBeNull();
	});

	it("coalesces concurrent readLegacyObject requests for the same object into one storage fetch", async () => {
		let fetchCount = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const payload = Uint8Array.from([9, 8, 7, 6]);
		const authority = new SupabaseObjectAuthority({
			projectUrl: "https://project.supabase.co",
			publishableKey: "sb_publishable_public",
			secretKey: "sb_secret_private",
			fetch: async () => {
				fetchCount++;
				if (fetchCount === 1) await gate;
				return new Response(payload);
			},
		});

		const readers = Array.from({ length: 50 }, () => authority.readLegacyObject(profileId, sha256));
		await Promise.resolve();
		expect(fetchCount).toBe(1);
		release();
		const results = await Promise.all(readers);
		expect(fetchCount).toBe(1);
		for (const result of results) expect(Buffer.from(result)).toEqual(Buffer.from(payload));

		const again = await authority.readLegacyObject(profileId, sha256);
		expect(fetchCount).toBe(2);
		expect(Buffer.from(again)).toEqual(Buffer.from(payload));
	});

	it("connects over private LAN TLS when given a matching CA and refuses wrong or invalid CAs and redirects", async () => {
		expect(
			() =>
				new SupabaseObjectAuthority({
					projectUrl: "https://127.0.0.1:8443",
					publishableKey: "sb_publishable_public",
					secretKey: "sb_secret_private",
					ca: "not-a-pem",
				}),
		).toThrow("CA certificate is invalid");

		const directory = await mkdtemp(join(tmpdir(), "qorpera-supabase-ca-"));
		let server: HttpsServer | undefined;
		try {
			const make = (name: string): void => {
				const made = spawnSync(
					"openssl",
					[
						"req",
						"-x509",
						"-newkey",
						"rsa:2048",
						"-nodes",
						"-keyout",
						join(directory, `${name}-key.pem`),
						"-out",
						join(directory, `${name}.pem`),
						"-days",
						"1",
						"-subj",
						"/CN=localhost",
						"-addext",
						"subjectAltName=IP:127.0.0.1",
					],
					{ encoding: "utf8", timeout: 15_000 },
				);
				if (made.status !== 0) throw new Error("Could not create test TLS certificate");
			};
			make("primary");
			make("other");
			const cert = await readFile(join(directory, "primary.pem"), "utf8");
			const key = await readFile(join(directory, "primary-key.pem"), "utf8");
			const otherCa = await readFile(join(directory, "other.pem"), "utf8");
			let mode: "ok" | "redirect" = "ok";
			server = createHttpsServer({ cert, key }, (req, res) => {
				req.resume();
				if (mode === "redirect") {
					res.writeHead(302, { location: "https://127.0.0.1/elsewhere" });
					res.end();
					return;
				}
				if (req.url?.includes("/storage/v1/object/")) {
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ Key: `${profileId}/${sha256}` }));
					return;
				}
				res.writeHead(200, { "content-type": "application/json" });
				res.end("true");
			});
			await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("No server address");
			const projectUrl = `https://127.0.0.1:${address.port}`;

			const trusted = new SupabaseObjectAuthority({
				projectUrl,
				publishableKey: "sb_publishable_public",
				secretKey: "sb_secret_private",
				ca: cert,
			});
			const wrong = new SupabaseObjectAuthority({
				projectUrl,
				publishableKey: "sb_publishable_public",
				secretKey: "sb_secret_private",
				ca: otherCa,
			});
			try {
				await expect(trusted.confirmUpload(profileId, sha256, 4)).resolves.toBeUndefined();
				expect(await trusted.writeReplica(profileId, sha256, Buffer.from("data"))).toBe("created");
				await expect(wrong.confirmUpload(profileId, sha256, 4)).rejects.toMatchObject({ status: 503 });
				mode = "redirect";
				await expect(trusted.confirmUpload(profileId, sha256, 4)).rejects.toMatchObject({ status: 503 });
			} finally {
				trusted.close();
				wrong.close();
			}
		} finally {
			if (server) {
				server.closeAllConnections();
				await new Promise<void>((resolve) => server!.close(() => resolve()));
			}
			await rm(directory, { recursive: true, force: true });
		}
	});
});
