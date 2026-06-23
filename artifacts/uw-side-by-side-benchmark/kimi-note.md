# Kimi WebBridge UW Benchmark Note

Health check passed: Kimi WebBridge reported `running: true`, `extension_connected: true`, daemon `v1.9.7`, extension `1.9.7`, port `10086`.

Canvas session `kimi-uw-canvas` partially reached authenticated context: after opening `https://canvas.uw.edu/`, Kimi `list_tabs` briefly reported URL `https://canvas.uw.edu/` with title `Dashboard`. I did not record course names, grades, account settings, or Canvas content. The required snapshot could not be completed because Kimi then reported the session tab had closed. A retry navigation timed out after 20 seconds and left no session tab, so dashboard/course-card reachability remains indeterminate.

UW Libraries session `kimi-uw-library` did not reach usable search results. Navigation to `https://www.lib.washington.edu/` timed out after 30 seconds, and direct navigation to the UW discovery search URL for `"browser automation AI web agents"` timed out after 45 seconds. Both attempts left zero tabs in the Kimi session, so no top-3 reference metadata could be extracted through Kimi.

Sessions created for this benchmark were closed at the end. Both close calls succeeded and reported `closed: 0`.

Artifacts:

- Structured result: `/Users/yinanli/Documents/nightCrawl/artifacts/uw-side-by-side-benchmark/kimi-results.json`
- Raw timing log: `/Users/yinanli/Documents/nightCrawl/artifacts/uw-side-by-side-benchmark/kimi-raw.jsonl`
