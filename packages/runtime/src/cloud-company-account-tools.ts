import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { type JsonValue, normalizeUuid, UUID_PATTERN } from "@qorpera/contracts";
import type { CompanyAccountAnswer, CompanyAccountRequest } from "./cloud-company-account-vault.ts";
import type { CloudCompanyPathControl } from "./cloud-company-path-gateway.ts";
import {
	type CloudNativeToolBinding,
	type CloudNativeToolIdentity,
	cloudToolRequest,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContext,
	CloudToolRefusal,
} from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "./cloud-native-tool-operations.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";

/** Company accounts A1-4b: the agent's own tool for the company's website accounts. */
export const CLOUD_COMPANY_ACCOUNT_TOOL_VERSION = "qorpera.company-account-tool/v1";

/** The vault's company_account route (A1-2), as the host's broker client calls it. */
export interface CloudCompanyAccountClient {
	companyAccount(request: CompanyAccountRequest, signal: AbortSignal): Promise<CompanyAccountAnswer>;
}

const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const TODO_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** As the receipt's logical key takes it after `company_account:<action>:`. */
const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAILBOX =
	/^([a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?)@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+)$/;
/** An email address's part before the @ holds at most 64 characters. */
const LOCAL_PART = 64;

/**
 * Which way in (Jonas, 2 October 2026). A service with an official connection is reached through it, never by a
 * website sign-up, sign-in or a password ask. A site with strict bot checks and no connection is a person's task in
 * their own browser. Matched on the site and its sign-in hosts, the domain itself or any name under it.
 */
const OFFICIAL: ReadonlyArray<{ name: string; domains: readonly string[]; connected: boolean }> = [
	// The connector catalog's GitHub, Gmail and Google Drive (cloud-connector-catalog.ts).
	{ name: "GitHub", domains: ["github.com", "ghe.com"], connected: true },
	{ name: "Google", domains: ["google.com", "gmail.com", "googleapis.com", "youtube.com"], connected: true },
	// An official connection the company cannot add yet.
	{
		name: "Microsoft",
		domains: [
			"microsoft.com",
			"microsoftonline.com",
			"live.com",
			"outlook.com",
			"office.com",
			"azure.com",
			"sharepoint.com",
		],
		connected: false,
	},
	{ name: "Slack", domains: ["slack.com"], connected: false },
];
const STRICT: ReadonlyArray<{ name: string; domains: readonly string[] }> = [
	{ name: "Apple", domains: ["apple.com", "icloud.com"] },
	{ name: "LinkedIn", domains: ["linkedin.com"] },
	{ name: "X", domains: ["x.com", "twitter.com"] },
	{ name: "Meta", domains: ["facebook.com", "instagram.com", "meta.com", "threads.net"] },
	// Amazon's stores sign in on their own sites in each country; AWS is under amazon.com.
	{
		name: "Amazon",
		domains: [
			"amazon.com",
			"amazon.de",
			"amazon.co.uk",
			"amazon.se",
			"amazon.fr",
			"amazon.it",
			"amazon.es",
			"amazon.nl",
			"amazon.pl",
			"amazon.com.be",
			"amazon.ie",
		],
	},
];
/** Payment providers hold the company's money and check who signs up: a person's task too. Banks are in the words. */
const MONEY: ReadonlyArray<{ name: string; domains: readonly string[] }> = [
	{ name: "PayPal", domains: ["paypal.com"] },
	{ name: "Stripe", domains: ["stripe.com"] },
];

const under = (host: string, domains: readonly string[]) =>
	domains.some((domain) => host === domain || host.endsWith(`.${domain}`));

/** Why the agent may not open an account on these hosts itself, or undefined when it may. */
export function companyAccountWayIn(hosts: readonly string[]): string | undefined {
	const official = OFFICIAL.find((service) => hosts.some((host) => under(host, service.domains)));
	if (official)
		return official.connected
			? `${official.name} has an official connection: use it (a member connects it with the Connect card when it is not connected yet). Never sign up or sign in on its website, and never ask anyone for its password.`
			: `${official.name} is reached only through an official connection, which the company cannot add yet: tell a member what you need. Never sign up or sign in on its website, and never ask anyone for its password.`;
	const strict = STRICT.find((service) => hosts.some((host) => under(host, service.domains)));
	if (strict)
		return `${strict.name} checks for automated browsers: an account there is a person's task in their own browser. Prepare the steps and ask a member; never ask anyone for its password.`;
	const money = MONEY.find((service) => hosts.some((host) => under(host, service.domains)));
	if (money)
		return `${money.name} is a payment provider: an account there is a person's task in their own browser. Prepare the steps and ask a member; never ask anyone for its password.`;
	return undefined;
}

/** Whether two hosts are one website: the same, or one a name under the other, `www.` aside. */
export function companyAccountSameWebsite(a: string, b: string): boolean {
	const x = a.replace(/^www\./, "");
	const y = b.replace(/^www\./, "");
	return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

/**
 * The account's own address: `<mailbox>+<tag>@<mail domain>`, the tag the site (find_mail's tags, 1 to 64 of
 * [a-z0-9._-]), shortened with part of its hash when the address would pass 64 characters before the @; undefined
 * when the mailbox leaves too little room for that.
 */
export function companyAccountLogin(mailbox: string, site: string): string | undefined {
	const parts = MAILBOX.exec(mailbox);
	if (!parts) return undefined;
	const [, local, , domain] = parts as unknown as [string, string, string, string];
	// Room for at least a short site part and 8 hex characters of its hash, so two sites rarely share a login.
	const room = Math.min(64, LOCAL_PART - local.length - 1);
	if (room < 12 && site.length > room) return undefined;
	const tag =
		site.length <= room
			? site
			: `${site.slice(0, room - 9).replace(/[.-]+$/, "")}-${createHash("sha256").update(site).digest("hex").slice(0, 8)}`;
	return `${local}+${tag}@${domain}`;
}

const OPEN_KEYS = new Set(["action", "site", "signInHosts", "mailbox", "todo", "purpose", "password", "operationKey"]);
const STATE_KEYS = new Set(["action", "account", "status", "operationKey"]);

type Parsed =
	| { action: "find"; site?: string }
	| {
			action: "open";
			site: string;
			signInHosts: string[];
			mailbox?: string;
			todo: string;
			purpose: string;
			password: { length?: number; symbols?: boolean };
			operationKey: string;
	  }
	| { action: "state"; account: string; status: "connected" | "needs_person" | "closed"; operationKey: string };

function host(value: unknown): string {
	if (typeof value !== "string")
		throw new CloudToolArgumentRefusal("site is a website's host name, such as vercel.com");
	const lowered = value.trim().toLowerCase();
	if (lowered.length > 253 || !HOST.test(lowered))
		throw new CloudToolArgumentRefusal("site is a website's host name, such as vercel.com");
	return lowered;
}

function operationKey(value: unknown): string {
	if (typeof value !== "string" || !OPERATION_KEY.test(value))
		throw new CloudToolArgumentRefusal(
			"operationKey is 1 to 128 of letters, digits, dot, dash, underscore and colon",
		);
	return value;
}

/** A closed parser: what the model's schema hints say, checked again. */
export function parseCompanyAccountArguments(value: unknown): Parsed {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new CloudToolArgumentRefusal("Arguments are an object");
	const a = value as Record<string, unknown>;
	if (a.action === "find") {
		if (Object.keys(a).some((key) => key !== "action" && key !== "site"))
			throw new CloudToolArgumentRefusal("find takes only site");
		return a.site === undefined ? { action: "find" } : { action: "find", site: host(a.site) };
	}
	if (a.action === "open") {
		if (Object.keys(a).some((key) => !OPEN_KEYS.has(key)))
			throw new CloudToolArgumentRefusal(`open takes only ${[...OPEN_KEYS].slice(1).join(", ")}`);
		const site = host(a.site);
		const hosts = a.signInHosts === undefined ? [] : a.signInHosts;
		if (!Array.isArray(hosts) || hosts.length > 4)
			throw new CloudToolArgumentRefusal("signInHosts lists at most 4 host names");
		const signInHosts = hosts.map(host);
		if (new Set(signInHosts).size !== signInHosts.length || signInHosts.includes(site))
			throw new CloudToolArgumentRefusal("signInHosts are other host names than the site, each once");
		// Which way in, as the arguments are read: before any review, so no member is ever asked to approve it.
		const wayIn = companyAccountWayIn([site, ...signInHosts]);
		if (wayIn) throw new CloudToolArgumentRefusal(wayIn);
		if (a.mailbox !== undefined && (typeof a.mailbox !== "string" || !MAILBOX.test(a.mailbox.trim().toLowerCase())))
			throw new CloudToolArgumentRefusal("mailbox is one of the company's mailbox addresses");
		if (typeof a.todo !== "string" || !TODO_KEY.test(a.todo))
			throw new CloudToolArgumentRefusal("todo is the key of your open todo that needs the account");
		if (typeof a.purpose !== "string" || a.purpose.trim().length < 1 || a.purpose.trim().length > 512)
			throw new CloudToolArgumentRefusal("purpose says in up to 512 characters what the account is for");
		const policy = a.password === undefined ? {} : a.password;
		if (!policy || typeof policy !== "object" || Array.isArray(policy))
			throw new CloudToolArgumentRefusal("password is {length?, symbols?}");
		const { length, symbols, ...rest } = policy as Record<string, unknown>;
		if (
			Object.keys(rest).length > 0 ||
			(length !== undefined &&
				(!Number.isSafeInteger(length) || (length as number) < 12 || (length as number) > 64)) ||
			(symbols !== undefined && typeof symbols !== "boolean")
		)
			throw new CloudToolArgumentRefusal("password is {length: 12 to 64, symbols: true or false}");
		return {
			action: "open",
			site,
			signInHosts,
			...(a.mailbox === undefined ? {} : { mailbox: (a.mailbox as string).trim().toLowerCase() }),
			todo: a.todo,
			purpose: a.purpose.trim(),
			password: {
				...(length === undefined ? {} : { length: length as number }),
				...(symbols === undefined ? {} : { symbols: symbols as boolean }),
			},
			operationKey: operationKey(a.operationKey),
		};
	}
	if (a.action === "state") {
		if (Object.keys(a).some((key) => !STATE_KEYS.has(key)))
			throw new CloudToolArgumentRefusal("state takes only account, status and operationKey");
		const account = normalizeUuid(a.account);
		if (!account) throw new CloudToolArgumentRefusal("account is an account's id from find or open");
		if (a.status !== "connected" && a.status !== "needs_person" && a.status !== "closed")
			throw new CloudToolArgumentRefusal("status is connected, needs_person or closed");
		return {
			action: "state",
			account,
			status: a.status,
			operationKey: operationKey(a.operationKey),
		};
	}
	throw new CloudToolArgumentRefusal("action is find, open or state");
}

export const CLOUD_COMPANY_ACCOUNT_TOOL_DESCRIPTION =
	"The company's own accounts on websites, for work an open todo of yours needs. Look first: find lists the company's accounts (on one site with site) and its mailboxes; use an account that serves rather than opening another. " +
	"Which way in: a service with an official connection (GitHub, Google, Microsoft, Slack) is reached through it, never by a website sign-up or sign-in; a site with strict bot checks (Apple, LinkedIn, X, Facebook, Instagram, Amazon) and banks and payment providers (PayPal, Stripe) are a person's task in their own browser: prepare the steps and ask a member. Never ask anyone for a password. " +
	"open, before you type anything into a sign-up form, makes the account with the company's own address (one of its mailboxes with the site as a +tag: the account's login) and a password only the vault knows, for your todo (its key). Give the website's own sign-in hosts when it signs in elsewhere (accounts.example.com), and its password rules when it has them (length, symbols). " +
	"Type the login, password or an authenticator code only with computer_browser vault_fill {role, name, account, field}; never type a password yourself. Find the website's confirmation with find_mail to the account's login. " +
	"A page that shows a CAPTCHA, a bot check, an unusual activity warning or a block ends the attempt at once: never retry it; set the account needs_person and tell a member what a person must do. " +
	"state records the website's answer: connected once it accepted the account, needs_person when a step needs a person; closed deletes the company's password and authenticator for good, so close only an account the company no longer needs. " +
	"The vault's answer, the account or why it refused, is the call's result. An open or a state change with the same operationKey and arguments is the same call; a different one needs a new operationKey.";

/** The tool, for a company run (not a worker, not a folder company: their accounts come with A1-7). */
export function cloudCompanyAccountTool(options: {
	binding: CloudNativeToolBinding;
	identity: CloudNativeToolIdentity;
	control: CloudCompanyPathControl;
	operations: Pick<CloudNativeToolOperations, "execute">;
	accounts: CloudCompanyAccountClient;
}): CloudNativeTool {
	const binding = parseCloudNativeToolBinding(options.binding);
	const identity = Object.freeze({ ...options.identity });
	if (
		Object.entries(binding).some(
			([key, value]) => key !== "credentialCapsuleId" && identity[key as keyof CloudNativeToolIdentity] !== value,
		)
	)
		throw new Error("Company account binding differs");
	const check = (context: CloudToolContext) => {
		if (
			context.runId !== identity.runId ||
			context.companyId !== identity.companyId ||
			!context.identity ||
			!isDeepStrictEqual(context.identity, identity)
		)
			throw new Error("Company account context differs");
	};
	// The company's accounts and mailboxes, and the todo's id by its key; a refusal the agent can act on is answered.
	const find = async (request: Record<string, string>, signal: AbortSignal) => {
		const answer = (await cloudToolRequest(
			(requestSignal) =>
				options.control.call(
					"qorpera_find_company_accounts",
					{ p_binding: binding, p_request: request },
					requestSignal,
				),
			signal,
		)) as Record<string, JsonValue> | null;
		if (!answer || answer.schema !== "qorpera.agent-company-accounts/v1") throw new Error("Account read differs");
		const refused = answer.refused as Record<string, JsonValue> | undefined;
		if (refused) {
			if (typeof refused.message !== "string") throw new Error("Account read differs");
			throw new CloudToolRefusal(refused.message);
		}
		if (answer.runId !== binding.runId || !Array.isArray(answer.accounts) || !Array.isArray(answer.mailboxes))
			throw new Error("Account read differs");
		return answer as {
			accounts: Array<{ accountId: string; site: string; signInHosts: string[]; login: string; status: string }>;
			mailboxes: string[];
			todo?: { key: string; id: string };
			more?: boolean;
		};
	};
	const run = (
		parsed: Extract<Parsed, { action: "open" | "state" }>,
		logicalOperationKey: string,
		args: { [key: string]: JsonValue },
		request: (effect: { receiptId: string; inputSha256: string; idempotencyKey: string }) => CompanyAccountRequest,
		context: CloudToolContext,
	) =>
		options.operations.execute({
			operation: {
				tool: "company_account" satisfies CloudRuntimeToolOperation,
				toolVersion: CLOUD_COMPANY_ACCOUNT_TOOL_VERSION,
				logicalOperationKey,
				arguments: args,
				target: { realm: "company_account", action: parsed.action },
				requiresCompanyRevision: false,
			},
			authorize: async (_operation, admitted) => {
				if (!isDeepStrictEqual(admitted, identity)) throw new Error("Company account identity changed");
			},
			// The vault checks the run, the receipt and the company's rules, and answers the account or its refusal.
			perform: async (_operation, effect) => ({
				content: {
					kind: "json",
					value: (await options.accounts.companyAccount(request(effect), effect.signal)) as unknown as JsonValue,
				},
			}),
			signal: context.signal,
			observation: context.observation,
		});
	return {
		name: "company_account" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_COMPANY_ACCOUNT_TOOL_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["action"],
			properties: {
				action: { enum: ["find", "open", "state"] },
				site: { type: "string", maxLength: 253, description: "A website's host name, such as vercel.com." },
				signInHosts: { type: "array", maxItems: 4, items: { type: "string", maxLength: 253 } },
				mailbox: {
					type: "string",
					maxLength: 320,
					description: "One of the company's mailboxes, as find lists it.",
				},
				todo: { type: "string", pattern: TODO_KEY.source, description: "The key of your open todo." },
				purpose: { type: "string", maxLength: 512 },
				password: {
					type: "object",
					additionalProperties: false,
					properties: { length: { type: "integer", minimum: 12, maximum: 64 }, symbols: { type: "boolean" } },
				},
				account: { type: "string", pattern: UUID_PATTERN.source },
				status: { enum: ["connected", "needs_person", "closed"] },
				operationKey: { type: "string", pattern: OPERATION_KEY.source },
			},
		},
		parseArguments: (value) => parseCompanyAccountArguments(value) as unknown as JsonValue,
		async execute(value, context) {
			check(context);
			const parsed = parseCompanyAccountArguments(value);
			if (parsed.action === "find") {
				const found = await find(parsed.site ? { site: parsed.site } : {}, context.signal);
				return {
					kind: "json",
					value: {
						accounts: found.accounts,
						mailboxes: found.mailboxes,
						...(found.more ? { more: true } : {}),
					} as unknown as JsonValue,
				};
			}
			if (parsed.action === "state")
				return run(
					parsed,
					`state:${parsed.account}:${parsed.operationKey}`,
					{ account: parsed.account, status: parsed.status },
					(effect) => ({
						action: "state",
						binding,
						receiptId: effect.receiptId,
						inputSha256: effect.inputSha256,
						idempotencyKey: effect.idempotencyKey,
						accountId: parsed.account,
						status: parsed.status,
					}),
					context,
				);
			const found = await find({ todo: parsed.todo, site: parsed.site }, context.signal);
			if (!found.todo) throw new Error("Account read differs");
			if (found.mailboxes.length === 0)
				throw new CloudToolRefusal(
					"The company has no mailbox: an account signs up with one. Ask an owner to add a mailbox.",
				);
			const mailbox = parsed.mailbox ?? (found.mailboxes.length === 1 ? found.mailboxes[0] : undefined);
			if (!mailbox)
				throw new CloudToolRefusal(
					`Name the mailbox the account signs up with: one of ${found.mailboxes.join(", ")}`,
				);
			if (!found.mailboxes.includes(mailbox))
				throw new CloudToolRefusal(
					`${mailbox} is not one of the company's mailboxes: ${found.mailboxes.join(", ")}`,
				);
			const login = companyAccountLogin(mailbox, parsed.site);
			if (!login) throw new CloudToolRefusal(`${mailbox} is too long to carry a +tag: name another mailbox`);
			// Reuse first: an account on this website (its own host, a name under it or above it, its sign-in hosts) under
			// another address serves; one under this address is the same opening repeated, or the vault answers that it
			// exists. The company's newest accounts are looked at too, for one on a name above or under the site.
			const newest = await find({}, context.signal);
			const other = [...found.accounts, ...newest.accounts].find(
				(account) =>
					account.login.toLowerCase() !== login &&
					[account.site, ...account.signInHosts].some((known) => companyAccountSameWebsite(known, parsed.site)),
			);
			if (other)
				throw new CloudToolRefusal(
					`The company already has an account on this website, on ${other.site} (${other.accountId}, ${other.status}, ${other.login}): use it.`,
				);
			const todoId = found.todo.id;
			return run(
				parsed,
				`open:${parsed.operationKey}`,
				{
					site: parsed.site,
					signInHosts: parsed.signInHosts,
					login,
					purpose: parsed.purpose,
					todo: todoId,
					password: parsed.password,
				},
				(effect) => ({
					action: "open",
					binding,
					receiptId: effect.receiptId,
					inputSha256: effect.inputSha256,
					idempotencyKey: effect.idempotencyKey,
					site: parsed.site,
					signInHosts: parsed.signInHosts,
					login,
					purpose: parsed.purpose,
					todoId,
					password: parsed.password,
				}),
				context,
			);
		},
	};
}
