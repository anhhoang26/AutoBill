"""Test gửi message qua ws_server → extension → Facebook

conversation_id từ Pancake có format: {page_id}_{thread_id}
  Ví dụ: "539060145964207_23930918266550665"

Extension cần:
  - page_id:         "539060145964207"        (phần trước _)
  - conversation_id: "23930918266550665"       (phần sau _ = thread_id)

Extension sẽ resolve thread_id → PSID (other_user_fbid) qua GraphQL hoặc HTML parsing.
"""

import asyncio
import json
import websockets

# Lấy từ Pancake bill data:
# bill_pancake["page"]["id"] = page_id
# bill_pancake["conversation_id"] = "{page_id}_{thread_id}"
PAGE_ID = "122094746090007575"
THREAD_ID = "61578770600262"  # = selected_item_id từ URL Facebook Business inbox
MESSAGE = "Đây là link sản phẩm của bạn"

async def main():
    print(f"[TEST] Gửi '{MESSAGE}' → thread={THREAD_ID} page={PAGE_ID}")
    async with websockets.connect("ws://localhost:8765") as ws:
        await ws.send(json.dumps({
            "type": "py_command",
            "conversation_id": THREAD_ID,
            "message": MESSAGE,
            "page_id": PAGE_ID,
        }))
        result = json.loads(await ws.recv())
    print(f"[TEST] Kết quả: {result}")

if __name__ == "__main__":
    asyncio.run(main())
