/**
 * Background script — message relay and WebSocket management.
 *
 * Bridges communication between content script (CC scraper) and
 * the backend WebSocket for real-time interview processing.
 */

export default defineBackground(() => {
  console.log("[Interview Intel] Background script loaded");

  const HTTP_BASE = import.meta.env.WXT_API_BASE || "http://localhost:8000";
  const WS_BASE = HTTP_BASE.replace("http", "ws");
  
  let ws: WebSocket | null = null;
  let currentSessionId = "";

  /**
   * Connect to the backend WebSocket for a session.
   */
  function connectWebSocket(sessionId: string) {
    if (ws && ws.readyState === WebSocket.OPEN && currentSessionId === sessionId) {
      return; // Already connected
    }

    // Close existing connection
    if (ws) {
      ws.close();
    }

    currentSessionId = sessionId;
    ws = new WebSocket(`${WS_BASE}/ws/interview/${sessionId}`);

    ws.onopen = () => {
      console.log(`[Interview Intel] WebSocket connected for session ${sessionId}`);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        // Forward messages to the side panel
        chrome.runtime.sendMessage({
          type: "WS_MESSAGE",
          data: msg,
        }).catch(() => {
          // Side panel might not be open yet
        });
      } catch (e) {
        console.error("[Interview Intel] Failed to parse WS message:", e);
      }
    };

    ws.onerror = (err) => {
      console.error("[Interview Intel] WebSocket error:", err);
    };

    ws.onclose = () => {
      console.log("[Interview Intel] WebSocket disconnected");
      ws = null;
    };
  }

  /**
   * Send data to the backend via WebSocket.
   */
  function sendToBackend(data: object) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    } else {
      console.warn("[Interview Intel] WebSocket not connected, queuing message");
      // Try to reconnect
      if (currentSessionId) {
        connectWebSocket(currentSessionId);
        // Retry after a short delay
        setTimeout(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
          }
        }, 1000);
      }
    }
  }

  // Listen for messages from content script and popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case "CC_TEXT":
        // Relay CC text from content script to backend
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          connectWebSocket(msg.sessionId);
        }
        sendToBackend({
          type: "cc_text",
          speaker: msg.speaker,
          text: msg.text,
        });
        sendResponse({ status: "relayed" });
        break;

      case "OPEN_SIDEPANEL":
        // Open the side panel
        if (sender.tab?.windowId) {
          chrome.sidePanel
            .open({ windowId: sender.tab.windowId })
            .catch(console.error);
        } else {
          chrome.windows.getCurrent((window) => {
            if (window.id) {
              chrome.sidePanel
                .open({ windowId: window.id })
                .catch(console.error);
            }
          });
        }
        sendResponse({ status: "opening_sidepanel" });
        break;

      case "CONNECT_WS":
        connectWebSocket(msg.sessionId);
        sendResponse({ status: "connecting" });
        break;

      case "DISCONNECT_WS":
        if (ws) {
          ws.close();
          ws = null;
        }
        sendResponse({ status: "disconnected" });
        break;

      case "REQUEST_FOLLOWUP":
        sendToBackend({ type: "request_followup" });
        sendResponse({ status: "requested" });
        break;

      case "END_INTERVIEW":
        sendToBackend({ type: "end_interview" });
        setTimeout(() => {
          if (ws) {
            ws.close();
            ws = null;
          }
        }, 1000);
        sendResponse({ status: "ending" });
        break;

      default:
        break;
    }

    // Return true to indicate async sendResponse
    return true;
  });

  // Auto-connect if there's an active session
  chrome.storage.local.get(["sessionId", "isLive"], (data) => {
    if (data.isLive && data.sessionId) {
      connectWebSocket(data.sessionId);
    }
  });

  // Function to open side panel for a specific tab
  async function ensureSidePanelOpen(tabId: number) {
    try {
      const data = await chrome.storage.local.get(["isLive"]);
      if (!data.isLive) return;

      console.log(`[Interview Intel] Ensuring side panel is open for tab ${tabId}`);

      // Ensure side panel is enabled for this tab
      await chrome.sidePanel.setOptions({
        tabId,
        path: 'sidepanel.html',
        enabled: true
      });

      // Attempt to open
      await chrome.sidePanel.open({ tabId });
      console.log(`[Interview Intel] Side panel open request sent for tab ${tabId}`);
    } catch (err) {
      console.error(`[Interview Intel] Failed to open side panel for tab ${tabId}:`, err);
      // Fallback: try opening by windowId
      chrome.windows.getCurrent((win) => {
        if (win.id) {
          chrome.sidePanel.open({ windowId: win.id }).catch(console.error);
        }
      });
    }
  }

  // Automatically open side panel when a Google Meet tab is opened or updated in live mode
  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab.url?.includes("meet.google.com")) {
      ensureSidePanelOpen(tabId);
    }
  });

  // Also catch tab activation
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url?.includes("meet.google.com")) {
      ensureSidePanelOpen(activeInfo.tabId);
    }
  });

  // Also catch window creation/focus
  chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab?.id && tab.url?.includes("meet.google.com")) {
      ensureSidePanelOpen(tab.id);
    }
  });
});
