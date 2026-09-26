#!/usr/bin/env python3
"""Before synthetic identity installation: actual guest routing/TLS proof.

The host firewall must already deny forwarding. No real provider credential
exists in this guest; negative tests never contain a token or company bytes.
"""
import ipaddress
import json
import socket
import ssl
import sys
import urllib.error
import urllib.request

host, port, destination = sys.argv[1:]
assert ipaddress.ip_address(host).is_private and host.startswith("10.")
assert 1024 <= int(port) <= 65535
assert destination == "/var/tmp/qorpera-founding-network-proof.json"


def refused(address, family=socket.AF_INET):
    sock = socket.socket(family, socket.SOCK_STREAM)
    sock.settimeout(2)
    try:
        sock.connect((address, 443))
    except (OSError, TimeoutError):
        return True
    finally:
        sock.close()
    raise AssertionError("Guest external route was reachable")


assert refused("8.8.8.8")
assert refused("1.1.1.1")
assert refused("2606:4700:4700::1111", socket.AF_INET6)
assert set(row[4][0] for row in socket.getaddrinfo("chatgpt.com", 443, socket.AF_INET)) == {"93.184.215.14"}
context = ssl.create_default_context()
with socket.create_connection(("93.184.215.14", 443), timeout=3) as raw:
    with context.wrap_socket(raw, server_hostname="chatgpt.com") as tls:
        tls.sendall(b"POST /backend-api/codex/responses HTTP/1.1\r\nHost: chatgpt.com\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
        assert b" 403 " in tls.recv(512).split(b"\r\n", 1)[0]
try:
    urllib.request.urlopen(f"https://{host}:{port}/rest/v1/rpc/qorpera_set_account_entitlement", timeout=3, context=context)
except urllib.error.HTTPError as error:
    assert error.code == 403
else:
    raise AssertionError("Guest gateway accepted uncredentialed financial request")
with open(destination, "x", encoding="utf8") as output:
    json.dump({"schema": "qorpera.founding-guest-network/v1", "externalIpv4Denied": True,
               "externalIpv6Denied": True, "syntheticDnsAndTls": True, "uncredentialedBillingDenied": True}, output)
