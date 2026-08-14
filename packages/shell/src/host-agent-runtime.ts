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
	delete env.QORPERA_AUTONOMOUS;
	env.ELECTRON_RUN_AS_NODE = "1";
	return {
		command: options.nodeExecutable,
		args: [options.rpcEntry, ...options.args],
		cwd: options.cwd,
		env,
	};
}
