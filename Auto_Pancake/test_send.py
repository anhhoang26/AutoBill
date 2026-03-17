"""Test gửi message qua ws_server → extension → Facebook"""

import asyncio
import json
import websockets

PAGE_ID = "61550017050246"
RECIPIENT_ID = "61578770600262"
MESSAGE = "Hi test"

async def main():
    print(f"[TEST] Gửi '{MESSAGE}' → {RECIPIENT_ID}")
    async with websockets.connect("ws://localhost:8765") as ws:
        await ws.send(json.dumps({
            "type": "py_command",
            "conversation_id": RECIPIENT_ID,
            "message": MESSAGE,
            "page_id": PAGE_ID or None,
        }))
        result = json.loads(await ws.recv())
    print(f"[TEST] Kết quả: {result}")

if __name__ == "__main__":
    asyncio.run(main())
