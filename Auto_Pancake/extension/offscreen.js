/**
 * Offscreen Document - AutoBill Messenger v5.1
 *
 * Giống Pancake offscreen: chỉ dùng để giữ kết nối persistent
 * (service worker bị kill sau 30s idle, offscreen document sống mãi)
 *
 * Nhiệm vụ:
 *  1. Duy trì WebSocket đến ws_server.py
 *  2. Nhận send_message từ ws_server
 *  3. Relay sang background service worker để xử lý FB API
 *  4. Trả kết quả về ws_server
 */

"use strict";

const WS_URL = "ws://localhost:8765";

let ws = null;
let reconnectTimer = null;

// ── WebSocket ──────────────────────────────────────────────────────────────────

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  console.log("[AutoBill] Connecting to ws_server...");
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("[AutoBill] Connected ✓");
    clearTimeout(reconnectTimer);
    ws.send(JSON.stringify({ type: "ext_hello" }));
    chrome.runtime.sendMessage({ type: "ws_status", connected: true }).catch(() => {});
  };

  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.action === "ping") {
      ws.send(JSON.stringify({ action: "pong" }));
      return;
    }

    if (msg.action === "send_message") {
      console.log(`[AutoBill] send_message → background cid=${msg.correlation_id?.slice(0, 8)}`);

      // Relay sang background service worker để xử lý FB API
      const result = await chrome.runtime.sendMessage({
        type: "fb_send",
        payload: {
          conversation_id: msg.conversation_id,
          message: msg.message,
          image_base64: msg.image_base64,
          page_id: msg.page_id,
        },
      });

      ws.send(JSON.stringify({ action: "result", correlation_id: msg.correlation_id, ...result }));
    }
  };

  ws.onclose = () => {
    console.log("[AutoBill] Disconnected, retry 5s");
    chrome.runtime.sendMessage({ type: "ws_status", connected: false }).catch(() => {});
    reconnectTimer = setTimeout(connect, 5000);
  };

  ws.onerror = () => ws.close();
}

// ── Init ───────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ws_reconnect") { connect(); sendResponse({ ok: true }); }
  if (msg.type === "ws_get_status") { sendResponse({ connected: ws?.readyState === WebSocket.OPEN }); }
  return true;
});

connect();
console.log("[AutoBill] Offscreen loaded v5.1");
