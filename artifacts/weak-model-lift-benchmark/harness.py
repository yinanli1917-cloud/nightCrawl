"""
[INPUT]:  DEEPSEEK_API_KEY (env or ~/.config/fictionworks/secrets.env); nightcrawl CLI
          at stealth/browser/src/cli.ts; tasks.json (protocol3 subset).
[OUTPUT]: parse_action, parse_verdict, call_deepseek, nc_cmd, agent_loop,
          condition_A/C/B, judge. Pure parsers unit-tested by test_harness.py.
[POS]:    Weak-model-lift benchmark core. The reasoning loop is deepseek-v4-flash
          ONLY (no Claude) so the measured capability is the weak model's own.
          Condition B = flash + nightcrawl; C = flash + naive fetch; A = flash alone.
          Judge = deepseek-v4-pro (a SEPARATE model; the driver never grades itself).
"""
import os
import re
import json
import subprocess
import urllib.request

DS_MODEL_FLASH = "deepseek-v4-flash"
DS_MODEL_PRO = "deepseek-v4-pro"
API_URL = "https://api.deepseek.com/chat/completions"
NC_CLI = "/Users/liyinan/Desktop/DesignDesign/nightCrawl/stealth/browser/src/cli.ts"
BUN = os.path.expanduser("~/.bun/bin/bun")
SECRETS = os.path.expanduser("~/.config/fictionworks/secrets.env")
OBS_CAP = 6000

# ------------------------------------------------------------------- parsers (pure)
# Accept BOTH the paren form `name(arg)` AND the space form `name arg` — a weak model
# frequently writes `ACTION: goto https://...` without parens. Rejecting that silently
# dropped its navigations and measured a broken harness, not the tool. The space form is
# condition-neutral (it also rescues C's `fetch url`), so the comparison stays fair.
_ACTION_PAREN = re.compile(r"^\s*ACTION:\s*(\w+)\((.*)\)\s*$")
_ACTION_SPACE = re.compile(r"^\s*ACTION:\s*(\w+)(?:\s+(.*\S))?\s*$")
_FINISH_RE = re.compile(r"^\s*FINISH:\s*(.*\S)\s*$")
_VERDICT_RE = re.compile(r"VERDICT:\s*(CORRECT|PARTIAL|INCORRECT)", re.I)


def parse_action(text):
    """Return the LAST (name, arg) directive in the model output, or None.
    Tries `name(arg)` (keeps inner parens), then `name arg` (space form), then FINISH:."""
    result = None
    for line in text.splitlines():
        m = _ACTION_PAREN.match(line)
        if m:
            result = (m.group(1), m.group(2).strip())
            continue
        m = _ACTION_SPACE.match(line)
        if m:
            result = (m.group(1), (m.group(2) or "").strip())
            continue
        m = _FINISH_RE.match(line)
        if m:
            result = ("finish", m.group(1).strip())
    return result


def parse_verdict(text):
    """Extract the judge verdict; fail CLOSED to INCORRECT when unparseable."""
    m = _VERDICT_RE.search(text or "")
    return m.group(1).upper() if m else "INCORRECT"


# A FINISH whose text is itself an unexecuted command (the observed failure: the model
# built the right run_js/goto/fetch but pasted it into FINISH instead of running it).
_DIRECTIVE_LIKE = re.compile(
    r"^\s*(ACTION:|FINISH:|(goto|get_text|run_js|find|table|read|data|fetch|search|follow)\s*\()", re.I)


def looks_like_directive(answer):
    return bool(_DIRECTIVE_LIKE.match(answer or ""))


def _unquote(arg):
    """Strip ONE layer of wrapping quotes. A weak model writes goto("url")/fetch("url")/
    run_js("expr"); the paren parser keeps the quotes, so passing them raw to nc yields
    'Invalid URL' and the model loops. Stripping them is correct translation (what a bare
    goto(url) already does), condition-neutral across B and C."""
    a = (arg or "").strip()
    if len(a) >= 2 and a[0] in "\"'" and a[-1] == a[0]:
        a = a[1:-1]
    return a


def _split_arg(arg):
    """Strip one layer of wrapping quotes, then whitespace-split (for find/table args)."""
    return _unquote(arg).split()


# ------------------------------------------------------------------- deepseek client
def _api_key():
    k = os.environ.get("DEEPSEEK_API_KEY")
    if k:
        return k
    try:
        for line in open(SECRETS, encoding="utf-8"):
            line = line.strip()
            if line.startswith("DEEPSEEK_API_KEY"):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    raise RuntimeError("DEEPSEEK_API_KEY not found in env or secrets.env")


def call_deepseek(model, messages, temperature=0.0, max_tokens=6000, timeout=180):
    body = json.dumps({"model": model, "messages": messages,
                       "temperature": temperature, "max_tokens": max_tokens}).encode()
    req = urllib.request.Request(API_URL, data=body, headers={
        "Authorization": "Bearer " + _api_key(), "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = json.loads(r.read())
    return d["choices"][0]["message"]["content"] or ""


# ------------------------------------------------------------------- nightcrawl tool
def nc_cmd(args, timeout=60, engine=None):
    cmd = [BUN, "run", NC_CLI] + list(args)
    if engine:
        cmd.append("--engine=" + engine)
    env = dict(os.environ)
    env["PATH"] = os.path.expanduser("~/.bun/bin") + ":" + env.get("PATH", "")
    env["BROWSE_IGNORE_HTTPS_ERRORS"] = "1"
    # Cap nightcrawl output BELOW OBS_CAP so its "use find/table/data" footer survives
    # truncation (the footer is a teaching channel for the weak model).
    env["BROWSE_MAX_OUTPUT"] = "5000"
    env["NIGHTCRAWL_BLOCK_HEADED"] = "1"        # window-free: a long run never pops a window
    env["NIGHTCRAWL_NO_FAILURE_CAPTURE"] = "1"  # this is a measurement, not real usage
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        return "ERROR: nightcrawl timeout after %ss" % timeout
    return ((r.stdout or "") + (r.stderr or "")).strip()


# ------------------------------------------------------------------- naive fetch tool
def _http_get(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    return raw.decode("utf-8", "replace")


def _html_to_text(html):
    html = re.sub(r"(?is)<(script|style|noscript).*?</\1>", " ", html)
    html = re.sub(r"(?s)<[^>]+>", " ", html)
    html = re.sub(r"&nbsp;", " ", html)
    return re.sub(r"\s+", " ", html).strip()


# ------------------------------------------------------------------- agent loop
def agent_loop(task, tools, system, max_steps):
    msgs = [{"role": "system", "content": system},
            {"role": "user", "content": "Task: %s\nStart from: %s" % (task["task"], task["website"])}]
    log = []
    reprompted = False
    for _ in range(max_steps):
        out = call_deepseek(DS_MODEL_FLASH, msgs)
        log.append({"model": out[:600]})
        act = parse_action(out)
        if act is None:
            msgs += [{"role": "assistant", "content": out},
                     {"role": "user", "content": "Reply with exactly one ACTION: ... or FINISH: ... line."}]
            continue
        name, arg = act
        if name == "finish":
            # Honest-FINISH guard: a FINISH that is itself an unexecuted command means the
            # model built the right call but never ran it. Re-prompt ONCE to run it first.
            if looks_like_directive(arg) and not reprompted:
                reprompted = True
                msgs += [{"role": "assistant", "content": out},
                         {"role": "user", "content": "That FINISH is a command, not an answer. "
                          "Run it as an ACTION, read the OBSERVATION, THEN FINISH with the actual value."}]
                continue
            return arg, log
        fn = tools.get(name)
        obs = fn(arg) if fn else "Unknown action %r. Available: %s" % (name, list(tools))
        obs = (obs or "")[:OBS_CAP]
        log.append({"obs_" + name: obs[:400]})
        msgs += [{"role": "assistant", "content": out},
                 {"role": "user", "content": "OBSERVATION:\n" + obs}]
    msgs.append({"role": "user", "content": "Max steps reached. Output 'FINISH: <best answer now>'."})
    out = call_deepseek(DS_MODEL_FLASH, msgs)
    act = parse_action(out)
    return (act[1] if act and act[0] == "finish" else out[:300]), log


# ------------------------------------------------------------------- conditions
_A_SYS = ("Answer the question from your own knowledge only. You have NO web access. "
          "If you do not know, give your best guess. End with exactly one line 'FINISH: <answer>'.")

_C_SYS = ("You answer by fetching web pages. Tool:\n"
          "ACTION: fetch(<url>)  -> returns the page's visible text (no JS render, no login).\n"
          "When ready: FINISH: <answer>. Output exactly one directive per turn, nothing else.")

_B_SYS = ("You answer by driving a real browser (nightcrawl). PREFER the high-level tools "
          "below over run_js — they return structured data directly, so you rarely need to "
          "write JavaScript. Tools:\n"
          "ACTION: goto(<url>)          -> navigate to a page. If a goto fails (404/not found), "
          "DON'T guess another URL — use search() or goto the site homepage\n"
          "ACTION: search(<query>)      -> drive THIS site's own search box (finds the right page "
          "for you instead of guessing a URL)\n"
          "ACTION: follow(<keyword>)    -> click the on-page link best matching a keyword, in one "
          "step (e.g. walk a search result -> the document); no need to snapshot/inspect refs\n"
          "ACTION: find(<keyword>)      -> jump to a term in a big page; returns the surrounding "
          "text and a pointer to any table it is in\n"
          "ACTION: table(<index|near KW> [--sort COL] [--desc] [--top N]) -> extract a table as "
          "rows (no arg lists every table); --sort/--top ranks it so you READ OFF the max/min\n"
          "ACTION: read()               -> the readable main article text (cleaner than get_text)\n"
          "ACTION: data()               -> the JSON/CSV backend request behind a chart/data page, "
          "with a ready-to-run fetch (the numbers on a chart are NOT in the page text)\n"
          "ACTION: get_text()           -> raw visible text of the page (noisy; prefer read/find)\n"
          "ACTION: run_js(<expression>) -> last resort; must be ONE expression that RETURNS a value\n"
          "When ready: FINISH: <answer>. FINISH takes the ANSWER itself, never a command. "
          "Output exactly one directive per turn, nothing else.")


def condition_A(task):
    out = call_deepseek(DS_MODEL_FLASH, [{"role": "system", "content": _A_SYS},
                                         {"role": "user", "content": task["task"]}])
    act = parse_action(out)
    return (act[1] if act and act[0] == "finish" else out.strip()[:300]), [{"model": out[:600]}]


def _tools_fetch():
    def fetch(url):
        try:
            return _html_to_text(_http_get(_unquote(url)))
        except Exception as e:
            return "ERROR: %s" % e
    return {"fetch": fetch}


def _tools_nc():
    # engine="headless" is EXPLICIT: never inherit a sticky real-Arc tab. The
    # weak-model-lift measurement must isolate the engine variable, and a long
    # background run must never drive the user's real browser.
    def goto(url):
        # Return nc's REAL result (status / LOGIN_REQUIRED / error), not a blind
        # "navigated". The old version lied on failure, so the model kept reading the
        # STALE previous tab thinking it had navigated (the SEC task read example.com).
        out = nc_cmd(["goto", _unquote(url)], timeout=120, engine="headless")
        return out or ("navigated: " + url)
    return {"goto": goto,
            "get_text": lambda _="": nc_cmd(["text"], timeout=40, engine="headless"),
            "find": lambda kw: nc_cmd(["find"] + _split_arg(kw), timeout=40, engine="headless"),
            "table": lambda a="": nc_cmd(["table"] + _split_arg(a), timeout=40, engine="headless"),
            "read": lambda _="": nc_cmd(["read"], timeout=40, engine="headless"),
            "data": lambda _="": nc_cmd(["data"], timeout=40, engine="headless"),
            "search": lambda q: nc_cmd(["search"] + _split_arg(q), timeout=60, engine="headless"),
            "follow": lambda kw: nc_cmd(["follow"] + _split_arg(kw), timeout=60, engine="headless"),
            "run_js": lambda e: nc_cmd(["js", _unquote(e)], timeout=50, engine="headless")}


def condition_C(task):
    return agent_loop(task, _tools_fetch(), _C_SYS, max_steps=4)


def condition_B(task):
    return agent_loop(task, _tools_nc(), _B_SYS, max_steps=12)


# ------------------------------------------------------------------- judge (separate model)
_JUDGE_SYS = ("You grade a candidate answer against a reference answer for a web-retrieval task. "
              "Judge only whether the KEY FACT matches. Output exactly one line: "
              "'VERDICT: CORRECT', 'VERDICT: PARTIAL', or 'VERDICT: INCORRECT'.")


def judge(task, candidate):
    usr = "Question: %s\nReference answer: %s\nCandidate answer: %s" % (
        task["task"], task["answer"], candidate)
    out = call_deepseek(DS_MODEL_PRO, [{"role": "system", "content": _JUDGE_SYS},
                                       {"role": "user", "content": usr}], max_tokens=1500)
    return parse_verdict(out), out.strip()[:200]
