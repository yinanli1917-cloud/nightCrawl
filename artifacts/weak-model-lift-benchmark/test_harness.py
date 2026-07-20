"""
[INPUT]:  harness module (parse_action, parse_verdict, call_deepseek, nc_cmd).
[OUTPUT]: pure-logic unit tests + opt-in live smoke (RUN_LIVE=1).
[POS]:    TDD guard for the weak-model-lift benchmark. Parsers unit-tested;
          network calls gated so red->green never depends on connectivity.
Run:  python3 test_harness.py            (unit only)
      RUN_LIVE=1 python3 test_harness.py  (unit + live smoke)
"""
import os
import harness as H


def test_parse_action_goto():
    assert H.parse_action("thinking\nACTION: goto(https://a.com/x)") == ("goto", "https://a.com/x")


def test_parse_action_get_text():
    assert H.parse_action("ACTION: get_text()") == ("get_text", "")


def test_parse_action_run_js_keeps_inner_parens():
    a, arg = H.parse_action("ACTION: run_js(document.title.slice(0,5))")
    assert a == "run_js" and arg == "document.title.slice(0,5)"


def test_parse_action_fetch():
    assert H.parse_action("ACTION: fetch(https://b.com)") == ("fetch", "https://b.com")


def test_parse_action_finish():
    assert H.parse_action("reason\nFINISH: The answer is 42") == ("finish", "The answer is 42")


def test_parse_action_last_directive_wins():
    txt = "ACTION: get_text()\nlater\nFINISH: done"
    assert H.parse_action(txt) == ("finish", "done")


def test_parse_action_none_when_absent():
    assert H.parse_action("just prose") is None


def test_parse_action_space_form_goto():
    # The observed weak-model fumble: goto without parens must still parse.
    assert H.parse_action("ACTION: goto https://clinicaltrials.gov/search?cond=X") == \
        ("goto", "https://clinicaltrials.gov/search?cond=X")


def test_parse_action_space_form_bare_command():
    assert H.parse_action("ACTION: get_text") == ("get_text", "")
    assert H.parse_action("ACTION: data") == ("data", "")


def test_parse_action_paren_still_wins():
    assert H.parse_action("ACTION: run_js(document.title.slice(0,5))") == \
        ("run_js", "document.title.slice(0,5)")


def test_parse_verdict_correct():
    assert H.parse_verdict("ok\nVERDICT: CORRECT") == "CORRECT"


def test_parse_verdict_partial():
    assert H.parse_verdict("VERDICT: PARTIAL close") == "PARTIAL"


def test_parse_verdict_fails_closed():
    assert H.parse_verdict("rambled, no token") == "INCORRECT"


def test_looks_like_directive_flags_unexecuted_commands():
    assert H.looks_like_directive("run_js(fetch('/x').then(r=>r.json()))")
    assert H.looks_like_directive("goto(https://a.com)")
    assert H.looks_like_directive("ACTION: get_text()")
    assert H.looks_like_directive("data()")


def test_looks_like_directive_passes_real_answers():
    assert not H.looks_like_directive("2006")
    assert not H.looks_like_directive("The answer is 524 million")
    assert not H.looks_like_directive("NCT03393000, enrollment 19")


def test_split_arg_strips_quotes_and_splits():
    assert H._split_arg('"Operating lease"') == ["Operating", "lease"]
    assert H._split_arg("near Thereafter") == ["near", "Thereafter"]
    assert H._split_arg("0") == ["0"]
    assert H._split_arg("") == []


def test_unquote_strips_wrapping_quotes_for_goto():
    # The real held-out bug: goto("url") kept the quotes -> nc 'Invalid URL' -> the model
    # looped. _unquote fixes it while leaving a bare url and inner quotes untouched.
    assert H._unquote('"https://ourworldindata.org/co2-emissions"') == "https://ourworldindata.org/co2-emissions"
    assert H._unquote("'https://a.com/x'") == "https://a.com/x"
    assert H._unquote("https://a.com/x") == "https://a.com/x"
    assert H._unquote('document.querySelector("a").href') == 'document.querySelector("a").href'


def test_live_deepseek_roundtrip():
    if os.environ.get("RUN_LIVE") != "1":
        print("  (skip live deepseek)"); return
    out = H.call_deepseek(H.DS_MODEL_FLASH, [{"role": "user", "content": "Reply with exactly: PONG"}])
    assert "PONG" in out.upper(), out


def test_live_nc_goto():
    if os.environ.get("RUN_LIVE") != "1":
        print("  (skip live nc)"); return
    H.nc_cmd(["goto", "https://example.com"], timeout=90)
    txt = H.nc_cmd(["text"], timeout=30)
    assert "example" in txt.lower(), txt[:200]


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    p = f = 0
    for fn in fns:
        try:
            fn(); print(f"PASS {fn.__name__}"); p += 1
        except Exception as e:
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {e}"); f += 1
    print(f"\n{p} passed, {f} failed")
    raise SystemExit(1 if f else 0)
