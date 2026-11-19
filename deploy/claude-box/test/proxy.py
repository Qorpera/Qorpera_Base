#!/usr/bin/env python3
"""C2i proof: the test VM's nested VMs reach no network of their own, and the image's recipe fetches Ubuntu's packages
and npm's (apt-get, npm ci, Claude Code's tarball). This is an HTTP proxy on the test VM's LXD bridge for those hosts
alone: CONNECT for HTTPS, absolute-URI requests for plain HTTP. Usage: proxy.py LISTEN_HOST PORT (prints READY)."""
import asyncio, sys

ALLOWED = {"archive.ubuntu.com", "security.ubuntu.com", "registry.npmjs.org"}


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
        line, _, rest = head.partition(b"\r\n")
        method, target, version = line.decode("latin1").split(" ", 2)
        if method == "CONNECT":
            host, _, port = target.rpartition(":")
            port = int(port)
            prefix = b""
        else:
            if not target.startswith("http://"):
                raise ValueError("not a proxy request")
            authority, _, path = target[len("http://"):].partition("/")
            host, _, port = authority.partition(":")
            port = int(port or 80)
            prefix = f"{method} /{path} {version}\r\n".encode("latin1") + rest
        if host not in ALLOWED or port not in (80, 443):
            writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
            print(f"refused {host}:{port}", flush=True)
            return writer.close()
        up_reader, up_writer = await asyncio.open_connection(host, port)
        if method == "CONNECT":
            writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            await writer.drain()
        else:
            up_writer.write(prefix)
            await up_writer.drain()
        await asyncio.gather(pipe(reader, up_writer), pipe(up_reader, writer))
    except Exception as error:
        print(f"error {error!r}", flush=True)
        try:
            writer.close()
        except Exception:
            pass


async def main():
    server = await asyncio.start_server(serve, sys.argv[1], int(sys.argv[2]))
    print("READY", flush=True)
    async with server:
        await server.serve_forever()


asyncio.run(main())
