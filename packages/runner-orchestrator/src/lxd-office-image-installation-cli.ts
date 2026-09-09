#!/usr/bin/env node
import { inspectOfficeImageDependencies, installOfficeImage } from "./lxd-office-image-installation-host.ts";

const [stage, flag, spec, ...extra] = process.argv.slice(2);
const report = (error: unknown) => {
	console.error(
		error instanceof Error && /^OFFICE_(?:IMAGE|INSTALL)_[A-Z_]+$/.test(error.message)
			? error.message
			: "OFFICE_IMAGE_UNCONFIRMED",
	);
	process.exitCode = 1;
};
if (stage === "--measure-dependencies" && process.argv.length === 3)
	void inspectOfficeImageDependencies()
		.then((value) => console.log(JSON.stringify(value)))
		.catch(report);
else if (["--check", "--apply", "--locked"].includes(stage ?? "") && flag === "--spec" && spec && !extra.length)
	void installOfficeImage(stage as "--check" | "--apply" | "--locked", spec).catch(report);
else {
	console.error("OFFICE_IMAGE_ARGUMENTS_INVALID");
	process.exitCode = 2;
}
