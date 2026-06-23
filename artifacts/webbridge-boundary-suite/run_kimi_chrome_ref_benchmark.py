#!/usr/bin/env python3
import base64
import json
import time
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent
API = "http://127.0.0.1:10086/command"
MAIN_URL = "http://127.0.0.1:8876/main.html"
FRAME_URL = "http://127.0.0.1:8877/iframe.html"
UPLOAD_FILE = str(ROOT / "upload-fixture.txt")


def post(action, args=None, session="chrome-boundary-ref", timeout=25):
    payload = {"action": action, "args": args or {}, "session": session}
    req = urllib.request.Request(
        API,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            elapsed = (time.perf_counter() - started) * 1000
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                data = {"raw": raw}
            return {"action": action, "session": session, "elapsed_ms": round(elapsed, 1), "ok": True, "response": data}
    except Exception as exc:
        elapsed = (time.perf_counter() - started) * 1000
        return {"action": action, "session": session, "elapsed_ms": round(elapsed, 1), "ok": False, "error": repr(exc)}


def eval_js(code, session):
    return post("evaluate", {"code": f"(() => {{ {code} }})()"}, session=session)


def shrink(result):
    response = result.get("response")
    if isinstance(response, dict) and isinstance(response.get("data"), dict):
        data = dict(response["data"])
        if "tree" in data:
            tree = data.get("tree") or ""
            data["tree_preview"] = tree[:2000]
            data["tree_chars"] = len(tree)
            data.pop("tree", None)
        if "data" in data and isinstance(data["data"], str):
            data["data"] = f"<base64 omitted: {len(data['data'])} chars>"
        response = dict(response)
        response["data"] = data
        result = dict(result)
        result["response"] = response
    return result


def save_screenshot(result, path):
    data = ((result.get("response") or {}).get("data") or {}).get("data")
    if data and isinstance(data, str) and not data.startswith("<base64"):
        Path(path).write_bytes(base64.b64decode(data))
        return str(Path(path).resolve())
    return None


def main():
    stamp = time.strftime("%Y%m%d-%H%M%S")
    main_session = f"chrome-boundary-ref-{stamp}"
    frame_session = f"chrome-frame-ref-{stamp}"
    results = {
        "benchmark": "kimi-webbridge-chrome-boundary-suite-ref-mode",
        "timestamp": stamp,
        "main_url": MAIN_URL,
        "frame_url": FRAME_URL,
        "upload_file": UPLOAD_FILE,
        "sessions": {"main": main_session, "frame": frame_session},
        "steps": [],
    }

    def step(label, action, args=None, session=None, timeout=25):
        result = post(action, args, session or main_session, timeout=timeout)
        result["label"] = label
        results["steps"].append(shrink(result))
        return result

    def js(label, code, session=None):
        result = eval_js(code, session or main_session)
        result["label"] = label
        results["steps"].append(shrink(result))
        return result

    step("navigate_main", "navigate", {"url": MAIN_URL, "newTab": True, "group_title": "Kimi ref"})
    step("snapshot_main", "snapshot")
    step("fill_name_ref", "fill", {"selector": "@e1", "value": "Kimi Ref"})
    step("fill_notes_ref", "fill", {"selector": "@e2", "value": "Boundary benchmark notes from Kimi refs"})
    step("fill_contenteditable_ref", "fill", {"selector": "@e3", "value": "Contenteditable text from Kimi refs"})
    step("click_dynamic_submit_ref", "click", {"selector": "@e4"})
    js("dynamic_result_ref", "return document.querySelector('#dynamic-result')?.textContent;")

    step("click_trusted_gate_ref", "click", {"selector": "@e5"})
    js("trusted_gate_result_ref", "return document.querySelector('#trusted-result')?.textContent;")

    step("fill_shadow_ref", "fill", {"selector": "@e6", "value": "Kimi Ref Shadow"})
    step("click_shadow_ref", "click", {"selector": "@e7"})
    js("shadow_result_ref", "return document.querySelector('#shadow-result')?.textContent;")

    step("upload_file_ref", "upload", {"selector": "@e8", "files": [UPLOAD_FILE]})
    js("upload_result_ref", "return document.querySelector('#upload-result')?.textContent;")

    step("fill_cross_origin_iframe_from_parent", "fill", {"selector": "#frame-input", "value": "Kimi parent iframe attempt"})
    js(
        "cross_origin_parent_probe",
        "try { return document.querySelector('#xframe').contentWindow.document.body.innerText; } catch (error) { return error.name + ': ' + error.message; }",
    )

    step("navigate_frame_direct", "navigate", {"url": FRAME_URL, "newTab": True, "group_title": "Kimi ref"}, session=frame_session)
    step("fill_frame_direct", "fill", {"selector": "#frame-input", "value": "Kimi direct iframe page"}, session=frame_session)
    step("click_frame_direct", "click", {"selector": "#frame-send"}, session=frame_session)
    js("frame_direct_result", "return document.querySelector('#frame-result')?.textContent;", session=frame_session)

    step("click_summary_ref", "click", {"selector": "#summarize"})
    js("summary_result_ref", "return JSON.parse(document.querySelector('#summary').textContent);")
    step("save_pdf", "save_as_pdf", {"paper_format": "letter", "print_background": True, "file_name": f"kimi-chrome-boundary-ref-{stamp}.pdf"}, timeout=40)
    screenshot = step("screenshot_png", "screenshot", {"format": "png"}, timeout=40)
    screenshot_path = save_screenshot(screenshot, ROOT / f"kimi-chrome-boundary-ref-{stamp}.png")
    if screenshot_path:
        results["screenshot_path"] = screenshot_path
    step("close_main_session", "close_session")
    step("close_frame_session", "close_session", session=frame_session)

    out = ROOT / f"kimi-chrome-boundary-ref-results-{stamp}.json"
    out.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(out)


if __name__ == "__main__":
    main()
