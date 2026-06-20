#!/usr/bin/env python3
"""Ollama MCP Server - lets Claude delegate tasks to a local Ollama model."""

import httpx
from mcp.server.fastmcp import FastMCP

OLLAMA_BASE_URL = "http://192.168.50.100:11434"
DEFAULT_TIMEOUT = 120

mcp = FastMCP("ollama")


@mcp.tool()
async def ollama_list_models() -> str:
    """List all models currently available on the local Ollama server."""
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            r = await client.get(f"{OLLAMA_BASE_URL}/api/tags")
            r.raise_for_status()
            models = [m["name"] for m in r.json().get("models", [])]
            return "\n".join(models) if models else "No models found on Ollama server."
        except httpx.ConnectError:
            return f"Could not connect to Ollama at {OLLAMA_BASE_URL}. Is it running?"


@mcp.tool()
async def ollama_generate(prompt: str, model: str = "", system: str = "") -> str:
    """
    Send a prompt to the local Ollama model and return its response.

    Args:
        prompt: The user prompt / question.
        model:  Ollama model name (e.g. "qwen3-coder:latest"). Leave blank to auto-select.
        system: Optional system prompt.
    """
    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
        if not model:
            try:
                r = await client.get(f"{OLLAMA_BASE_URL}/api/tags")
                r.raise_for_status()
                models = r.json().get("models", [])
                if not models:
                    return "Error: No models loaded on Ollama server."
                model = models[0]["name"]
            except httpx.ConnectError:
                return f"Could not connect to Ollama at {OLLAMA_BASE_URL}."

        payload: dict = {"model": model, "prompt": prompt, "stream": False}
        if system:
            payload["system"] = system

        try:
            r = await client.post(f"{OLLAMA_BASE_URL}/api/generate", json=payload)
            r.raise_for_status()
            return f"[{model}]\n\n{r.json().get('response', '').strip()}"
        except httpx.ConnectError:
            return f"Could not connect to Ollama at {OLLAMA_BASE_URL}."


if __name__ == "__main__":
    mcp.run()
