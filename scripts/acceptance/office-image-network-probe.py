"""Bounded IPv4 + authenticated HTTPS probe from the actual disposable guest."""
import json
import socket
import urllib.request

original = socket.getaddrinfo


def first_ipv4(host, port, family=0, socktype=0, proto=0, flags=0):
    return original(host, port, socket.AF_INET, socktype, proto, flags)[:1]


socket.getaddrinfo = first_ipv4
url = "https://archive.ubuntu.com/ubuntu/dists/resolute/InRelease"
with urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=8) as response:
    assert response.status == 200
    print(json.dumps({"url": url, "status": response.status, "ipv4": True, "tlsVerified": True}))
