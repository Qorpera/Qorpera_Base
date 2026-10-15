import { describe, expect, it, vi } from "vitest";
import type { Cloud } from "../src/cloud/client.ts";
import {
	codingValueProblem,
	createWebCodingEnvironment,
	parseCodingEnvironment,
} from "../src/cloud/coding-environment.ts";
import { CloudShapeError } from "../src/cloud/parse.ts";
import { id, timestamp } from "./fixtures.ts";

const profile = { profileId: id(10), environmentId: id(11) };
const memberId = id(12);
const origin = "https://company41-node-01.tailbb15c7.ts.net:10000";

const ticket = {
	schema: "qorpera.cloud-secret-capture/v1",
	ticketId: id(20),
	captureCapability: "c".repeat(43),
	serviceOrigin: origin,
	expiresAt: timestamp,
	scope: { companyId: id(10) },
};

const grant = {
	grantId: id(31),
	repository: "acme/web",
	issuedByUserId: memberId,
	createdAt: timestamp,
};

const companyVariable = {
	schema: "qorpera.coding-environment-secret/v1",
	secretId: id(30),
	name: "NPM_TOKEN",
	ownerKind: "company",
	purpose: "Installs private packages",
	version: 2,
	grants: [grant],
	createdAt: timestamp,
	updatedAt: timestamp,
};

function cloudWith(rpc: (name: string, args: Record<string, unknown>) => unknown) {
	return {
		rpc: vi.fn(async (name: string, args: Record<string, unknown>) => rpc(name, args)),
	} as unknown as Cloud & { rpc: ReturnType<typeof vi.fn> };
}

function setup(rpc: (name: string, args: Record<string, unknown>) => unknown = () => ticket) {
	const cloud = cloudWith(rpc);
	const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({}));
	return { cloud, fetch, client: createWebCodingEnvironment(cloud, profile, memberId, fetch) };
}

describe("coding environment client", () => {
	it("lists the variables with their repositories and refuses an answer of another shape", async () => {
		const { cloud, client } = setup(() => [companyVariable]);
		await expect(client.list()).resolves.toEqual([
			{
				secretId: id(30),
				name: "NPM_TOKEN",
				ownerKind: "company",
				purpose: "Installs private packages",
				version: 2,
				grants: [grant],
				createdAt: timestamp,
				updatedAt: timestamp,
			},
		]);
		expect(cloud.rpc).toHaveBeenCalledWith("qorpera_list_coding_environment", {
			p_profile_id: id(10),
			p_environment_id: id(11),
		});
		expect(() => parseCodingEnvironment([{ ...companyVariable, schema: "qorpera.cloud-secret/v1" }])).toThrow(
			CloudShapeError,
		);
		expect(() => parseCodingEnvironment([{ ...companyVariable, name: "npm_token" }])).toThrow(CloudShapeError);
		expect(() =>
			parseCodingEnvironment([{ ...companyVariable, grants: [{ ...grant, repository: "Acme/Web" }] }]),
		).toThrow(CloudShapeError);
		expect(() => parseCodingEnvironment({})).toThrow(CloudShapeError);
	});

	it("captures a member's own variable for the signed-in member, sending only the value to the broker", async () => {
		const { cloud, fetch, client } = setup();
		await client.capture({
			ownerKind: "member",
			name: "NPM_TOKEN",
			purpose: "Installs private packages",
			value: "fake-value-1",
		});
		expect(cloud.rpc).toHaveBeenCalledWith("qorpera_begin_cloud_secret_capture", {
			p_profile_id: id(10),
			p_environment_id: id(11),
			p_owner_kind: "member",
			p_owner_user_id: memberId,
			p_connector_id: "environment",
			p_secret_name: "npm_token",
			p_purpose: "Installs private packages",
			p_existing_secret_id: null,
		});
		expect(fetch.mock.calls[0]![0]).toBe(`${origin}/v1/captures/${id(20)}?company=${id(10)}`);
		expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({
			schema: "qorpera.cloud-secret-capture-request/v1",
			captureCapability: "c".repeat(43),
			fields: { value: "fake-value-1" },
		});
		// The value never goes to the cloud.
		expect(JSON.stringify(cloud.rpc.mock.calls)).not.toContain("fake-value-1");
	});

	it("captures a company variable without an owner, and a replaced value names the variable it replaces", async () => {
		const { cloud, client } = setup();
		await client.capture({ ownerKind: "company", name: "NPM_TOKEN", purpose: "Packages", value: "fake-value-2" });
		expect(cloud.rpc).toHaveBeenLastCalledWith(
			"qorpera_begin_cloud_secret_capture",
			expect.objectContaining({ p_owner_kind: "company", p_owner_user_id: null, p_existing_secret_id: null }),
		);
		await client.capture({
			ownerKind: "company",
			name: "NPM_TOKEN",
			purpose: "Packages",
			value: "fake-value-3",
			existingSecretId: id(30),
		});
		expect(cloud.rpc).toHaveBeenLastCalledWith(
			"qorpera_begin_cloud_secret_capture",
			expect.objectContaining({ p_secret_name: "npm_token", p_existing_secret_id: id(30) }),
		);
	});

	it("refuses a name or a value the kernel or the broker would refuse before any request leaves", async () => {
		const { cloud, fetch, client } = setup();
		const base = { ownerKind: "member" as const, purpose: "Packages" };
		await expect(client.capture({ ...base, name: "npm_token", value: "fake-value-1" })).rejects.toThrow(
			"Invalid variable name.",
		);
		await expect(client.capture({ ...base, name: "NPM_TOKEN", value: "fake-12" })).rejects.toThrow(
			"The broker would refuse this value.",
		);
		await expect(client.capture({ ...base, name: "NPM_TOKEN", value: "fake-value\0" })).rejects.toThrow(
			"The broker would refuse this value.",
		);
		await expect(
			client.capture({ ...base, name: "NPM_TOKEN", value: "fake-value-1", existingSecretId: "../secrets" }),
		).rejects.toThrow("Invalid variable.");
		expect(cloud.rpc).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("counts a value's bytes as the broker does", () => {
		expect(codingValueProblem("fake-12")).toBe("short");
		expect(codingValueProblem("fake-123")).toBeUndefined();
		// Four letters, eight bytes.
		expect(codingValueProblem("æøåæ")).toBeUndefined();
		expect(codingValueProblem("fake\0value")).toBe("nul");
		expect(codingValueProblem("x".repeat(32 * 1024))).toBeUndefined();
		expect(codingValueProblem("x".repeat(32 * 1024 + 1))).toBe("long");
	});

	it("gives a variable to a repository, takes it back and removes a variable with their own calls", async () => {
		const { cloud, client } = setup((name) => {
			if (name === "qorpera_grant_coding_environment_secret")
				return { schema: "qorpera.coding-environment-grant/v1", status: "active", secretId: id(30), ...grant };
			if (name === "qorpera_revoke_coding_environment_grant")
				return { schema: "qorpera.coding-environment-grant/v1", status: "revoked", secretId: id(30), ...grant };
			return null;
		});
		await expect(client.grant(id(30), "acme/web")).resolves.toEqual(grant);
		expect(cloud.rpc).toHaveBeenLastCalledWith("qorpera_grant_coding_environment_secret", {
			p_profile_id: id(10),
			p_secret_id: id(30),
			p_repository: "acme/web",
		});
		await client.revokeGrant(id(31));
		expect(cloud.rpc).toHaveBeenLastCalledWith("qorpera_revoke_coding_environment_grant", {
			p_profile_id: id(10),
			p_grant_id: id(31),
		});
		await client.remove(id(30));
		expect(cloud.rpc).toHaveBeenLastCalledWith("qorpera_revoke_cloud_secret", {
			p_profile_id: id(10),
			p_secret_id: id(30),
		});
	});

	it("refuses a grant answer in the wrong state and ids that are not UUIDs", async () => {
		const { cloud, client } = setup(() => ({
			schema: "qorpera.coding-environment-grant/v1",
			status: "revoked",
			secretId: id(30),
			...grant,
		}));
		await expect(client.grant(id(30), "acme/web")).rejects.toThrow(CloudShapeError);
		cloud.rpc.mockClear();
		await expect(client.grant("../secrets", "acme/web")).rejects.toThrow("Invalid variable.");
		await expect(client.revokeGrant("../grants")).rejects.toThrow("Invalid grant.");
		await expect(client.remove("../secrets")).rejects.toThrow("Invalid variable.");
		expect(cloud.rpc).not.toHaveBeenCalled();
	});
});
