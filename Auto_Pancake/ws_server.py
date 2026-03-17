"""
WebSocket server — cầu nối giữa Python và Chrome extension.

Luồng:
  Python code  ──py_command──▶  ws_server  ──send_message──▶  extension  ──▶  Facebook API
               ◀──result──────             ◀──result──────────

Cách dùng từ Python:
  # Async
  from ws_server import send_message_to_extension
  result = await send_message_to_extension(conversation_id, message, page_id=page_id)

  # Sync
  from ws_server import send_fb_message
  result = send_fb_message(conversation_id, message, page_id=page_id)
"""

import asyncio
import base64
import json
import os
import threading
import uuid

import websockets

# Extension connections
_extension: websockets.WebSocketServerProtocol | None = None

# Pending requests: correlation_id → Future
_pending: dict[str, asyncio.Future] = {}

# Background event loop (cho sync callers)
_loop: asyncio.AbstractEventLoop | None = None
_loop_ready = threading.Event()


# ── Handlers ──────────────────────────────────────────────────────────────────

async def _handle_extension(websocket):
    global _extension
    _extension = websocket
    print(f"[WS] Extension connected")

    try:
        async for raw in websocket:
            msg = json.loads(raw)

            if msg.get("action") == "pong":
                continue

            if msg.get("action") == "result":
                cid = msg.get("correlation_id")
                if cid and cid in _pending:
                    _pending[cid].set_result(msg)
                else:
                    print(f"[WS] Unmatched result: {msg}")

    except Exception as e:
        print(f"[WS] Extension error: {e}")
    finally:
        if _extension is websocket:
            _extension = None
        print("[WS] Extension disconnected")


async def _handle_py_client(websocket, first_msg):
    result = await send_message_to_extension(
        conversation_id=first_msg.get("conversation_id"),
        message=first_msg.get("message", ""),
        image_path=first_msg.get("image_path"),
        page_id=first_msg.get("page_id"),
        timeout=first_msg.get("timeout", 30),
    )
    await websocket.send(json.dumps(result))


async def handler(websocket):
    print(f"[WS] New connection from {websocket.remote_address}")
    try:
        raw = await asyncio.wait_for(websocket.recv(), timeout=10)
    except asyncio.TimeoutError:
        print("[WS] No hello message, closing")
        return
    except Exception as e:
        print(f"[WS] Read error: {e}")
        return

    msg = json.loads(raw)

    if msg.get("type") == "ext_hello":
        print("[WS] Extension identified")
        await _handle_extension(websocket)

    elif msg.get("type") == "py_command":
        print(f"[WS] Python command: conv={msg.get('conversation_id')}")
        await _handle_py_client(websocket, msg)

    else:
        print(f"[WS] Unknown hello: {msg}")


# ── Ping loop ──────────────────────────────────────────────────────────────────

async def _ping_loop():
    while True:
        await asyncio.sleep(20)
        if _extension:
            try:
                await _extension.send(json.dumps({"action": "ping"}))
            except Exception:
                pass


# ── Public API ─────────────────────────────────────────────────────────────────

async def send_message_to_extension(
    conversation_id: str,
    message: str = "",
    image_path: str | None = None,
    page_id: str | None = None,
    timeout: int = 30,
) -> dict:
    if not _extension:
        return {"success": False, "error": "No extension connected"}

    cid = str(uuid.uuid4())
    command = {
        "action": "send_message",
        "correlation_id": cid,
        "conversation_id": conversation_id,
        "message": message,
    }
    if page_id:
        command["page_id"] = page_id
    if image_path and os.path.exists(image_path):
        with open(image_path, "rb") as f:
            command["image_base64"] = "data:image/png;base64," + base64.b64encode(f.read()).decode()
        print(f"[WS] Image attached: {image_path}")

    loop = asyncio.get_running_loop()
    future = loop.create_future()
    _pending[cid] = future

    try:
        await _extension.send(json.dumps(command))
        print(f"[WS] Sent to extension: conv={conversation_id} cid={cid[:8]}")
        result = await asyncio.wait_for(future, timeout=timeout)
        print(f"[WS] Result: {result}")
        return result
    except asyncio.TimeoutError:
        return {"success": False, "error": "Timeout"}
    except Exception as e:
        return {"success": False, "error": str(e)}
    finally:
        _pending.pop(cid, None)


def send_fb_message(
    conversation_id: str,
    message: str = "",
    image_path: str | None = None,
    page_id: str | None = None,
    timeout: int = 30,
) -> dict:
    """Sync wrapper — dùng được từ cả sync và async context."""
    global _loop

    coro = send_message_to_extension(conversation_id, message, image_path, page_id, timeout)

    # Nếu đang trong async context, chạy trên background loop
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None

    if running:
        _loop_ready.wait(timeout=5)
        future = asyncio.run_coroutine_threadsafe(coro, _loop)
        return future.result(timeout=timeout + 5)
    else:
        return asyncio.run(coro)


# ── Server ─────────────────────────────────────────────────────────────────────

async def start_server(host="localhost", port=8765):
    async with websockets.serve(handler, host, port):
        print(f"[WS] Server started on ws://{host}:{port}")
        asyncio.create_task(_ping_loop())
        await asyncio.Future()


def start_background_server(host="localhost", port=8765):
    """Khởi động server trên background thread — cho processBill.py dùng."""
    global _loop

    def _run():
        global _loop
        _loop = asyncio.new_event_loop()
        asyncio.set_event_loop(_loop)
        _loop_ready.set()
        _loop.run_until_complete(start_server(host, port))

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    _loop_ready.wait(timeout=5)
    print("[WS] Background server started")


if __name__ == "__main__":
    print("[WS] AutoBill WebSocket Server")
    print("[WS] Waiting for Chrome extension...")
    asyncio.run(start_server())
