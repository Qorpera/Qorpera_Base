interface HostAgentProcessOptions {
	nodeExecutable: string;
	rpcEntry: string;
	args: string[];
	cwd: string;
	environment?: NodeJS.ProcessEnv;
}

export interface HostAgentProcess {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
}

function replaceEnvironmentValue(environment: NodeJS.ProcessEnv, name: string, value?: string): void {
	for (const existing of Object.keys(environment)) {
		if (existing.toLowerCase() === name.toLowerCase()) delete environment[existing];
	}
	if (value !== undefined) environment[name] = value;
}

/**
 * Launch a controller as the signed-in desktop user. The process inherits the
 * complete host environment and working directory so ordinary CLIs can use
 * the user's network, credential helpers, keychains, configuration, and
 * browser handoffs exactly as they do from the user's terminal.
 */
export function createHostAgentProcess(options: HostAgentProcessOptions): HostAgentProcess {
	const env = { ...(options.environment ?? process.env) };
	// Runtime role markers belong to the child being created, not the process
	// that happened to launch Base. startChild adds this marker back only for
	// controller-initiated work.
	replaceEnvironmentValue(env, "QORPERA_AUTONOMOUS");
	replaceEnvironmentValue(env, "ELECTRON_RUN_AS_NODE", "1");
	return {
		command: options.nodeExecutable,
		args: [options.rpcEntry, ...options.args],
		cwd: options.cwd,
		env,
	};
}
