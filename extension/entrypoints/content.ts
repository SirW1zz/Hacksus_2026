/**
 * Content script for Google Meet — scrapes Closed Captions from the DOM.
 *
 * Uses MutationObserver to detect CC text changes and sends them to the
 * background script for relay to the backend via WebSocket.
 */

export default defineContentScript({
  matches: ["*://meet.google.com/*"],
  runAt: "document_idle",

  main() {
    console.log("[Interview Intel] Content script loaded on Google Meet");

    let isScrapingActive = false;
    let sessionId = "";
    let observer: MutationObserver | null = null;
    let lastText = "";
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    // Known CC container selectors (Google Meet updates these periodically)
    const CC_SELECTORS = [
      // Current known selectors for Google Meet captions
      'div[jscontroller] div[class*="iOzk7"]', // Caption container
      ".a4cQT", // Speaker name container
      'div[data-self-name]', // Self-identified speaker
      'span[dir="ltr"]', // Caption text spans
      ".TBMuR.bj4p3b", // Caption text wrapper
      ".zs7s8d.jxFHg", // Caption line
    ];

    /**
     * Find the CC container in the DOM.
     * Google Meet dynamically renders captions, so we try multiple selectors.
     */
    function findCaptionContainer(): Element | null {
      // Try to find the main captions region
      const captionRegion = document.querySelector(
        'div[jsname="dsyhDe"]'
      );
      if (captionRegion) return captionRegion;

      // Fallback: look for common caption wrapper classes
      const fallbacks = [
        'div[jsname="YSg2M"]',
        ".a4cQT",
        'div[class*="caption"]',
      ];

      for (const sel of fallbacks) {
        const el = document.querySelector(sel);
        if (el) return el;
      }

      return null;
    }

    /**
     * Extract speaker name and text from a caption element.
     */
    function extractCaption(
      element: Element
    ): { speaker: string; text: string } | null {
      const text = element.textContent?.trim();
      if (!text || text === lastText) return null;

      lastText = text;

      // Try to extract speaker name
      const speakerEl =
        element.querySelector(".zs7s8d") ||
        element.querySelector('img[alt]')?.parentElement;

      const speaker = speakerEl?.textContent?.trim() || "Participant";

      // Extract just the caption text (removing speaker name if embedded)
      let captionText = text;
      if (speaker && captionText.startsWith(speaker)) {
        captionText = captionText.substring(speaker.length).trim();
      }

      if (!captionText) return null;

      return { speaker, text: captionText };
    }

    /**
     * Start observing the DOM for CC changes.
     */
    function startObserving() {
      if (observer) return;

      // Find or wait for the CC container
      const findAndObserve = () => {
        const container =
          findCaptionContainer() || document.body;

        observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            // Check added nodes
            for (const node of mutation.addedNodes) {
              if (node instanceof Element) {
                const caption = extractCaption(node);
                if (caption) {
                  debouncedSend(caption);
                }
              }
            }

            // Check characterData changes (text content changes)
            if (
              mutation.type === "characterData" &&
              mutation.target.parentElement
            ) {
              const caption = extractCaption(mutation.target.parentElement);
              if (caption) {
                debouncedSend(caption);
              }
            }

            // Check subtree modifications
            if (mutation.type === "childList" && mutation.target instanceof Element) {
              const caption = extractCaption(mutation.target);
              if (caption) {
                debouncedSend(caption);
              }
            }
          }
        });

        observer.observe(container, {
          childList: true,
          subtree: true,
          characterData: true,
        });

        console.log("[Interview Intel] CC Observer started");
      };

      // Retry finding the container every 2 seconds for 30 seconds
      let attempts = 0;
      const interval = setInterval(() => {
        const container = findCaptionContainer();
        if (container || attempts >= 15) {
          clearInterval(interval);
          findAndObserve();
        }
        attempts++;
      }, 2000);

      // Also try immediately
      findAndObserve();
    }

    /**
     * Debounced send to avoid flooding with partial captions.
     */
    function debouncedSend(caption: { speaker: string; text: string }) {
      if (debounceTimer) clearTimeout(debounceTimer);

      debounceTimer = setTimeout(() => {
        chrome.runtime.sendMessage({
          type: "CC_TEXT",
          sessionId,
          speaker: caption.speaker,
          text: caption.text,
        });
      }, 500);
    }

    /**
     * Stop observing.
     */
    function stopObserving() {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      lastText = "";
      console.log("[Interview Intel] CC Observer stopped");
    }

    // Listen for messages from popup/background
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === "START_SCRAPING") {
        sessionId = msg.sessionId;
        isScrapingActive = true;
        startObserving();
        sendResponse({ status: "scraping_started" });
      } else if (msg.type === "STOP_SCRAPING") {
        isScrapingActive = false;
        stopObserving();
        sendResponse({ status: "scraping_stopped" });
      } else if (msg.type === "PING") {
        sendResponse({ status: "alive", scraping: isScrapingActive });
      }
    });

    // Auto-start if session was already active (e.g., page refresh)
    chrome.storage.local.get(["sessionId", "isLive"], (data) => {
      if (data.isLive && data.sessionId) {
        sessionId = data.sessionId;
        isScrapingActive = true;
        startObserving();
      }
    });
  },
});
