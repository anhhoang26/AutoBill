"""
AutoBill main pipeline - async with concurrent bill processing.

Pipeline:
  1. Login to logistics APIs (HAL + Anousith)
  2. Fetch shipments from both providers (in parallel)
  3. Fetch orders from Pancake POS
  4. Match orders -> generate images -> send bills (concurrently)
  5. Sleep and repeat
"""

import asyncio
import glob
import json
import os
import signal
import sys
import time
from concurrent.futures import ThreadPoolExecutor

from login import login, loginAnousith, loginHal
from purchase import getAllShipment, getAllBillInPancake, getAllBillNeedProcess
from processBill import process_bills_batch
from createImageBill import close_browser

POLL_INTERVAL = 5 * 60  # 5 minutes
RETRY_INTERVAL = 60     # 1 minute on error
CLEANUP_INTERVAL = 12 * 3600  # 12 hours

_executor = ThreadPoolExecutor(max_workers=4)
_shutdown = False
_last_cleanup = 0


def _signal_handler(sig, frame):
    global _shutdown
    print("\n[MAIN] Shutdown requested...")
    _shutdown = True


async def run_in_thread(func, *args):
    """Run a sync function in thread pool without blocking the event loop."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_executor, func, *args)


async def fetch_data():
    """Fetch shipments and Pancake orders in parallel."""
    # Run both fetches concurrently in thread pool
    await asyncio.gather(
        run_in_thread(getAllShipment),
        run_in_thread(getAllBillInPancake),
    )

    # Match bills (fast, CPU-only)
    return await run_in_thread(getAllBillNeedProcess)


def cleanup_old_files():
    """Remove orphan bill images older than 1 hour and cap JSON file sizes."""
    # Clean orphan images in image_bill/
    if os.path.isdir("image_bill"):
        now = time.time()
        for f in glob.glob("image_bill/*.png"):
            try:
                if now - os.path.getmtime(f) > 3600:  # older than 1 hour
                    os.remove(f)
                    print(f"[CLEANUP] Removed orphan image: {f}")
            except OSError:
                pass

    # Clean output images older than 3 days
    for d in ["../output/anousith", "../output/hal"]:
        if os.path.isdir(d):
            now = time.time()
            for f in glob.glob(os.path.join(d, "*.png")):
                try:
                    if now - os.path.getmtime(f) > 3 * 86400:
                        os.remove(f)
                        print(f"[CLEANUP] Removed old output: {f}")
                except OSError:
                    pass


async def pipeline_cycle():
    """Single pipeline cycle: login -> fetch -> process."""
    global _last_cleanup
    print("-----------Start process---------")

    # Cleanup every 12 hours
    if time.time() - _last_cleanup >= CLEANUP_INTERVAL:
        cleanup_old_files()
        _last_cleanup = time.time()

    # Login (sync, quick)
    await run_in_thread(login)

    # Fetch data (parallel)
    bills = await fetch_data()
    print(f"Total bill need process: {len(bills)}")

    if not bills:
        return

    # Save for debugging
    with open("billNeedProcess.json", "w") as f:
        json.dump(bills, f, indent=4)

    # Process all bills concurrently
    await process_bills_batch(bills[:1], concurrency=5)


async def main():
    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)

    print("[MAIN] AutoBill pipeline started")

    while not _shutdown:
        try:
            await pipeline_cycle()
        except Exception as e:
            print(f"[MAIN] Error: {e}")
            if not _shutdown:
                await asyncio.sleep(RETRY_INTERVAL)
                continue

        if not _shutdown:
            print(f"[MAIN] Sleeping {POLL_INTERVAL}s...")
            await asyncio.sleep(POLL_INTERVAL)

    # Cleanup
    await close_browser()
    print("[MAIN] Shutdown complete")


if __name__ == "__main__":
    asyncio.run(main())
