"""Session management: manual login via browser, save/load cookies."""

import json
import os
import asyncio
from playwright.async_api import async_playwright, BrowserContext


async def save_cookies(context: BrowserContext, cookie_file: str):
    """Save browser cookies to file."""
    cookies = await context.cookies()
    os.makedirs(os.path.dirname(cookie_file), exist_ok=True)
    with open(cookie_file, "w") as f:
        json.dump(cookies, f, indent=2)
    print(f"[AUTH] Cookies saved to {cookie_file} ({len(cookies)} cookies)")


async def load_cookies(context: BrowserContext, cookie_file: str) -> bool:
    """Load cookies from file into browser context. Returns True if loaded."""
    if not os.path.exists(cookie_file):
        return False
    with open(cookie_file, "r") as f:
        cookies = json.load(f)
    if not cookies:
        return False
    await context.add_cookies(cookies)
    print(f"[AUTH] Loaded {len(cookies)} cookies from {cookie_file}")
    return True


async def manual_login(site_key: str, site_config: dict) -> bool:
    """Open browser for user to manually login. Save cookies after."""
    base_url = site_config["base_url"]
    cookie_file = site_config["cookie_file"]
    name = site_config["name"]

    print(f"\n{'='*50}")
    print(f"[AUTH] Opening browser for {name}")
    print(f"[AUTH] URL: {base_url}")
    print(f"[AUTH] Please login manually, then press ENTER in this terminal.")
    print(f"{'='*50}\n")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        context = await browser.new_context()
        page = await context.new_page()
        await page.goto(base_url)

        # Wait for user to login
        await asyncio.get_event_loop().run_in_executor(
            None, input, f"[AUTH] Press ENTER after you have logged into {name}... "
        )

        await save_cookies(context, cookie_file)
        await browser.close()

    return True


async def ensure_session(site_key: str, site_config: dict, playwright_instance) -> BrowserContext:
    """Ensure we have valid cookies. Returns a browser context with cookies loaded.
    If cookies are invalid, opens browser for manual login."""
    cookie_file = site_config["cookie_file"]
    orders_url = site_config["orders_url"]

    browser = await playwright_instance.chromium.launch(headless=True)
    context = await browser.new_context()

    loaded = await load_cookies(context, cookie_file)
    if not loaded:
        await browser.close()
        await manual_login(site_key, site_config)
        browser = await playwright_instance.chromium.launch(headless=True)
        context = await browser.new_context()
        await load_cookies(context, cookie_file)
        return context, browser

    # Test if session is still valid by navigating to orders page
    page = await context.new_page()
    try:
        response = await page.goto(orders_url, wait_until="networkidle", timeout=30000)
        current_url = page.url

        # If redirected to login page, session expired
        if "login" in current_url.lower() or "signin" in current_url.lower():
            print(f"[AUTH] Session expired for {site_config['name']}, re-login needed")
            await browser.close()
            await manual_login(site_key, site_config)
            browser = await playwright_instance.chromium.launch(headless=True)
            context = await browser.new_context()
            await load_cookies(context, cookie_file)
    except Exception as e:
        print(f"[AUTH] Session check failed: {e}")
        await browser.close()
        await manual_login(site_key, site_config)
        browser = await playwright_instance.chromium.launch(headless=True)
        context = await browser.new_context()
        await load_cookies(context, cookie_file)
    else:
        await page.close()

    return context, browser
