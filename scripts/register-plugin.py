#!/usr/bin/env python3
"""Add or remove this plugin's absolute path in ~/.config/opencode/opencode.json's
"plugin" array. Uses real JSON parsing (not sed) because opencode.json is an
arbitrary user-owned file, not a template this repo controls."""
import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in ("add", "remove"):
        print("uso: register-plugin.py <add|remove> <caminho-absoluto-do-index.js>", file=sys.stderr)
        return 1

    action, entry = sys.argv[1], sys.argv[2]
    config_path = Path.home() / ".config" / "opencode" / "opencode.json"
    config_path.parent.mkdir(parents=True, exist_ok=True)

    if config_path.exists():
        data = json.loads(config_path.read_text())
    else:
        data = {"$schema": "https://opencode.ai/config.json"}

    plugins = data.get("plugin")
    if not isinstance(plugins, list):
        plugins = []

    changed = False
    if action == "add":
        if entry in plugins:
            print(f"ja registrado em {config_path}: {entry}")
        else:
            plugins.append(entry)
            changed = True
    else:
        if entry in plugins:
            plugins.remove(entry)
            changed = True
        else:
            print(f"nao estava registrado em {config_path}: {entry}")

    if changed:
        data["plugin"] = plugins
        config_path.write_text(json.dumps(data, indent=2) + "\n")
        verb = "adicionado a" if action == "add" else "removido de"
        print(f"{entry} {verb} {config_path} (plugin: {plugins})")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
