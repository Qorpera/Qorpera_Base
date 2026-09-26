/** Cleanup errors must never let the outer acceptance harness delete the
 * accounting database. Its close handle memoizes this first retention choice.
 * Retain before diagnostic I/O; a full disk cannot turn uncertainty into proof.
 */
export async function closeFoundingNativeCustody({ stages, preserve, diagnostics }) {
	const failures = [];
	let retained = false;
	for (const stage of stages) {
		try {
			await stage();
		} catch (error) {
			failures.push(error);
			if (!retained) {
				retained = true;
				try {
					await preserve();
				} catch (retentionError) {
					failures.push(retentionError);
				}
			}
		}
	}
	if (!failures.length) return;
	for (const diagnostic of diagnostics) {
		try {
			await diagnostic();
		} catch (error) {
			failures.push(error);
		}
	}
	throw new AggregateError(
		failures,
		"Native physical closure unconfirmed; private accounting custody retained",
	);
}
