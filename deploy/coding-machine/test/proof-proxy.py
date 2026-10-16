"""The internet for test/prove-coding-image.sh's machines: an HTTP proxy on the test machine, for the proof's length.

  setpriv --reuid=65534 --regid=65534 --clear-groups python3 -I - <bridge-address> <bridge-network> < proof-proxy.py

A test machine's Docker drops what its LXD bridge would forward (its FORWARD chain's policy), and the proof may not
change the test machine's nft rules. So the builder and the coding machine reach the internet through this proxy on
the bridge's own address, as the test machine's own connections. It serves clients on the bridge only, and only
public addresses: CONNECT tunnels to port 443 (HTTPS, registries) and plain GET and HEAD requests to port 80 (apt),
one request per connection. It listens on a free port and prints it.
"""
import ipaddress
import socket
import socketserver
import sys
import threading
from urllib.parse import urlsplit

HOP = {"connection", "proxy-connection", "keep-alive", "proxy-authorization"}


def pipe(source, sink):
    try:
        while data := source.recv(65536):
            sink.sendall(data)
    except OSError:
        pass
    finally:
        try:
            sink.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def connect(host, port):
    """A connection to the first public address of host that answers, IPv4 first."""
    error = OSError(f"{host} has no public address")
    found = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    for family, kind, proto, _, address in sorted(found, key=lambda a: a[0] != socket.AF_INET):
        if not ipaddress.ip_address(address[0]).is_global:
            continue
        origin = socket.socket(family, kind, proto)
        origin.settimeout(30)
        try:
            origin.connect(address)
        except OSError as e:
            origin.close()
            error = e
            continue
        origin.settimeout(600)
        return origin
    raise error


class Proxy(socketserver.BaseRequestHandler):
    def handle(self):
        client = self.request
        if ipaddress.ip_address(self.client_address[0]) not in BRIDGE:
            return
        client.settimeout(600)
        head = b""
        while b"\r\n\r\n" not in head:
            data = client.recv(65536)
            if not data or len(head) > 65536:
                return
            head += data
        head, _, rest = head.partition(b"\r\n\r\n")
        line, *headers = head.decode("latin-1").split("\r\n")
        try:
            method, target, version = line.split(" ", 2)
            if method == "CONNECT":
                host, _, port = target.rpartition(":")
                if port != "443":
                    raise ValueError("CONNECT only to port 443")
                origin = connect(host.strip("[]"), 443)
                client.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
                origin.sendall(rest)
                upstream = threading.Thread(target=pipe, args=(client, origin), daemon=True)
                upstream.start()
                pipe(origin, client)
                upstream.join()
            else:
                url = urlsplit(target)
                if method not in ("GET", "HEAD") or url.scheme != "http" or not url.hostname or url.port not in (None, 80):
                    raise ValueError("only GET and HEAD of http:// URLs on port 80")
                path = (url.path or "/") + (f"?{url.query}" if url.query else "")
                kept = [h for h in headers if h.split(":", 1)[0].strip().lower() not in HOP]
                origin = connect(url.hostname, 80)
                origin.sendall("\r\n".join([f"{method} {path} {version}", *kept, "Connection: close", "", ""]).encode("latin-1"))
                pipe(origin, client)
            origin.close()
        except (OSError, ValueError) as error:
            print(f"{self.client_address[0]} {line}: {error}", file=sys.stderr, flush=True)
            try:
                client.sendall(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
            except OSError:
                pass


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True


address, network = sys.argv[1:3]
BRIDGE = ipaddress.ip_network(network, strict=False)
server = Server((address, 0), Proxy)
print(server.server_address[1], flush=True)
server.serve_forever()
