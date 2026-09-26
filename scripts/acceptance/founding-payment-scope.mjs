import assert from "node:assert/strict";

/** The hosted payment stage may load Stripe's cross-origin UI dependencies.
 * Auth, company setup and runtime proof remain local before and after it. */
export function foundingNetworkScope(origin) {
	assert.equal(new URL(origin).origin, origin);
	let payment = false,
		used = false;
	return {
		allows(value) {
			const url = new URL(value);
			return (
				url.origin === origin || ["data:", "blob:"].includes(url.protocol) || (payment && url.protocol === "https:")
			);
		},
		async pay(use) {
			assert(!used && !payment, "Hosted payment stage may run only once");
			used = true;
			payment = true;
			try {
				return await use();
			} finally {
				payment = false;
			}
		},
	};
}
