# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AutoBill is a Python asyncio application that crawls logistics websites (HAL Logistics, Anousith Express) for shipping orders and renders shipping labels as PNG images. It uses Playwright for browser automation and network interception, Jinja2 for HTML templating, and stores all data as JSON files.

## Commands

```bash
# Install dependencies
pip install -r requirements.txt
playwright install chromium

# Run modes
python main.py daemon    # Continuous polling (default, every 300s)
python main.py once      # Single crawl cycle
python main.py login <site>  # Force re-login (site: "hal" or "anousith")
```

No test framework, linter, or formatter is configured.

## Architecture

**Pipeline flow:** `main.py` orchestrates → `auth.py` ensures valid session → `crawler.py` intercepts API responses during page load → `renderer.py` renders Jinja2 HTML templates to PNG via Playwright screenshot.

**Key modules:**
- **main.py** — Entry point, daemon loop, config loading, graceful shutdown (SIGINT/SIGTERM)
- **auth.py** — Cookie-based session persistence with manual browser login fallback
- **crawler.py** — Network request interception to capture API responses; site-specific parsers (`parse_hal_responses`, `parse_anousith_responses`) normalize orders into a standard schema; deduplication against `data/orders.json`
- **renderer.py** — Renders label HTML with Jinja2, screenshots the `#label` element to PNG using Playwright

**Templates** (`templates/`): `hal_label.html` (red theme) and `anousith_label.html` (blue theme) — HTML labels with JsBarcode barcodes, Lao language text, CSS Grid layout at 420px width.

**Data flow:** Cookies in `sessions/`, orders in `data/orders.json`, debug API responses in `data/debug/`, rendered PNGs in `output/{source}/{tracking_number}.png`.

**Adding a new logistics site** requires: a new entry in `config.json` sites, a parser function in `crawler.py`, a normalizer function in `crawler.py`, and a new HTML template in `templates/`.

## Conventions

- Async/await throughout (Playwright requires it)
- Print-based logging with `[MODULE_NAME]` prefixes (e.g., `[MAIN]`, `[AUTH]`, `[CRAWL]`, `[RENDER]`)
- `Auto_Pancake/` is a legacy directory — not part of the active pipeline
