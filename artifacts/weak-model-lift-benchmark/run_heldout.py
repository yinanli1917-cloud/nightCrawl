"""Generalization run: condition B (flash + nightcrawl) on 12 HELD-OUT tasks the
primitives were never tuned against. Proves the approach isn't overfit to the 6."""
import json, os, time
import harness as H
ART = os.path.dirname(os.path.abspath(__file__))
tasks = json.load(open(os.path.join(ART, "heldout-tasks.json"), encoding="utf-8"))
ts = time.strftime("%Y%m%dT%H%M%S")
results = []
for t in tasks:
    t0 = time.time()
    try:
        ans, log = H.condition_B(t)
        verdict, jr = H.judge(t, ans)
        steps = len(log)
    except Exception as e:
        ans, verdict, jr, steps = "ERROR: %s" % e, "INCORRECT", "run-error", 0
    row = {"task_idx": t["task_idx"], "website": t["website"], "ref": t["answer"],
           "verdict": verdict, "answer": ans[:300], "steps": steps, "secs": round(time.time()-t0,1)}
    results.append(row)
    print("[%s] %-9s %2ds  %s | %s" % (t["task_idx"], verdict, steps, t["website"][:30], ans[:50].replace("\n"," ")))
    json.dump(results, open(os.path.join(ART, "heldout-results-%s.json" % ts), "w"), ensure_ascii=False, indent=2)
c = sum(1 for r in results if r["verdict"] == "CORRECT")
p = sum(1 for r in results if r["verdict"] == "PARTIAL")
print("\nHELD-OUT B: %d CORRECT, %d PARTIAL, %d INCORRECT (n=%d)" % (c, p, len(results)-c-p, len(results)))
