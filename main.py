"""AutoBill Pancake - Auto crawl orders & render shipping labels as PNG."""

import asyncio
import json
import os
import sys
import signal
from datetime import datetime

from playwright.async_api import async_playwright

from auth import ensure_session, save_cookies
from crawler import crawl_orders, load_existing_orders, save_orders, get_new_orders
from renderer import render_label_to_png


CONFIG_FILE = os.path.join(os.path.dirname(__file__), "config.json")
running = True


def load_config():
    with open(CONFIG_FILE, "r") as f:
        return json.load(f)


def signal_handler(sig, frame):
    global running
    print("\n[MAIN] Shutting down gracefully...")
    running = False


async def process_site(site_key: str, site_config: dict, config: dict, pw):
    """Process a single site: ensure session, crawl, render new labels."""
    try:
        context, browser = await ensure_session(site_key, site_config, pw)
    except Exception as e:
        print(f"[MAIN] Failed to get session for {site_config['name']}: {e}")
        return

    try:
        # Crawl orders
        orders = await crawl_orders(context, site_key, site_config)

        # Save updated cookies after crawling
        await save_cookies(context, site_config["cookie_file"])

        # Check for new orders
        existing = load_existing_orders(config.get("data_dir", "data"))
        new_orders = get_new_orders(orders, existing)

        if new_orders:
            print(f"[MAIN] {len(new_orders)} new orders from {site_config['name']}")
            for order in new_orders:
                tracking = order.get("tracking_number", "unknown")
                try:
                    output_path = await render_label_to_png(
                        order, config.get("output_dir", "output"), pw
                    )
                    print(f"[MAIN] ✓ {tracking} → {output_path}")
                    existing[tracking] = {
                        **{k: v for k, v in order.items() if k != "raw"},
                        "rendered_at": datetime.now().isoformat(),
                        "image_path": output_path,
                    }
                except Exception as e:
                    print(f"[MAIN] ✗ Failed to render {tracking}: {e}")

            save_orders(existing, config.get("data_dir", "data"))
        else:
            print(f"[MAIN] No new orders from {site_config['name']}")

    except Exception as e:
        print(f"[MAIN] Error processing {site_config['name']}: {e}")
        import traceback
        traceback.print_exc()
    finally:
        await browser.close()


async def run_once(config: dict):
    """Run one crawl cycle for all sites."""
    async with async_playwright() as pw:
        for site_key, site_config in config["sites"].items():
            await process_site(site_key, site_config, config, pw)


async def run_daemon(config: dict):
    """Run continuously, polling at configured interval."""
    global running
    interval = config.get("poll_interval_seconds", 300)

    print(f"[MAIN] AutoBill Pancake daemon started")
    print(f"[MAIN] Poll interval: {interval}s")
    print(f"[MAIN] Output dir: {config.get('output_dir', 'output')}")
    print(f"[MAIN] Press Ctrl+C to stop\n")

    # First run
    await run_once(config)

    # Daemon loop
    while running:
        print(f"\n[MAIN] Next poll in {interval}s... ({datetime.now().strftime('%H:%M:%S')})")
        for _ in range(interval):
            if not running:
                break
            await asyncio.sleep(1)

        if running:
            print(f"\n[MAIN] === Poll cycle at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} ===")
            await run_once(config)

    print("[MAIN] Daemon stopped.")


def main():
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    config = load_config()

    # Create directories
    os.makedirs(config.get("output_dir", "output"), exist_ok=True)
    os.makedirs(config.get("data_dir", "data"), exist_ok=True)
    os.makedirs(config.get("sessions_dir", "sessions"), exist_ok=True)

    mode = sys.argv[1] if len(sys.argv) > 1 else "daemon"

    if mode == "once":
        print("[MAIN] Running single crawl cycle...")
        asyncio.run(run_once(config))
    elif mode == "login":
        # Force re-login for a specific site
        site = sys.argv[2] if len(sys.argv) > 2 else None
        if site and site in config["sites"]:
            from auth import manual_login
            asyncio.run(manual_login(site, config["sites"][site]))
        else:
            print(f"Usage: python main.py login <{'|'.join(config['sites'].keys())}>")
    else:
        asyncio.run(run_daemon(config))


if __name__ == "__main__":
    main()
