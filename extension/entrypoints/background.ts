/**
 * Background script — orchestrates tab audio capture, Deepgram relay,
 * WebSocket management, and side panel.
 *
 * Audio pipeline: tabCapture → offscreen document → Deepgram WS → transcript
 *   → background → backend WS → analysis
 */

export default defineBackground(() => {
  console.log("[Interview Intel] Background script loaded");

  const HTTP_BASE = import.meta.env.WXT_API_BASE || "http://localhost:8000";
  const WS_BASE = HTTP_BASE.replace("http", "ws");
  const DEEPGRAM_KEY = import.meta.env.WXT_DEEPGRAM_KEY || "";

  let ws: WebSocket | null = null;
  let currentSessionId = "";
  let isCapturing = false;

  // ─────────────── Backend WebSocket ───────────────

  function connectWebSocket(sessionId: string) {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) && currentSessionId === sessionId) {
      return;
    }
    if (ws) ws.close();

    currentSessionId = sessionId;
    ws = new WebSocket(`${WS_BASE}/ws/interview/${sessionId}`);

    ws.onopen = () => {
      console.log(`[Interview Intel] Backend WS connected for session ${sessionId}`);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        chrome.runtime.sendMessage({ type: "WS_MESSAGE", data: msg }).catch(() => { });
      } catch (e) {
        console.error("[Interview Intel] Failed to parse WS message:", e);
      }
    };

    ws.onerror = (err) => console.error("[Interview Intel] Backend WS error:", err);

    ws.onclose = () => {
      console.log("[Interview Intel] Backend WS disconnected");
      ws = null;
    };
  }

  function sendToBackend(data: object) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    } else {
      console.warn("[Interview Intel] Backend WS not connected, attempting reconnect...");
      if (currentSessionId) {
        connectWebSocket(currentSessionId);
        setTimeout(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
          }
        }, 1000);
      }
    }
  }

  // ─────────────── Tab Audio Capture ───────────────

  async function ensureOffscreenDocument() {
    const existingContexts = await (chrome as any).runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (existingContexts.length > 0) return; // Already exists

    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: "Capture tab audio for real-time transcription via Deepgram",
    });
    console.log("[Interview Intel] Offscreen document created");
  }

  async function startTabCapture(tabId: number, sessionId: string) {
    if (isCapturing) {
      console.log("[Interview Intel] Already capturing, skipping...");
      return;
    }

    try {
      // Get the Deepgram key from storage (set during session creation)
      const stored = await chrome.storage.local.get(["deepgramKey"]);
      const deepgramKey = stored.deepgramKey || DEEPGRAM_KEY;

      if (!deepgramKey) {
        console.error("[Interview Intel] No Deepgram API key found!");
        return;
      }

      // Get a media stream ID for the tab
      const streamId = await new Promise<string>((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(id);
          }
        });
      });
      console.log("[Interview Intel] Got stream ID for tab", tabId);

      // Create offscreen document
      await ensureOffscreenDocument();

      // Tell offscreen document to start capturing
      await chrome.runtime.sendMessage({
        type: "START_CAPTURE",
        streamId,
        deepgramKey,
        sessionId,
      });

      isCapturing = true;
      console.log("[Interview Intel] Tab capture started for tab", tabId);
    } catch (err) {
      console.error("[Interview Intel] Failed to start tab capture:", err);
      // Fall back to CC scraping — the content script's polling should still work
    }
  }

  async function stopTabCapture() {
    if (!isCapturing) return;

    try {
      await chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
    } catch { }

    // Close offscreen document
    try {
      const existingContexts = await (chrome as any).runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
      });
      if (existingContexts.length > 0) {
        await chrome.offscreen.closeDocument();
      }
    } catch { }

    isCapturing = false;
    console.log("[Interview Intel] Tab capture stopped");
  }

  // ─────────────── Message Handling ───────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      // === Deepgram transcript from offscreen document ===
      case "DEEPGRAM_TRANSCRIPT":
        // Relay to backend WS (reuse cc_text pipeline)
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          connectWebSocket(msg.sessionId);
        }
        sendToBackend({
          type: "cc_text",
          speaker: msg.speaker,
          text: msg.text,
        });
        // Also forward to sidepanel for immediate transcript display
        chrome.runtime.sendMessage({
          type: "WS_MESSAGE",
          data: {
            type: "transcript",
            speaker: msg.speaker,
            text: msg.text,
            is_final: true,
          },
        }).catch(() => { });
        sendResponse({ status: "relayed" });
        break;

      case "DEEPGRAM_UTTERANCE_END":
        // Natural pause in speech — good time for suggestions
        sendToBackend({ type: "utterance_end" });
        sendResponse({ status: "ok" });
        break;

      case "DEEPGRAM_STATUS":
        // Forward Deepgram connection status to sidepanel
        chrome.runtime.sendMessage({
          type: "WS_MESSAGE",
          data: { type: "deepgram_status", status: msg.status },
        }).catch(() => { });
        sendResponse({ status: "ok" });
        break;

      // === CC text from content script ===
      case "CC_TEXT":
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          connectWebSocket(msg.sessionId);
        }
        sendToBackend({
          type: "cc_text",
          speaker: msg.speaker,
          text: msg.text,
        });
        // ALSO forward to sidepanel for immediate display
        chrome.runtime.sendMessage({
          type: "WS_MESSAGE",
          data: {
            type: "transcript",
            speaker: msg.speaker,
            text: msg.text,
            is_final: true,
          },
        }).catch(() => { });
        sendResponse({ status: "relayed" });
        break;

      // === Start tab capture ===
      case "START_TAB_CAPTURE":
        (async () => {
          // Resolve tab ID from sender or active meet tab
          let tabId = msg.tabId || sender.tab?.id;
          if (!tabId) {
            const meetTabs = await chrome.tabs.query({ url: "https://meet.google.com/*" });
            tabId = meetTabs[0]?.id;
          }
          if (tabId) {
            await startTabCapture(tabId, msg.sessionId);
          } else {
            console.warn("[Interview Intel] No Meet tab found for tab capture");
          }
          sendResponse({ status: "started" });
        })();
        return true; // async response

      // === Stop tab capture ===
      case "STOP_TAB_CAPTURE":
        (async () => {
          await stopTabCapture();
          sendResponse({ status: "stopped" });
        })();
        return true;

      // === Side panel fallback ===
      case "OPEN_SIDEPANEL":
        // Cannot open side panel via message (requires user gesture)
        // This is now purely setting the options so it is enabled manually
        (async () => {
          try {
            const meetTabs = await chrome.tabs.query({ url: "https://meet.google.com/*" });
            if (meetTabs.length > 0 && meetTabs[0].id) {
              await chrome.sidePanel.setOptions({
                tabId: meetTabs[0].id,
                path: "sidepanel.html",
                enabled: true,
              });
            }
          } catch (err) {
            console.error("[Interview Intel] OPEN_SIDEPANEL error:", err);
          }
        })();
        sendResponse({ status: "opening_sidepanel" });
        break;

      // === WS management ===
      case "CONNECT_WS":
        connectWebSocket(msg.sessionId);
        sendResponse({ status: "connecting" });
        break;

      case "DISCONNECT_WS":
        if (ws) { ws.close(); ws = null; }
        sendResponse({ status: "disconnected" });
        break;

      case "REQUEST_FOLLOWUP":
        sendToBackend({ type: "request_followup" });
        sendResponse({ status: "requested" });
        break;

      case "END_INTERVIEW":
        (async () => {
          // Stop content scripts in ALL Meet tabs
          try {
            const meetTabs = await chrome.tabs.query({ url: "https://meet.google.com/*" });
            for (const tab of meetTabs) {
              if (tab.id) {
                chrome.tabs.sendMessage(tab.id, { type: "STOP_SCRAPING" }).catch(() => { });
              }
            }
          } catch { }

          // Send end_interview to backend
          sendToBackend({ type: "end_interview" });
          // Stop tab capture
          await stopTabCapture();
          // Close WS after brief delay to let end_interview go through
          setTimeout(() => { if (ws) { ws.close(); ws = null; } }, 2000);
          // Clear local state
          chrome.storage.local.set({ isLive: false, sessionId: "" }).catch(() => { });
          sendResponse({ status: "ending" });
        })();
        return true; // async

      default:
        break;
    }

    return true;
  });

  // ─────────────── Auto-connect & Side Panel ───────────────

  chrome.storage.local.get(["sessionId", "isLive"], (data) => {
    if (data.isLive && data.sessionId) {
      connectWebSocket(data.sessionId);
    }
  });

  async function ensureSidePanelOpen(tabId: number) {
    try {
      const data = await chrome.storage.local.get(["isLive", "sessionId"]);
      if (!data.isLive || !data.sessionId) return;

      // Enable side panel for this tab
      await chrome.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled: true });

      // Ensure the backend WebSocket is connected
      connectWebSocket(data.sessionId);

      // Tell the content script to start scraping if it hasn't already
      chrome.tabs.sendMessage(tabId, {
        type: "START_SCRAPING",
        sessionId: data.sessionId,
      }).catch(() => {
         // Dynamically inject if missing (e.g. extension was reloaded)
         if (chrome.scripting) {
            chrome.scripting.executeScript({
               target: { tabId },
               files: ["content-scripts/content.js"]
            }).then(() => {
               setTimeout(() => {
                  chrome.tabs.sendMessage(tabId, { type: "START_SCRAPING", sessionId: data.sessionId }).catch(()=>{});
               }, 500);
            }).catch(()=>{});
         }
      });

      // Also try tab capture for Deepgram (bonus quality)
      if (!isCapturing) {
        await startTabCapture(tabId, data.sessionId).catch(() => { });
      }
    } catch (err) {
      console.error(`[Interview Intel] Failed to setup side panel for tab ${tabId}:`, err);
    }
  }

  /**
   * Full cleanup when the meeting ends — called from tab close or URL change.
   */
  async function autoEndSession() {
    const data = await chrome.storage.local.get(["isLive", "sessionId"]);
    if (!data.isLive || !data.sessionId) return;

    console.log("[Interview Intel] Auto-ending session:", data.sessionId);

    // Stop all content scripts
    try {
      const meetTabs = await chrome.tabs.query({ url: "https://meet.google.com/*" });
      for (const tab of meetTabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, { type: "STOP_SCRAPING" }).catch(() => { });
        }
      }
    } catch { }

    // Tell backend to end
    sendToBackend({ type: "end_interview" });
    await stopTabCapture();

    // Notify the side panel that the meeting ended
    chrome.runtime.sendMessage({
      type: "WS_MESSAGE",
      data: { type: "session_ended" },
    }).catch(() => { });

    setTimeout(() => { if (ws) { ws.close(); ws = null; } }, 2000);
    chrome.storage.local.set({ isLive: false, sessionId: "" }).catch(() => { });
  }

  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab.url?.includes("meet.google.com")) {
      ensureSidePanelOpen(tabId);
    }

    // Detect when a Meet tab navigates AWAY from the meeting (user left or meeting ended)
    if (changeInfo.url && !changeInfo.url.includes("meet.google.com")) {
      // This tab was on Meet but navigated away — check if it was our last Meet tab
      const meetTabs = await chrome.tabs.query({ url: "https://meet.google.com/*" });
      if (meetTabs.length === 0) {
        autoEndSession();
      }
    }
  });

  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url?.includes("meet.google.com")) {
      ensureSidePanelOpen(activeInfo.tabId);
    }
  });

  chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab?.id && tab.url?.includes("meet.google.com")) {
      ensureSidePanelOpen(tab.id);
    }
  });

  chrome.tabs.onRemoved.addListener(async (_tabId) => {
    // Check if any Meet tabs remain
    const meetTabs = await chrome.tabs.query({ url: "https://meet.google.com/*" });
    if (meetTabs.length === 0) {
      console.log("[Interview Intel] Last Meet tab closed, ending session automatically.");
      autoEndSession();
    }
  });
});
