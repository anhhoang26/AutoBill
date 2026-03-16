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
import json
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

_executor = ThreadPoolExecutor(max_workers=4)
_shutdown = False


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


async def pipeline_cycle():
    """Single pipeline cycle: login -> fetch -> process."""
    print("-----------Start process---------")

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
    await process_bills_batch(bills, concurrency=5)


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
