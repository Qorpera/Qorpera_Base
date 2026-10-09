import { describe, expect, it } from "vitest";
import { ObjectDependencyError } from "../src/dependency.ts";
import { MemberCompanyHeadConflict, SupabaseMemberCompanyAuthority } from "../src/member-company-authority.ts";

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
		[409, "PT409", true, 409],
		[409, "23505", false, 409],
		[500, "40001", false, 409],
		[500, "40P01", false, 409],
		[500, "55P03", false, 409],
		[500, "55000", false, 423],
		[500, "57014", false, 503],
		[500, "XX000", false, 500],
		[409, "QRC01", false, 409],
		[412, "PT412", false, 412],
	] as const)("classifies %s/%s without retrying uncertainty", async (status, code, rebuild, expectedStatus) => {
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
		expect(error instanceof MemberCompanyHeadConflict).toBe(rebuild);
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
