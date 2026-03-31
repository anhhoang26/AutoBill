"""Render shipping labels as PNG images using HTML templates + Playwright screenshot."""

import os
import tempfile
from datetime import datetime, timezone, timedelta
from jinja2 import Environment, FileSystemLoader


TEMPLATES_DIR = os.path.join(os.path.dirname(__file__), "templates")
jinja_env = Environment(loader=FileSystemLoader(TEMPLATES_DIR))

# Lao timezone (UTC+7)
LAO_TZ = timezone(timedelta(hours=7))


def format_number(value):
    """Format number with comma separator."""
    try:
        return f"{int(float(str(value))):,}"
    except (ValueError, TypeError):
        return str(value)


def format_anousith_date(iso_date_str):
    """Convert ISO date string to 'DD-MM-YYYY, HH:MM' in Lao timezone."""
    if not iso_date_str:
        return ""
    try:
        dt = datetime.fromisoformat(iso_date_str.replace("Z", "+00:00"))
        dt_lao = dt.astimezone(LAO_TZ)
        return dt_lao.strftime("%d-%m-%Y, %H:%M")
    except Exception:
        return str(iso_date_str)


def anousith_api_to_template(item: dict) -> dict:
    """Convert Anousith ItemsV2 API response item to template variables."""
    customer = item.get("customerId") or {}
    origin_branch = item.get("originBranchId") or {}
    dest_branch = item.get("destBranchId") or {}
    origin_province = item.get("originProvinceId") or {}
    dest_province = item.get("destProvinceId") or {}
    received_by = item.get("originReceiveBy") or item.get("createdBy") or {}

    package_price = item.get("packagePrice", 0) or 0
    item_value_kip = item.get("itemValueKIP", 0) or 0
    is_cod = str(item.get("isCod", "0")) == "1"
    charge_on_shop = item.get("charge_on_shop", 0) == 1

    total = package_price + (item_value_kip if is_cod else 0)

    return {
        "source": "anousith",
        "tracking_number": item.get("trackingId", ""),
        "item_name": item.get("itemName", ""),
        "date": format_anousith_date(item.get("originReceiveDate")),
        "received_by": received_by.get("first_name", ""),
        "origin_province": origin_province.get("provinceName", ""),
        "dest_province": dest_province.get("provinceName", ""),
        "origin_branch": origin_branch.get("branch_name", ""),
        "dest_branch": dest_branch.get("branch_name", ""),
        "sender_id": customer.get("id_list", ""),
        "sender_name": customer.get("full_name", ""),
        "sender_phone": customer.get("contact_info", ""),
        "receiver_name": item.get("receiverName", ""),
        "receiver_phone": item.get("receiverPhone", ""),
        "dest_address": dest_branch.get("branch_address", ""),
        "dest_contact": dest_branch.get("contactInfo", ""),
        "width": item.get("width", 0),
        "weight": item.get("weight", 0),
        "package_price_display": format_number(package_price),
        "is_cod": is_cod,
        "charge_on_shop": charge_on_shop,
        "cod_display": format_number(item_value_kip),
        "total_display": format_number(total),
    }


def hal_api_to_template(item: dict) -> dict:
    """Convert HAL shipments/orders API response item to template variables."""
    sender = item.get("sender_customer") or {}
    receiver = item.get("receiver_customer") or {}
    start_branch = item.get("start_branch") or {}
    end_branch = item.get("end_branch") or {}
    parcel = item.get("parcel") or {}
    parcel_category = parcel.get("parcel_category") or {}

    return {
        "source": "hal",
        "tracking_number": item.get("shipment_number", ""),
        "date": item.get("start_date_actual", ""),
        "sender_name": sender.get("name", ""),
        "sender_phone": sender.get("tel", ""),
        "receiver_name": receiver.get("name", ""),
        "receiver_phone": receiver.get("tel", ""),
        "from_branch": start_branch.get("name", ""),
        "to_branch": end_branch.get("name", ""),
        "item_description": parcel_category.get("name_la") or parcel.get("name", ""),
        "quantity": item.get("pieces", 1),
        "weight": parcel.get("weight", 0),
        "size": parcel.get("dimension_length", 0),
        "cdc_amount": format_number(item.get("total_freight", 0)),
        "cod_amount": format_number(item.get("total_price", 0)),
    }


def render_label_html(order: dict) -> str:
    """Render order data into HTML label string."""
    source = order.get("source", "hal")
    template_name = f"{source}_label.html"
    template = jinja_env.get_template(template_name)
    return template.render(**order)


async def render_label_to_png(order: dict, output_dir: str, playwright_instance) -> str:
    """Render order label to PNG file. Returns output file path."""
    source = order.get("source", "hal")
    tracking = order.get("tracking_number", "unknown")
    safe_tracking = "".join(c for c in str(tracking) if c.isalnum() or c in "-_")

    # Create output directory
    site_output_dir = os.path.join(output_dir, source)
    os.makedirs(site_output_dir, exist_ok=True)
    output_path = os.path.join(site_output_dir, f"{safe_tracking}.png")

    # Render HTML
    html_content = render_label_html(order)

    # Write to temp file
    with tempfile.NamedTemporaryFile(mode="w", suffix=".html", delete=False, encoding="utf-8") as f:
        f.write(html_content)
        temp_html = f.name

    try:
        browser = await playwright_instance.chromium.launch(headless=True)
        page = await browser.new_page(viewport={"width": 520, "height": 900}, device_scale_factor=2)
        await page.goto(f"file://{temp_html}")

        # Wait for barcode and fonts to render
        await page.wait_for_timeout(2000)

        # Screenshot just the label element
        label = await page.query_selector("#label")
        if label:
            await label.screenshot(path=output_path)
        else:
            await page.screenshot(path=output_path, full_page=True)

        await browser.close()
        print(f"[RENDER] Saved label: {output_path}")
    finally:
        os.unlink(temp_html)

    return output_path
