import { describe, expect, it } from "vitest";
import { ObjectDependencyError } from "../src/dependency.ts";
import { SupabaseMemberCompanyAuthority } from "../src/member-company-authority.ts";

const token = "synthetic-member-jwt";

describe("human and publisher transport separation", () => {
	it("keeps service credentials out of member RPCs and member credentials out of publication", async () => {
		const requests: Request[] = [];
		const authority = new SupabaseMemberCompanyAuthority({
			projectUrl: "https://cloud.test",
			publishableKey: "public-fixture",
			secretKey: "secret-fixture",
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return Response.json({});
			},
		});
		await authority.member("qorpera_member_folder_writer", token, {}, new AbortController().signal);
		await authority.publisher("qorpera_folder_commit", {}, new AbortController().signal);
		expect(
			requests.map((request) => [
				request.headers.get("apikey"),
				request.headers.get("authorization"),
				request.redirect,
			]),
		).toEqual([
			["public-fixture", `Bearer ${token}`, "error"],
			["secret-fixture", null, "error"],
		]);
	});

	it.each([
		[409, "23505", 409],
		[500, "40001", 409],
		[500, "40P01", 409],
		[500, "55P03", 409],
		[500, "55000", 423],
		[500, "54000", 413],
		[500, "57014", 503],
		[500, "XX000", 500],
		[409, "QRC01", 409],
		[412, "PT412", 412],
	] as const)("classifies %s/%s without retrying uncertainty", async (status, code, expectedStatus) => {
		const authority = new SupabaseMemberCompanyAuthority({
			projectUrl: "https://cloud.test",
			publishableKey: "public",
			secretKey: "secret",
			fetch: async () => Response.json({ code }, { status }),
		});
		const error = await authority
			.publisher("qorpera_folder_commit", {}, new AbortController().signal)
			.catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(ObjectDependencyError);
		expect(error).toMatchObject({ status: expectedStatus });
	});

	it("refuses one request on a company's limit and leaves the circuit closed", async () => {
		let calls = 0;
		const authority = new SupabaseMemberCompanyAuthority({
			projectUrl: "https://cloud.test",
			publishableKey: "public",
			secretKey: "secret",
			fetch: async () => {
				calls++;
				return calls === 1 ? Response.json({ code: "54000" }, { status: 500 }) : Response.json({ ok: true });
			},
		});
		const begin = () => authority.member("qorpera_room_image_begin", token, {}, new AbortController().signal);
		await expect(begin()).rejects.toMatchObject({ status: 413 });
		await expect(begin()).resolves.toEqual({ ok: true });
	});

	it("answers the erase route's missing message as 404, and another RPC's P0002 as a failure", async () => {
		let calls = 0;
		const authority = new SupabaseMemberCompanyAuthority({
			projectUrl: "https://cloud.test",
			publishableKey: "public",
			secretKey: "secret",
			fetch: async () => {
				calls++;
				return calls < 3 ? Response.json({ code: "P0002" }, { status: 500 }) : Response.json({ ok: true });
			},
		});
		const signal = new AbortController().signal;
		await expect(authority.publisher("qorpera_memory_message_erase_request", {}, signal)).rejects.toMatchObject({
			status: 404,
		});
		await expect(authority.publisher("qorpera_memory_message_erase_status", {}, signal)).rejects.toMatchObject({
			status: 404,
		});
		await expect(authority.publisher("qorpera_memory_message_erase_status", {}, signal)).resolves.toEqual({
			ok: true,
		});
		calls = 0;
		await expect(authority.publisher("qorpera_folder_commit", {}, signal)).rejects.toMatchObject({ status: 500 });
	});

	it("preserves a denial without waiting for its body", async () => {
		const authority = new SupabaseMemberCompanyAuthority({
			projectUrl: "https://cloud.test",
			publishableKey: "public",
			secretKey: "secret",
			requestTimeoutMs: 100,
			fetch: async () => new Response(new ReadableStream(), { status: 403 }),
		});
		await expect(
			authority.member("qorpera_member_folder_writer", token, {}, new AbortController().signal),
		).rejects.toMatchObject({ status: 403 });
	});
});
