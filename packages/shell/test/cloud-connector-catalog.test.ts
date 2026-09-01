import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { JsonValue } from "@qorpera/contracts";
import { describe, expect, it } from "vitest";
import { assertConnectorDestination, CloudConnectorCatalog } from "../src/cloud-connector-catalog.ts";
import { connectorDigest, connectorJsonText } from "../src/cloud-connector-contract.ts";
import { cloudConnectorFixture, connectorCall } from "./fixtures/cloud-connector.ts";

describe("governed cloud connector catalog", () => {
	it("pins the actual adapter bytes and separate read/write schemas", () => {
		const fixture = cloudConnectorFixture();
		const bytes = readFileSync(new URL("../src/cloud-connector-github.ts", import.meta.url));
		expect(fixture.adapter.manifest.implementation.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
		expect(fixture.adapter.manifest.operations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "issues.get",
					access: "read",
					effect: "none",
					permission: "issues:read",
					receipt: "run_operation",
				}),
				expect.objectContaining({
					id: "issues.create_comment",
					access: "write",
					effect: "external",
					permission: "issues:write",
					reconciliation: "none",
					approval: "action_grant",
				}),
			]),
		);
		expect(fixture.catalog.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
		expect(fixture.catalog.inputSchema.oneOf).toHaveLength(2);
		expect(JSON.stringify(fixture.catalog.inputSchema)).not.toMatch(
			/credential|principal|providerAccountId|connectionId|sponsorUserId/,
		);
	});

	it.each([
		"schema",
		"manifest version",
		"implementation hash",
		"implementation version",
		"destination",
		"operation classification",
		"operation schema",
		"credential value",
	])("rejects installed %s drift", (change) => {
		const fixture = cloudConnectorFixture();
		const manifest = JSON.parse(JSON.stringify(fixture.adapter.manifest)) as Record<string, JsonValue>;
		if (change === "schema") manifest.schema = "qorpera.connector/v1";
		if (change === "manifest version") manifest.version = "2.0.0";
		if (change === "implementation hash")
			(manifest.implementation as Record<string, JsonValue>).sha256 = "0".repeat(64);
		if (change === "implementation version") (manifest.implementation as Record<string, JsonValue>).version = "next";
		if (change === "destination") manifest.destinations = ["https://api.github.com", "https://untrusted.example"];
		const operations = manifest.operations as Array<Record<string, JsonValue>>;
		if (change === "operation classification") operations[1].access = "read";
		if (change === "operation schema") operations[0].inputSchema = { type: "object", additionalProperties: true };
		if (change === "credential value") manifest.token = "synthetic-value-not-accepted";
		expect(
			() =>
				new CloudConnectorCatalog(
					[{ installation: { ...fixture.installation, manifest }, account: fixture.account }],
					[fixture.adapter],
				),
		).toThrow();
	});

	it("rejects duplicate installations, missing adapters and ungoverned paths", () => {
		const fixture = cloudConnectorFixture();
		const registration = { installation: fixture.installation, account: fixture.account };
		expect(() => new CloudConnectorCatalog([registration, registration], [fixture.adapter])).toThrow();
		expect(() => new CloudConnectorCatalog([registration], [])).toThrow();
		expect(
			() =>
				new CloudConnectorCatalog(
					[
						{
							...registration,
							installation: {
								...fixture.installation,
								object: {
									...fixture.installation.object,
									logicalPath: "/srv/company/connectors/manifest.json",
								},
							},
						},
					],
					[fixture.adapter],
				),
		).toThrow();
	});

	it("pins snapshots and permits only the installed operation subset", () => {
		const fixture = cloudConnectorFixture();
		const installation = { ...fixture.installation, enabledOperations: ["issues.get"] };
		const account = { ...fixture.account };
		const catalog = new CloudConnectorCatalog([{ installation, account }], [fixture.adapter]);
		installation.enabledOperations.push("issues.create_comment");
		account.connectionId = randomUUID();
		expect(catalog.get("qorpera.github", "issues.get").entry.account.connectionId).toBe(fixture.account.connectionId);
		expect(() => catalog.parseCall(connectorCall(true))).toThrow();
	});

	it("keeps member and company credential ownership explicit and company-bound", () => {
		const fixture = cloudConnectorFixture();
		const companyAccount = { ...fixture.account, owner: { kind: "company", id: fixture.identity.companyId } };
		expect(
			() =>
				new CloudConnectorCatalog(
					[{ installation: fixture.installation, account: companyAccount }],
					[fixture.adapter],
				),
		).not.toThrow();
		expect(
			() =>
				new CloudConnectorCatalog(
					[
						{
							installation: fixture.installation,
							account: { ...companyAccount, owner: { kind: "company", id: randomUUID() } },
						},
					],
					[fixture.adapter],
				),
		).toThrow();
		expect(
			() =>
				new CloudConnectorCatalog(
					[{ installation: fixture.installation, account: { ...fixture.account, companyId: randomUUID() } }],
					[fixture.adapter],
				),
		).toThrow();
	});

	it.each([
		"//attacker.example",
		"../other",
		"%2e%2e",
		"acme/other",
		"acme\\other",
		"acme?token=x",
		"acme#fragment",
		"acme@evil",
	])("rejects destination escape %s", (repositoryOwner) => {
		const fixture = cloudConnectorFixture();
		const call = connectorCall() as Record<string, JsonValue>;
		(call.input as Record<string, JsonValue>).repositoryOwner = repositoryOwner;
		expect(() => fixture.catalog.parseCall(call)).toThrow();
	});

	it.each(["mona-cat_octo", "the-octocat_acme", "octo_admin", `${"a".repeat(30)}_abcdefgh`])(
		"accepts managed-user repository owner %s in both schemas and prepared destinations",
		(repositoryOwner) => {
			const fixture = cloudConnectorFixture();
			for (const write of [false, true]) {
				const call = fixture.catalog.parseCall(
					connectorCall(write, "managed-repository-owner", "RoadMap", repositoryOwner.toUpperCase()),
				);
				const { entry, operation } = fixture.catalog.get(call.connectorId, call.operationId);
				const properties = operation.inputSchema.properties as Record<string, { pattern: string }>;
				expect(new RegExp(properties.repositoryOwner.pattern).test(repositoryOwner.toUpperCase())).toBe(true);
				expect(call.input.repositoryOwner).toBe(repositoryOwner);
				const request = fixture.adapter.prepare(call.operationId, call.input);
				expect(request.url).toBe(
					`https://api.github.com/repos/${repositoryOwner}/roadmap/issues/42${write ? "/comments" : ""}`,
				);
				expect(request.resource.repository).toBe(`${repositoryOwner}/roadmap`);
				expect(() => assertConnectorDestination(entry, operation, request)).not.toThrow();
			}
		},
	);

	it.each([
		"",
		"_octo",
		".",
		"..",
		"mona_octo/other",
		"mona_octo\\other",
		"mona_octo%2fother",
		"mona_octo?query",
		"mona_octo#fragment",
		"mona_octo@evil",
		"mona_octo\n",
		"mona_octo\r\n",
		"mona_octo\u2028",
		"mona_octo\u2029",
		"acme\n",
		`${"a".repeat(31)}_abcdefgh`,
	])("rejects unsafe repository owner %j in both schemas and parsers", (repositoryOwner) => {
		const fixture = cloudConnectorFixture();
		for (const write of [false, true]) {
			const operation = fixture.adapter.manifest.operations[write ? 1 : 0];
			const properties = operation.inputSchema.properties as Record<string, { pattern: string }>;
			expect(new RegExp(properties.repositoryOwner.pattern).test(repositoryOwner)).toBe(false);
			expect(() =>
				fixture.catalog.parseCall(connectorCall(write, "unsafe-repository-owner", "roadmap", repositoryOwner)),
			).toThrow("invalid_arguments");
		}
	});

	it.each(["companyId", "requesterUserId", "sponsorUserId", "credential", "token", "url", "headers", "path"])(
		"rejects model-selected %s",
		(key) => {
			const fixture = cloudConnectorFixture();
			const call = connectorCall() as Record<string, JsonValue>;
			expect(() => fixture.catalog.parseCall({ ...call, [key]: "untrusted" })).toThrow();
			expect(() =>
				fixture.catalog.parseCall({
					...call,
					input: { ...(call.input as Record<string, JsonValue>), [key]: "untrusted" },
				}),
			).toThrow();
		},
	);

	it("normalizes repository identity and rejects invalid write content", () => {
		const fixture = cloudConnectorFixture();
		const properties = fixture.adapter.manifest.operations[0].inputSchema.properties as Record<
			string,
			{ pattern: string }
		>;
		expect(new RegExp(properties.repositoryOwner.pattern).test("Acme")).toBe(true);
		expect(new RegExp(properties.repository.pattern).test("RoadMap")).toBe(true);
		const call = connectorCall(true) as Record<string, JsonValue>;
		expect(
			fixture.catalog.parseCall({
				...call,
				input: { repositoryOwner: "Acme", repository: "RoadMap", issueNumber: 42, body: "hello" },
			}).input,
		).toEqual({ repositoryOwner: "acme", repository: "roadmap", issueNumber: 42, body: "hello" });
		for (const body of ["", " ", "secret://github", "ghp_SYNTHETIC_VALUE", "x".repeat(4097), "abc\u0000def"]) {
			expect(() =>
				fixture.catalog.parseCall({ ...call, input: { ...(call.input as Record<string, JsonValue>), body } }),
			).toThrow();
		}
	});

	it.each([".github", ".github-private", "-tools", "a", "a".repeat(100)])(
		"accepts valid repository name %s in both schemas and prepared destinations",
		(repository) => {
			const fixture = cloudConnectorFixture();
			for (const write of [false, true]) {
				const call = fixture.catalog.parseCall(connectorCall(write, "valid-repository", repository.toUpperCase()));
				const { entry, operation } = fixture.catalog.get(call.connectorId, call.operationId);
				const properties = operation.inputSchema.properties as Record<string, { pattern: string }>;
				expect(new RegExp(properties.repository.pattern).test(repository)).toBe(true);
				expect(call.input.repository).toBe(repository);
				const request = fixture.adapter.prepare(call.operationId, call.input);
				expect(request.url).toBe(
					`https://api.github.com/repos/acme/${repository}/issues/42${write ? "/comments" : ""}`,
				);
				expect(request.resource.repository).toBe(`acme/${repository}`);
				expect(() => assertConnectorDestination(entry, operation, request)).not.toThrow();
			}
		},
	);

	it.each([
		"",
		".",
		"..",
		"../other",
		".github/../other",
		".github\\other",
		"%2e%2e",
		".%2e",
		"%2Fother",
		"%252e%252e",
		".github?token=x",
		".github#fragment",
		".github@evil",
		".github\n",
		".github\r\n",
		"x".repeat(101),
	])("rejects unsafe repository name %j in both schemas and parsers", (repository) => {
		const fixture = cloudConnectorFixture();
		for (const write of [false, true]) {
			const operation = fixture.adapter.manifest.operations[write ? 1 : 0];
			const properties = operation.inputSchema.properties as Record<string, { pattern: string }>;
			expect(new RegExp(properties.repository.pattern).test(repository)).toBe(false);
			expect(() => fixture.catalog.parseCall(connectorCall(write, "unsafe-repository", repository))).toThrow(
				"invalid_arguments",
			);
		}
	});

	it("rechecks prepared destinations and read classification before credentials", () => {
		const fixture = cloudConnectorFixture();
		const { entry, operation } = fixture.catalog.get("qorpera.github", "issues.get");
		const input = fixture.catalog.parseCall(connectorCall()).input;
		const request = fixture.adapter.prepare(operation.id, input);
		for (const url of [
			"https://api.github.com.evil.example/x",
			"http://api.github.com/x",
			"https://api.github.com:444/x",
			"https://member:secret@api.github.com/x",
			"https://api.github.com/x#fragment",
		]) {
			expect(() => assertConnectorDestination(entry, operation, { ...request, url })).toThrow();
		}
		expect(() => assertConnectorDestination(entry, operation, { ...request, method: "POST" })).toThrow();
		expect(() =>
			assertConnectorDestination(entry, operation, { ...request, headers: { authorization: "synthetic" } }),
		).toThrow();
	});

	it("rejects cyclic, accessor and oversized JSON without running getters", () => {
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		expect(() => connectorJsonText(cycle)).toThrow();
		expect(() =>
			connectorJsonText({
				get credential() {
					throw new Error("getter ran");
				},
			}),
		).toThrow("Cloud connector");
		expect(() => connectorJsonText({ body: "x".repeat(40_000) })).toThrow();
		expect(connectorDigest({ b: 2, a: 1 })).toBe(connectorDigest({ a: 1, b: 2 }));
	});
});
