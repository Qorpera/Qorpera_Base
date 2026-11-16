import { runMachineAccountFillCli } from "./cloud-machine-account-fill.ts";

const exit = (code: number) => process.stdout.write("", () => process.exit(code));
runMachineAccountFillCli({ argv: process.argv.slice(2), stdin: process.stdin, stdout: process.stdout }).then(
	exit,
	() => {
		process.stderr.write("MACHINE_ACCOUNT_FILL_FAILED\n");
		exit(1);
	},
);
