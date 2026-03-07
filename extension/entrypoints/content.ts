/**
 * Content script for Google Meet — scrapes Closed Captions from the DOM.
 *
 * Strategy: Observe the entire document for caption containers. Google Meet
 * renders captions inside specific containers that we detect via multiple
 * selector strategies. We poll + observe to handle both initial render and
 * dynamic updates.
 */

export default defineContentScript({
  matches: ["*://meet.google.com/*"],
  runAt: "document_idle",

  main() {
    console.log("[Interview Intel] Content script loaded on Google Meet");

    let isScrapingActive = false;
    let sessionId = "";
    let observer: MutationObserver | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let lastSentText = "";
    let lastSentTime = 0;

    /**
     * All known selectors for Google Meet captions across versions.
     * We try multiple approaches to find the caption text.
     */
    const CAPTION_CONTAINER_SELECTORS = [
      // Current Google Meet (2024-2026) caption containers
      'div[jsname="dsyhDe"]',       // Main captions wrapper
      'div[jsname="YSg2M"]',        // Alt captions wrapper
      'div[jsname="tgaKEf"]',       // Another caption variant
      '.a4cQT',                      // Caption bar container class
      'div[class*="iOzk7"]',        // Caption inner container
    ];

    const CAPTION_TEXT_SELECTORS = [
      // Caption text elements
      '.TBMuR.bj4p3b',              // Caption text wrapper
      '.zs7s8d.jxFHg',              // Caption line
      'span[dir="ltr"]',            // LTR text spans inside captions
      'div[class*="bj4p3b"]',       // Caption text alt class
    ];

    const SPEAKER_SELECTORS = [
      '.zs7s8d',                     // Speaker name element
      'div[class*="KcIKyf"]',       // Speaker name alt
      'img[alt]',                    // Speaker avatar (alt = name)
    ];

    /**
     * Find all caption text currently visible on screen using multiple strategies.
     */
    function scrapeCaptions(): { speaker: string; text: string }[] {
      const results: { speaker: string; text: string }[] = [];

      // Strategy 1: Look for known caption containers
      for (const containerSel of CAPTION_CONTAINER_SELECTORS) {
        const containers = document.querySelectorAll(containerSel);
        for (const container of containers) {
          const text = extractTextFromContainer(container);
          if (text) {
            results.push(text);
          }
        }
      }

      // Strategy 2: If no containers found, try direct text selectors
      if (results.length === 0) {
        for (const textSel of CAPTION_TEXT_SELECTORS) {
          const elements = document.querySelectorAll(textSel);
          for (const el of elements) {
            const content = el.textContent?.trim();
            if (content && content.length > 2) {
              results.push({ speaker: "Participant", text: content });
            }
          }
        }
      }

      // Strategy 3: Broad scan — look for any element that looks like a caption overlay
      if (results.length === 0) {
        // Google Meet captions are positioned at the bottom of the video
        const candidates = document.querySelectorAll('div[style*="bottom"], div[style*="z-index"]');
        for (const el of candidates) {
          const text = el.textContent?.trim();
          // Caption-like: short text, visible, near bottom
          if (text && text.length > 3 && text.length < 500) {
            const rect = el.getBoundingClientRect();
            // Must be in the lower half of the screen and reasonably sized
            if (rect.bottom > window.innerHeight * 0.6 && rect.height < 200 && rect.height > 10) {
              // Quick check: skip known non-caption UI elements
              const tagName = el.tagName.toLowerCase();
              if (tagName !== 'button' && !el.querySelector('button') && !el.closest('[role="toolbar"]')) {
                results.push({ speaker: "Participant", text });
              }
            }
          }
        }
      }

      return results;
    }

    /**
     * Extract speaker + text from a caption container element.
     */
    function extractTextFromContainer(container: Element): { speaker: string; text: string } | null {
      // Try to get the full text
      const fullText = container.textContent?.trim();
      if (!fullText || fullText.length < 2) return null;

      // Try to find the speaker name
      let speaker = "Participant";
      for (const sel of SPEAKER_SELECTORS) {
        const speakerEl = container.querySelector(sel);
        if (speakerEl) {
          if (sel.includes('img')) {
            speaker = (speakerEl as HTMLImageElement).alt || "Participant";
          } else {
            const name = speakerEl.textContent?.trim();
            if (name && name.length > 0 && name.length < 50) {
              speaker = name;
            }
          }
          break;
        }
      }

      // Remove speaker name from the caption text
      let captionText = fullText;
      if (speaker !== "Participant" && captionText.startsWith(speaker)) {
        captionText = captionText.substring(speaker.length).trim();
      }

      if (!captionText || captionText.length < 2) return null;

      return { speaker, text: captionText };
    }

    /**
     * Send caption to background script for relay to backend.
     * Deduplicates and rate-limits sends.
     */
    function sendCaption(speaker: string, text: string) {
      const now = Date.now();
      // Deduplicate: skip if same text sent within last 2 seconds
      if (text === lastSentText && now - lastSentTime < 2000) return;
      // Rate limit: at least 500ms between sends
      if (now - lastSentTime < 500) return;

      lastSentText = text;
      lastSentTime = now;

      console.log(`[Interview Intel] CC: [${speaker}] ${text.substring(0, 80)}...`);

      chrome.runtime.sendMessage({
        type: "CC_TEXT",
        sessionId,
        speaker,
        text,
      }).catch(() => {
        // Background script might not be ready
      });
    }

    /**
     * Poll-based caption scraping. Runs every 1.5 seconds.
     * This is the primary method — more reliable than pure MutationObserver
     * because Google Meet's caption DOM can be complex and vary by version.
     */
    function startPolling() {
      if (pollInterval) return;

      console.log("[Interview Intel] Starting caption polling...");

      pollInterval = setInterval(() => {
        if (!isScrapingActive) return;

        const captions = scrapeCaptions();
        for (const cap of captions) {
          sendCaption(cap.speaker, cap.text);
        }
      }, 1500);
    }

    /**
     * Mutation-based caption scraping. Catches real-time CC updates.
     */
    function startObserving() {
      if (observer) return;

      console.log("[Interview Intel] Starting MutationObserver...");

      // Observe the whole document body for caption changes
      observer = new MutationObserver((mutations) => {
        if (!isScrapingActive) return;

        for (const mutation of mutations) {
          // Check newly added nodes
          for (const node of mutation.addedNodes) {
            if (node instanceof Element) {
              const text = node.textContent?.trim();
              if (text && text.length > 2 && text.length < 500) {
                // Check if this node matches any caption selector
                for (const sel of CAPTION_CONTAINER_SELECTORS) {
                  if (node.matches(sel) || node.querySelector(sel)) {
                    const result = extractTextFromContainer(node);
                    if (result) {
                      sendCaption(result.speaker, result.text);
                    }
                    break;
                  }
                }

                // Also check text selectors
                for (const sel of CAPTION_TEXT_SELECTORS) {
                  if (node.matches(sel)) {
                    sendCaption("Participant", text);
                    break;
                  }
                }
              }
            }
          }

          // Character data (text content) changes inside existing elements
          if (
            mutation.type === "characterData" &&
            mutation.target.parentElement
          ) {
            const parent = mutation.target.parentElement;
            const text = parent.textContent?.trim();
            if (text && text.length > 2 && text.length < 500) {
              // Check if parent is a caption element
              for (const sel of [...CAPTION_CONTAINER_SELECTORS, ...CAPTION_TEXT_SELECTORS]) {
                if (parent.matches(sel) || parent.closest(sel)) {
                  const container = parent.closest(CAPTION_CONTAINER_SELECTORS.join(",")) || parent;
                  const result = extractTextFromContainer(container);
                  if (result) {
                    sendCaption(result.speaker, result.text);
                  }
                  break;
                }
              }
            }
          }
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }

    /**
     * Start all scraping methods.
     */
    function startScraping() {
      console.log("[Interview Intel] Starting scraping (poll + observer)...");
      startPolling();
      startObserving();
    }

    /**
     * Stop all scraping.
     */
    function stopScraping() {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      lastSentText = "";
      lastSentTime = 0;
      console.log("[Interview Intel] All scraping stopped");
    }

    // Listen for messages from popup/background
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === "START_SCRAPING") {
        sessionId = msg.sessionId;
        isScrapingActive = true;
        startScraping();
        sendResponse({ status: "scraping_started" });
      } else if (msg.type === "STOP_SCRAPING") {
        isScrapingActive = false;
        stopScraping();
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
        startScraping();
      }
    });
  },
});
