#!/usr/bin/env python3
"""
setup-secrets.py — Register VibeCode TWS API keys as GitHub Codespaces user secrets.

Usage:
    python3 scripts/setup-secrets.py

Requirements:
    pip install PyNaCl requests

The script will prompt for each API key interactively (input is hidden).
Secrets are stored as user-level Codespaces secrets scoped to this repository,
so they are injected automatically as environment variables in every Codespace
opened on VibeCode_TWS:
    OPENAI_API_KEY
    ANTHROPIC_API_KEY
    GOOGLE_API_KEY

You only need to run this once per machine / PAT token.
"""

import os
import sys
import json
import base64
import getpass

try:
    import requests
    from nacl import encoding, public
except ImportError:
    print("Installing dependencies…")
    os.system(f"{sys.executable} -m pip install PyNaCl requests -q")
    import requests
    from nacl import encoding, public

GITHUB_API = "https://api.github.com"
REPO = "Jerrycyborg/VibeCode_TWS"

SECRETS = [
    {
        "env_var": "OPENAI_API_KEY",
        "label": "OpenAI API Key",
        "hint": "sk-...",
        "providers": ["GPT-4o", "GPT-4 Turbo", "GPT-3.5 Turbo"],
    },
    {
        "env_var": "ANTHROPIC_API_KEY",
        "label": "Anthropic API Key",
        "hint": "sk-ant-...",
        "providers": ["Claude 3.5 Sonnet", "Claude 3 Haiku"],
    },
    {
        "env_var": "GOOGLE_API_KEY",
        "label": "Google AI API Key",
        "hint": "AIza...",
        "providers": ["Gemini 1.5 Pro", "Gemini 1.5 Flash"],
    },
]


def encrypt_secret(public_key_b64: str, secret_value: str) -> str:
    """Encrypt a secret using the repo's public key (libsodium sealed box)."""
    public_key_bytes = base64.b64decode(public_key_b64)
    pk = public.PublicKey(public_key_bytes, encoding.RawEncoder)
    sealed_box = public.SealedBox(pk)
    encrypted = sealed_box.encrypt(secret_value.encode("utf-8"))
    return base64.b64encode(encrypted).decode("utf-8")


def get_public_key(token: str) -> dict:
    r = requests.get(
        f"{GITHUB_API}/user/codespaces/secrets/public-key",
        headers={"Authorization": f"token {token}", "Accept": "application/vnd.github+json"},
    )
    r.raise_for_status()
    return r.json()


def get_repo_id(token: str, repo: str) -> int:
    r = requests.get(
        f"{GITHUB_API}/repos/{repo}",
        headers={"Authorization": f"token {token}", "Accept": "application/vnd.github+json"},
    )
    r.raise_for_status()
    return r.json()["id"]


def set_secret(token: str, name: str, encrypted_value: str, key_id: str, repo_id: int):
    """Create or update a user Codespaces secret scoped to this repo."""
    payload = {
        "encrypted_value": encrypted_value,
        "key_id": key_id,
        "selected_repository_ids": [repo_id],
        "visibility": "selected",
    }
    r = requests.put(
        f"{GITHUB_API}/user/codespaces/secrets/{name}",
        headers={
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
        },
        data=json.dumps(payload),
    )
    r.raise_for_status()
    return r.status_code  # 201 created, 204 updated


def main():
    print("=" * 55)
    print("  VibeCode TWS — Codespaces Secrets Setup")
    print("=" * 55)
    print()
    print("This script stores your AI API keys as GitHub Codespaces")
    print(f"user secrets scoped to {REPO}.")
    print("They will be auto-injected as env vars in every Codespace.")
    print()

    token = os.environ.get("GITHUB_TOKEN") or getpass.getpass(
        "GitHub PAT (needs codespace:secrets scope): "
    )

    try:
        pk_data = get_public_key(token)
        repo_id = get_repo_id(token, REPO)
    except requests.HTTPError as e:
        print(f"\n❌ GitHub API error: {e}")
        print("Make sure your token has 'codespace:secrets' scope.")
        sys.exit(1)

    print(f"✅ Authenticated  |  Repo ID: {repo_id}\n")

    skipped = 0
    saved = 0

    for secret in SECRETS:
        providers_str = ", ".join(secret["providers"])
        print(f"─── {secret['label']} ───")
        print(f"    Used for: {providers_str}")
        print(f"    Env var:  {secret['env_var']}")
        value = getpass.getpass(f"    Value ({secret['hint']}) — leave blank to skip: ")

        if not value.strip():
            print("    ⏭  Skipped\n")
            skipped += 1
            continue

        encrypted = encrypt_secret(pk_data["key"], value.strip())
        try:
            status = set_secret(token, secret["env_var"], encrypted, pk_data["key_id"], repo_id)
            action = "Created" if status == 201 else "Updated"
            print(f"    ✅ {action}: {secret['env_var']}\n")
            saved += 1
        except requests.HTTPError as e:
            print(f"    ❌ Failed: {e}\n")

    print("=" * 55)
    print(f"  Done — {saved} secret(s) saved, {skipped} skipped")
    print()
    print("  Open or restart your Codespace to pick up the new")
    print("  secrets. VibeCode will use them automatically.")
    print("=" * 55)


if __name__ == "__main__":
    main()
