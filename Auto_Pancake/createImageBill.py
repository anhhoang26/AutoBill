"""
Bill image generation using a shared Playwright browser instance.

Reuses a single browser + page, just navigates to new HTML each time (~200-500ms per bill).
"""

import asyncio
import os
import sys
import json
from playwright.async_api import async_playwright

# Add parent dir so we can import renderer
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from renderer import anousith_api_to_template, hal_api_to_template, render_label_html

# --- Shared browser + page pool ---

PAGE_POOL_SIZE = 5  # should match process_bills_batch concurrency

_playwright = None
_browser = None
_page_pool: asyncio.Queue | None = None
_pool_init_lock = asyncio.Lock()


async def _get_browser():
    """Get or create the shared browser instance."""
    global _playwright, _browser
    if _playwright is None:
        _playwright = await async_playwright().start()
    if _browser is None or not _browser.is_connected():
        _browser = await _playwright.chromium.launch(
            headless=True,
            args=["--disable-web-security", "--no-sandbox", "--disable-gpu"],
        )
    return _browser


async def _get_page_pool() -> asyncio.Queue:
    """Lazy-init a queue of pre-opened pages. Callers `get()` a page, `put()` it back."""
    global _page_pool
    if _page_pool is not None:
        return _page_pool
    async with _pool_init_lock:
        if _page_pool is not None:
            return _page_pool
        browser = await _get_browser()
        pool: asyncio.Queue = asyncio.Queue()
        for _ in range(PAGE_POOL_SIZE):
            page = await browser.new_page(
                viewport={"width": 800, "height": 900},
                device_scale_factor=2,
            )
            await pool.put(page)
        _page_pool = pool
        return pool


async def close_browser():
    """Close shared browser. Call on shutdown."""
    global _browser, _page_pool, _playwright
    _page_pool = None
    if _browser:
        try:
            await _browser.close()
        except Exception:
            pass
        _browser = None
    if _playwright:
        try:
            await _playwright.stop()
        except Exception:
            pass
        _playwright = None


# --- Image generation ---

async def generate_image(bill, is_hal):
    """Generate a bill image. Uses shared browser for speed."""
    if is_hal:
        await _generate_hal(bill)
    else:
        await _generate_anousith(bill)


async def _render_bill(html_content, html_file, output_path):
    """Render HTML to PNG using a page from the shared pool (up to PAGE_POOL_SIZE in parallel)."""
    os.makedirs(os.path.dirname(html_file), exist_ok=True)
    with open(html_file, "w", encoding="utf-8") as f:
        f.write(html_content)

    pool = await _get_page_pool()
    page = await pool.get()
    try:
        file_url = f"file:///{os.path.abspath(html_file)}"
        await page.goto(file_url, wait_until="load")
        try:
            # JsBarcode fills #barcode svg after CDN script loads — wait for it to have content
            await page.wait_for_function(
                "() => { const b = document.querySelector('#barcode'); return b && b.children.length > 0; }",
                timeout=3000,
            )
        except Exception:
            pass

        el = await page.query_selector("#label")
        if el:
            await el.screenshot(path=output_path)
        else:
            await page.screenshot(path=output_path)
    finally:
        await pool.put(page)
        try:
            os.remove(html_file)
        except OSError:
            pass


async def _generate_anousith(bill):
    template_data = anousith_api_to_template(bill)
    raw_html = render_label_html(template_data)
    html_file = f"image_bill/{bill['_id']}.html"
    output_path = f"image_bill/bill_anousith_{bill['_id']}.png"
    await _render_bill(raw_html, html_file, output_path)


async def _generate_hal(bill):
    template_data = hal_api_to_template(bill)
    raw_html = render_label_html(template_data)
    html_file = f"image_bill/{bill['id']}.html"
    output_path = f"image_bill/bill_hal_{bill['id']}.png"
    await _render_bill(raw_html, html_file, output_path)


# --- Legacy sync wrappers ---

def anousith(bill):
    asyncio.run(_generate_anousith(bill))


def hal(bill):
    asyncio.run(_generate_hal(bill))


if __name__ == "__main__":
    orders = json.load(open("listCurrentProcess.json", "r", encoding="utf-8"))
    asyncio.run(_generate_anousith(orders[0]))
