export interface MaintenanceGate {
	run<T>(operation: () => Promise<T>): Promise<T>;
}

export function createSerialGate(): MaintenanceGate {
	let tail: Promise<unknown> = Promise.resolve();
	return {
		async run<T>(operation: () => Promise<T>): Promise<T> {
			const next = tail.catch(() => undefined).then(operation);
			tail = next.catch(() => undefined);
			return await next;
		},
	};
}

export interface GatewayMaintenanceOptions {
	readonly probeAuthority: () => Promise<void>;
	readonly probeStore: () => Promise<void>;
	readonly recoverGc: () => Promise<void>;
	readonly reconcile: () => Promise<void>;
	readonly nasGate: MaintenanceGate;
	readonly intervalMs?: number;
	readonly onProbeError?: () => void;
	readonly onMaintainError?: () => void;
}

export function startGatewayMaintenance(options: GatewayMaintenanceOptions): {
	readonly probe: () => Promise<void>;
	readonly maintain: () => Promise<void>;
	readonly stop: () => void;
} {
	const intervalMs = options.intervalMs ?? 15_000;
	let stopped = false;
	let probingAuthority = false;
	let probingStore = false;
	let maintaining = false;

	const probeAuthority = async (): Promise<void> => {
		if (stopped || probingAuthority) return;
		probingAuthority = true;
		try {
			await options.probeAuthority();
		} catch {
			options.onProbeError?.();
		} finally {
			probingAuthority = false;
		}
	};

	const probeStore = async (): Promise<void> => {
		if (stopped || probingStore) return;
		probingStore = true;
		try {
			// WHY: Share one serial NAS gate with folderGc and reconcile NAS I/O so maintenance never takes both NAS lanes.
			await options.nasGate.run(() => options.probeStore());
		} catch {
			options.onProbeError?.();
		} finally {
			probingStore = false;
		}
	};

	const probe = async (): Promise<void> => {
		if (stopped) return;
		await Promise.all([probeAuthority(), probeStore()]);
	};

	const maintain = async (): Promise<void> => {
		if (stopped || maintaining) return;
		maintaining = true;
		try {
			// WHY: recoverGc and reconcile gate only leaf NAS calls under per-key locks so they never invert with request-path locks.
			await options.recoverGc();
			if (stopped) return;
			await options.reconcile();
		} catch {
			options.onMaintainError?.();
		} finally {
			maintaining = false;
		}
	};

	const probeTimer = setInterval(() => {
		void probe();
	}, intervalMs);
	const maintainTimer = setInterval(() => {
		void maintain();
	}, intervalMs);
	// WHY: Skip the initial post-probe maintenance pass if stop() was called while probe() was in flight.
	void probe().then(() => {
		if (!stopped) return maintain();
	});

	return {
		probe,
		maintain,
		stop: () => {
			stopped = true;
			clearInterval(probeTimer);
			clearInterval(maintainTimer);
		},
	};
}
