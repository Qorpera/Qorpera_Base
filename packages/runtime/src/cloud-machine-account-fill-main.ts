import { runMachineAccountFillCli } from "./cloud-machine-account-fill.ts";

/* fill_company_account's helper as a program (20260930781000): scripts/package-machine-guest.mjs bundles this entry alone
 * as /opt/qorpera-machine/cloud-machine-account-fill.mjs, and the coding executor runs it on a company machine. Nothing
 * imports it: loading it runs the helper. The exchange is on stdin and stdout (cloud-machine-account-fill.ts); each line
 * it prints is the key's public half or a code. It exits once its answer is written, whatever is still open (a browser
 * that stopped answering); a failure prints a fixed word on stderr and exits 1. */
const exit = (code: number) => process.stdout.write("", () => process.exit(code));
runMachineAccountFillCli({ argv: process.argv.slice(2), stdin: process.stdin, stdout: process.stdout }).then(
	exit,
	() => {
		process.stderr.write("MACHINE_ACCOUNT_FILL_FAILED\n");
		exit(1);
	},
);
