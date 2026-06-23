#!/usr/bin/env python3
import base64
import json
import time
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent
API = "http://127.0.0.1:10086/command"
MAIN_URL = "http://127.0.0.1:8876/main.html"
FRAME_URL = "http://127.0.0.1:8877/iframe.html"
UPLOAD_FILE = str(ROOT / "upload-fixture.txt")


def post(action, args=None, session="chrome-boundary", timeout=25):
    payload = {"action": action, "args": args or {}, "session": session}
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        API,
        data=body,
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
            return {
                "action": action,
                "session": session,
                "elapsed_ms": round(elapsed, 1),
                "ok": True,
                "response": data,
            }
    except Exception as exc:
        elapsed = (time.perf_counter() - started) * 1000
        return {
            "action": action,
            "session": session,
            "elapsed_ms": round(elapsed, 1),
            "ok": False,
            "error": repr(exc),
        }


def eval_js(code, session):
    return post("evaluate", {"code": f"(() => {{ {code} }})()"}, session=session)


def shrink(item):
    response = item.get("response")
    label = item.get("label")
    if label == "screenshot_png" and isinstance(response, dict) and "data" in response:
        item = dict(item)
        response = dict(response)
        if isinstance(response["data"], dict) and "data" in response["data"]:
            data = dict(response["data"])
            data["data"] = f"<base64 omitted: {len(data['data'])} chars>"
            response["data"] = data
        elif isinstance(response["data"], str):
            response["data"] = f"<base64 omitted: {len(response['data'])} chars>"
        item["response"] = response
    if isinstance(response, dict) and isinstance(response.get("data"), dict) and "tree" in response["data"]:
        item = dict(item)
        response = dict(response)
        data = dict(response["data"])
        tree = data.get("tree") or ""
        data["tree_preview"] = tree[:2000]
        data["tree_chars"] = len(tree)
        data.pop("tree", None)
        response["data"] = data
        item["response"] = response
    return item


def save_screenshot(item, path):
    data = (item.get("response") or {}).get("data")
    if isinstance(data, dict):
        data = data.get("data") or data.get("base64")
    if not data:
        return None
    Path(path).write_bytes(base64.b64decode(data))
    return str(Path(path).resolve())


def main():
    stamp = time.strftime("%Y%m%d-%H%M%S")
    main_session = f"chrome-boundary-{stamp}"
    frame_session = f"chrome-frame-{stamp}"
    results = {
        "benchmark": "kimi-webbridge-chrome-boundary-suite",
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

    step("navigate_main", "navigate", {"url": MAIN_URL, "newTab": True, "group_title": "Kimi boundary"})
    step("snapshot_main", "snapshot")
    js(
        "page_health",
        "return {url: location.href, title: document.title, ready: document.readyState, hasName: !!document.querySelector('#name'), body: document.body.innerText.slice(0, 240)};",
    )

    step("fill_name", "fill", {"selector": "#name", "value": "Kimi Chrome"})
    step("fill_notes", "fill", {"selector": "#notes", "value": "Boundary benchmark notes from Kimi"})
    step("fill_contenteditable", "fill", {"selector": "#editor", "value": "Contenteditable text from Kimi"})
    step("click_dynamic_submit", "click", {"selector": "#dynamic-submit"})
    js(
        "dynamic_result",
        "return {result: document.querySelector('#dynamic-result')?.textContent, events: window.__events, editor: document.querySelector('#editor')?.textContent};",
    )

    step("click_trusted_gate", "click", {"selector": "#trusted-click"})
    js("trusted_gate_result", "return document.querySelector('#trusted-result')?.textContent;")

    step("fill_shadow_direct", "fill", {"selector": "#shadow-name", "value": "Kimi direct shadow"})
    js(
        "shadow_via_evaluate",
        "const root = document.querySelector('shadow-widget').shadowRoot; const input = root.querySelector('#shadow-name'); input.value = 'Kimi Shadow'; input.dispatchEvent(new Event('input', {bubbles: true})); root.querySelector('#shadow-button').click(); return document.querySelector('#shadow-result').textContent;",
    )

    step("upload_file", "upload", {"selector": "#file-input", "files": [UPLOAD_FILE]})
    js("upload_result", "return document.querySelector('#upload-result')?.textContent;")

    step("fill_cross_origin_iframe_from_parent", "fill", {"selector": "#frame-input", "value": "Kimi parent iframe attempt"})
    js(
        "cross_origin_parent_probe",
        "try { return document.querySelector('#remote-frame').contentWindow.document.body.innerText; } catch (error) { return error.name + ': ' + error.message; }",
    )

    step("network_start", "network", {"cmd": "start"})
    js("fetch_for_network_capture", "return fetch('/iframe.html').then(r => r.text()).then(t => t.length);")
    step("network_list", "network", {"cmd": "list", "filter": "iframe.html"})
    step("network_stop", "network", {"cmd": "stop"})

    step("navigate_frame_direct", "navigate", {"url": FRAME_URL, "newTab": True, "group_title": "Kimi boundary"}, session=frame_session)
    step("fill_frame_direct", "fill", {"selector": "#frame-input", "value": "Kimi direct iframe page"}, session=frame_session)
    step("click_frame_direct", "click", {"selector": "#frame-send"}, session=frame_session)
    js("frame_direct_result", "return document.querySelector('#frame-result')?.textContent;", session=frame_session)

    step("click_summary", "click", {"selector": "#summarize"})
    js(
        "summary_result",
        "return {summary: document.querySelector('#summary')?.textContent, trusted: document.querySelector('#trusted-result')?.textContent, upload: document.querySelector('#upload-result')?.textContent};",
    )

    step("save_pdf", "save_as_pdf", {"paper_format": "letter", "print_background": True, "file_name": f"kimi-chrome-boundary-{stamp}.pdf"}, timeout=40)
    screenshot = step("screenshot_png", "screenshot", {"format": "png"}, timeout=40)
    screenshot_path = save_screenshot(screenshot, ROOT / f"kimi-chrome-boundary-{stamp}.png")
    if screenshot_path:
        results["screenshot_path"] = screenshot_path

    step("list_tabs", "list_tabs")
    step("close_main_session", "close_session")
    step("close_frame_session", "close_session", session=frame_session)

    out = ROOT / f"kimi-chrome-boundary-results-{stamp}.json"
    out.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(out)


if __name__ == "__main__":
    main()
