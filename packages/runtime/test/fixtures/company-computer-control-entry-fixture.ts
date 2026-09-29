import { runCompanyComputerControlEntry } from "../../src/cloud-company-computer-control-entry.ts";

/** Synthetic office control: each scenario fails or succeeds in one of the
 * ways real protected work can, after trying every in-process output path. */
const secret = "protected-request-and-credential-bytes";
function noise() {
	console.log(secret);
	console.info(secret);
	console.warn(secret);
	console.error(secret);
	console.debug(secret);
	console.trace(secret);
	process.stdout.write(secret);
	process.stderr.write(secret);
	process.emitWarning(secret);
}
const scenarios: Record<string, () => Promise<void>> = {
	"noisy-success": async () => noise(),
	"awaited-write": () => new Promise<void>((done) => process.stdout.write(secret, () => done())),
	"noisy-refusal": async () => {
		noise();
		throw new Error(secret);
	},
	"synchronous-throw": () => {
		throw new Error(secret);
	},
	"uncaught-exception": () => {
		setImmediate(() => {
			throw new Error(secret);
		});
		return new Promise<void>(() => {});
	},
	"uncaught-after-success": async () => {
		setTimeout(() => {
			throw new Error(secret);
		}, 20);
	},
	"unhandled-rejection": async () => {
		Promise.reject(new Error(secret));
	},
	"refusal-then-uncaught": async () => {
		setTimeout(() => {
			throw new Error(secret);
		}, 20);
		throw new Error(secret);
	},
};

runCompanyComputerControlEntry({
	moduleUrl: import.meta.url,
	names: ["company-computer-control-entry-fixture.ts", "qorpera-company-computer-fixture-control.mjs"],
	help: "Fixture office control.",
	failure: "Fixture office control could not confirm its request.",
	run: (args) => {
		const scenario = scenarios[args[0] ?? ""];
		if (!scenario || args.length !== 1) throw new Error(secret);
		return scenario();
	},
});
