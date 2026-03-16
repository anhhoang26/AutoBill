/**
 * Content Script - runs on facebook.com
 * Sends messages using Facebook's internal API.
 * Supports correlation IDs for matching requests to responses.
 */

let fbDtsg = null;
let jazoest = null;

// --- Token extraction ---

function extractFbDtsg() {
  // Method 1: hidden input
  const input = document.querySelector('input[name="fb_dtsg"]');
  if (input) return input.value;

  // Method 2: from script tags
  const scripts = document.querySelectorAll("script");
  for (const script of scripts) {
    const text = script.textContent;
    if (!text) continue;

    let match = text.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/);
    if (match) return match[1];

    match = text.match(/fb_dtsg.*?"token"\s*:\s*"([^"]+)"/);
    if (match) return match[1];

    match = text.match(/"name"\s*:\s*"fb_dtsg"\s*,\s*"value"\s*:\s*"([^"]+)"/);
    if (match) return match[1];
  }

  // Method 3: from body HTML
  try {
    const match = document.body.innerHTML.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/);
    if (match) return match[1];
  } catch (e) {}

  return null;
}

function extractJazoest() {
  const input = document.querySelector('input[name="jazoest"]');
  if (input) return input.value;

  const scripts = document.querySelectorAll("script");
  for (const script of scripts) {
    const text = script.textContent;
    if (!text) continue;
    const match = text.match(/jazoest[=:](\d+)/);
    if (match) return match[1];
  }
  return null;
}

function getUserId() {
  const match = document.cookie.match(/c_user=(\d+)/);
  return match ? match[1] : null;
}

function initTokens() {
  fbDtsg = extractFbDtsg();
  jazoest = extractJazoest();
  const userId = getUserId();
  console.log("[AutoBill] fb_dtsg:", fbDtsg ? "found" : "NOT FOUND");
  console.log("[AutoBill] user_id:", userId || "NOT FOUND");
  return !!fbDtsg;
}

// --- Message handler ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "send_fb_message") {
    handleSendMessage(msg)
      .then((result) => {
        // Attach correlation_id if provided
        if (msg.correlation_id) result.correlation_id = msg.correlation_id;
        sendResponse(result);
      })
      .catch((e) => {
        const result = { success: false, error: e.message };
        if (msg.correlation_id) result.correlation_id = msg.correlation_id;
        sendResponse(result);
      });
    return true;
  }
});

// --- Send message ---

async function handleSendMessage({ conversation_id, message, image_base64, image_url, page_id }) {
  if (!fbDtsg) {
    const found = initTokens();
    if (!found) {
      return { success: false, error: "Could not extract fb_dtsg token. Make sure you're logged into Facebook." };
    }
  }

  try {
    let attachmentId = null;
    if (image_base64 || image_url) {
      attachmentId = await uploadImage(image_base64, image_url, page_id);
      // If image was requested but upload failed, abort instead of sending empty message
      if (!attachmentId) {
        return { success: false, error: "Image upload failed - aborting to avoid sending empty message" };
      }
    }

    return await sendMessageAPI(conversation_id, message, attachmentId, page_id);
  } catch (e) {
    console.error("[AutoBill] Send error:", e);
    // Token may have expired, clear and retry once
    if (e.message && e.message.includes("fb_dtsg")) {
      fbDtsg = null;
    }
    return { success: false, error: e.message };
  }
}

// --- Image upload ---

async function uploadImage(base64Data, imageUrl, pageId) {
  let blob;
  if (base64Data) {
    blob = base64ToBlob(base64Data);
  } else if (imageUrl) {
    try {
      const resp = await fetch(imageUrl);
      if (!resp.ok) throw new Error(`Fetch image failed: ${resp.status}`);
      blob = await resp.blob();
    } catch (e) {
      console.error("[AutoBill] Image fetch failed:", e);
      return null;
    }
  }

  if (!blob) return null;

  const formData = new FormData();
  formData.append("fb_dtsg", fbDtsg);
  formData.append("upload_1024", blob, "bill_image.png");

  const uploadUrl = "https://upload.facebook.com/ajax/mercury/upload.php";
  const queryParams = new URLSearchParams({ __a: "1", fb_dtsg: fbDtsg });

  try {
    const resp = await fetch(`${uploadUrl}?${queryParams}`, {
      method: "POST",
      body: formData,
      credentials: "include",
    });

    if (!resp.ok) {
      console.error("[AutoBill] Upload HTTP error:", resp.status);
      return null;
    }

    const text = await resp.text();
    const jsonStr = text.replace(/^for\s*\(;;\);/, "");
    const data = JSON.parse(jsonStr);

    if (data.payload && data.payload.metadata) {
      const metadata = data.payload.metadata[0];
      return metadata.image_id || metadata.fbid;
    }

    console.error("[AutoBill] Upload response unexpected:", data);
    return null;
  } catch (e) {
    console.error("[AutoBill] Upload failed:", e);
    return null;
  }
}

// --- Send via messaging API ---

async function sendMessageAPI(conversationId, messageText, attachmentId, pageId) {
  const userId = getUserId();
  const timestamp = Date.now();

  const formData = new URLSearchParams();
  formData.append("fb_dtsg", fbDtsg);
  if (jazoest) formData.append("jazoest", jazoest);

  let otherUserFbId = conversationId;
  if (conversationId.includes("_")) {
    const parts = conversationId.split("_");
    otherUserFbId = parts[parts.length - 1];
  }

  if (pageId) {
    formData.append("source", "source:pages:message");
    formData.append("page_id", pageId);
  }

  if (messageText) {
    formData.append("body", messageText);
  }

  if (attachmentId) {
    formData.append("image_ids[0]", attachmentId);
    formData.append("has_attachment", "true");
  }

  formData.append("specific_to_list[0]", `fbid:${otherUserFbId}`);
  formData.append("specific_to_list[1]", `fbid:${pageId || userId}`);
  formData.append("timestamp", timestamp.toString());
  formData.append("offline_threading_id", generateOfflineId());
  formData.append("__a", "1");

  const apiUrl = "https://www.facebook.com/messaging/send/";

  try {
    const resp = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
      credentials: "include",
    });

    const text = await resp.text();
    const jsonStr = text.replace(/^for\s*\(;;\);/, "");

    try {
      const data = JSON.parse(jsonStr);
      if (data.error) {
        return { success: false, error: `Facebook error: ${data.error}` };
      }
      return { success: true, data };
    } catch (parseErr) {
      if (resp.ok) return { success: true };
      return { success: false, error: `HTTP ${resp.status}: ${text.substring(0, 200)}` };
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// --- Utilities ---

function generateOfflineId() {
  const now = Date.now();
  const random = Math.floor(Math.random() * 4294967295);
  return `${now}${random}`;
}

function base64ToBlob(base64) {
  let data = base64;
  let mime = "image/png";
  if (base64.startsWith("data:")) {
    const parts = base64.split(",");
    mime = parts[0].match(/:(.*?);/)[1];
    data = parts[1];
  }
  const bstr = atob(data);
  const arr = new Uint8Array(bstr.length);
  for (let i = 0; i < bstr.length; i++) {
    arr[i] = bstr.charCodeAt(i);
  }
  return new Blob([arr], { type: mime });
}

// Init tokens after page loads
setTimeout(() => initTokens(), 2000);
console.log("[AutoBill] Content script loaded (API mode)");
