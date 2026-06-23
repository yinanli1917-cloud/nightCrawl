#!/usr/bin/env python3
import json
import os
import shutil
import subprocess
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[1]
BROWSER_DIR = REPO / "stealth" / "browser"
MAIN_URL = "http://127.0.0.1:8876/main.html"
UPLOAD_FILE = str(ROOT / "upload-fixture.txt")


def build_env():
    env = os.environ.copy()
    env["PATH"] = f"{Path.home()}/.bun/bin:" + env.get("PATH", "")
    env["BROWSE_STATE_FILE"] = "/tmp/nightcrawl-boundary/state/browse.json"
    env["BROWSE_PROFILE_DIR"] = "/tmp/nightcrawl-boundary/profile"
    env["BROWSE_EXTENSIONS"] = "none"
    env["BROWSE_IGNORE_HTTPS_ERRORS"] = "1"
    return env


def run_nc(args, env, timeout=45):
    started = time.perf_counter()
    proc = subprocess.run(
        ["bun", "run", "src/cli.ts", *args],
        cwd=BROWSER_DIR,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
    )
    elapsed = (time.perf_counter() - started) * 1000
    return {
        "args": args,
        "elapsed_ms": round(elapsed, 1),
        "exit_code": proc.returncode,
        "stdout": proc.stdout.strip(),
        "stderr": proc.stderr.strip(),
    }


def main():
    stamp = time.strftime("%Y%m%d-%H%M%S")
    env = build_env()
    Path("/tmp/nightcrawl-boundary/state").mkdir(parents=True, exist_ok=True)
    Path("/tmp/nightcrawl-boundary/profile").mkdir(parents=True, exist_ok=True)

    screenshot_path = f"/tmp/nightcrawl-boundary-{stamp}.png"
    pdf_path = f"/tmp/nightcrawl-boundary-{stamp}.pdf"
    results = {
        "benchmark": "nightcrawl-boundary-suite",
        "timestamp": stamp,
        "main_url": MAIN_URL,
        "upload_file": UPLOAD_FILE,
        "state_file": env["BROWSE_STATE_FILE"],
        "profile_dir": env["BROWSE_PROFILE_DIR"],
        "steps": [],
        "screenshot_path": screenshot_path,
        "pdf_path": pdf_path,
    }

    def step(label, args, timeout=45):
        result = run_nc(args, env, timeout=timeout)
        result["label"] = label
        results["steps"].append(result)
        return result

    try:
        step("status_cold_start", ["status"], timeout=60)
        step("goto_main", ["goto", MAIN_URL], timeout=60)
        step("snapshot_main", ["snapshot", "-i"], timeout=60)
        step("fill_name", ["fill", "#name", "nightCrawl Chrome comparison"])
        step("fill_notes", ["fill", "#notes", "Boundary benchmark notes from nightCrawl"])
        step("fill_contenteditable", ["fill", "#editor", "Contenteditable text from nightCrawl"])
        step("click_dynamic_submit", ["click", "#dynamic-submit"])
        step(
            "dynamic_result",
            [
                "js",
                "(() => ({result: document.querySelector('#dynamic-result')?.textContent, editor: document.querySelector('#editor')?.textContent}))()",
            ],
        )
        step("click_trusted_gate", ["click", "#trusted-click"])
        step("trusted_gate_result", ["js", "document.querySelector('#trusted-result')?.textContent"])
        step("fill_shadow_direct", ["fill", "#shadow-name", "nightCrawl Shadow"])
        step("click_shadow_direct", ["click", "#shadow-button"])
        step("shadow_result", ["js", "document.querySelector('#shadow-result')?.textContent"])
        step("upload_file", ["upload", "#file-input", UPLOAD_FILE])
        step("upload_result", ["js", "document.querySelector('#upload-result')?.textContent"])
        step("fill_cross_origin_iframe_without_frame", ["fill", "#frame-input", "nightCrawl parent iframe attempt"])
        step(
            "cross_origin_parent_probe",
            [
                "js",
                "(() => { try { return document.querySelector('#xframe').contentWindow.document.body.innerText; } catch (error) { return error.name + ': ' + error.message; } })()",
            ],
        )
        step("switch_to_iframe", ["frame", "#xframe"])
        step("fill_frame", ["fill", "#frame-input", "nightCrawl iframe value"])
        step("click_frame", ["click", "#frame-send"])
        step("frame_result", ["js", "document.querySelector('#frame-result')?.textContent"])
        step("switch_to_main", ["frame", "main"])
        step("click_summary", ["click", "#summarize"])
        step("summary_result", ["js", "JSON.parse(document.querySelector('#summary').textContent)"])
        step("network", ["network"], timeout=60)
        step("screenshot_viewport", ["screenshot", "--viewport", screenshot_path], timeout=60)
        step("pdf", ["pdf", pdf_path], timeout=60)
    finally:
        step("stop", ["stop"], timeout=20)

    out = ROOT / f"nightcrawl-boundary-results-{stamp}.json"
    out.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(out)


if __name__ == "__main__":
    main()
