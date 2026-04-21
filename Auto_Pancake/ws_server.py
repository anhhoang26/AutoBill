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
    print("[WS] Extension connected")
    try:
        async for raw in websocket:
            msg = json.loads(raw)
            if msg.get("action") == "pong":
                continue
            if msg.get("action") == "result":
                cid = msg.get("correlation_id")
                if cid and cid in _pending:
                    _pending[cid].set_result(msg)
    except Exception:
        pass
    finally:
        if _extension is websocket:
            _extension = None
        print("[WS] Extension disconnected")


async def _handle_py_client(websocket, first_msg):
    bill_id = first_msg.get("bill_id") or "?"
    print(f"[WS] → {bill_id}")
    result = await send_message_to_extension(
        conversation_id=first_msg.get("conversation_id"),
        message=first_msg.get("message", ""),
        image_path=first_msg.get("image_path"),
        image_base64=first_msg.get("image_base64"),
        page_id=first_msg.get("page_id"),
        recipient_psid=first_msg.get("recipient_psid"),
        timeout=first_msg.get("timeout", 30),
    )
    if result.get("success"):
        print(f"[WS] ✓ {bill_id}")
    else:
        print(f"[WS] ✗ {bill_id} err={result.get('error', '')[:120]}")
    await websocket.send(json.dumps(result))


async def _handle_py_raw_command(websocket, first_msg):
    """Forward a raw action (like 'warmup') to the extension and await its result."""
    global _extension
    if not _extension:
        await websocket.send(json.dumps({"success": False, "error": "No extension connected"}))
        return
    cid = str(uuid.uuid4())
    command = {"correlation_id": cid, **{k: v for k, v in first_msg.items() if k not in ("type", "timeout")}}
    timeout = first_msg.get("timeout", 60)
    loop = asyncio.get_running_loop()
    future = loop.create_future()
    _pending[cid] = future
    try:
        await _extension.send(json.dumps(command))
        result = await asyncio.wait_for(future, timeout=timeout)
        await websocket.send(json.dumps(result))
    except asyncio.TimeoutError:
        await websocket.send(json.dumps({"success": False, "error": "Timeout"}))
    except Exception as e:
        await websocket.send(json.dumps({"success": False, "error": str(e)}))
    finally:
        _pending.pop(cid, None)


async def handler(websocket):
    try:
        raw = await asyncio.wait_for(websocket.recv(), timeout=10)
    except Exception:
        return
    msg = json.loads(raw)
    t = msg.get("type")
    if t == "ext_hello":
        await _handle_extension(websocket)
    elif t == "py_command":
        await _handle_py_client(websocket, msg)
    elif t == "py_command_raw":
        await _handle_py_raw_command(websocket, msg)


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
    image_base64: str | None = None,
    page_id: str | None = None,
    recipient_psid: str | None = None,
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
    if recipient_psid:
        command["recipient_psid"] = recipient_psid
    if image_base64:
        command["image_base64"] = image_base64
    elif image_path and os.path.exists(image_path):
        with open(image_path, "rb") as f:
            command["image_base64"] = "data:image/png;base64," + base64.b64encode(f.read()).decode()

    loop = asyncio.get_running_loop()
    future = loop.create_future()
    _pending[cid] = future

    try:
        await _extension.send(json.dumps(command))
        result = await asyncio.wait_for(future, timeout=timeout)
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

    coro = send_message_to_extension(conversation_id, message, image_path=image_path, page_id=page_id, timeout=timeout)

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


# ── Client mode: connect to external standalone ws_server ────────────────────

async def warmup_via_external_server(
    page_ids: list,
    timeout: int = 60,
    server_url: str = "ws://localhost:8765",
) -> dict:
    """Tell the extension to pre-fetch FB context + scrape doc_ids for the given page_ids.
    Call at the start of a batch so the first real send is fast."""
    payload = {
        "type": "py_command_raw",
        "action": "warmup",
        "page_ids": list(page_ids),
        "timeout": timeout,
    }
    try:
        async with websockets.connect(server_url, open_timeout=5) as ws:
            await ws.send(json.dumps(payload))
            raw = await asyncio.wait_for(ws.recv(), timeout=timeout + 5)
            return json.loads(raw)
    except (ConnectionRefusedError, OSError) as e:
        return {"success": False, "error": f"ws_server not running: {e}"}
    except asyncio.TimeoutError:
        return {"success": False, "error": "Warmup timeout"}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def send_via_external_server(
    conversation_id: str,
    message: str = "",
    image_path: str | None = None,
    page_id: str | None = None,
    recipient_psid: str | None = None,
    bill_id: str | None = None,
    timeout: int = 30,
    server_url: str = "ws://localhost:8765",
) -> dict:
    """Connect to an externally-running ws_server as Python client and send command.

    Use this when ws_server.py is running as a standalone process (recommended —
    extension stays connected across main.py restarts)."""
    payload = {
        "type": "py_command",
        "conversation_id": conversation_id,
        "message": message,
        "timeout": timeout,
    }
    if bill_id:
        payload["bill_id"] = bill_id
    if page_id:
        payload["page_id"] = page_id
    if recipient_psid:
        payload["recipient_psid"] = recipient_psid
    if image_path and os.path.exists(image_path):
        with open(image_path, "rb") as f:
            payload["image_base64"] = "data:image/png;base64," + base64.b64encode(f.read()).decode()

    try:
        async with websockets.connect(server_url, open_timeout=5) as ws:
            await ws.send(json.dumps(payload))
            raw = await asyncio.wait_for(ws.recv(), timeout=timeout + 5)
            return json.loads(raw)
    except (ConnectionRefusedError, OSError) as e:
        return {"success": False, "error": f"ws_server not running at {server_url}: {e}"}
    except asyncio.TimeoutError:
        return {"success": False, "error": "Timeout waiting for result"}
    except Exception as e:
        return {"success": False, "error": str(e)}


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
