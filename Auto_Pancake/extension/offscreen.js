/**
 * Offscreen document - maintains persistent WebSocket connection.
 * Service workers get killed after ~30s idle in MV3, so we keep
 * the long-lived WS here instead.
 */

const WS_URL = "ws://localhost:8765";
let ws = null;
let reconnectTimer = null;

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  try {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log("[AutoBill:offscreen] Connected to server");
      clearReconnectTimer();
      chrome.runtime.sendMessage({ type: "ws_status", connected: true }).catch(() => {});
    };

    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.action === "send_message") {
          // Forward to background -> content script
          chrome.runtime.sendMessage({ type: "ws_command", data }).catch(() => {});
        } else if (data.action === "ping") {
          ws.send(JSON.stringify({ action: "pong" }));
        }
      } catch (e) {
        console.error("[AutoBill:offscreen] Error:", e);
        sendToServer({ action: "result", success: false, error: e.message });
      }
    };

    ws.onclose = () => {
      console.log("[AutoBill:offscreen] Disconnected");
      chrome.runtime.sendMessage({ type: "ws_status", connected: false }).catch(() => {});
      scheduleReconnect();
    };

    ws.onerror = () => ws.close();
  } catch (e) {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  clearReconnectTimer();
  reconnectTimer = setTimeout(() => connect(), 5000);
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function sendToServer(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ws_send_result") {
    sendToServer({ action: "result", ...msg.result });
    sendResponse({ ok: true });
  } else if (msg.type === "ws_reconnect") {
    connect();
    sendResponse({ ok: true });
  } else if (msg.type === "ws_get_status") {
    sendResponse({ connected: ws && ws.readyState === WebSocket.OPEN });
  }
  return true;
});

connect();
console.log("[AutoBill:offscreen] Loaded");
