"""
Bill image generation using a shared browser instance.

Before: launched a new Chrome process per bill (~2-4s overhead each).
Now: reuses a single browser + page, just navigates to new HTML each time (~200-500ms per bill).
"""

import asyncio
import os
import json
from pyppeteer import launch

# --- Shared browser pool ---

_browser = None
_pages: dict[str, any] = {}  # "hal" | "anousith" -> Page


async def _get_browser():
    """Get or create the shared browser instance."""
    global _browser
    if _browser is None or not _browser.process:
        _browser = await launch(
            executablePath="/usr/bin/google-chrome",
            headless=True,
            args=["--disable-web-security", "--no-sandbox", "--disable-gpu"],
            handleSIGINT=False,
            handleSIGTERM=False,
            handleSIGHUP=False,
        )
    return _browser


async def _get_page(page_type, width=700, height=600):
    """Get or create a reusable page for the given type."""
    global _pages
    if page_type not in _pages or _pages[page_type].isClosed():
        browser = await _get_browser()
        page = await browser.newPage()
        await page.setViewport({"width": width, "height": height, "deviceScaleFactor": 1})
        _pages[page_type] = page
    return _pages[page_type]


async def close_browser():
    """Close shared browser. Call on shutdown."""
    global _browser, _pages
    if _browser:
        try:
            await _browser.close()
        except Exception:
            pass
        _browser = None
        _pages = {}


# --- Image generation ---

async def generate_image(bill, is_hal):
    """Generate a bill image. Uses shared browser for speed."""
    if is_hal:
        await _generate_hal(bill)
    else:
        await _generate_anousith(bill)


async def _generate_anousith(bill):
    raw_html = open("app.anousith-express.com/search_item.html", "r", encoding="utf-8").read()

    replacements = {
        "{{trackingId}}": bill["trackingId"],
        "{{originProvinceId.provinceName}}": bill["originProvinceId"]["provinceName"],
        "{{destProvinceId.provinceName}}": bill["destProvinceId"]["provinceName"],
        "{{originBranchId.branch_name}}": bill["originBranchId"]["branch_name"],
        "{{destBranchId.branch_name}}": bill["destBranchId"]["branch_name"],
        "{{customerId.full_name}}": bill["customerId"]["full_name"],
        "{{customerId.contact_info}}": bill["customerId"]["contact_info"],
        "{{receiverName}}": bill["receiverName"],
        "{{receiverPhone}}": bill["receiverPhone"],
        "{{width}}": str(bill["width"]),
        "{{weight}}": str(bill["weight"]),
        "{{packagePrice}}": f'{bill["packagePrice"]:,}',
        "{{itemValueKIP}}": f'{bill["itemValueKIP"]:,}',
        "{{totalValueInKip}}": f'{bill["packagePrice"] + bill["itemValueKIP"]:,}',
    }

    for key, val in replacements.items():
        raw_html = raw_html.replace(key, val)

    html_file = f"app.anousith-express.com/{bill['_id']}.html"
    os.makedirs(os.path.dirname(html_file), exist_ok=True)
    with open(html_file, "w", encoding="utf-8") as f:
        f.write(raw_html)

    try:
        page = await _get_page("anousith", width=700, height=600)
        file_url = f"file:///{os.path.abspath(html_file)}"
        await page.goto(file_url, {"waitUntil": "networkidle0"})

        output_path = f"image_bill/bill_anousith_{bill['_id']}.png"
        os.makedirs(os.path.dirname(output_path), exist_ok=True)

        el = await page.querySelector(".bill-content")
        if el:
            await el.screenshot({"path": output_path})
        else:
            await page.screenshot({"path": output_path})
    finally:
        try:
            os.remove(html_file)
        except OSError:
            pass


async def _generate_hal(bill):
    raw_html = open("halOrder/index.html", "r", encoding="utf-8").read()

    replacements = {
        "{{start_date_actual}}": bill["start_date_actual"],
        "{{shipment_number}}": bill["shipment_number"],
        "{{sender_customer.name}}": bill["sender_customer"]["name"],
        "{{sender_customer.tel}}": bill["sender_customer"]["tel"],
        "{{receiver_customer.name}}": bill["receiver_customer"]["name"],
        "{{receiver_customer.tel}}": bill["receiver_customer"]["tel"],
        "{{start_branch.name}}": bill["start_branch"]["name"],
        "{{end_branch.name}}": bill["end_branch"]["name"],
        "{{parcel.name}}": bill["parcel"]["name"] or "ແປ້ງທາຜິວກາຍ",
        "{{pieces}}": str(bill["pieces"]),
        "{{parcel.weight}}": str(bill["parcel"]["weight"]),
        "{{parcel.weight_unit}}": bill["parcel"]["weight_unit"],
        "{{parcel.dimension_length}}": str(bill["parcel"]["dimension_length"]),
        "{{total_freight}}": str(bill["total_freight"]),
        "{{total_price}}": str(bill["total_price"]),
    }

    for key, val in replacements.items():
        raw_html = raw_html.replace(key, val)

    html_file = f"halOrder/{bill['id']}.html"
    with open(html_file, "w", encoding="utf-8") as f:
        f.write(raw_html)

    try:
        page = await _get_page("hal", width=400, height=600)
        file_url = f"file:///{os.path.abspath(html_file)}"
        await page.goto(file_url, {"waitUntil": "networkidle0"})

        output_path = f"image_bill/bill_hal_{bill['id']}.png"
        os.makedirs(os.path.dirname(output_path), exist_ok=True)

        el = await page.querySelector(".outer")
        if el:
            await el.screenshot({"path": output_path})
        else:
            await page.screenshot({"path": output_path})
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
