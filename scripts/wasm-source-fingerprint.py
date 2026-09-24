#!/usr/bin/env python3
"""Fingerprint committed engine inputs without frontend consumer directories."""

import hashlib
import subprocess


CONSUMERS = {
    b"rau-credits",
    b"rhwp-agent",
    b"rhwp-chrome",
    b"rhwp-firefox",
    b"rhwp-safari",
    b"rhwp-shared",
    b"rhwp-studio",
    b"rhwp-vscode",
}

tree = subprocess.check_output(["git", "ls-tree", "-z", "HEAD:rhwp"])
entries = (
    entry
    for entry in tree.split(b"\0")
    if entry and entry.split(b"\t", 1)[1] not in CONSUMERS
)
digest = hashlib.sha256()
for entry in entries:
    digest.update(entry + b"\0")
print(digest.hexdigest())
