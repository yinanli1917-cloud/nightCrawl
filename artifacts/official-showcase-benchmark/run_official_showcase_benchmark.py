#!/usr/bin/env python3
import csv
import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent
REPO = Path("/Users/yinanli/Documents/nightCrawl")
NC_DIR = REPO / "stealth" / "browser"
KIMI_API = "http://127.0.0.1:10086/command"


TASKS = [
    {
        "id": "shopping_compare",
        "official_case": "Compare Shopping Prices / e-commerce price comparison",
        "url": "https://www.amazon.com/s?k=mechanical+keyboard&i=electronics&rh=p_36%3A-15000%2Cp_72%3A1248879011",
        "goal": "Find mechanical keyboards under $150 with high ratings without adding anything to cart.",
        "extractor": "amazon",
    },
    {
        "id": "cross_site_research",
        "official_case": "Cross-Site Search / information research",
        "url": "https://www.kimi.com/help/kimi-webbridge/kimi-webbridge-how-it-works",
        "goal": "Extract Kimi's own WebBridge features and use cases from the Help Center.",
        "extractor": "kimi_help",
    },
    {
        "id": "job_collection",
        "official_case": "Collect Job Listings",
        "url": "https://www.ycombinator.com/jobs?query=ai%20agent",
        "goal": "Collect public AI-agent-related job listings without logging in or applying.",
        "extractor": "yc_jobs",
    },
    {
        "id": "sheets_readiness",
        "official_case": "Build Google Sheets / data-entry readiness",
        "url": "https://docs.google.com/spreadsheets/u/0/",
        "goal": "Check whether an authenticated Sheets workspace is reachable. Do not create or edit files.",
        "extractor": "sheets_readiness",
    },
]


COMMON_JS = r"""
(() => {
  const text = document.body ? document.body.innerText : "";
  const links = [...document.querySelectorAll("a")].slice(0, 120).map(a => ({
    text: (a.innerText || a.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 220),
    href: a.href
  })).filter(x => x.text || x.href);
  return {url: location.href, title: document.title, text: text.slice(0, 6000), links};
})()
"""


EXTRACTORS = {
    "amazon": r"""
(() => {
  const cards = [...document.querySelectorAll('[data-component-type="s-search-result"]')].slice(0, 12).map(card => {
    const titleEl = card.querySelector('h2 span, h2 a span, [data-cy="title-recipe"] span');
    const priceWhole = card.querySelector('.a-price-whole');
    const priceFrac = card.querySelector('.a-price-fraction');
    const rating = card.querySelector('.a-icon-alt');
    const link = card.querySelector('h2 a, a.a-link-normal.s-no-outline');
    return {
      title: titleEl?.innerText?.trim() || "",
      price: priceWhole ? `$${priceWhole.innerText.replace(/[^\d]/g, "")}${priceFrac ? "." + priceFrac.innerText.trim() : ""}` : "",
      rating: rating?.innerText?.trim() || "",
      href: link?.href || ""
    };
  }).filter(x => x.title);
  const text = document.body?.innerText || "";
  return {
    url: location.href,
    title: document.title,
    blocked: /captcha|robot|automated access|sorry/i.test(text),
    resultCount: cards.length,
    items: cards.slice(0, 5),
    textPreview: text.slice(0, 2500)
  };
})()
""",
    "kimi_help": r"""
(() => {
  const text = document.body?.innerText || "";
  const headings = [...document.querySelectorAll('h1,h2,h3')].map(h => h.innerText.trim()).filter(Boolean);
  const bullets = [...document.querySelectorAll('li')].map(li => li.innerText.trim().replace(/\s+/g, ' ')).filter(Boolean).slice(0, 30);
  const featureRows = [...document.querySelectorAll('table tr')].map(tr => [...tr.cells].map(td => td.innerText.trim().replace(/\s+/g, ' '))).filter(r => r.length);
  return {url: location.href, title: document.title, headings, bullets, featureRows, textPreview: text.slice(0, 3000)};
})()
""",
    "yc_jobs": r"""
(() => {
  const text = document.body?.innerText || "";
  const links = [...document.querySelectorAll('a')].map(a => ({
    text: (a.innerText || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' '),
    href: a.href
  })).filter(x => x.text && /job|companies|apply|engineer|agent|ai|founding|product/i.test(x.text + ' ' + x.href));
  const seen = new Set();
  const items = [];
  for (const link of links) {
    const key = link.text + link.href;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(link);
    if (items.length >= 10) break;
  }
  return {url: location.href, title: document.title, blocked: /captcha|blocked|enable javascript/i.test(text), items, textPreview: text.slice(0, 3000)};
})()
""",
    "sheets_readiness": r"""
(() => {
  const text = document.body?.innerText || "";
  return {
    url: location.href,
    title: document.title,
    loggedInLikely: /blank spreadsheet|template gallery|recent spreadsheets|Sheets|Start a new spreadsheet/i.test(text) && !/Sign in|Use your Google Account/i.test(text),
    loginWallLikely: /Sign in|Use your Google Account|to continue to Sheets/i.test(text),
    visibleSignals: text.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 30)
  };
})()
""",
}


def now_ms():
    return int(time.time() * 1000)


def post_kimi(action, args=None, session="official", timeout=35):
    payload = {"action": action, "args": args or {}, "session": session}
    req = urllib.request.Request(
        KIMI_API,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    start = now_ms()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            data = json.loads(raw)
            return {"ok": True, "duration_ms": now_ms() - start, "response": data}
    except Exception as exc:
        return {"ok": False, "duration_ms": now_ms() - start, "error": repr(exc)}


def restart_kimi():
    start = now_ms()
    proc = subprocess.run(
        ["bash", "-lc", "~/.kimi-webbridge/bin/kimi-webbridge restart >/tmp/kimi-official-restart.log 2>&1; sleep 7; ~/.kimi-webbridge/bin/kimi-webbridge status"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=25,
    )
    try:
        status = json.loads(proc.stdout.strip().splitlines()[-1])
    except Exception:
        status = {"raw": proc.stdout.strip(), "stderr": proc.stderr.strip()}
    return {"duration_ms": now_ms() - start, "status": status, "exit_code": proc.returncode}


def run_kimi_task(task):
    session = f"kimi-official-{task['id']}-{int(time.time())}"
    record = {"session": session, "task": task, "steps": []}
    record["restart"] = restart_kimi()
    nav = post_kimi("navigate", {"url": task["url"], "newTab": True, "group_title": f"Kimi {task['id']}"}, session=session, timeout=45)
    record["steps"].append({"name": "navigate", **nav})
    if not nav.get("ok") or not nav.get("response", {}).get("ok"):
        record["outcome"] = "navigate_failed"
        return record
    time.sleep(3)
    extract = post_kimi("evaluate", {"code": EXTRACTORS[task["extractor"]]}, session=session, timeout=30)
    record["steps"].append({"name": "extract_specific", **extract})
    if not extract.get("ok") or not extract.get("response", {}).get("ok"):
        fallback = post_kimi("evaluate", {"code": COMMON_JS}, session=session, timeout=30)
        record["steps"].append({"name": "extract_common_fallback", **fallback})
    record["outcome"] = "completed" if any(s.get("response", {}).get("ok") for s in record["steps"] if s["name"].startswith("extract")) else "extract_failed"
    return record


def nc_env():
    env = os.environ.copy()
    env["PATH"] = f"{Path.home()}/.bun/bin:" + env.get("PATH", "")
    env["BROWSE_EXTENSIONS"] = "all"
    env["BROWSE_IGNORE_HTTPS_ERRORS"] = "1"
    return env


def run_nc(args, timeout=60):
    start = now_ms()
    proc = subprocess.run(
        ["bun", "run", "src/cli.ts", *args],
        cwd=NC_DIR,
        env=nc_env(),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
    )
    return {
        "args": args,
        "duration_ms": now_ms() - start,
        "exit_code": proc.returncode,
        "stdout": proc.stdout.strip(),
        "stderr": proc.stderr.strip(),
        "ok": proc.returncode == 0,
    }


def parse_nc_json(stdout):
    text = stdout.strip()
    if text.startswith("--- BEGIN UNTRUSTED"):
        lines = text.splitlines()
        inner = "\n".join(line for line in lines if not line.startswith("--- BEGIN") and not line.startswith("--- END"))
        text = inner.strip()
    try:
        return json.loads(text)
    except Exception:
        return {"raw": stdout[:6000]}


def run_nc_task(task):
    record = {"task": task, "steps": []}
    nav = run_nc(["goto", task["url"]], timeout=75)
    record["steps"].append({"name": "goto", **nav})
    if not nav["ok"]:
        record["outcome"] = "navigate_failed"
        return record
    time.sleep(2)
    js = run_nc(["js", EXTRACTORS[task["extractor"]]], timeout=60)
    js["parsed"] = parse_nc_json(js["stdout"])
    record["steps"].append({"name": "extract_specific", **js})
    if not js["ok"]:
        fallback = run_nc(["js", COMMON_JS], timeout=60)
        fallback["parsed"] = parse_nc_json(fallback["stdout"])
        record["steps"].append({"name": "extract_common_fallback", **fallback})
    record["outcome"] = "completed" if any(s.get("ok") for s in record["steps"] if s["name"].startswith("extract")) else "extract_failed"
    return record


def extract_value_from_kimi(record):
    for step in record.get("steps", []):
        data = step.get("response", {}).get("data")
        if isinstance(data, dict) and "value" in data:
            return data["value"]
    return None


def extract_value_from_nc(record):
    for step in record.get("steps", []):
        if step.get("parsed"):
            return step["parsed"]
    return None


def write_csv(results):
    csv_path = ROOT / "official-showcase-extracted-items.csv"
    rows = []
    for runner in ["kimi", "nightcrawl"]:
        for record in results[runner]["tasks"]:
            value = extract_value_from_kimi(record) if runner == "kimi" else extract_value_from_nc(record)
            if not isinstance(value, dict):
                continue
            items = value.get("items") or value.get("links") or []
            if record["task"]["id"] == "cross_site_research":
                items = [{"text": b} for b in (value.get("bullets") or [])[:8]]
            if record["task"]["id"] == "sheets_readiness":
                items = [{"text": signal} for signal in (value.get("visibleSignals") or [])[:8]]
            for item in items[:8]:
                rows.append({
                    "runner": runner,
                    "task_id": record["task"]["id"],
                    "official_case": record["task"]["official_case"],
                    "title_or_text": item.get("title") or item.get("text") or "",
                    "price": item.get("price", ""),
                    "rating": item.get("rating", ""),
                    "href": item.get("href", ""),
                })
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["runner", "task_id", "official_case", "title_or_text", "price", "rating", "href"])
        writer.writeheader()
        writer.writerows(rows)
    return str(csv_path)


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    started = time.strftime("%Y-%m-%dT%H-%M-%S")
    results = {
        "benchmark": "kimi-official-showcase-side-by-side",
        "started_at": started,
        "source_cases": TASKS,
        "kimi": {"tasks": []},
        "nightcrawl": {"tasks": []},
    }

    for task in TASKS:
        results["kimi"]["tasks"].append(run_kimi_task(task))

    status = run_nc(["status"], timeout=75)
    results["nightcrawl"]["status"] = status
    for task in TASKS:
        results["nightcrawl"]["tasks"].append(run_nc_task(task))
    results["nightcrawl"]["stop"] = run_nc(["stop"], timeout=20)

    results["csv_path"] = write_csv(results)
    json_path = ROOT / f"official-showcase-results-{started}.json"
    json_path.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(json_path)


if __name__ == "__main__":
    main()
