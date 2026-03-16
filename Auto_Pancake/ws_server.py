"""
WebSocket server for communicating with AutoBill Messenger Chrome extension.
Sends message commands to the extension which sends them via Facebook browser session.

Fixed: correlation IDs to prevent race conditions, proper async support.
"""

import asyncio
import json
import base64
import os
import uuid
import websockets

connected_clients = set()
# Map correlation_id -> Future for matching responses
pending_requests: dict[str, asyncio.Future] = {}


async def handler(websocket):
    """Handle a WebSocket connection from the Chrome extension."""
    connected_clients.add(websocket)
    print(f"[WS] Extension connected. Total clients: {len(connected_clients)}")

    try:
        async for message in websocket:
            data = json.loads(message)
            if data.get("action") == "pong":
                continue
            if data.get("action") == "result":
                cid = data.get("correlation_id")
                if cid and cid in pending_requests:
                    pending_requests[cid].set_result(data)
                else:
                    print(f"[WS] Unmatched result (no correlation_id): {data}")
    except Exception as e:
        print(f"[WS] Connection error: {e}")
    finally:
        connected_clients.discard(websocket)
        print(f"[WS] Extension disconnected. Total clients: {len(connected_clients)}")


async def send_message_to_extension(conversation_id, message="", image_path=None, page_id=None, timeout=30):
    """
    Send a message command to the Chrome extension.

    Args:
        conversation_id: Facebook conversation ID
        message: Text message to send
        image_path: Local path to image file (will be converted to base64)
        page_id: Facebook page ID (for sending as page)
        timeout: Seconds to wait for response

    Returns:
        dict with success status
    """
    if not connected_clients:
        return {"success": False, "error": "No extension connected"}

    correlation_id = str(uuid.uuid4())

    command = {
        "action": "send_message",
        "conversation_id": conversation_id,
        "message": message,
        "correlation_id": correlation_id,
    }

    if page_id:
        command["page_id"] = page_id

    # Convert image to base64 if provided
    if image_path and os.path.exists(image_path):
        with open(image_path, "rb") as f:
            img_data = base64.b64encode(f.read()).decode("utf-8")
            command["image_base64"] = f"data:image/png;base64,{img_data}"

    # Create future for this request
    loop = asyncio.get_running_loop()
    future = loop.create_future()
    pending_requests[correlation_id] = future

    # Send to first connected client
    client = next(iter(connected_clients))
    try:
        await client.send(json.dumps(command))
        print(f"[WS] Sent command: send_message to {conversation_id} (cid={correlation_id[:8]})")

        # Wait for matching result
        result = await asyncio.wait_for(future, timeout=timeout)
        return result
    except asyncio.TimeoutError:
        return {"success": False, "error": "Timeout waiting for extension response"}
    except Exception as e:
        return {"success": False, "error": str(e)}
    finally:
        pending_requests.pop(correlation_id, None)


async def start_server(host="localhost", port=8765):
    """Start the WebSocket server."""
    server = await websockets.serve(handler, host, port)
    print(f"[WS] Server started on ws://{host}:{port}")
    print("[WS] Waiting for Chrome extension to connect...")
    await asyncio.Future()  # Run forever


# --- Singleton event loop for sync callers ---

_server_loop: asyncio.AbstractEventLoop | None = None
_server_started = False


def get_server_loop():
    """Get or create the background event loop running the WS server."""
    global _server_loop, _server_started
    if _server_loop is None or _server_loop.is_closed():
        import threading
        _server_loop = asyncio.new_event_loop()

        def _run():
            asyncio.set_event_loop(_server_loop)
            _server_loop.run_forever()

        t = threading.Thread(target=_run, daemon=True)
        t.start()

    if not _server_started:
        asyncio.run_coroutine_threadsafe(
            websockets.serve(handler, "localhost", 8765), _server_loop
        ).result(timeout=5)
        _server_started = True
        print("[WS] Server started on ws://localhost:8765 (background thread)")

    return _server_loop


def send_fb_message(conversation_id, message="", image_path=None, page_id=None, timeout=30):
    """
    Send a Facebook message via the extension. Works from both sync and async contexts.

    Usage:
        from ws_server import send_fb_message
        result = send_fb_message("conv_id", "Hello!", "image.png")
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    coro = send_message_to_extension(conversation_id, message, image_path, page_id, timeout)

    if loop and loop.is_running():
        # Called from async context - use the server's background loop
        server_loop = get_server_loop()
        future = asyncio.run_coroutine_threadsafe(coro, server_loop)
        return future.result(timeout=timeout + 5)
    else:
        # Called from sync context
        return asyncio.run(coro)


if __name__ == "__main__":
    print("[WS] AutoBill WebSocket Server")
    print("[WS] 1. Start this server")
    print("[WS] 2. Open Chrome with AutoBill Messenger extension")
    print("[WS] 3. Login to Facebook in Chrome")
    print("[WS] 4. Extension will auto-connect\n")
    asyncio.run(start_server())
