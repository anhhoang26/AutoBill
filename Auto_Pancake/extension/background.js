/**
 * Background Service Worker (MV3)
 *
 * WebSocket lives in offscreen.js (persistent).
 * This script bridges: offscreen <-> content script on facebook.com tab.
 */

let isConnected = false;

// --- Offscreen document management ---

async function ensureOffscreen() {
  const exists = await chrome.offscreen.hasDocument();
  if (!exists) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WEB_SOCKET"],
      justification: "Maintain persistent WebSocket connection to local server",
    });
    console.log("[AutoBill] Offscreen document created");
  }
}

// --- Facebook tab management ---

async function findFacebookTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.facebook.com/*" });
  if (tabs.length > 0) return tabs[0];
  const bizTabs = await chrome.tabs.query({ url: "https://business.facebook.com/*" });
  if (bizTabs.length > 0) return bizTabs[0];
  return null;
}

function waitForTabLoad(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeout);
    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Send command to content script ---

async function handleSendMessage(data) {
  let tab = await findFacebookTab();

  if (!tab) {
    const newTab = await chrome.tabs.create({
      url: "https://www.facebook.com/",
      active: false,
    });
    await waitForTabLoad(newTab.id);
    await sleep(3000);
    tab = newTab;
  }

  try {
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: "send_fb_message",
      ...data,
    });
    // Forward result back to offscreen -> WS server
    chrome.runtime.sendMessage({ type: "ws_send_result", result }).catch(() => {});
  } catch (e) {
    const result = { success: false, error: "Content script error: " + e.message };
    chrome.runtime.sendMessage({ type: "ws_send_result", result }).catch(() => {});
  }
}

// --- Message router ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // From offscreen: WS command received
  if (msg.type === "ws_command") {
    handleSendMessage(msg.data);
    sendResponse({ ok: true });
  }
  // From offscreen: connection status changed
  else if (msg.type === "ws_status") {
    isConnected = msg.connected;
    // Forward to popup if open
    chrome.runtime.sendMessage({ type: "status", connected: isConnected }).catch(() => {});
    sendResponse({ ok: true });
  }
  // From popup: get status
  else if (msg.type === "get_status") {
    sendResponse({ connected: isConnected });
  }
  // From popup: reconnect
  else if (msg.type === "reconnect") {
    ensureOffscreen().then(() => {
      chrome.runtime.sendMessage({ type: "ws_reconnect" }).catch(() => {});
    });
    sendResponse({ ok: true });
  }
  return true;
});

// Auto-create offscreen on startup
ensureOffscreen();
