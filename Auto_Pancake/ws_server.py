"""
WebSocket server for communicating with AutoBill Messenger Chrome extension.
Sends message commands to the extension which sends them via Facebook browser session.
"""

import asyncio
import json
import base64
import os
import websockets

connected_clients = set()
pending_results = asyncio.Queue()


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
                await pending_results.put(data)
                print(f"[WS] Result: {data}")
    except Exception as e:
        print(f"[WS] Connection error: {e}")
    finally:
        connected_clients.discard(websocket)
        print(f"[WS] Extension disconnected. Total clients: {len(connected_clients)}")


async def send_message_to_extension(conversation_id, message="", image_path=None):
    """
    Send a message command to the Chrome extension.

    Args:
        conversation_id: Facebook conversation ID
        message: Text message to send
        image_path: Local path to image file (will be converted to base64)

    Returns:
        dict with success status
    """
    if not connected_clients:
        return {"success": False, "error": "No extension connected"}

    command = {
        "action": "send_message",
        "conversation_id": conversation_id,
        "message": message,
    }

    # Convert image to base64 if provided
    if image_path and os.path.exists(image_path):
        with open(image_path, "rb") as f:
            img_data = base64.b64encode(f.read()).decode("utf-8")
            command["image_base64"] = f"data:image/png;base64,{img_data}"

    # Send to first connected client
    client = next(iter(connected_clients))
    await client.send(json.dumps(command))
    print(f"[WS] Sent command: send_message to {conversation_id}")

    # Wait for result with timeout
    try:
        result = await asyncio.wait_for(pending_results.get(), timeout=30)
        return result
    except asyncio.TimeoutError:
        return {"success": False, "error": "Timeout waiting for extension response"}


async def start_server(host="localhost", port=8765):
    """Start the WebSocket server."""
    server = await websockets.serve(handler, host, port)
    print(f"[WS] Server started on ws://{host}:{port}")
    print("[WS] Waiting for Chrome extension to connect...")
    await asyncio.Future()  # Run forever


# --- Integration with existing processBill.py ---

async def _send_via_extension(conversation_id, message, image_path):
    """Internal async wrapper for sending."""
    return await send_message_to_extension(conversation_id, message, image_path)


def send_fb_message(conversation_id, message="", image_path=None):
    """
    Synchronous wrapper to send a Facebook message via the extension.
    Call this from processBill.py when the API method fails (7-day limit).

    Usage:
        from ws_server import send_fb_message
        result = send_fb_message("539060145964207_23930918266550665", "Hello!", "image_bill/bill.png")
    """
    loop = asyncio.get_event_loop()
    if loop.is_running():
        # If called from within an async context
        future = asyncio.ensure_future(_send_via_extension(conversation_id, message, image_path))
        return future
    else:
        return asyncio.run(_send_via_extension(conversation_id, message, image_path))


if __name__ == "__main__":
    print("[WS] AutoBill WebSocket Server")
    print("[WS] 1. Start this server")
    print("[WS] 2. Open Chrome with AutoBill Messenger extension")
    print("[WS] 3. Login to Facebook in Chrome")
    print("[WS] 4. Extension will auto-connect\n")
    asyncio.run(start_server())
