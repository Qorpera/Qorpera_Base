import assert from "node:assert/strict";
import test from "node:test";
import { foundingNetworkScope } from "./founding-payment-scope.mjs";

test("external payment resources cannot remain enabled during ordinary company setup", async () => {
	const scope = foundingNetworkScope("https://127.0.0.1:4312");
	assert(scope.allows("https://127.0.0.1:4312/rest/v1/rpc/member"));
	assert(!scope.allows("https://checkout.stripe.com/c/pay/test"));
	await scope.pay(async () => {
		assert(scope.allows("https://checkout.stripe.com/c/pay/test"));
		assert(scope.allows("https://js.stripe.com/resource"));
		assert(!scope.allows("http://checkout.stripe.com/insecure"));
		assert(!scope.allows("file:///tmp/private"));
		await assert.rejects(
			scope.pay(async () => {}),
			/only once/,
		);
	});
	assert(!scope.allows("https://checkout.stripe.com/c/pay/test"));
	await assert.rejects(
		scope.pay(async () => {}),
		/only once/,
	);
});

test("a failed payment also closes external network authority", async () => {
	const scope = foundingNetworkScope("https://127.0.0.1:4312");
	await assert.rejects(
		scope.pay(async () => {
			throw new Error("Provider unavailable");
		}),
		/Provider unavailable/,
	);
	assert(!scope.allows("https://api.stripe.com"));
	assert(scope.allows("https://127.0.0.1:4312"));
});
