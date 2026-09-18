// noVNC raw-channel adapter for the fixed desktop IPC bridge. One read and
// one write may be pending; queued bytes are bounded in both processes.
export function createMemberDisplayChannel(request, connectionId) {
	const maximum = 256 * 1024;
	let state = 1, receiver = null, reading = false, sending = false, pendingBytes = 0, queue = [], ack = null, inFlight = null;
	const close = (failed = false) => {
		if (state === 3) return;
		state = 3;
		for (const bytes of queue) bytes.fill(0);
		inFlight?.fill(0);
		queue = []; pendingBytes = 0;
		void request({ method:"close",connectionId }).catch(() => undefined);
		queueMicrotask(() => {
			if (failed) channel.onerror?.(new Event("error"));
			channel.onclose?.({ code:failed ? 1006 : 1000,reason:"",wasClean:!failed });
		});
	};
	const read = async () => {
		if (reading || state !== 1 || !receiver) return;
		reading = true;
		try {
			while (state === 1 && receiver) {
				const reply = await request({ method:"read",connectionId,ack });
				if (state !== 1) return;
				const value = reply?.result;
				if (!reply?.ok || !value || !["open","closed"].includes(value.state) ||
					!(value.data instanceof ArrayBuffer) || value.data.byteLength > maximum || typeof value.ack !== "string" || value.ack.length !== 36) throw new Error("Display unavailable");
				ack = value.ack;
				if (value.state === "closed") { close(true); return; }
				if (value.data.byteLength) {
					if (!receiver) throw new Error("Display receiver changed");
					receiver({ data:value.data });
				}
			}
		} catch { close(true); }
		finally { reading = false; }
	};
	const send = async () => {
		if (sending || state !== 1) return;
		sending = true;
		try {
			while (state === 1 && queue.length) {
				const data = queue.shift();
				inFlight = data;
				try {
					const result = await request({ method:"send",connectionId,data });
					if (!result?.ok) throw new Error("Display input unavailable");
				} finally { if (state === 1) pendingBytes -= data.byteLength; data.fill(0); inFlight = null; }
			}
		} catch { close(true); }
		finally { sending = false; }
	};
	const channel = {
		get readyState() { return state; }, protocol:"",
		get binaryType() { return "arraybuffer"; }, set binaryType(value) { if (value !== "arraybuffer") close(true); },
		onopen:null,onerror:null,onclose:null,
		get onmessage() { return receiver; }, set onmessage(value) { receiver = value; queueMicrotask(read); },
		send(bytes) {
			if (state !== 1 || !(bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes)) ||
				bytes.byteLength < 1 || pendingBytes + bytes.byteLength > maximum || queue.length >= 1024) { close(true); return; }
			const data = bytes instanceof ArrayBuffer ? new Uint8Array(bytes).slice() : new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength).slice();
			queue.push(data); pendingBytes += data.byteLength; void send();
		},
		close:() => close(),
	};
	return channel;
}
