#!/usr/bin/env python3
import base64
import contextlib
import http.server
import json
import os
import re
import socketserver
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent
REPO = Path("/Users/yinanli/Documents/nightCrawl")
FIXTURE_DIR = REPO / "artifacts" / "webbridge-boundary-suite"
KIMI_API = "http://127.0.0.1:10086/command"
LOG_PATH = Path.home() / ".kimi-webbridge" / "logs" / "daemon.log"


def ms() -> int:
    return int(time.time() * 1000)


def read_log() -> str:
    try:
        return LOG_PATH.read_text(errors="replace")
    except FileNotFoundError:
        return ""


def log_counts(text: str) -> dict:
    patterns = {
        "connected": r"\[ws\] extension connected",
        "disconnected": r"\[ws\] extension disconnected",
        "context_canceled": r"context canceled",
        "stale_tab": r"stale tab",
        "command_call": r"webbridge_command_call",
    }
    return {name: len(re.findall(pattern, text)) for name, pattern in patterns.items()}


def cmd(action: str, args=None, session="kimi-real", timeout=45) -> dict:
    payload = {"action": action, "args": args or {}, "session": session}
    req = urllib.request.Request(
        KIMI_API,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = ms()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            try:
                body = json.loads(raw)
            except Exception:
                body = {"raw": raw[:2000]}
            return {
                "action": action,
                "ok": True,
                "duration_ms": ms() - started,
                "status": resp.status,
                "response": body,
            }
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:2000]
        return {
            "action": action,
            "ok": False,
            "duration_ms": ms() - started,
            "status": exc.code,
            "error": body or repr(exc),
        }
    except Exception as exc:
        return {
            "action": action,
            "ok": False,
            "duration_ms": ms() - started,
            "error": repr(exc),
        }


def data_value(step: dict):
    data = step.get("response", {}).get("data")
    if isinstance(data, dict) and "value" in data:
        return data["value"]
    return data


@contextlib.contextmanager
def fixture_server(port=0):
    class ReusableTCPServer(socketserver.TCPServer):
        allow_reuse_address = True

    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, fmt, *args):
            pass

    old_cwd = os.getcwd()
    os.chdir(FIXTURE_DIR)
    server = ReusableTCPServer(("127.0.0.1", port), QuietHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        os.chdir(old_cwd)


def run_task(task_id: str, runner):
    session = f"kimi-real-{task_id}-{int(time.time())}"
    record = {"id": task_id, "session": session, "steps": []}
    before = read_log()
    started = ms()
    try:
        runner(session, record)
    except Exception as exc:
        record["exception"] = repr(exc)
    finally:
        record["steps"].append(cmd("list_tabs", session=session, timeout=8))
        record["steps"].append(cmd("close_session", session=session, timeout=8))
        record["duration_ms"] = ms() - started
        after = read_log()
        before_counts = log_counts(before)
        after_counts = log_counts(after)
        record["log_delta"] = {
            key: after_counts.get(key, 0) - before_counts.get(key, 0)
            for key in after_counts
        }
        record["success"] = score_task(record)
    return record


def score_task(record: dict) -> bool:
    if record.get("exception"):
        return False
    meaningful = [s for s in record.get("steps", []) if s["action"] not in ("list_tabs", "close_session")]
    if not meaningful or not all(s.get("ok") and s.get("response", {}).get("ok", True) for s in meaningful[:1]):
        return False
    if record["id"] == "sanity_example":
        return any(data_value(s) == "Example Domain" for s in record["steps"])
    if record["id"] == "local_input_boundary":
        return bool(record.get("summary", {}).get("trusted_mouse") == "trusted-click:true")
    if record["id"] == "kimi_help_research":
        return bool(record.get("summary", {}).get("heading_count", 0) >= 1)
    if record["id"] == "uw_library_references":
        return bool(record.get("summary", {}).get("reference_count", 0) >= 3)
    if record["id"] == "shopping_compare":
        return bool(record.get("summary", {}).get("item_count", 0) >= 3 or record.get("summary", {}).get("blocked"))
    if record["id"] in ("sheets_readiness", "canvas_readiness"):
        return bool(record.get("summary"))
    return True


def sanity_example(session, record):
    record["steps"].append(cmd("navigate", {"url": "https://example.com", "newTab": True, "group_title": "Kimi sanity"}, session=session, timeout=35))
    record["steps"].append(cmd("evaluate", {"code": "document.title"}, session=session, timeout=10))
    record["steps"].append(cmd("snapshot", {}, session=session, timeout=15))
    record["summary"] = {"title": data_value(record["steps"][-2])}


def local_input_boundary(session, record):
    with fixture_server() as base:
        record["steps"].append(cmd("navigate", {"url": f"{base}/main.html", "newTab": True, "group_title": "Kimi input boundary"}, session=session, timeout=25))
        record["steps"].append(cmd("fill", {"selector": "#name", "value": "Kimi Clean Profile"}, session=session, timeout=10))
        record["steps"].append(cmd("fill", {"selector": "#notes", "value": "Textarea fill from Kimi WebBridge"}, session=session, timeout=10))
        record["steps"].append(cmd("fill", {"selector": "#editor", "value": "Rich editor fill from Kimi WebBridge"}, session=session, timeout=10))
        record["steps"].append(cmd("click", {"selector": "#trusted-click"}, session=session, timeout=10))
        record["steps"].append(cmd("evaluate", {"code": "document.querySelector('#trusted-result').textContent"}, session=session, timeout=10))
        trusted_dom = data_value(record["steps"][-1])
        record["steps"].append(cmd("navigate", {"url": f"{base}/main.html", "newTab": False}, session=session, timeout=20))
        record["steps"].append(cmd("mouse_click", {"selector": "#trusted-click"}, session=session, timeout=10))
        record["steps"].append(cmd("evaluate", {"code": "document.querySelector('#trusted-result').textContent"}, session=session, timeout=10))
        trusted_mouse = data_value(record["steps"][-1])
        record["steps"].append(cmd("evaluate", {"code": "document.querySelector('#dynamic-submit').disabled"}, session=session, timeout=10))
        record["summary"] = {
            "trusted_dom": trusted_dom,
            "trusted_mouse": trusted_mouse,
            "dynamic_submit_disabled_after_fill": data_value(record["steps"][-1]),
        }


def kimi_help_research(session, record):
    js = r"""
(() => {
  const text = document.body?.innerText || "";
  const headings = [...document.querySelectorAll("h1,h2,h3")].map(h => h.innerText.trim()).filter(Boolean);
  const rows = [...document.querySelectorAll("table tr")].map(tr => [...tr.cells].map(td => td.innerText.trim().replace(/\s+/g, " "))).filter(r => r.length);
  const bullets = [...document.querySelectorAll("li")].map(li => li.innerText.trim().replace(/\s+/g, " ")).filter(Boolean).slice(0, 20);
  return {url: location.href, title: document.title, headings, rows, bullets, textPreview: text.slice(0, 1200)};
})()
"""
    record["steps"].append(cmd("navigate", {"url": "https://www.kimi.com/help/kimi-webbridge/kimi-webbridge-how-it-works", "newTab": True, "group_title": "Kimi help research"}, session=session, timeout=45))
    time.sleep(2)
    record["steps"].append(cmd("evaluate", {"code": js}, session=session, timeout=20))
    value = data_value(record["steps"][-1]) or {}
    record["summary"] = {
        "title": value.get("title"),
        "heading_count": len(value.get("headings", [])),
        "table_row_count": len(value.get("rows", [])),
        "sample_headings": value.get("headings", [])[:5],
    }


def uw_library_references(session, record):
    search_js = r"""
(() => {
  const candidates = [...document.querySelectorAll('input, textarea, [contenteditable="true"]')]
    .map((el, i) => ({i, tag: el.tagName, type: el.getAttribute('type'), name: el.getAttribute('name'), id: el.id, placeholder: el.getAttribute('placeholder'), aria: el.getAttribute('aria-label'), visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)}))
    .filter(x => x.visible);
  return candidates;
})()
"""
    extract_js = r"""
(() => {
  const text = document.body?.innerText || "";
  const links = [...document.querySelectorAll("a")].map(a => ({
    text: (a.innerText || a.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 220),
    href: a.href
  })).filter(x => x.text && x.href);
  const refs = [];
  for (const link of links) {
    if (/primo|exlibris|article|record|fulldisplay|library|catalog|doi|search/i.test(link.href + " " + link.text)) {
      if (!refs.some(r => r.text === link.text && r.href === link.href)) refs.push(link);
    }
    if (refs.length >= 8) break;
  }
  return {url: location.href, title: document.title, refs, textPreview: text.slice(0, 1200)};
})()
"""
    record["steps"].append(cmd("navigate", {"url": "https://lib.uw.edu/", "newTab": True, "group_title": "Kimi UW library"}, session=session, timeout=45))
    time.sleep(2)
    record["steps"].append(cmd("evaluate", {"code": search_js}, session=session, timeout=15))
    selector = "input[type='search'], input[name='q'], input[name='query'], input[placeholder*='Search' i], input[aria-label*='Search' i]"
    record["steps"].append(cmd("fill", {"selector": selector, "value": "agentic browser automation"}, session=session, timeout=15))
    record["steps"].append(cmd("send_keys", {"keys": "Enter"}, session=session, timeout=10))
    time.sleep(5)
    record["steps"].append(cmd("evaluate", {"code": extract_js}, session=session, timeout=20))
    value = data_value(record["steps"][-1]) or {}
    if len(value.get("refs", [])) < 3:
        fallback = "https://orbiscascade-washington.primo.exlibrisgroup.com/discovery/search?query=any,contains,agentic%20browser%20automation&tab=Everything&search_scope=MyInst_and_CI&vid=01ALLIANCE_UW:UW&offset=0"
        record["steps"].append(cmd("navigate", {"url": fallback, "newTab": False}, session=session, timeout=45))
        time.sleep(5)
        record["steps"].append(cmd("evaluate", {"code": extract_js}, session=session, timeout=20))
        value = data_value(record["steps"][-1]) or value
    record["summary"] = {
        "title": value.get("title"),
        "url": value.get("url"),
        "reference_count": len(value.get("refs", [])),
        "references": value.get("refs", [])[:5],
    }


def shopping_compare(session, record):
    js = r"""
(() => {
  const text = document.body?.innerText || "";
  const cards = [...document.querySelectorAll('[data-component-type="s-search-result"]')].slice(0, 16).map(card => {
    const title = card.querySelector('h2 span, h2 a span, [data-cy="title-recipe"] span')?.innerText?.trim() || "";
    const whole = card.querySelector('.a-price-whole')?.innerText?.replace(/[^\d]/g, "") || "";
    const frac = card.querySelector('.a-price-fraction')?.innerText?.trim() || "";
    const rating = card.querySelector('.a-icon-alt')?.innerText?.trim() || "";
    const href = card.querySelector('h2 a, a.a-link-normal.s-no-outline')?.href || "";
    return {title, price: whole ? `$${whole}${frac ? "." + frac : ""}` : "", rating, href};
  }).filter(x => x.title);
  return {
    url: location.href,
    title: document.title,
    blocked: /captcha|robot|automated access|sorry/i.test(text),
    items: cards.slice(0, 8),
    textPreview: text.slice(0, 1200)
  };
})()
"""
    url = "https://www.amazon.com/s?k=mechanical+keyboard&i=electronics&rh=p_36%3A-15000%2Cp_72%3A1248879011"
    record["steps"].append(cmd("navigate", {"url": url, "newTab": True, "group_title": "Kimi shopping"}, session=session, timeout=55))
    time.sleep(5)
    record["steps"].append(cmd("evaluate", {"code": js}, session=session, timeout=25))
    value = data_value(record["steps"][-1]) or {}
    record["summary"] = {
        "title": value.get("title"),
        "url": value.get("url"),
        "blocked": value.get("blocked"),
        "item_count": len(value.get("items", [])),
        "items": value.get("items", [])[:5],
    }


def sheets_readiness(session, record):
    js = r"""
(() => {
  const text = document.body?.innerText || "";
  return {
    url: location.href,
    title: document.title,
    loggedInLikely: /blank spreadsheet|template gallery|recent spreadsheets|start a new spreadsheet/i.test(text) && !/sign in|use your google account/i.test(text),
    loginWallLikely: /sign in|use your google account|to continue to sheets/i.test(text),
    safeSignals: text.split('\n').map(s => s.trim()).filter(Boolean).filter(s => /sign in|sheets|template|blank|google account|recent/i.test(s)).slice(0, 12)
  };
})()
"""
    record["steps"].append(cmd("navigate", {"url": "https://docs.google.com/spreadsheets/u/0/", "newTab": True, "group_title": "Kimi Sheets readiness"}, session=session, timeout=45))
    time.sleep(3)
    record["steps"].append(cmd("evaluate", {"code": js}, session=session, timeout=20))
    record["summary"] = data_value(record["steps"][-1]) or {}


def canvas_readiness(session, record):
    js = r"""
(() => {
  const text = document.body?.innerText || "";
  return {
    url: location.href,
    title: document.title,
    dashboardLikely: /Dashboard|Courses|Calendar|To Do/i.test(text) && !/login|sign in|UW NetID/i.test(text),
    loginWallLikely: /UW NetID|login|sign in|Duo|password/i.test(text),
    safeSignals: text.split('\n').map(s => s.trim()).filter(Boolean).filter(s => /Dashboard|Courses|Calendar|UW NetID|login|sign in|password|Duo/i.test(s)).slice(0, 12)
  };
})()
"""
    record["steps"].append(cmd("navigate", {"url": "https://canvas.uw.edu/", "newTab": True, "group_title": "Kimi Canvas readiness"}, session=session, timeout=45))
    time.sleep(3)
    record["steps"].append(cmd("evaluate", {"code": js}, session=session, timeout=20))
    record["summary"] = data_value(record["steps"][-1]) or {}


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    result = {
        "started_at": time.strftime("%Y-%m-%dT%H-%M-%S"),
        "status_before": None,
        "tasks": [],
    }
    result["status_before"] = os.popen("~/.kimi-webbridge/bin/kimi-webbridge status").read().strip()
    task_fns = [
        ("sanity_example", sanity_example),
        ("local_input_boundary", local_input_boundary),
        ("kimi_help_research", kimi_help_research),
        ("uw_library_references", uw_library_references),
        ("shopping_compare", shopping_compare),
        ("sheets_readiness", sheets_readiness),
        ("canvas_readiness", canvas_readiness),
    ]
    for task_id, fn in task_fns:
        result["tasks"].append(run_task(task_id, fn))
        time.sleep(1)
    result["status_after"] = os.popen("~/.kimi-webbridge/bin/kimi-webbridge status").read().strip()
    out_json = ROOT / f"kimi-real-capability-{result['started_at']}.json"
    out_json.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")

    lines = [
        "# Kimi WebBridge Real Capability Retest",
        "",
        f"Started: `{result['started_at']}`",
        "",
        "| Task | Success | Duration | Key result | Disconnects | Stale tabs |",
        "|---|---:|---:|---|---:|---:|",
    ]
    for task in result["tasks"]:
        summary = task.get("summary") or {}
        key = ""
        if task.get("exception"):
            key = task["exception"]
        elif task["id"] == "sanity_example":
            key = summary.get("title", "")
        elif task["id"] == "local_input_boundary":
            key = f"DOM={summary.get('trusted_dom')}; mouse={summary.get('trusted_mouse')}"
        elif task["id"] == "kimi_help_research":
            key = f"{summary.get('heading_count', 0)} headings; {summary.get('table_row_count', 0)} table rows"
        elif task["id"] == "uw_library_references":
            key = f"{summary.get('reference_count', 0)} references"
        elif task["id"] == "shopping_compare":
            key = f"{summary.get('item_count', 0)} items; blocked={summary.get('blocked')}"
        elif task["id"] in ("sheets_readiness", "canvas_readiness"):
            key = f"loginWall={summary.get('loginWallLikely')}; loggedIn/dashboard={summary.get('loggedInLikely', summary.get('dashboardLikely'))}"
        lines.append(
            f"| `{task['id']}` | {task.get('success')} | {task.get('duration_ms')} ms | {key} | "
            f"{task.get('log_delta', {}).get('disconnected', 0)} | {task.get('log_delta', {}).get('stale_tab', 0)} |"
        )
    lines.extend(["", f"Raw JSON: `{out_json}`", ""])
    (ROOT / f"kimi-real-capability-{result['started_at']}.md").write_text("\n".join(lines), encoding="utf-8")
    print(out_json)


if __name__ == "__main__":
    main()
