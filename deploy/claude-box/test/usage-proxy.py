#!/usr/bin/env python3
"""Claude login usage and resets: the helper's egress as a CONNECT proxy for the stub proof. A CONNECT to a host in the
allow file (one name per line) goes to the stub on 127.0.0.1; anything else is refused with 403. Each CONNECT is one
JSON line: host and whether it passed. Nothing leaves the machine. Usage: usage-proxy.py PORT STUBPORT ALLOWFILE LOG"""
import asyncio, json, sys, time

PORT, STUB, ALLOW, LOG = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4]
T0 = time.time()


def log(rec):
    rec["t"] = round(time.time() - T0, 3)
    with open(LOG, "a") as f:
        f.write(json.dumps(rec) + "\n")


async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def serve(reader, writer):
    try:
        head = await reader.readuntil(b"\r\n\r\n")
        line = head.split(b"\r\n", 1)[0].decode("latin1")
        method, target, _ = line.split(" ", 2)
        host, _, port = target.rpartition(":")
        allowed = {h.strip() for h in open(ALLOW).read().split() if h.strip()}
        ok = method == "CONNECT" and port == "443" and host in allowed
        log({"kind": "connect", "host": host[:80], "passed": ok})
        if not ok:
            writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
            return writer.close()
        up_reader, up_writer = await asyncio.open_connection("127.0.0.1", STUB)
        writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
        await writer.drain()
        await asyncio.gather(pipe(reader, up_writer), pipe(up_reader, writer))
    except Exception:
        try:
            writer.close()
        except Exception:
            pass


async def main():
    server = await asyncio.start_server(serve, "127.0.0.1", PORT)
    print("READY", flush=True)
    async with server:
        await server.serve_forever()


asyncio.run(main())
