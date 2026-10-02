import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { cloudActionEffect, describeCloudAction } from "../src/cloud-action-review.ts";
import {
	type CloudCompanyAccountClient,
	cloudCompanyAccountTool,
	companyAccountLogin,
	companyAccountWayIn,
} from "../src/cloud-company-account-tools.ts";
import type { CloudCompanyPathControl } from "../src/cloud-company-path-gateway.ts";
import { CloudNativeToolBoundary } from "../src/cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "../src/cloud-native-tool-operations.ts";
import { CLOUD_RUNTIME_TOOL_OPERATIONS } from "../src/cloud-runtime-observability.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const TODO = "81300000-0000-4000-8000-000000000060";
const ACCOUNT = "81300000-0000-4000-8000-0000000000a1";

function fixture(
	answer: Partial<{ accounts: unknown[]; mailboxes: string[]; refused: { code: string; message: string } }> = {},
) {
	const { authority, binding } = nativeToolAuthorityFixture();
	const identity = authority.identity;
	const control = {
		call: vi.fn(async (method: string, args: Record<string, unknown>) => {
			if (method !== "qorpera_find_company_accounts") throw new Error(`unexpected ${method}`);
			const request = args.p_request as { todo?: string };
			if (answer.refused) return { schema: "qorpera.agent-company-accounts/v1", refused: answer.refused };
			return {
				schema: "qorpera.agent-company-accounts/v1",
				runId: binding.runId,
				mailboxes: answer.mailboxes ?? ["agents@inbox.qorpera.com"],
				accounts: answer.accounts ?? [],
				...(request.todo ? { todo: { key: request.todo, id: TODO } } : {}),
			};
		}),
	};
	const accounts = {
		companyAccount: vi.fn<CloudCompanyAccountClient["companyAccount"]>(async (request) => ({
			schema: "qorpera.company-account/v1",
			accountId: ACCOUNT,
			site: request.action === "open" ? request.site : "vercel.com",
			signInHosts: [],
			login: request.action === "open" ? request.login : "agents+vercel.com@inbox.qorpera.com",
			twoStep: "none",
			status: request.action === "open" ? "pending" : request.status,
			version: 1,
		})),
	};
	const receiptId = randomUUID();
	const execute = vi.fn<CloudNativeToolOperations["execute"]>(async (options) => {
		await options.authorize(options.operation, identity, options.signal);
		return (
			await options.perform(options.operation, {
				identity,
				receiptId,
				inputSha256: "a".repeat(64),
				idempotencyKey: "b".repeat(64),
				signal: options.signal,
			})
		).content;
	});
	const tool = cloudCompanyAccountTool({
		binding,
		identity,
		control: control as unknown as CloudCompanyPathControl,
		operations: { execute },
		accounts,
	});
	const boundary = new CloudNativeToolBoundary({
		companyId: identity.companyId,
		runId: identity.runId,
		identity,
		tools: [tool],
		assertActive: async () => undefined,
		signal: new AbortController().signal,
	});
	let calls = 0;
	const invoke = (args: Record<string, unknown>) =>
		boundary.invoke(`call_${++calls}`, "qorpera", "company_account", args as never);
	const text = (result: { contentItems: ReadonlyArray<{ type: string; text?: string }> }) => {
		const first = result.contentItems[0];
		return first && "text" in first ? (first.text ?? "") : "";
	};
	return { binding, identity, control, accounts, execute, invoke, text, receiptId };
}

const open = (extra: Record<string, unknown> = {}) => ({
	action: "open",
	site: "Vercel.com",
	todo: "website-online",
	purpose: "Host the company website",
	operationKey: "vercel-signup",
	...extra,
});

describe("company_account", () => {
	it("is a tool the runtime observes by name", () => {
		expect(CLOUD_RUNTIME_TOOL_OPERATIONS).toContain("company_account");
	});

	it("finds the company's accounts and mailboxes through the run binding", async () => {
		const f = fixture({
			accounts: [{ accountId: ACCOUNT, site: "vercel.com", signInHosts: [], login: "x", status: "connected" }],
		});
		const result = await f.invoke({ action: "find", site: "Vercel.COM" });
		expect(result.success, JSON.stringify(result)).toBe(true);
		expect(f.control.call.mock.calls[0]!.slice(0, 2)).toEqual([
			"qorpera_find_company_accounts",
			{ p_binding: f.binding, p_request: { site: "vercel.com" } },
		]);
		expect(f.text(result)).toContain(ACCOUNT);
		expect(f.text(result)).toContain("agents@inbox.qorpera.com");
		expect(f.execute).not.toHaveBeenCalled();
	});

	it("passes the database's refusal on in its own words", async () => {
		const f = fixture({ refused: { code: "0A000", message: "Company accounts are switched off" } });
		const result = await f.invoke({ action: "find" });
		expect(result.success).toBe(false);
		expect(f.text(result)).toContain("REFUSED: Company accounts are switched off");
	});

	it("opens an account with the company's tagged address for the agent's todo, through an effect receipt", async () => {
		const f = fixture();
		const result = await f.invoke(open({ signInHosts: ["Login.Vercel.com"], password: { length: 20 } }));
		expect(result.success, JSON.stringify(result)).toBe(true);
		expect(f.control.call.mock.calls[0]![1]).toEqual({
			p_binding: f.binding,
			p_request: { todo: "website-online", site: "vercel.com" },
		});
		const operation = f.execute.mock.calls[0]![0].operation;
		expect(operation).toEqual({
			tool: "company_account",
			toolVersion: "qorpera.company-account-tool/v1",
			logicalOperationKey: "open:vercel-signup",
			arguments: {
				site: "vercel.com",
				signInHosts: ["login.vercel.com"],
				login: "agents+vercel.com@inbox.qorpera.com",
				purpose: "Host the company website",
				todo: TODO,
				password: { length: 20 },
			},
			target: { realm: "company_account", action: "open" },
			requiresCompanyRevision: false,
		});
		expect(f.accounts.companyAccount.mock.calls[0]![0]).toEqual({
			action: "open",
			binding: f.binding,
			receiptId: f.receiptId,
			inputSha256: "a".repeat(64),
			idempotencyKey: "b".repeat(64),
			site: "vercel.com",
			signInHosts: ["login.vercel.com"],
			login: "agents+vercel.com@inbox.qorpera.com",
			purpose: "Host the company website",
			todoId: TODO,
			password: { length: 20 },
		});
		expect(f.text(result)).toContain(ACCOUNT);
	});

	it("never opens an account where an official connection or a person belongs, and asks the database nothing", async () => {
		for (const [args, says] of [
			[open({ site: "github.com" }), "GitHub has an official connection"],
			[open({ site: "mail.google.com" }), "Google has an official connection"],
			[open({ site: "vercel.com", signInHosts: ["accounts.google.com"] }), "Google has an official connection"],
			[open({ site: "login.microsoftonline.com" }), "Microsoft is reached only through an official connection"],
			[open({ site: "slack.com" }), "Slack is reached only through an official connection"],
			[open({ site: "appleid.apple.com" }), "Apple checks for automated browsers"],
			[open({ site: "www.linkedin.com" }), "LinkedIn checks for automated browsers"],
			[open({ site: "x.com" }), "X checks for automated browsers"],
			[open({ site: "business.facebook.com" }), "Meta checks for automated browsers"],
		] as const) {
			const f = fixture();
			const result = await f.invoke(args);
			expect(result.success, String(args.site)).toBe(false);
			expect(f.text(result)).toContain(`REFUSED: ${says}`);
			expect(f.text(result)).toContain("never ask anyone for its password");
			expect(f.control.call).not.toHaveBeenCalled();
			expect(f.execute).not.toHaveBeenCalled();
		}
		// A name that only looks alike is a site of its own.
		expect(companyAccountWayIn(["notgithub.com", "github.com.example"])).toBeUndefined();
	});

	it("chooses the company's one mailbox, or the one named, and refuses without one", async () => {
		const none = fixture({ mailboxes: [] });
		expect(none.text(await none.invoke(open()))).toContain("REFUSED: The company has no mailbox");
		const two = fixture({ mailboxes: ["agents@inbox.qorpera.com", "ops@inbox.qorpera.com"] });
		expect(two.text(await two.invoke(open()))).toContain(
			"REFUSED: Name the mailbox the account signs up with: one of agents@inbox.qorpera.com, ops@inbox.qorpera.com",
		);
		expect(two.text(await two.invoke(open({ mailbox: "sales@inbox.qorpera.com" })))).toContain(
			"REFUSED: sales@inbox.qorpera.com is not one of the company's mailboxes",
		);
		const chosen = await two.invoke(open({ mailbox: "OPS@inbox.qorpera.com" }));
		expect(chosen.success, JSON.stringify(chosen)).toBe(true);
		expect(two.accounts.companyAccount.mock.calls[0]![0]).toMatchObject({
			login: "ops+vercel.com@inbox.qorpera.com",
		});
		expect(none.execute).not.toHaveBeenCalled();
	});

	it("reuses the company's account on the site, and repeats its own opening", async () => {
		const other = fixture({
			accounts: [
				{
					accountId: ACCOUNT,
					site: "vercel.com",
					signInHosts: [],
					login: "team@acme.example",
					status: "connected",
				},
			],
		});
		expect(other.text(await other.invoke(open()))).toContain(
			`REFUSED: The company already has an account on vercel.com (${ACCOUNT}, connected, team@acme.example): use it.`,
		);
		expect(other.execute).not.toHaveBeenCalled();
		// Its own address: the same opening again, which its receipt answers (or the vault says it exists).
		const same = fixture({
			accounts: [
				{
					accountId: ACCOUNT,
					site: "vercel.com",
					signInHosts: [],
					login: "Agents+Vercel.com@inbox.qorpera.com",
					status: "pending",
				},
			],
		});
		expect((await same.invoke(open())).success).toBe(true);
		expect(same.execute).toHaveBeenCalledOnce();
	});

	it("records the website's answer for one account by its id", async () => {
		const f = fixture();
		const result = await f.invoke({
			action: "state",
			account: ACCOUNT.toUpperCase(),
			status: "needs_person",
			operationKey: "captcha-stop",
		});
		expect(result.success, JSON.stringify(result)).toBe(true);
		expect(f.execute.mock.calls[0]![0].operation).toMatchObject({
			logicalOperationKey: `state:${ACCOUNT}:captcha-stop`,
			arguments: { account: ACCOUNT, status: "needs_person" },
			target: { realm: "company_account", action: "state" },
		});
		expect(f.accounts.companyAccount.mock.calls[0]![0]).toEqual({
			action: "state",
			binding: f.binding,
			receiptId: f.receiptId,
			inputSha256: "a".repeat(64),
			idempotencyKey: "b".repeat(64),
			accountId: ACCOUNT,
			status: "needs_person",
		});
		expect(f.control.call).not.toHaveBeenCalled();
	});

	it("refuses malformed arguments before anything is asked", async () => {
		const f = fixture();
		for (const args of [
			{ action: "list" },
			{ action: "find", todo: "x" },
			open({ extra: true }),
			open({ site: "not a host" }),
			open({ site: "https://vercel.com" }),
			open({ todo: "Website Online" }),
			open({ purpose: " " }),
			open({ password: { length: 8 } }),
			open({ password: { symbols: "yes" } }),
			open({ password: { length: 20, dictionary: true } }),
			open({ signInHosts: ["vercel.com"] }),
			open({ signInHosts: ["a.example", "a.example"] }),
			open({ signInHosts: ["a.example", "b.example", "c.example", "d.example", "e.example"] }),
			open({ mailbox: "not an address" }),
			open({ operationKey: "has space" }),
			{ action: "state", account: "vercel", status: "closed", operationKey: "k" },
			{ action: "state", account: ACCOUNT, status: "deleted", operationKey: "k" },
			{ action: "state", account: ACCOUNT, status: "closed" },
		]) {
			const result = await f.invoke(args);
			expect(result.success, JSON.stringify(args)).toBe(false);
			expect(f.text(result), JSON.stringify(args)).toContain("INVALID_ARGUMENTS");
		}
		expect(f.control.call).not.toHaveBeenCalled();
		expect(f.execute).not.toHaveBeenCalled();
	});
});

describe("company account login", () => {
	it("tags the mailbox with the site, shortened so the part before the @ stays within 64 characters", () => {
		expect(companyAccountLogin("agents@inbox.qorpera.com", "vercel.com")).toBe("agents+vercel.com@inbox.qorpera.com");
		const long = `${"a".repeat(60)}.example.com`;
		const login = companyAccountLogin("agents@inbox.qorpera.com", long)!;
		const local = login.split("@")[0]!;
		expect(local.length).toBeLessThanOrEqual(64);
		expect(local).toMatch(/^agents\+a+-[0-9a-f]{8}$/);
		expect(companyAccountLogin("agents@inbox.qorpera.com", long)).toBe(login);
		const tight = companyAccountLogin(`${"m".repeat(60)}@inbox.qorpera.com`, "vercel.com")!;
		expect(tight).toMatch(/^m{60}\+[0-9a-f]{3}@inbox\.qorpera\.com$/);
		expect(companyAccountLogin(`${"m".repeat(63)}@inbox.qorpera.com`, "vercel.com")).toBeUndefined();
		expect(companyAccountLogin("not an address", "vercel.com")).toBeUndefined();
	});
});

describe("company_account review", () => {
	it("reads, acts outside, keeps books, or deletes for good, and says so on the card", () => {
		const tool = { name: "company_account", source: "runtime" } as const;
		expect(cloudActionEffect(tool, { action: "find" })).toBe("read");
		expect(cloudActionEffect(tool, { action: "open", site: "vercel.com" })).toBe("external");
		expect(cloudActionEffect(tool, { action: "state", status: "connected" })).toBe("internal");
		expect(cloudActionEffect(tool, { action: "state", status: "needs_person" })).toBe("internal");
		expect(cloudActionEffect(tool, { action: "state", status: "closed" })).toBe("destructive");
		const opening = describeCloudAction(tool, {
			action: "open",
			site: "vercel.com",
			purpose: "Hosting",
			todo: "web",
		});
		expect(opening).toMatchObject({ title: "Open a company account on a website", target: "vercel.com" });
		expect(opening.details.purpose).toBe("Hosting");
		const closing = describeCloudAction(tool, { action: "state", account: ACCOUNT, status: "closed" });
		expect(closing.title).toBe("Close a company account");
		expect(closing.details.effect).toContain("Deletes the company's password and authenticator");
		const fill = describeCloudAction(
			{ name: "computer_browser", source: "runtime" },
			{
				operationKey: "k",
				action: {
					kind: "browser",
					action: "vault_fill",
					role: "textbox",
					name: "Password",
					account: ACCOUNT,
					field: "password",
				},
			},
		);
		expect(fill).toMatchObject({
			title: "Type a company account's sign-in into a web page",
			target: 'textbox "Password"',
			details: { account: ACCOUNT, field: "password" },
		});
	});
});
