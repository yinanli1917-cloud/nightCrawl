# Deliverable verification playbook

Companion to the nightcrawl skill **Deliverable Verification Contract** section.

## Recipe: library search + download (Primo / Discovery)

**Intent:** User gets the publisher PDF for a known record (title or DOI).

**Plan checks:**

1. Search results contain record title (or DOI).
2. Fulldisplay page shows same title + DOI.
3. Resolved download URL is `.../download/` or Crossref `application/pdf` link — not a random `/view/.../galley` from homepage.
4. File passes `nc verify file --kind publisher-pdf --contains "<title fragment>" --min-pages 2`.

**Acquire:**

```bash
# Search (homepage box or direct Discovery URL)
nc goto "https://search.lib.uw.edu/discovery/search?query=any,contains,<QUERY>..."
nc text | head -40   # confirm results

# Record
nc click @e<result-link>
nc text | grep -i "<title fragment>"

# Resolve publisher PDF URL — prefer DOI, not guessing
curl -s "https://api.crossref.org/works/<DOI>" | jq -r '.message.link[] | select(.["content-type"]=="application/pdf") | .URL'

# Download bytes (curl or future nc fetch — must be file bytes, not nc pdf)
curl -fL -o "$OUT/article.pdf" "<publisher-download-url>"

# Assert
nc verify file "$OUT/article.pdf" --kind publisher-pdf --contains "<title fragment>" --min-pages 2
```

**Never:** `nc pdf` for this intent.

## Recipe: logged-in page state

```bash
nc goto https://canvas.uw.edu/
nc verify page --url-includes canvas.uw.edu --text-includes Dashboard --text-excludes "sign in"
```

## Recipe: explicit "save this page as PDF"

User asked for a visual capture, not a publisher file.

```bash
nc pdf /tmp/page-capture.pdf
nc verify file /tmp/page-capture.pdf --kind page-print-pdf --allow-browser-print --contains "<expected heading>"
```

## Recipe: extracted list (top N results)

```bash
nc text > /tmp/results.txt
# Assert in agent logic: count lines matching pattern, spot-check #1 title
nc verify page --text-includes "<query term>"
```

## When verify fails

1. Do not claim completion.
2. Return `VERIFY_FAILED` checks to the user.
3. Retry from the failed layer (wrong URL → re-resolve; wrong file → re-download bytes).

## CLI reference

```bash
nc verify file <path> \
  [--kind publisher-pdf|page-print-pdf|json|image] \
  [--contains TEXT]... \
  [--not-contains TEXT]... \
  [--min-pages N] [--min-bytes N]

nc verify page \
  [--url-includes FRAG]... [--url-excludes FRAG]... \
  [--text-includes TEXT]... [--text-excludes TEXT]...
```

Requires `pdftotext` / `pdfinfo` (poppler) when installed; degrades to byte-string scan otherwise.
