"""Render shipping labels as PNG images using HTML templates + Playwright screenshot."""

import os
import tempfile
from jinja2 import Environment, FileSystemLoader


TEMPLATES_DIR = os.path.join(os.path.dirname(__file__), "templates")
jinja_env = Environment(loader=FileSystemLoader(TEMPLATES_DIR))


def render_label_html(order: dict) -> str:
    """Render order data into HTML label string."""
    source = order.get("source", "hal")
    template_name = f"{source}_label.html"
    template = jinja_env.get_template(template_name)

    # Format amounts with comma separator
    cod = order.get("cod_amount", 0)
    cdc = order.get("cdc_amount", 0)
    try:
        cod = f"{int(float(str(cod))):,}"
    except (ValueError, TypeError):
        cod = str(cod)
    try:
        cdc = f"{int(float(str(cdc))):,}"
    except (ValueError, TypeError):
        cdc = str(cdc)

    context = {
        **order,
        "cod_amount": cod,
        "cdc_amount": cdc,
    }
    return template.render(**context)


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
        page = await browser.new_page(viewport={"width": 500, "height": 800})
        await page.goto(f"file://{temp_html}")

        # Wait for barcode to render
        await page.wait_for_timeout(1000)

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
