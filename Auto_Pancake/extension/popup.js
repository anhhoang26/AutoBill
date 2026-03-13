const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const reconnectBtn = document.getElementById("reconnectBtn");

function updateStatus(connected) {
  dot.className = connected ? "dot connected" : "dot disconnected";
  statusText.textContent = connected ? "Connected to server" : "Disconnected";
}

// Get initial status
chrome.runtime.sendMessage({ type: "get_status" }, (response) => {
  if (response) updateStatus(response.connected);
});

// Listen for status updates
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "status") {
    updateStatus(msg.connected);
  }
});

reconnectBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "reconnect" });
  statusText.textContent = "Reconnecting...";
});
