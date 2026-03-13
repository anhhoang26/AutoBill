/**
 * Content Script - runs on facebook.com
 * Sends messages using Facebook's internal API (same as web app uses)
 * instead of DOM automation - much harder to detect.
 */

let fbDtsg = null;
let jazoest = null;

// Extract fb_dtsg token from the page (Facebook's CSRF token)
function extractFbDtsg() {
  // Method 1: from hidden input
  const input = document.querySelector('input[name="fb_dtsg"]');
  if (input) return input.value;

  // Method 2: from page source via regex
  const scripts = document.querySelectorAll("script");
  for (const script of scripts) {
    const text = script.textContent;
    if (!text) continue;

    // Pattern: "DTSGInitialData",[],{"token":"..."}
    let match = text.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/);
    if (match) return match[1];

    // Pattern: fb_dtsg.*?"token":"..."
    match = text.match(/fb_dtsg.*?"token"\s*:\s*"([^"]+)"/);
    if (match) return match[1];

    // Pattern: {"name":"fb_dtsg","value":"..."}
    match = text.match(/"name"\s*:\s*"fb_dtsg"\s*,\s*"value"\s*:\s*"([^"]+)"/);
    if (match) return match[1];
  }

  // Method 3: from require calls
  try {
    const bodyText = document.body.innerHTML;
    const match = bodyText.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/);
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
  // Get current user ID from cookies
  const match = document.cookie.match(/c_user=(\d+)/);
  return match ? match[1] : null;
}

function getPageId() {
  // Try to extract page ID from URL or context
  const match = window.location.href.match(/\/(\d+)\//);
  return match ? match[1] : null;
}

// Initialize tokens
function initTokens() {
  fbDtsg = extractFbDtsg();
  jazoest = extractJazoest();
  const userId = getUserId();
  console.log("[AutoBill] fb_dtsg:", fbDtsg ? "found" : "NOT FOUND");
  console.log("[AutoBill] user_id:", userId || "NOT FOUND");
  return !!fbDtsg;
}

// Listen for commands from background script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "send_fb_message") {
    handleSendMessage(msg)
      .then((result) => sendResponse(result))
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }
});

/**
 * Send message using Facebook's internal GraphQL API
 * This is the same API that facebook.com uses when you send a message
 */
async function handleSendMessage({ conversation_id, message, image_base64, image_url, page_id }) {
  if (!fbDtsg) {
    const found = initTokens();
    if (!found) {
      return { success: false, error: "Could not extract fb_dtsg token. Make sure you're logged into Facebook." };
    }
  }

  try {
    // If there's an image, upload it first then send with attachment
    let attachmentId = null;
    if (image_base64 || image_url) {
      attachmentId = await uploadImage(image_base64, image_url, page_id);
    }

    // Send the message
    const result = await sendMessageAPI(conversation_id, message, attachmentId, page_id);
    return result;
  } catch (e) {
    console.error("[AutoBill] Send error:", e);
    return { success: false, error: e.message };
  }
}

/**
 * Upload image to Facebook and get attachment ID
 */
async function uploadImage(base64Data, imageUrl, pageId) {
  let blob;
  if (base64Data) {
    blob = base64ToBlob(base64Data);
  } else if (imageUrl) {
    const resp = await fetch(imageUrl);
    blob = await resp.blob();
  }

  if (!blob) return null;

  const formData = new FormData();
  formData.append("fb_dtsg", fbDtsg);
  formData.append("upload_1024", blob, "bill_image.png");

  // Use Facebook's file upload endpoint
  const uploadUrl = "https://upload.facebook.com/ajax/mercury/upload.php";
  const queryParams = new URLSearchParams({
    __a: "1",
    fb_dtsg: fbDtsg,
  });

  try {
    const resp = await fetch(`${uploadUrl}?${queryParams}`, {
      method: "POST",
      body: formData,
      credentials: "include",
    });

    const text = await resp.text();
    // Facebook returns "for (;;);{...}" format
    const jsonStr = text.replace(/^for\s*\(;;\);/, "");
    const data = JSON.parse(jsonStr);

    if (data.payload && data.payload.metadata) {
      const metadata = data.payload.metadata[0];
      return metadata.image_id || metadata.fbid;
    }

    console.error("[AutoBill] Upload response:", data);
    return null;
  } catch (e) {
    console.error("[AutoBill] Upload failed:", e);
    return null;
  }
}

/**
 * Send message via Facebook's messaging API
 * Uses the same endpoint as the Messenger web app
 */
async function sendMessageAPI(conversationId, messageText, attachmentId, pageId) {
  const userId = getUserId();
  const timestamp = Date.now();

  // Build the message payload - matches what Facebook's web app sends
  const formData = new URLSearchParams();
  formData.append("fb_dtsg", fbDtsg);
  if (jazoest) formData.append("jazoest", jazoest);

  // Determine the thread key format
  // Facebook conversation IDs can be: "t_<id>" or just numeric
  let otherUserFbId = conversationId;
  if (conversationId.includes("_")) {
    // Format: pageId_recipientId — extract recipient
    const parts = conversationId.split("_");
    otherUserFbId = parts[parts.length - 1];
  }

  // If sending as a Page
  if (pageId) {
    formData.append("source", "source:pages:message");
    formData.append("page_id", pageId);
  }

  // Message body
  if (messageText) {
    formData.append("body", messageText);
  }

  // Image attachment
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
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
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
      // If response is not JSON but status is OK, consider it success
      if (resp.ok) {
        return { success: true };
      }
      return { success: false, error: `HTTP ${resp.status}: ${text.substring(0, 200)}` };
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Generate a unique offline threading ID (matches Facebook's pattern)
 */
function generateOfflineId() {
  const now = Date.now();
  const random = Math.floor(Math.random() * 4294967295);
  return `${now}${random}`;
}

/**
 * Convert base64 string to Blob
 */
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

// Init on load
setTimeout(() => {
  initTokens();
}, 2000);

console.log("[AutoBill] Content script loaded (API mode)");
