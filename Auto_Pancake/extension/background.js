/**
 * Background Service Worker
 * Connects to local Python WebSocket server.
 * Dispatches message commands to content script on any facebook.com tab.
 *
 * Content script uses Facebook's internal API (not DOM automation)
 * so no need to navigate to specific Messenger URLs.
 */

const WS_URL = "ws://localhost:8765";
let ws = null;
let reconnectTimer = null;
let isConnected = false;

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  try {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      isConnected = true;
      console.log("[AutoBill] Connected to server");
      clearReconnectTimer();
      chrome.runtime.sendMessage({ type: "status", connected: true }).catch(() => {});
    };

    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log("[AutoBill] Received command:", data.action);

        if (data.action === "send_message") {
          await handleSendMessage(data);
        } else if (data.action === "ping") {
          ws.send(JSON.stringify({ action: "pong" }));
        }
      } catch (e) {
        console.error("[AutoBill] Error handling message:", e);
        sendResult({ success: false, error: e.message });
      }
    };

    ws.onclose = () => {
      isConnected = false;
      console.log("[AutoBill] Disconnected");
      chrome.runtime.sendMessage({ type: "status", connected: false }).catch(() => {});
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

function sendResult(result) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "result", ...result }));
  }
}

/**
 * Find any facebook.com tab and send command to content script
 */
async function findFacebookTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.facebook.com/*" });
  if (tabs.length > 0) return tabs[0];

  // Try business.facebook.com
  const bizTabs = await chrome.tabs.query({ url: "https://business.facebook.com/*" });
  if (bizTabs.length > 0) return bizTabs[0];

  return null;
}

async function handleSendMessage(data) {
  const tab = await findFacebookTab();

  if (!tab) {
    // No FB tab open - create one and wait for it to load
    const newTab = await chrome.tabs.create({
      url: "https://www.facebook.com/",
      active: false,
    });
    await waitForTabLoad(newTab.id);
    await sleep(3000); // Wait for content script to init

    try {
      const result = await chrome.tabs.sendMessage(newTab.id, {
        type: "send_fb_message",
        ...data,
      });
      sendResult(result);
    } catch (e) {
      sendResult({ success: false, error: "Content script not ready: " + e.message });
    }
    return;
  }

  try {
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: "send_fb_message",
      ...data,
    });
    sendResult(result);
  } catch (e) {
    sendResult({ success: false, error: e.message });
  }
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Handle messages from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "get_status") {
    sendResponse({ connected: isConnected });
  } else if (msg.type === "reconnect") {
    connect();
    sendResponse({ ok: true });
  }
  return true;
});

// Auto-connect
connect();
