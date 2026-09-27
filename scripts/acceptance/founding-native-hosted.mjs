import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { runFoundingBrowser } from "./founding-browser.mjs";
import { prepareHostedFoundingScenario, protectedStripeTestKey } from "./founding-stripe-hosted.mjs";

export function foundingNativeJoinedOptions(args) {
	const options = {};
	for (let index = 0; index < args.length; index += 2) {
		const field = { "--host": "host", "--stripe-cli": "stripeCli", "--stripe-key": "stripeKey" }[args[index]];
		const value = args[index + 1];
		assert(
			field &&
				options[field] === undefined &&
				typeof value === "string" &&
				isAbsolute(value) &&
				resolve(value) === value &&
				value !== "/" &&
				!/[\x00-\x20\x7f'\\]/.test(value),
			"Exact joined acceptance paths required",
		);
		options[field] = value;
	}
	assert(options.host, "Require --host");
	assert(
		Boolean(options.stripeCli) === Boolean(options.stripeKey),
		"Hosted payment requires both --stripe-cli and --stripe-key",
	);
	return options;
}

/** Call only after host preflight. Validation never contacts Stripe. */
export async function readFoundingNativePayment(options) {
	if (!options.stripeKey && !options.stripeCli) return undefined;
	assert(options.stripeKey && options.stripeCli, "Explicit paired Stripe paths required");
	const secret = await protectedStripeTestKey(options.stripeKey);
	const executable = await lstat(options.stripeCli);
	assert(
		executable.isFile() && !executable.isSymbolicLink() && (executable.mode & 0o022) === 0,
		"Protected Stripe CLI required",
	);
	assert.equal(await realpath(options.stripeCli), options.stripeCli);
	const version = await promisify(execFile)(options.stripeCli, ["--version"], {
		encoding: "utf8",
		timeout: 10000,
		maxBuffer: 2048,
		env: { PATH: process.env.PATH },
	});
	assert.equal(version.stdout.trim(), "stripe version 1.52.0", "Reviewed Stripe CLI version required");
	return { secret, stripeCli: options.stripeCli };
}

/** One browser flow and one bootstrap store. Native custody owns bootstrap
 * shutdown; the hosted child owns its test subscriptions and webhook listener.
 * Dependency parameters are confined to this isolated acceptance composition. */
export async function prepareFoundingNativeBrowser(
	{ platform, bootstrap, modelAccountSetup, afterMaterialized, payment },
	{ prepareHosted = prepareHostedFoundingScenario, runBrowser = runFoundingBrowser } = {},
) {
	assert(bootstrap && typeof bootstrap.nativeHandler === "function" && typeof bootstrap.close === "function");
	assert(typeof modelAccountSetup === "function" && typeof afterMaterialized === "function");
	const shared = { bootstrap, modelAccountSetup, afterMaterialized };
	if (!payment)
		return {
			close: async () => {},
			runBrowser: (options) => runBrowser({ ...options, ...shared }),
		};
	assert(/^sk_test_[A-Za-z0-9]+$/.test(payment.secret), "Only Stripe test mode is allowed");
	return prepareHosted(platform, {
		...payment,
		out: platform.out,
		...shared,
		bootstrap: { ...bootstrap, close: async () => {} },
	});
}
