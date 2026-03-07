/**
 * Offscreen document script — captures tab audio and streams to Deepgram.
 *
 * Flow:
 * 1. Background sends START_CAPTURE with streamId, deepgramKey, sessionId
 * 2. getUserMedia with chromeMediaSource:"tab" to get audio stream
 * 3. WebSocket to Deepgram's real-time API (wss://api.deepgram.com/v1/listen)
 * 4. Web Audio API ScriptProcessor converts audio to linear16 PCM @ 16kHz
 * 5. Deepgram returns transcription → relayed back to background script
 */

let deepgramWs = null;
let audioStream = null;
let audioContext = null;
let processor = null;
let source = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "START_CAPTURE") {
    startCapture(msg.streamId, msg.deepgramKey, msg.sessionId);
    sendResponse({ status: "starting" });
  } else if (msg.type === "STOP_CAPTURE") {
    stopCapture();
    sendResponse({ status: "stopping" });
  }
  return true;
});

async function startCapture(streamId, deepgramKey, sessionId) {
  console.log("[Offscreen] Starting audio capture with streamId:", streamId);

  try {
    // Get the audio stream from the tab
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
    });

    console.log("[Offscreen] Got audio stream, tracks:", audioStream.getAudioTracks().length);

    // Connect to Deepgram real-time API
    const dgUrl = "wss://api.deepgram.com/v1/listen?model=nova-2&language=en&smart_format=true&diarize=true&punctuate=true&interim_results=false&utterance_end_ms=1500&vad_events=true&encoding=linear16&sample_rate=16000&channels=1";

    deepgramWs = new WebSocket(dgUrl, ["token", deepgramKey]);

    deepgramWs.onopen = () => {
      console.log("[Offscreen] ✅ Deepgram WebSocket connected!");
      chrome.runtime.sendMessage({ type: "DEEPGRAM_STATUS", status: "connected" }).catch(() => {});

      // Start recording audio and sending to Deepgram
      startRecording(sessionId);
    };

    deepgramWs.onmessage = (event) => {
      try {
        const result = JSON.parse(event.data);

        // Handle transcription results
        if (result.type === "Results" && result.channel && result.channel.alternatives && result.channel.alternatives[0]) {
          const alt = result.channel.alternatives[0];
          const transcript = alt.transcript;

          if (transcript && transcript.trim().length > 0) {
            const isFinal = result.is_final;

            // Extract speaker from diarization
            let speaker = "Participant";
            if (alt.words && alt.words.length > 0 && alt.words[0].speaker !== undefined) {
              const speakerId = alt.words[0].speaker;
              speaker = speakerId === 0 ? "Interviewer" : "Candidate";
            }

            console.log("[Offscreen] Transcript (" + (isFinal ? "final" : "interim") + "): [" + speaker + "] " + transcript.substring(0, 80));

            // Relay final transcripts
            if (isFinal) {
              chrome.runtime.sendMessage({
                type: "DEEPGRAM_TRANSCRIPT",
                speaker: speaker,
                text: transcript,
                isFinal: true,
                sessionId: sessionId,
              }).catch(() => {});
            }
          }
        }

        // Handle utterance end (natural pause in speech)
        if (result.type === "UtteranceEnd") {
          chrome.runtime.sendMessage({
            type: "DEEPGRAM_UTTERANCE_END",
            sessionId: sessionId,
          }).catch(() => {});
        }
      } catch (e) {
        console.error("[Offscreen] Error parsing Deepgram response:", e);
      }
    };

    deepgramWs.onerror = (err) => {
      console.error("[Offscreen] Deepgram WebSocket error:", err);
      chrome.runtime.sendMessage({ type: "DEEPGRAM_STATUS", status: "error" }).catch(() => {});
    };

    deepgramWs.onclose = (event) => {
      console.log("[Offscreen] Deepgram WebSocket closed:", event.code, event.reason);
      chrome.runtime.sendMessage({ type: "DEEPGRAM_STATUS", status: "disconnected" }).catch(() => {});
    };

  } catch (err) {
    console.error("[Offscreen] Failed to start capture:", err);
    chrome.runtime.sendMessage({ type: "DEEPGRAM_STATUS", status: "error", error: String(err) }).catch(() => {});
  }
}

function startRecording(sessionId) {
  if (!audioStream || !deepgramWs) return;

  // Use Web Audio API to convert to linear16 PCM at 16kHz
  audioContext = new AudioContext({ sampleRate: 16000 });
  source = audioContext.createMediaStreamSource(audioStream);

  // ScriptProcessor to get raw PCM data (4096 buffer, 1 input channel, 1 output channel)
  processor = audioContext.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = (event) => {
    if (!deepgramWs || deepgramWs.readyState !== WebSocket.OPEN) return;

    const inputData = event.inputBuffer.getChannelData(0);
    // Convert float32 [-1, 1] to int16 [-32768, 32767]
    const int16Data = new Int16Array(inputData.length);
    for (let i = 0; i < inputData.length; i++) {
      const s = Math.max(-1, Math.min(1, inputData[i]));
      int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    deepgramWs.send(int16Data.buffer);
  };

  source.connect(processor);
  processor.connect(audioContext.destination);

  console.log("[Offscreen] 🎙️ Audio recording started — streaming to Deepgram");
}

function stopCapture() {
  console.log("[Offscreen] Stopping capture...");

  if (processor) {
    processor.disconnect();
    processor = null;
  }
  if (source) {
    source.disconnect();
    source = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }

  if (deepgramWs) {
    if (deepgramWs.readyState === WebSocket.OPEN) {
      deepgramWs.send(JSON.stringify({ type: "CloseStream" }));
    }
    deepgramWs.close();
    deepgramWs = null;
  }

  if (audioStream) {
    audioStream.getTracks().forEach((track) => track.stop());
    audioStream = null;
  }

  console.log("[Offscreen] Capture stopped");
}
