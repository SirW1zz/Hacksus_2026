/**
 * Content script for Google Meet — captures closed captions using MutationObserver.
 *
 * Strategy:
 *   Uses MutationObserver to watch for caption elements as they appear in real-time.
 *   This is far more reliable than polling because captions are transient DOM nodes.
 *   Also falls back to periodic polling as a safety net.
 *
 *   The user of the extension is labeled "Interviewer" (Google Meet shows "You").
 *   All other participants are labeled "Candidate".
 */

export default defineContentScript({
  matches: ["*://meet.google.com/*"],
  runAt: "document_idle",

  main() {
    console.log("[Interview Intel] Content script loaded on Google Meet");

    let isActive = false;
    let sessionId = "";
    let observer: MutationObserver | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;

    // Dedup: track recently sent captions
    const sentTexts = new Map<string, number>(); // key -> timestamp

    // Cleanup old dedup entries periodically
    setInterval(() => {
      const cutoff = Date.now() - 10000;
      for (const [key, time] of sentTexts) {
        if (time < cutoff) sentTexts.delete(key);
      }
    }, 15000);

    // ─── Caption Detection ───

    function getCaptionText(node: Node): { speaker: string; text: string } | null {
      if (!(node instanceof HTMLElement)) return null;

      const fullText = node.textContent?.trim();
      if (!fullText || fullText.length < 2 || fullText.length > 500) return null;

      // Filter out UI junk
      if (/afrikaans|albanian|amharic|select.*language|turn on|present now/i.test(fullText)) {
        return null;
      }

      // Try to find the speaker name. Google Meet uses a nested structure:
      // The caption container has a speaker name element and caption text.
      let speaker = "Candidate";

      // Method 1: Look for speaker name in child elements
      const nameEl = node.querySelector('.zs7s8d, [class*="KcIKyf"], [data-sender-name]');
      if (nameEl) {
        const name = nameEl.textContent?.trim();
        if (name && name.length > 0 && name.length < 50) {
          speaker = name.toLowerCase() === "you" ? "Interviewer" : name;
        }
      }

      // Method 2: Check for image alt text (speaker avatar)
      if (speaker === "Candidate") {
        const img = node.querySelector('img[alt]');
        if (img) {
          const alt = (img as HTMLImageElement).alt?.trim();
          if (alt && alt.length > 0 && alt.length < 50) {
            speaker = alt.toLowerCase() === "you" ? "Interviewer" : alt;
          }
        }
      }

      // Extract just the caption text (remove speaker name from beginning)
      let captionText = fullText;
      if (speaker !== "Candidate" && speaker !== "Interviewer" && captionText.startsWith(speaker)) {
        captionText = captionText.substring(speaker.length).trim();
      }
      // If speaker is "You" in the original, the fullText might start with "You"
      if (captionText.startsWith("You ") || captionText.startsWith("You\n")) {
        speaker = "Interviewer";
        captionText = captionText.substring(3).trim();
      }

      if (!captionText || captionText.length < 2) return null;

      return { speaker, text: captionText };
    }

    function sendCaption(speaker: string, text: string) {
      const dedupKey = `${speaker}:${text}`;
      const now = Date.now();

      // Don't send exact same text within 3 seconds
      if (sentTexts.has(dedupKey) && now - (sentTexts.get(dedupKey) || 0) < 3000) {
        return;
      }

      sentTexts.set(dedupKey, now);

      console.log(`[Interview Intel] 📝 [${speaker}]: ${text.substring(0, 80)}${text.length > 80 ? '...' : ''}`);

      chrome.runtime.sendMessage({
        type: "CC_TEXT",
        sessionId,
        speaker,
        text,
      }).catch(() => {});
    }

    // ─── MutationObserver (Primary Method) ───

    function startObserver() {
      if (observer) return;

      console.log("[Interview Intel] 👁️ Starting MutationObserver for captions...");

      // We watch the entire body for added nodes, then filter for caption-like content
      observer = new MutationObserver((mutations) => {
        if (!isActive) return;

        for (const mutation of mutations) {
          // Check added nodes
          for (const node of mutation.addedNodes) {
            processNode(node);
          }

          // Also check if existing node's text changed (characterData)
          if (mutation.type === 'characterData' && mutation.target.parentElement) {
            processNode(mutation.target.parentElement);
          }
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        characterDataOldValue: false,
      });
    }

    function processNode(node: Node) {
      if (!(node instanceof HTMLElement)) return;

      // Look for caption containers using multiple selector strategies
      // Strategy 1: Known jsname attributes
      const captionContainers = [
        ...node.querySelectorAll('div[jsname="dsyhDe"]'),
        ...node.querySelectorAll('div[jsname="YSg2M"]'),
        ...node.querySelectorAll('div[jsname="tgaKEf"]'),
        ...node.querySelectorAll('.a4cQT'),
        ...node.querySelectorAll('div.iOzk7'),
      ];

      // If the node itself matches
      if (node.matches?.('div[jsname="dsyhDe"], div[jsname="YSg2M"], div[jsname="tgaKEf"], .a4cQT, div.iOzk7')) {
        captionContainers.push(node);
      }

      if (captionContainers.length > 0) {
        for (const container of captionContainers) {
          const result = getCaptionText(container);
          if (result) {
            sendCaption(result.speaker, result.text);
          }
        }
        return; // Found via known selectors, done
      }

      // Strategy 2: Heuristic — look for any small div with text that appeared
      // in the lower portion of the screen (caption area). This is the fallback
      // for when Google changes their class names.
      // We look for text nodes that are direct children or shallow descendants
      // and have a speaker-text pattern.
      if (node.childNodes.length > 0 && node.childNodes.length < 10) {
        const text = node.textContent?.trim();
        if (text && text.length > 3 && text.length < 300) {
          // Check if this looks like a caption (has a speaker label pattern)
          // Google Meet captions: "SpeakerName caption text here"
          // They appear in elements that are near the bottom of the page
          const rect = node.getBoundingClientRect?.();
          if (rect && rect.top > window.innerHeight * 0.6) {
            // This element is in the lower 40% of the screen (caption area)
            const result = getCaptionText(node);
            if (result) {
              sendCaption(result.speaker, result.text);
            }
          }
        }
      }
    }

    function stopObserver() {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
    }

    // ─── Polling Fallback (Safety Net) ───

    function startPolling() {
      if (pollInterval) return;

      console.log("[Interview Intel] 🔄 Starting polling fallback...");

      pollInterval = setInterval(() => {
        if (!isActive) return;

        // Try all known selectors
        const selectors = [
          'div[jsname="dsyhDe"]',
          'div[jsname="YSg2M"]',
          'div[jsname="tgaKEf"]',
          '.a4cQT',
          'div.iOzk7',
        ];

        for (const sel of selectors) {
          const elements = document.querySelectorAll(sel);
          for (const el of elements) {
            const result = getCaptionText(el);
            if (result) {
              sendCaption(result.speaker, result.text);
            }
          }
        }
      }, 1500);
    }

    function stopPolling() {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    }

    // ─── Start/Stop ───

    function start() {
      if (isActive) return;
      isActive = true;
      console.log("[Interview Intel] ▶ Starting transcript capture (Observer + Polling)...");
      startObserver();
      startPolling();

      // Also try tab capture via background (bonus Deepgram quality)
      chrome.runtime.sendMessage({
        type: "START_TAB_CAPTURE",
        sessionId,
      }).catch(() => {});
    }

    function stop() {
      isActive = false;
      stopObserver();
      stopPolling();
      chrome.runtime.sendMessage({ type: "STOP_TAB_CAPTURE" }).catch(() => {});
      sentTexts.clear();
      console.log("[Interview Intel] ⏹ Transcript capture stopped");
    }

    // ─── Message Listeners ───

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === "START_SCRAPING") {
        sessionId = msg.sessionId;
        start();
        sendResponse({ status: "started" });
      } else if (msg.type === "STOP_SCRAPING") {
        stop();
        sendResponse({ status: "stopped" });
      } else if (msg.type === "PING") {
        sendResponse({ status: "alive", scraping: isActive });
      }
    });

    // ─── Auto-start if session was already active ───
    chrome.storage.local.get(["sessionId", "isLive"], (data) => {
      if (data.isLive && data.sessionId) {
        console.log("[Interview Intel] Auto-starting (session was already live)");
        sessionId = data.sessionId;
        start();
      }
    });

    // ─── Auto-enable captions ───
    // Wait for the page to fully load, then try to enable captions
    const tryEnableCaptions = () => {
      // Look for the CC button by aria-label
      const ccButtons = document.querySelectorAll('button[aria-label*="caption" i], button[aria-label*="subtitle" i]');
      for (const btn of ccButtons) {
        const pressed = btn.getAttribute("aria-pressed");
        if (pressed === "false") {
          console.log("[Interview Intel] 🎬 Auto-enabling captions...");
          (btn as HTMLElement).click();
          return true;
        }
      }
      return false;
    };

    // Try multiple times since the button might not be rendered yet
    setTimeout(tryEnableCaptions, 3000);
    setTimeout(tryEnableCaptions, 6000);
    setTimeout(tryEnableCaptions, 10000);
    setTimeout(tryEnableCaptions, 15000);
  },
});
