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

# --- Shared browser pool ---

_playwright = None
_browser = None
_pages: dict[str, any] = {}  # "hal" | "anousith" -> Page


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


async def _get_page(page_type, width=520, height=900):
    """Get or create a reusable page for the given type."""
    global _pages
    if page_type not in _pages or _pages[page_type].is_closed():
        browser = await _get_browser()
        page = await browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=2)
        _pages[page_type] = page
    return _pages[page_type]


async def close_browser():
    """Close shared browser. Call on shutdown."""
    global _browser, _pages, _playwright
    if _browser:
        try:
            await _browser.close()
        except Exception:
            pass
        _browser = None
        _pages = {}
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


async def _generate_anousith(bill):
    template_data = anousith_api_to_template(bill)
    raw_html = render_label_html(template_data)

    html_file = f"image_bill/{bill['_id']}.html"
    os.makedirs(os.path.dirname(html_file), exist_ok=True)
    with open(html_file, "w", encoding="utf-8") as f:
        f.write(raw_html)

    try:
        page = await _get_page("anousith", width=520, height=900)
        file_url = f"file:///{os.path.abspath(html_file)}"
        await page.goto(file_url, wait_until="networkidle")
        await page.wait_for_timeout(1000)

        output_path = f"image_bill/bill_anousith_{bill['_id']}.png"

        el = await page.query_selector("#label")
        if el:
            await el.screenshot(path=output_path)
        else:
            await page.screenshot(path=output_path)
    finally:
        try:
            os.remove(html_file)
        except OSError:
            pass


async def _generate_hal(bill):
    template_data = hal_api_to_template(bill)
    raw_html = render_label_html(template_data)

    html_file = f"image_bill/{bill['id']}.html"
    os.makedirs(os.path.dirname(html_file), exist_ok=True)
    with open(html_file, "w", encoding="utf-8") as f:
        f.write(raw_html)

    try:
        page = await _get_page("hal", width=520, height=900)
        file_url = f"file:///{os.path.abspath(html_file)}"
        await page.goto(file_url, wait_until="networkidle")
        await page.wait_for_timeout(1000)

        output_path = f"image_bill/bill_hal_{bill['id']}.png"

        el = await page.query_selector("#label")
        if el:
            await el.screenshot(path=output_path)
        else:
            await page.screenshot(path=output_path)
    finally:
        try:
            os.remove(html_file)
        except OSError:
            pass


# --- Legacy sync wrappers ---

def anousith(bill):
    asyncio.run(_generate_anousith(bill))


def hal(bill):
    asyncio.run(_generate_hal(bill))


if __name__ == "__main__":
    orders = json.load(open("listCurrentProcess.json", "r", encoding="utf-8"))
    asyncio.run(_generate_anousith(orders[0]))
