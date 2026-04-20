"""
Bill processing pipeline - async with extension fallback queue.

Flow:
  1. Generate bill image (reuses shared browser)
  2. Try sending via Pancake API
  3. If Pancake fails, push to extension queue for retry
  4. Update order status on success
"""

import asyncio
import json
import os
import requests
from dotenv import load_dotenv
from createImageBill import generate_image, close_browser

load_dotenv(os.path.join(os.path.dirname(__file__), ".env.example"), override=True)

POS_PANCAKE_API_KEY = os.getenv("POS_PANCAKE_API_KEY")
PANCAKE_ACCESS_TOKEN = os.getenv("PANCAKE_ACCESS_TOKEN")
PANCAKE_JWT = os.getenv("PANCAKE_JWT", "")
SHOP_ID = os.getenv("SHOP_ID")


def _get_page_id(bill_pancake):
    """Extract page_id from bill — supports both flat 'page_id' and nested 'page.id'."""
    return bill_pancake.get("page_id") or bill_pancake.get("page", {}).get("id")


def _get_thread_id(bill_pancake):
    """Extract Facebook thread_id from conversation_id.

    Pancake format: '{page_id}_{thread_id}' e.g. '539060145964207_23930918266550665'
    Extension needs just the thread_id part (after the underscore).
    """
    conv_id = bill_pancake.get("conversation_id", "")
    if "_" in conv_id:
        return conv_id.split("_", 1)[1]
    return conv_id

# --- Extension fallback queue ---

_ext_queue: asyncio.Queue | None = None
_ext_worker_task: asyncio.Task | None = None


def get_ext_queue() -> asyncio.Queue:
    global _ext_queue
    if _ext_queue is None:
        _ext_queue = asyncio.Queue()
    return _ext_queue


_ws_server_started = False


def _ensure_ws_server():
    """Start the WebSocket server (background thread) so the Chrome extension can connect."""
    global _ws_server_started
    if _ws_server_started:
        return
    from ws_server import start_background_server
    start_background_server()
    _ws_server_started = True


async def start_ext_worker():
    """Background worker that processes the extension fallback queue."""
    global _ext_worker_task
    _ensure_ws_server()
    if _ext_worker_task and not _ext_worker_task.done():
        return
    _ext_worker_task = asyncio.create_task(_ext_worker_loop())


async def _ext_worker_loop():
    """Process extension queue items one by one."""
    from ws_server import send_message_to_extension

    queue = get_ext_queue()
    while True:
        item = await queue.get()
        bill_pancake = item["bill_pancake"]
        bill_file = item["bill_file"]
        ship_fee = item["ship_fee"]

        print(f"[EXT-Q] Processing {bill_pancake['id']} via extension...")

        for attempt in range(3):
            try:
                result = await send_message_to_extension(
                    _get_thread_id(bill_pancake),
                    message="",
                    image_path=bill_file,
                    page_id=_get_page_id(bill_pancake),
                )
                if isinstance(result, dict) and result.get("success"):
                    print(f"[EXT-Q] Success: {bill_pancake['id']}")
                    _cleanup_and_update(bill_pancake, bill_file, ship_fee)
                    break
                print(f"[EXT-Q] Attempt {attempt + 1} failed: {bill_pancake['id']}: {result}")
            except Exception as e:
                print(f"[EXT-Q] Attempt {attempt + 1} error: {bill_pancake['id']}: {e}")

            if attempt < 2:
                await asyncio.sleep(2)
        else:
            print(f"[EXT-Q] Gave up on {bill_pancake['id']} after 3 attempts")

        queue.task_done()


# --- Pancake API functions ---

def _pancake_headers():
    """Common headers for Pancake API calls."""
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "Origin": "https://pancake.vn",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    }
    if PANCAKE_JWT:
        headers["Cookie"] = f"jwt={PANCAKE_JWT}"
    return headers


def upload_bill_to_pancake(bill_pancake, file_local, max_retries=3):
    """Upload bill image to Pancake and return response."""
    page_id = _get_page_id(bill_pancake)
    url = f"https://pancake.vn/api/v1/pages/{page_id}/contents?access_token={PANCAKE_ACCESS_TOKEN}"

    for attempt in range(max_retries):
        try:
            with open(file_local, "rb") as f:
                files = [("file", (os.path.basename(file_local), f, "image/png"))]
                upload_headers = {k: v for k, v in _pancake_headers().items() if k != "Content-Type"}
                resp = requests.post(url, headers=upload_headers, files=files, timeout=15)

            try:
                data = resp.json()
            except Exception:
                data = {"raw": resp.text[:300]}

            if resp.status_code < 200 or resp.status_code >= 300:
                print(f"[PANCAKE] Upload failed {bill_pancake['id']}: HTTP {resp.status_code}")
                print(f"  Response: {json.dumps(data, ensure_ascii=False)[:300]}")
                if 400 <= resp.status_code < 500 and resp.status_code != 429:
                    return None
                continue

            if data.get("success"):
                return data
            print(f"[PANCAKE] Upload not successful {bill_pancake['id']}: {json.dumps(data, ensure_ascii=False)[:300]}")
        except Exception as e:
            print(f"[PANCAKE] Upload error attempt {attempt + 1}: {e}")

    return None


def create_fb_ids(bill_pancake, content_id, max_retries=3):
    """Create Facebook attachment IDs from uploaded content."""
    page_id = _get_page_id(bill_pancake)
    url = f"https://pancake.vn/api/v1/pages/{page_id}/contents/facebook?access_token={PANCAKE_ACCESS_TOKEN}&is_reusable=true&async=false"

    for attempt in range(max_retries):
        try:
            resp = requests.post(
                url,
                headers=_pancake_headers(),
                json={"content_ids": [content_id]},
                timeout=15,
            )
            if resp.status_code < 200 or resp.status_code >= 300:
                print(f"[PANCAKE] create_fb_ids failed {bill_pancake['id']}: HTTP {resp.status_code} {resp.text[:300]}")
                if 400 <= resp.status_code < 500 and resp.status_code != 429:
                    return None
                continue

            data = resp.json()
            if data.get("success"):
                return data["fb_ids"][0]
            print(f"[PANCAKE] create_fb_ids not successful {bill_pancake['id']}: {data}")
        except Exception as e:
            print(f"[PANCAKE] create_fb_ids error attempt {attempt + 1}: {e}")

    return None


def send_message_via_pancake(bill_pancake, upload_response, fb_ids, max_retries=3):
    """Send the bill image as a Facebook message via Pancake API."""
    page_id = _get_page_id(bill_pancake)
    url = f"https://pancake.vn/api/v1/pages/{page_id}/conversations/{bill_pancake['conversation_id']}/messages?access_token={PANCAKE_ACCESS_TOKEN}"

    payload = {
        "action": "reply_inbox",
        "message": "",
        "content_id": upload_response["id"],
        "attachment_id": fb_ids,
        "content_url": upload_response["content_url"],
        "width": upload_response["image_data"]["width"],
        "height": upload_response["image_data"]["height"],
        "send_by_platform": "web",
    }
    multipart = {k: (None, str(v)) for k, v in payload.items()}
    send_headers = {k: v for k, v in _pancake_headers().items() if k != "Content-Type"}

    for attempt in range(max_retries):
        try:
            resp = requests.post(url, headers=send_headers, files=multipart, timeout=15)
            try:
                data = resp.json()
            except Exception:
                data = {"raw": resp.text[:300]}

            if resp.status_code < 200 or resp.status_code >= 300:
                print(f"[PANCAKE] send_message failed {bill_pancake['id']}: HTTP {resp.status_code}")
                print(f"  URL: {url[:150]}")
                print(f"  Payload: {json.dumps(payload, ensure_ascii=False)[:300]}")
                print(f"  Response: {json.dumps(data, ensure_ascii=False)[:300]}")
                if 400 <= resp.status_code < 500 and resp.status_code != 429:
                    return False
                continue

            if data.get("success"):
                print(f"[PANCAKE] Success send message {bill_pancake['id']}")
                return True
            print(f"[PANCAKE] send_message not successful {bill_pancake['id']}: {json.dumps(data, ensure_ascii=False)[:300]}")
            # Non-retryable Facebook errors (by e_subcode)
            if data.get("e_subcode") in (2018278, 2018001, 551):
                print(f"[PANCAKE] {bill_pancake['id']} non-retryable (e_subcode={data.get('e_subcode')}), skip retry")
                return False
        except Exception as e:
            print(f"[PANCAKE] send_message error attempt {attempt + 1}: {e}")

    return False


def send_via_pancake(bill_pancake, file_local):
    """Full Pancake send pipeline: upload -> create fb_ids -> send message."""
    upload_resp = upload_bill_to_pancake(bill_pancake, file_local)
    if not upload_resp:
        return False

    fb_ids = create_fb_ids(bill_pancake, upload_resp["id"])
    if not fb_ids:
        return False

    return send_message_via_pancake(bill_pancake, upload_resp, fb_ids)


# --- Order status update ---

def update_order_status(bill_pancake, ship_fee, max_retries=3):
    """Update order status to 'shipped' in Pancake POS."""
    url = f"https://pos.pancake.vn/api/v1/shops/{SHOP_ID}/orders/{bill_pancake['id']}?api_key={POS_PANCAKE_API_KEY}"
    payload = {"status": 2, "partner_fee": ship_fee}

    for attempt in range(max_retries):
        try:
            resp = requests.put(url, json=payload, timeout=10)
            if 200 <= resp.status_code < 300:
                return True
            print(f"[PANCAKE] update_status failed {bill_pancake['id']}: HTTP {resp.status_code}")
            if 400 <= resp.status_code < 500 and resp.status_code != 429:
                return False
        except Exception as e:
            print(f"[PANCAKE] update_status error attempt {attempt + 1}: {e}")

    print(f"[PANCAKE] Failed update status {bill_pancake['id']}")
    return False


def _cleanup_and_update(bill_pancake, bill_file, ship_fee):
    """Delete temp image and update order status."""
    try:
        if os.path.exists(bill_file):
            os.remove(bill_file)
    except OSError:
        pass
    update_order_status(bill_pancake, ship_fee)


# --- Main processing ---

async def process_bill(bill_info):
    """
    Process a single bill: generate image -> send via Pancake -> fallback to extension queue.

    Args:
        bill_info: tuple of (bill_pancake, bill_shipment, is_hal)
    """
    import time as _time
    t_start = _time.time()

    bill_pancake, bill_shipment, is_hal = bill_info

    if is_hal:
        bill_file = f"image_bill/bill_hal_{bill_shipment['id']}.png"
        ship_fee = bill_shipment["total_freight"]
    else:
        bill_file = f"image_bill/bill_anousith_{bill_shipment['_id']}.png"
        ship_fee = bill_shipment["packagePrice"]

    # Step 1: Generate image (async, reuses browser)
    t1 = _time.time()
    await generate_image(bill_shipment, is_hal)
    t2 = _time.time()

    # Step 2: Try Pancake API (run in thread to not block event loop)
    loop = asyncio.get_running_loop()
    sent = await loop.run_in_executor(None, send_via_pancake, bill_pancake, bill_file)
    t3 = _time.time()

    print(f"[TIMER] {bill_pancake['id']}: gen={t2-t1:.2f}s send={t3-t2:.2f}s total={t3-t_start:.2f}s")

    if sent:
        _cleanup_and_update(bill_pancake, bill_file, ship_fee)
        return True

    # Step 3: Push to extension queue for async retry via Chrome extension
    print(f"[PROCESS] Pancake failed for {bill_pancake['id']}, queuing for extension...")
    queue = get_ext_queue()
    await queue.put({
        "bill_pancake": bill_pancake,
        "bill_file": bill_file,
        "ship_fee": ship_fee,
    })
    return False


async def process_bills_batch(bills, concurrency=5):
    """
    Process multiple bills concurrently.

    Args:
        bills: list of (bill_pancake, bill_shipment, is_hal) tuples
        concurrency: max parallel bill processing tasks
    """
    if not bills:
        return

    import time as _time
    batch_start = _time.time()

    # Start extension worker
    await start_ext_worker()

    sem = asyncio.Semaphore(concurrency)

    async def _process_with_limit(bill):
        async with sem:
            try:
                await process_bill(bill)
            except Exception as e:
                print(f"[PROCESS] Error processing bill: {e}")

    # Run all bills concurrently (limited by semaphore)
    await asyncio.gather(*[_process_with_limit(b) for b in bills])

    elapsed = _time.time() - batch_start
    rate = len(bills) / elapsed * 60 if elapsed > 0 else 0
    print(f"[TIMER] Batch done: {len(bills)} bills in {elapsed:.1f}s ({rate:.1f} bills/min)")

    # Wait for extension queue to drain
    queue = get_ext_queue()
    if not queue.empty():
        print(f"[PROCESS] Waiting for {queue.qsize()} extension queue items...")
        await queue.join()


# --- Legacy sync entry point ---

def processBill(bill_info):
    """Sync wrapper for backwards compatibility with main.py."""
    asyncio.run(process_bill(bill_info))


if __name__ == "__main__":
    import sys
    target_id = sys.argv[1] if len(sys.argv) > 1 else None
    target_id = 'L74447HN'
    if target_id:
        # Find specific bill by receiver name or tracking number
        anousith = json.load(open("listShipmentAnousith.json", encoding="utf-8")) if os.path.exists("listShipmentAnousith.json") else []
        hal = json.load(open("listShipmentHal.json", encoding="utf-8")) if os.path.exists("listShipmentHal.json") else []
        pancake = json.load(open("listBillInPancake.json", encoding="utf-8")) if os.path.exists("listBillInPancake.json") else []

        # Find shipment
        shipment, is_hal = None, False
        for b in anousith:
            if b.get("receiverName") == target_id or b.get("trackingId") == target_id:
                shipment, is_hal = b, False
                break
        if not shipment:
            for b in hal:
                if b.get("vendor_tracking_number") == target_id or b.get("shipment_number") == target_id:
                    shipment, is_hal = b, True
                    break

        # Find pancake order
        bill_pancake = None
        for b in pancake:
            if b.get("id") == target_id:
                bill_pancake = b
                break

        if shipment:
            if bill_pancake:
                print(f"[TEST] Processing {target_id} (hal={is_hal}) with Pancake order")

                async def _run_test():
                    # Start ext worker + ws_server so Pancake failures can fall back to extension
                    await start_ext_worker()
                    await process_bill((bill_pancake, shipment, is_hal))
                    queue = get_ext_queue()
                    if not queue.empty():
                        print(f"[TEST] Waiting for {queue.qsize()} extension queue items...")
                        await queue.join()

                asyncio.run(_run_test())
            else:
                print(f"[TEST] Shipment found, generating image only...")
                asyncio.run(generate_image(shipment, is_hal))
                key = "id" if is_hal else "_id"
                src = "hal" if is_hal else "anousith"
                print(f"[TEST] Image saved: image_bill/bill_{src}_{shipment[key]}.png")
        else:
            print(f"[TEST] Bill '{target_id}' not found in shipment lists")
    else:
        bill_need_process = json.load(open("billNeedProcess.json"))
        asyncio.run(process_bills_batch(bill_need_process))
