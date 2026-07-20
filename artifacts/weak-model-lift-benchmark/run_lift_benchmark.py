"""
[INPUT]:  tasks.json (protocol3 subset); harness.py; DEEPSEEK_API_KEY.
[OUTPUT]: results-<ts>.json + a printed summary table with the B-C lift.
[POS]:    Orchestrates the weak-model-lift benchmark: each task x {A,C,B},
          judged by deepseek-v4-pro. One cell failing never aborts the run.
Run: python3 run_lift_benchmark.py [--limit N] [--only A,C,B]
"""
import os
import sys
import json
import time
import harness as H

ART = os.path.dirname(os.path.abspath(__file__))
CONDS = {"A": H.condition_A, "C": H.condition_C, "B": H.condition_B}


def _arg(flag, default=None):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else default


def main():
    tasks = json.load(open(os.path.join(ART, "tasks.json"), encoding="utf-8"))
    limit = int(_arg("--limit", len(tasks)))
    only = _arg("--only")
    conds = {k: v for k, v in CONDS.items() if not only or k in only.split(",")}
    tasks = tasks[:limit]
    ts = time.strftime("%Y%m%dT%H%M%S")
    results = []
    for t in tasks:
        row = {"task_idx": t["task_idx"], "website": t["website"], "ref": t["answer"], "cells": {}}
        print("\n=== task #%s %s" % (t["task_idx"], t["website"]))
        print("    Q:", t["task"][:90])
        for name, fn in conds.items():
            t0 = time.time()
            try:
                ans, log = fn(t)
                verdict, jreason = H.judge(t, ans)
                steps = len(log)
            except Exception as e:
                ans, verdict, jreason, steps = "ERROR: %s" % e, "INCORRECT", "run-error", 0
            dt = round(time.time() - t0, 1)
            row["cells"][name] = {"answer": ans[:400], "verdict": verdict,
                                  "judge": jreason, "steps": steps, "secs": dt}
            print("    [%s] %-9s %2ds/%ss  %s" % (name, verdict, steps, dt, ans[:70].replace("\n", " ")))
        results.append(row)
        json.dump(results, open(os.path.join(ART, "results-%s.json" % ts), "w"),
                  ensure_ascii=False, indent=2)

    # summary
    print("\n" + "=" * 60)
    tally = {k: {"CORRECT": 0, "PARTIAL": 0, "INCORRECT": 0} for k in conds}
    for row in results:
        for k in conds:
            tally[k][row["cells"][k]["verdict"]] += 1
    n = len(results)
    print("condition            CORRECT PARTIAL INCORRECT  (n=%d)" % n)
    for k in conds:
        t = tally[k]
        print("  %-18s   %d       %d        %d" % (k, t["CORRECT"], t["PARTIAL"], t["INCORRECT"]))
    if "B" in conds and "C" in conds:
        b, c = tally["B"]["CORRECT"], tally["C"]["CORRECT"]
        print("\n  nightcrawl lift (B-C, CORRECT count): %+d / %d" % (b - c, n))
    print("results -> results-%s.json" % ts)


if __name__ == "__main__":
    main()
