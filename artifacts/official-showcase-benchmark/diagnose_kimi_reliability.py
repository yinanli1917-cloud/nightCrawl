#!/usr/bin/env python3
import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent
API = "http://127.0.0.1:10086/command"
CHROME_PROFILE = Path.home() / "Library/Application Support/Google/Chrome/Default"
KIMI_ID = "fldmhceldgbpfpkbgopacenieobmligc"


def post(action, args=None, session="diag", timeout=20):
    payload = {"action": action, "args": args or {}, "session": session}
    req = urllib.request.Request(API, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}, method="POST")
    start = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return {"ok": True, "duration_ms": round((time.perf_counter() - start) * 1000, 1), "response": json.loads(raw)}
    except Exception as exc:
        return {"ok": False, "duration_ms": round((time.perf_counter() - start) * 1000, 1), "error": repr(exc)}


def cmd(command, timeout=30):
    start = time.perf_counter()
    proc = subprocess.run(command, shell=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    return {
        "command": command,
        "duration_ms": round((time.perf_counter() - start) * 1000, 1),
        "exit_code": proc.returncode,
        "stdout": proc.stdout.strip(),
        "stderr": proc.stderr.strip(),
    }


def read_json(path):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return None


def extension_manifest(ext_id, ext_settings):
    path = ext_settings.get("path")
    if path:
        manifest_path = CHROME_PROFILE / "Extensions" / ext_id / path / "manifest.json"
    else:
        ext_dir = CHROME_PROFILE / "Extensions" / ext_id
        versions = sorted([p for p in ext_dir.iterdir() if p.is_dir()], reverse=True) if ext_dir.exists() else []
        manifest_path = versions[0] / "manifest.json" if versions else None
    manifest = read_json(manifest_path) if manifest_path else None
    return manifest_path, manifest


def inspect_extensions():
    prefs = read_json(CHROME_PROFILE / "Preferences") or {}
    settings = prefs.get("extensions", {}).get("settings", {})
    rows = []
    for ext_id, ext in settings.items():
        if not isinstance(ext, dict):
            continue
        manifest_path, manifest = extension_manifest(ext_id, ext)
        if not manifest:
            continue
        perms = manifest.get("permissions", []) or []
        host_perms = manifest.get("host_permissions", []) or []
        content_scripts = manifest.get("content_scripts", []) or []
        script_matches = []
        for script in content_scripts:
            script_matches.extend(script.get("matches", []) or [])
        enabled = ext.get("state") == 1
        name = manifest.get("name", "")
        risk = []
        joined = " ".join([name, ext_id, " ".join(perms), " ".join(host_perms), " ".join(script_matches)]).lower()
        if enabled and ext_id != KIMI_ID:
            if "debugger" in perms:
                risk.append("debugger_permission")
            if "<all_urls>" in host_perms or "<all_urls>" in script_matches:
                risk.append("all_urls")
            if any(x in joined for x in ["scrap", "screen", "record", "assistant", "ai", "copilot", "helper", "developer"]):
                risk.append("matches_kimi_conflict_categories")
            if any(x in perms for x in ["tabs", "scripting", "webRequest", "declarativeNetRequest", "activeTab"]):
                risk.append("browser_control_surface")
        rows.append({
            "id": ext_id,
            "enabled": enabled,
            "is_kimi": ext_id == KIMI_ID,
            "name": name,
            "version": manifest.get("version"),
            "permissions": perms,
            "host_permissions": host_perms,
            "content_script_matches": sorted(set(script_matches))[:20],
            "risk_flags": sorted(set(risk)),
            "manifest_path": str(manifest_path) if manifest_path else None,
        })
    return rows


def main():
    started = time.strftime("%Y-%m-%dT%H-%M-%S")
    result = {"started_at": started}
    result["pre_status"] = cmd("~/.kimi-webbridge/bin/kimi-webbridge status")
    result["restart"] = cmd("~/.kimi-webbridge/bin/kimi-webbridge restart >/tmp/kimi-diag-restart.log 2>&1; sleep 8; ~/.kimi-webbridge/bin/kimi-webbridge status", timeout=25)
    result["extensions"] = inspect_extensions()
    session = f"kimi-diag-{int(time.time())}"
    steps = []
    steps.append({"name": "navigate_example", **post("navigate", {"url": "https://example.com/", "newTab": True, "group_title": "Kimi diag"}, session=session, timeout=25)})
    for delay in [0, 2, 6, 12]:
        if delay:
            time.sleep(delay)
        steps.append({"name": f"evaluate_after_{delay}s", **post("evaluate", {"code": "(() => ({url: location.href, title: document.title, text: document.body.innerText.slice(0,120)}))()"}, session=session, timeout=15)})
    steps.append({"name": "snapshot", **post("snapshot", {}, session=session, timeout=20)})
    steps.append({"name": "list_tabs", **post("list_tabs", {}, session=session, timeout=10)})
    steps.append({"name": "close_session", **post("close_session", {}, session=session, timeout=10)})
    result["probe_session"] = session
    result["probe_steps"] = steps
    result["recent_log_tail"] = cmd("tail -n 160 ~/.kimi-webbridge/logs/daemon.log", timeout=10)["stdout"]

    out = ROOT / f"kimi-reliability-diagnosis-{started}.json"
    out.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(out)


if __name__ == "__main__":
    main()
