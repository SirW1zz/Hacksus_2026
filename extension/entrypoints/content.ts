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

    // ─── Dedup & Element Tracking ───
    // Google Meet CC actively updates caption text in-place. 
    // We track each element to only emit the final version of each caption.
    const elementTexts = new WeakMap<HTMLElement, string>();  // element → last seen text
    const elementTimers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();  // debounce timers
    const sentTexts: Array<{ speaker: string; text: string; time: number }> = [];
    const MAX_SENT_HISTORY = 50;
    const DEDUP_WINDOW_MS = 8000;
    const EMIT_DEBOUNCE_MS = 800;   // FASTER: wait less for CC to finish before emitting
    let lastActivityTime = Date.now(); // watchdog for responsiveness

    // Clean old dedup entries periodically
    setInterval(() => {
      const cutoff = Date.now() - DEDUP_WINDOW_MS;
      while (sentTexts.length > 0 && sentTexts[0].time < cutoff) {
        sentTexts.shift();
      }
    }, 10000);

    // ─── Caption Detection ───

    function getCaptionText(node: Node): { speaker: string; text: string } | null {
      if (!(node instanceof HTMLElement)) return null;

      const fullText = node.textContent?.trim();
      if (!fullText || fullText.length < 2 || fullText.length > 500) return null;

      // Filter out UI junk
      if (/afrikaans|albanian|amharic|select.*language|turn on|present now/i.test(fullText)) {
        return null;
      }

      // Try to find the speaker name
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
        const img = node.parentElement?.querySelector('img[alt]');
        if (img) {
          const alt = (img as HTMLImageElement).alt?.trim();
          if (alt && alt.length > 0 && alt.length < 50) {
            speaker = alt.toLowerCase() === "you" ? "Interviewer" : alt;
          }
        }
      }

      // Method 3: TREE TRAVERSAL FALLBACK (Robustness)
      // If we still don't have a name, look at siblings or ancestor siblings
      // Google Meet often places the name in a parallel div structure.
      if (speaker === "Candidate") {
        let current: HTMLElement | null = node;
        let depth = 0;
        while (current && depth < 4) {
          const sibling = current.previousElementSibling;
          if (sibling) {
            const possibleName = sibling.textContent?.trim();
            // Names are usually short and don't look like timestamps (e.g. "12:34 PM")
            if (possibleName && possibleName.length > 1 && possibleName.length < 40 && !/\d{1,2}:\d{2}/.test(possibleName)) {
              speaker = possibleName.toLowerCase() === "you" ? "Interviewer" : possibleName;
              break;
            }
          }
          current = current.parentElement;
          depth++;
        }
      }

      // Extract just the caption text (remove speaker name from beginning)
      let captionText = fullText;
      if (speaker !== "Candidate" && speaker !== "Interviewer" && captionText.startsWith(speaker)) {
        captionText = captionText.substring(speaker.length).trim();
      }
      if (captionText.startsWith("You ") || captionText.startsWith("You\n")) {
        speaker = "Interviewer";
        captionText = captionText.substring(3).trim();
      }

      if (!captionText || captionText.length < 2) return null;

      return { speaker, text: captionText };
    }

    /**
     * Check if text is a near-duplicate of a recently sent entry.
     * Returns true if it's a duplicate that should be skipped.
     */
    function isDuplicate(speaker: string, text: string): boolean {
      const normalizedNew = text.toLowerCase().trim();
      for (let i = sentTexts.length - 1; i >= 0; i--) {
        const entry = sentTexts[i];
        if (Date.now() - entry.time > DEDUP_WINDOW_MS) break;
        if (entry.speaker !== speaker) continue;

        const normalizedOld = entry.text.toLowerCase().trim();
        // Exact match
        if (normalizedNew === normalizedOld) return true;
        // New text is a substring of old (old was more complete)
        if (normalizedOld.includes(normalizedNew)) return true;
        // Old text is a prefix of new — this is an UPDATE, replace it
        if (normalizedNew.startsWith(normalizedOld) || normalizedNew.includes(normalizedOld)) {
          // Replace old with the updated (longer) version
          entry.text = text;
          entry.time = Date.now();
          return true; // Don't re-send, the backend already has a version
        }
      }
      return false;
    }

    function sendCaption(speaker: string, text: string) {
      if (isDuplicate(speaker, text)) return;

      sentTexts.push({ speaker, text, time: Date.now() });
      if (sentTexts.length > MAX_SENT_HISTORY) sentTexts.shift();

      console.log(`[Interview Intel] 📝 [${speaker}]: ${text.substring(0, 80)}${text.length > 80 ? '...' : ''}`);

      lastActivityTime = Date.now();
      chrome.runtime.sendMessage({
        type: "CC_TEXT",
        sessionId,
        speaker,
        text,
      }).catch(() => {});
    }

    /**
     * Debounced caption emit: tracks element text via WeakMap and only sends
     * after the element hasn't changed for EMIT_DEBOUNCE_MS.
     */
    function debouncedEmit(element: HTMLElement, speaker: string, text: string) {
      const previousText = elementTexts.get(element);
      if (previousText === text) return; // No change in this element
      elementTexts.set(element, text);

      // Clear existing timer for this element
      const existingTimer = elementTimers.get(element);
      if (existingTimer) clearTimeout(existingTimer);

      // Set a debounce timer — only emit after CC stops updating this element
      const timer = setTimeout(() => {
        elementTimers.delete(element);
        sendCaption(speaker, text);
      }, EMIT_DEBOUNCE_MS);
      elementTimers.set(element, timer);
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
      lastActivityTime = Date.now(); // We saw something in the DOM

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
            debouncedEmit(container as HTMLElement, result.speaker, result.text);
          }
        }
        return; // Found via known selectors, done
      }

      // Strategy 1.5: Broad Aria-label search
      const ariaCaptions = node.querySelectorAll('[aria-label*="caption" i]');
      if (ariaCaptions.length > 0) {
        for (const ac of ariaCaptions) {
           const result = getCaptionText(ac);
           if (result) debouncedEmit(ac as HTMLElement, result.speaker, result.text);
        }
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
              debouncedEmit(node, result.speaker, result.text);
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
              debouncedEmit(el as HTMLElement, result.speaker, result.text);
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

    // ─── Watchdog (Fail-proof) ───
    let watchdogInterval: ReturnType<typeof setInterval> | null = null;
    function startWatchdog() {
      if (watchdogInterval) return;
      watchdogInterval = setInterval(() => {
        if (!isActive) return;
        const inactiveDuration = Date.now() - lastActivityTime;
        if (inactiveDuration > 45000) { // 45 seconds of silence/no-DOM-changes
           console.warn("[Interview Intel] ⚠️ Watchdog: Transcription seems stuck. Restarting...");
           stopObserver();
           startObserver();
           lastActivityTime = Date.now();
        }
      }, 10000);
    }

    // ─── Start/Stop ───

    function start() {
      if (isActive) return;
      isActive = true;
      console.log("[Interview Intel] ▶ Starting transcript capture (Observer + Polling)...");
      startObserver();
      startPolling();
      startWatchdog();

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
      if (watchdogInterval) { clearInterval(watchdogInterval); watchdogInterval = null; }
      chrome.runtime.sendMessage({ type: "STOP_TAB_CAPTURE" }).catch(() => {});
      sentTexts.length = 0;
      // Clear debounce timers
      for (const timer of elementTimers.values()) clearTimeout(timer);
      elementTimers.clear();
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
        sendResponse({ type: "PONG", isActive });
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
      const buttons = document.querySelectorAll('button');
      for (const btn of Array.from(buttons)) {
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        const dataTooltip = (btn.getAttribute('data-tooltip') || '').toLowerCase();
        
        const isCaptionsBtn = ariaLabel.includes('caption') || ariaLabel.includes('subtitle') || 
                              dataTooltip.includes('caption') || dataTooltip.includes('subtitle');
        
        if (isCaptionsBtn) {
          // Check if it's currently OFF.
          if (ariaLabel.includes('turn on') || dataTooltip.includes('turn on') || btn.getAttribute('aria-pressed') === 'false') {
             console.log("[Interview Intel] 🎬 Auto-enabling captions...");
             btn.click();
             return true;
          } else if (ariaLabel.includes('turn off') || dataTooltip.includes('turn off') || btn.getAttribute('aria-pressed') === 'true') {
             console.log("[Interview Intel] 🎬 Captions are already on.");
             return true; // CC is already enabled
          }
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
