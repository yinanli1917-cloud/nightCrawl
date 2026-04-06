# HANDOFF — 2026-04-06

## What nightcrawl Is

The user's digital twin browser. Everything they can do in Arc, nightcrawl automates. Stealth is invisible infrastructure. Invoke via `/nightcrawl` skill.

## How to Run

```bash
export PATH="$HOME/.bun/bin:$PATH"
NC_DIR="/Users/yinanli/Documents/nightCrawl/stealth/browser"
BROWSE_EXTENSIONS=none BROWSE_EXTENSIONS_DIR= bun run $NC_DIR/src/cli.ts <command>
# Add BROWSE_IGNORE_HTTPS_ERRORS=1 for sites with bad certs
```

CDP patches require clean playwright-core on first run:
```bash
cd stealth/browser && rm -rf node_modules/playwright-core ~/.bun/install/cache/playwright-core@1.58.2@@@1 && bun install
```

## What's Working

### Stealth (verified 2026-04-05)
- CDP Runtime.Enable bypass (ported to PW 1.58.2)
- Dynamic UA from browsers.json (Chrome/145)
- navigator.webdriver deleted from prototype
- bot.sannysoft.com: UA/WebDriver/Chrome all PASS
- bot-detector.rebrowser.net: runtimeEnableLeak PASS

### Sites Verified
| Site | Status | Method |
|------|--------|--------|
| oversea.cnki.net | Full access | Direct stealth |
| CNKI China (www.cnki.net) | 42万 results | VPN proxy: `www--cnki--net--https.cnki.mdjsf.utuvpn.utuedu.com:9000` |
| wenshu.court.gov.cn | 871 results for "爬虫" | Handoff login (phone 15307739027), sessions expire on browser close |

### Cookie Persistence (generalized)
- Cookies auto-saved every 5 min + on shutdown + immediately after handoff/resume
- Stored at `~/.nightcrawl/browse-cookies.json`
- Auto-restored on next server startup
- Named states: `state save <name>` / `state load <name>` in `~/.nightcrawl/browse-states/`
- Saved state: `wenshu-authenticated` (3,164 cookies, likely expired)

### Handoff Flow
When nightcrawl can't get past a login (captcha, verification):
1. `handoff "message"` — opens headed Chrome at current page
2. User logs in manually (captcha, phone verification, whatever)
3. `resume` — closes headed, resumes headless, preserves all cookies
4. Cookies immediately persisted to disk for next session

Set `BROWSE_AUTO_HANDOVER=1` to auto-detect login walls and open headed mode.

## Known Issues

### XHS (小红书) — DO NOT TOUCH
User got a bot detection warning, account ban threatened. Must identify and fix detection vectors before accessing XHS again. Use throwaway account for testing. This is the ultimate benchmark.

### wenshu Sessions Expire
Server-side sessions die on browser close. Must handoff → login each new browser session. Image captcha blocks full automation.

### CNKI China Blocked Direct
Tencent Cloud WAF returns HTTP 418. Only accessible via university VPN proxy.

### Headless Limitations
- Plugins length = 0, WebGL = no context (inherent to headless, not fixable with JS)
- These don't trigger real-world detection

## nightcrawl Skill
At `.claude/skills/nightcrawl/SKILL.md`. Created via `/skill-creator` — eval loop started but not completed. 3 test prompts drafted (wenshu, sannysoft, CNKI VPN).

## Key Files
| File | Purpose |
|------|---------|
| `stealth/browser/src/stealth.ts` | All stealth: UA, patches, init scripts |
| `stealth/browser/src/browser-manager.ts` | Browser lifecycle, handoff/resume |
| `stealth/browser/src/server.ts` | HTTP server, cookie persistence, auto-handover |
| `stealth/patches/cdp/frames.js` | Patched for PW 1.58.2 |
| `.claude/skills/nightcrawl/SKILL.md` | Skill definition |

## Next Steps
1. Complete skill-creator eval loop (run test prompts, generate viewer, iterate)
2. XHS investigation (identify detection vectors with throwaway account)
3. Captcha solving for wenshu (screenshot + vision)
4. CNKI VPN personal login (modal form in iframe, credentials: 255122884 / Luffy551024usst for 上海理工大学)

## Commits This Session
```
e89e1d9 feat: nightcrawl skill, HTTPS error bypass, wenshu breakthrough
1072076 feat: CNKI China breakthrough — 42万 results via university VPN proxy
2ac18c8 fix: update wenshu test expectations, fix resume await
5fdb4b0 feat: stealth overhaul — CDP patches fixed, dynamic UA, anti-bot init scripts
```

---
*Created by Claude Code · 2026-04-06*
