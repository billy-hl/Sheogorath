#!/usr/bin/env python3
"""SSH MCP Server - gives Claude shell access to Leviathan (192.168.50.100)."""

import os
import paramiko
from mcp.server.fastmcp import FastMCP

SSH_HOST = "192.168.50.100"
SSH_PORT = 22
SSH_USER = "allisteras"
SSH_KEY_PATHS = [
    os.path.expanduser("~/.ssh/id_ed25519"),
    os.path.expanduser("~/.ssh/id_rsa"),
    os.path.expanduser("~/.ssh/id_ecdsa"),
]

mcp = FastMCP("ssh-leviathan")


def _get_client() -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    key = None
    for path in SSH_KEY_PATHS:
        if os.path.exists(path):
            try:
                key = paramiko.Ed25519Key.from_private_key_file(path)
                break
            except Exception:
                try:
                    key = paramiko.RSAKey.from_private_key_file(path)
                    break
                except Exception:
                    try:
                        key = paramiko.ECDSAKey.from_private_key_file(path)
                        break
                    except Exception:
                        continue

    if key is None:
        raise RuntimeError(f"No usable SSH key found. Tried: {SSH_KEY_PATHS}")

    client.connect(SSH_HOST, port=SSH_PORT, username=SSH_USER, pkey=key, timeout=10)
    return client


@mcp.tool()
def ssh_run(command: str) -> str:
    """
    Run a shell command on Leviathan (192.168.50.100) as allisteras.

    Args:
        command: The shell command to run (e.g. "systemctl status ollama")
    """
    try:
        client = _get_client()
        stdin, stdout, stderr = client.exec_command(command, timeout=60)
        out = stdout.read().decode("utf-8", errors="replace").strip()
        err = stderr.read().decode("utf-8", errors="replace").strip()
        exit_code = stdout.channel.recv_exit_status()
        client.close()

        parts = []
        if out:
            parts.append(out)
        if err:
            parts.append(f"[stderr]\n{err}")
        if exit_code != 0:
            parts.append(f"[exit code: {exit_code}]")
        return "\n".join(parts) if parts else "(no output)"
    except Exception as e:
        return f"SSH error: {e}"


@mcp.tool()
def ssh_read_file(path: str) -> str:
    """Read a file from Leviathan. Args: path: absolute path (e.g. '/etc/hosts')"""
    return ssh_run(f"cat {path}")


@mcp.tool()
def ssh_write_file(path: str, content: str) -> str:
    """Write content to a file on Leviathan via SFTP."""
    try:
        client = _get_client()
        sftp = client.open_sftp()
        with sftp.open(path, "w") as f:
            f.write(content)
        sftp.close()
        client.close()
        return f"Written to {path}"
    except Exception as e:
        return f"SSH write error: {e}"


if __name__ == "__main__":
    mcp.run()
