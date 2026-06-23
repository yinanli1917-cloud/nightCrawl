# Capture FXBaogao PDF

## Goal

Use the FXBaogao PDF capture attempt as a live regression scenario to stabilize
nightcrawl's authenticated handoff flow. The system must preserve the digital
twin contract: prefer existing browser-cookie sync for approved domains, avoid
unexpected visible windows, keep headed takeover windows alive when explicitly
requested, and return to headless control so the report can be captured.

## Acceptance Criteria

- [ ] FXBaogao report access can proceed through the intended auth ladder:
      scoped Arc/default-browser cookie import first, then explicit headed
      handoff only when cookie import cannot authenticate the site.
- [ ] `open-handoff` / headed launch no longer opens a window that immediately
      collapses because the controlling server exits or crashes.
- [ ] Headed startup failures surface a clear actionable error and do not leave
      the browser pointed at extension options or an unrelated tab.
- [ ] The handoff path honors notification/consent expectations: no silent
      surprise popups except when the user explicitly requested the window.
- [ ] A focused regression check covers the headed launch failure observed in
      this task (`disposable: expected channel Disposable`) or the closest
      deterministic seam if the exact CloakBrowser crash cannot be unit-tested.
- [ ] After auth is stable, the FXBaogao report can be retried and the available
      full PDF or page-image reconstruction path is documented.

## Notes

- Trigger URL:
  `https://www.fxbaogao.com/view?id=5396498&requestId=2605075111389767&query=%7B%22keywords%22:%22%E6%96%B0%E8%83%BD%E6%BA%90%E6%B1%BD%E8%BD%A6%E5%87%BA%E6%B5%B7%22%7D&index=0&pid=&xid=`
- Observed public preview endpoint returns only two images:
  `/mofoun/report/report/getReportPreviewImages?reportId=5396498`.
- Authenticated detail endpoint returned `{"code":1009,"msg":"尚未登陆"}` after
  scoped Arc import found zero FXBaogao cookies.
- Manual headed launch failed with `disposable: expected channel Disposable`,
  matching the user's report that a visible window opened and immediately
  closed.
- Capture result: downloaded full 35-page PDF to
  `/Users/yinanli/Documents/nightCrawl/artifacts/fxbaogao-5396498-2026-china-nev-overseas.pdf`.
- Working capture route after QR login:
  inspect `PDFViewerApplication.url` in the logged-in viewer, then download the
  `https://report.fxbaogao.com/...pdf?auth_key=...` URL with
  `Referer: https://www.fxbaogao.com/`. Direct download without referer loops to
  the OSS 403 page.
- Remaining issues observed during capture:
  1. Arc cookie import was insufficient for FXBaogao: only `www` cookies were
     found, API calls still returned `1009 尚未登陆`.
  2. FXBaogao SPA stores auth in localStorage (`user.id`, `user.token`); direct
     API replay also needs the site's request guard/signature, not only token
     headers.
  3. `nc js` returned blank for some complex async object expressions, making
     endpoint probing opaque.
  4. `nc snapshot -i` timed out on the PDF viewer, so the capture path had to
     use DOM/JS probes instead.
  5. The auth token was accidentally printed during extraction. Treat the
     FXBaogao session token as exposed and rotate/log out if needed.
## Decisions

- q1: Yes. The user's latest direction is to continue improving nightcrawl, the demo agent, and the digital twin browser. Treat the FXBaogao PDF as the trigger scenario and stabilize the handoff/auth flow first, while preserving the ability to complete the capture after login works.
