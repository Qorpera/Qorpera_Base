import { describe, expect, it, vi } from "vitest";
import { type Cloud, CloudRpcError } from "../src/cloud/client.ts";
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

/** A cloud that issues a new ticket for each begin, `lifetimeMs` from now, unless a refusal is queued. */
function ticketing(lifetimeMs = 10 * 60_000) {
	let next = 20;
	const refusals: unknown[] = [];
	return {
		refusals,
		rpc: () => {
			if (refusals.length) throw refusals.shift();
			return { ...ticket, ticketId: id(next++), expiresAt: new Date(Date.now() + lifetimeMs).toISOString() };
		},
	};
}

const broker = (ticketId: string) => `${origin}/v1/captures/${ticketId}?company=${id(10)}`;

/** Each broker request: where it went and the value it carried. */
function sent(fetch: ReturnType<typeof setup>["fetch"]): [string, string][] {
	return fetch.mock.calls.map(([url, init]): [string, string] => [
		String(url),
		JSON.parse(String(init?.body)).fields.value,
	]);
}

/** SQL's refusal of a second open replacement of one variable, or of a new name that now exists. */
const duplicate = () =>
	new CloudRpcError("qorpera_begin_cloud_secret_capture", { message: "duplicate key value", code: "23505" });

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

describe("a capture whose broker request failed", () => {
	const replacement = {
		ownerKind: "company" as const,
		name: "NPM_TOKEN",
		purpose: "Packages",
		existingSecretId: id(30),
	};
	const offline = () => new TypeError("Failed to fetch");

	it("sends the next try with the same ticket, asking the cloud for none and keeping no value", async () => {
		const { cloud, fetch, client } = setup(ticketing().rpc);
		fetch.mockRejectedValueOnce(offline());
		await expect(client.capture({ ...replacement, value: "fake-value-1" })).rejects.toThrow("Failed to fetch");
		await client.capture({ ...replacement, value: "fake-value-2" });
		expect(cloud.rpc).toHaveBeenCalledTimes(1);
		// Each try carries the value it was given: only the ticket was kept, and the cloud never saw a value.
		expect(sent(fetch)).toEqual([
			[broker(id(20)), "fake-value-1"],
			[broker(id(20)), "fake-value-2"],
		]);
		expect(JSON.stringify(cloud.rpc.mock.calls)).not.toContain("fake-value");
	});

	it("asks for one fresh ticket when the kept one was used by a try whose answer was lost", async () => {
		const { cloud, fetch, client } = setup(ticketing().rpc);
		// The broker saved the value, but its answer never arrived.
		fetch.mockRejectedValueOnce(offline());
		await expect(client.capture({ ...replacement, value: "fake-value-1" })).rejects.toThrow("Failed to fetch");
		// It refuses the used ticket as it refuses any other; the cloud issues a fresh one, and the value lands.
		fetch.mockResolvedValueOnce(
			Response.json({ schema: "qorpera.cloud-secret-error/v1", error: "unavailable" }, { status: 403 }),
		);
		await client.capture({ ...replacement, value: "fake-value-2" });
		expect(cloud.rpc).toHaveBeenCalledTimes(2);
		expect(sent(fetch)).toEqual([
			[broker(id(20)), "fake-value-1"],
			[broker(id(20)), "fake-value-2"],
			[broker(id(21)), "fake-value-2"],
		]);
	});

	it("keeps the open ticket when the cloud refuses a second one, failing with the broker's error", async () => {
		const tickets = ticketing();
		const { cloud, fetch, client } = setup(tickets.rpc);
		fetch.mockRejectedValueOnce(offline());
		await expect(client.capture({ ...replacement, value: "fake-value-1" })).rejects.toThrow("Failed to fetch");
		// The broker fails again; the kept ticket is still open, so the cloud refuses another.
		fetch.mockResolvedValueOnce(new Response(null, { status: 502 }));
		tickets.refusals.push(duplicate());
		await expect(client.capture({ ...replacement, value: "fake-value-2" })).rejects.toThrow(
			"The connection could not be started. Try again.",
		);
		await client.capture({ ...replacement, value: "fake-value-3" });
		expect(cloud.rpc).toHaveBeenCalledTimes(2);
		expect(sent(fetch)).toEqual([
			[broker(id(20)), "fake-value-1"],
			[broker(id(20)), "fake-value-2"],
			[broker(id(20)), "fake-value-3"],
		]);
	});

	it("keeps the ticket when the cloud cannot be asked for a fresh one", async () => {
		const tickets = ticketing();
		const { cloud, fetch, client } = setup(tickets.rpc);
		fetch.mockRejectedValueOnce(offline());
		await expect(client.capture({ ...replacement, value: "fake-value-1" })).rejects.toThrow("Failed to fetch");
		fetch.mockResolvedValueOnce(new Response(null, { status: 502 }));
		tickets.refusals.push(offline());
		await expect(client.capture({ ...replacement, value: "fake-value-2" })).rejects.toThrow("Failed to fetch");
		await client.capture({ ...replacement, value: "fake-value-3" });
		expect(cloud.rpc).toHaveBeenCalledTimes(2);
		expect(sent(fetch).map(([url]) => url)).toEqual([broker(id(20)), broker(id(20)), broker(id(20))]);
	});

	it("passes on a new name's 23505: the earlier try saved it, so the next try replaces it", async () => {
		const tickets = ticketing();
		const { fetch, client } = setup(tickets.rpc);
		const added = { ...replacement, existingSecretId: undefined };
		fetch.mockRejectedValueOnce(offline());
		await expect(client.capture({ ...added, value: "fake-value-1" })).rejects.toThrow("Failed to fetch");
		fetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
		tickets.refusals.push(duplicate());
		await expect(client.capture({ ...added, value: "fake-value-2" })).rejects.toMatchObject({ code: "23505" });
	});

	it.each([
		["has expired", -1_000],
		["has less than a minute left", 30_000],
	])("asks for a new ticket when the kept one %s", async (_, lifetimeMs) => {
		const { cloud, fetch, client } = setup(ticketing(lifetimeMs).rpc);
		fetch.mockRejectedValueOnce(offline());
		await expect(client.capture({ ...replacement, value: "fake-value-1" })).rejects.toThrow("Failed to fetch");
		await client.capture({ ...replacement, value: "fake-value-2" });
		expect(cloud.rpc).toHaveBeenCalledTimes(2);
		expect(sent(fetch).map(([url]) => url)).toEqual([broker(id(20)), broker(id(21))]);
	});

	it("forgets the ticket once a try with it succeeds", async () => {
		const { cloud, fetch, client } = setup(ticketing().rpc);
		fetch.mockRejectedValueOnce(offline());
		await expect(client.capture({ ...replacement, value: "fake-value-1" })).rejects.toThrow("Failed to fetch");
		await client.capture({ ...replacement, value: "fake-value-2" });
		await client.capture({ ...replacement, value: "fake-value-3" });
		expect(cloud.rpc).toHaveBeenCalledTimes(2);
		expect(sent(fetch).map(([url]) => url)).toEqual([broker(id(20)), broker(id(20)), broker(id(21))]);
	});

	it("stops at an abort without asking for a fresh ticket, and keeps the ticket for the next try", async () => {
		const { cloud, fetch, client } = setup(ticketing().rpc);
		fetch.mockRejectedValueOnce(offline());
		await expect(client.capture({ ...replacement, value: "fake-value-1" })).rejects.toThrow("Failed to fetch");
		const leaving = new AbortController();
		fetch.mockImplementationOnce(() => {
			leaving.abort(new Error("The page closed."));
			return new Promise<Response>(() => {});
		});
		await expect(client.capture({ ...replacement, value: "fake-value-2" }, leaving.signal)).rejects.toThrow(
			"The page closed.",
		);
		expect(cloud.rpc).toHaveBeenCalledTimes(1);
		await client.capture({ ...replacement, value: "fake-value-3" });
		expect(cloud.rpc).toHaveBeenCalledTimes(1);
		expect(sent(fetch).map(([url]) => url)).toEqual([broker(id(20)), broker(id(20)), broker(id(20))]);
	});
});
