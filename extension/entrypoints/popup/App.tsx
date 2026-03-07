import { useState, useRef, useEffect } from "react";

const API_BASE = import.meta.env.WXT_API_BASE || "http://localhost:8000";

export default function App() {
  const [sessionId, setSessionId] = useState<string>("");
  const [status, setStatus] = useState<"idle" | "preparing" | "live">("idle");
  const [meetDetected, setMeetDetected] = useState(false);
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [resumeUploaded, setResumeUploaded] = useState(false);
  const [jdText, setJdText] = useState("");
  const [scorecard, setScorecard] = useState<any>(null);
  const [guide, setGuide] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // Check if current tab is Google Meet
  const checkMeet = async () => {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      const isMeet = tab?.url?.includes("meet.google.com") ?? false;
      setMeetDetected(isMeet);
      return isMeet;
    } catch {
      return false;
    }
  };

  // Create new session
  const startSession = async () => {
    setLoading(true);
    setError("");
    try {
      const form = new FormData();
      form.append("interviewer", "default");
      const res = await fetch(`${API_BASE}/session/create`, {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      setSessionId(data.session_id);
      setStatus("preparing");

      // Store session in chrome.storage for content script
      await chrome.storage.local.set({ sessionId: data.session_id });
    } catch (e: any) {
      setError("Could not connect to backend. Is it running?");
    }
    setLoading(false);
  };

  // Open side panel directly to preserve user gesture passing
  const openSidePanel = async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id && tab.url?.includes("meet.google.com")) {
        await chrome.sidePanel.setOptions({ tabId: tab.id, path: 'sidepanel.html', enabled: true });
        await chrome.sidePanel.open({ tabId: tab.id });
      } else {
        const win = await chrome.windows.getCurrent();
        if (win.id) {
          await chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true });
          await chrome.sidePanel.open({ windowId: win.id });
        }
      }
    } catch (err) {
      console.error("Popup open sidepanel error:", err);
      // Fallback: send message to background
      chrome.runtime.sendMessage({ type: "OPEN_SIDEPANEL" });
    }
  };

  // Start Developer Mode (skip resume/JD upload)
  const startDevMode = async () => {
    // OPEN SIDE PANEL IMMEDIATELY to preserve the user's click gesture (don't block with await fetch!)
    openSidePanel().catch(console.error);

    setLoading(true);
    setError("");
    try {
      const form = new FormData();
      form.append("interviewer", "dev_user");
      const res = await fetch(`${API_BASE}/session/create`, {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      const newSessionId = data.session_id;

      // Call the dev-mock endpoint
      const mockForm = new FormData();
      mockForm.append("session_id", newSessionId);
      await fetch(`${API_BASE}/dev-mock`, {
        method: "POST",
        body: mockForm,
      });

      setSessionId(newSessionId);
      await chrome.storage.local.set({ sessionId: newSessionId, isLive: true });
      setStatus("live");
      
      // If we are already on a meet tab, tell it to start scraping
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url?.includes("meet.google.com") && tab.id) {
        chrome.tabs.sendMessage(tab.id, {
          type: "START_SCRAPING",
          sessionId: newSessionId,
        });
      } else {
        // Automatically open a new meet if not on one
        chrome.tabs.create({ url: "https://meet.google.com/new" });
      }

    } catch (e: any) {
      setError("Failed to start Developer Mode. Is the backend running?");
    }
    setLoading(false);
  };

  // Upload resume
  const uploadResume = async () => {
    if (!resumeFile || !sessionId) return;
    setLoading(true);
    setError("");
    try {
      const form = new FormData();
      form.append("session_id", sessionId);
      form.append("file", resumeFile);
      const res = await fetch(`${API_BASE}/upload-resume`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        setError(errData?.detail || `Resume upload failed (${res.status})`);
        setLoading(false);
        return;
      }
      const data = await res.json();
      if (data.parsed_resume) {
        setScorecard(null); // will get with JD
        setResumeUploaded(true);
        setInfo("Resume successfully parsed and uploaded!");
      }
    } catch (e: any) {
      setError("Resume upload failed — cannot reach backend");
    }
    setLoading(false);
  };

  // Upload JD and get scorecard + guide
  const uploadJd = async () => {
    if (!jdText || !sessionId) return;
    setLoading(true);
    setError("");
    try {
      const form = new FormData();
      form.append("session_id", sessionId);
      form.append("jd_text", jdText);
      const res = await fetch(`${API_BASE}/upload-jd`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        setError(errData?.detail || `JD upload failed (${res.status})`);
        setLoading(false);
        return;
      }
      const data = await res.json();
      console.log("[uploadJd] Success:", data);
      
      if (data.scorecard) setScorecard(data.scorecard);
      if (data.interview_guide) setGuide(data.interview_guide);
      
      if (!data.scorecard) {
        setInfo("JD uploaded, but scorecard generation is still in progress or no resume was found.");
      }
      if (data.warning) setError(data.warning);
    } catch (e: any) {
      setError("JD upload failed — cannot reach backend");
    }
    setLoading(false);
  };

  // Start live interview (open side panel + notify content script)
  const goLive = async () => {
    openSidePanel().catch(console.error);
    await chrome.storage.local.set({ sessionId, isLive: true });
    // Tell content script to start scraping
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, {
        type: "START_SCRAPING",
        sessionId,
      });
    }
    setStatus("live");
  };

  // Detect Google Meet
  useEffect(() => {
    checkMeet();
    const interval = setInterval(checkMeet, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="popup-container">
      {/* Header */}
      <header className="popup-header">
        <div className="logo-section">
          <div className="logo-icon">🧠</div>
          <div>
            <h1>Interview Intel</h1>
            <p className="subtitle">AI-Powered Copilot</p>
          </div>
        </div>
        <div className={`status-badge ${status}`}>
          {status === "idle" && "⏸ Idle"}
          {status === "preparing" && "⚡ Preparing"}
          {status === "live" && "🔴 LIVE"}
        </div>
      </header>

      {/* Meet Detection */}
      <div className={`meet-indicator ${meetDetected ? "active" : ""}`}>
        <span className="dot"></span>
        {meetDetected ? "Google Meet Detected" : "No Meet Session"}
      </div>

      {/* Info Display */}
      {info && <div className="info-banner">{info}</div>}
      {/* Error Display */}
      {error && <div className="error-banner">{error}</div>}

      {/* Step 1: Start Session */}
      {status === "idle" && (
        <div className="card">
          <h2>Start New Interview</h2>
          <p>Create a session to begin preparing for an interview.</p>
          <button
            className="btn primary"
            onClick={startSession}
            disabled={loading}
          >
            {loading ? "Creating..." : "🚀 Create Session"}
          </button>
          
          <div style={{ marginTop: "16px", borderTop: "1px dashed #333", paddingTop: "16px" }}>
            <p style={{ fontSize: "12px", color: "var(--text-dim)", marginBottom: "8px" }}>
              Testing the side panel? Skip the resume/JD setup:
            </p>
            <button
              className="btn secondary"
              style={{ width: "100%", background: "rgba(124, 92, 252, 0.1)", color: "var(--accent)" }}
              onClick={startDevMode}
              disabled={loading}
            >
              🛠️ Developer Mode (Quick Start)
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Upload Resume & JD */}
      {status === "preparing" && (
        <>
          <div className="card">
            <div className="session-tag">Session: {sessionId}</div>

            <h3>📄 Upload Resume</h3>
            <div
              className="file-drop"
              onClick={() => fileRef.current?.click()}
            >
              <input
                ref={fileRef}
                type="file"
                accept=".pdf"
                hidden
                onChange={(e) => {
                  setResumeFile(e.target.files?.[0] || null);
                  setResumeUploaded(false);
                  setInfo("");
                }}
              />
              {resumeFile ? (
                <span className="file-name">
                  {resumeUploaded ? "✅ Uploaded: " : "📎 Selected: "} 
                  {resumeFile.name}
                </span>
              ) : (
                <span>Click to select PDF</span>
              )}
            </div>
            <button
              className={`btn ${resumeUploaded ? "success" : "secondary"}`}
              onClick={uploadResume}
              disabled={!resumeFile || loading}
            >
              {loading ? "Parsing..." : resumeUploaded ? "Re-upload Resume" : "Upload Resume"}
            </button>
          </div>

          <div className="card">
            <h3>📋 Job Description</h3>
            <textarea
              placeholder="Paste the job description here..."
              value={jdText}
              onChange={(e) => setJdText(e.target.value)}
              rows={5}
            />
            <button
              className="btn secondary"
              onClick={uploadJd}
              disabled={!jdText || loading || !resumeUploaded}
            >
              {loading ? "Analyzing..." : "Upload JD & Generate Guide"}
            </button>
          </div>

          {/* Scorecard Preview */}
          {scorecard && (
            <div className="card scorecard">
              <h3>📊 Competency Scorecard</h3>
              <div className="match-score">
                <div className="score-circle">
                  {scorecard.overall_match_score ?? "?"}
                </div>
                <span className="match-label">
                  {scorecard.match_level ?? ""}
                </span>
              </div>
              {scorecard.competencies?.slice(0, 5).map((c: any, i: number) => (
                <div key={i} className="competency-row">
                  <span className="comp-name">{c.skill}</span>
                  <div className="comp-bar">
                    <div
                      className="comp-fill"
                      style={{ width: `${(c.score / 10) * 100}%` }}
                    />
                  </div>
                  <span className="comp-score">{c.score}/10</span>
                </div>
              ))}
            </div>
          )}

          {/* Go Live / Start Meet Button */}
          {scorecard && (
            <div className="card start-actions">
              {!meetDetected ? (
                <>
                  <p className="hint">Google Meet not detected. Start a new meeting to go live.</p>
                  <button 
                    className="btn secondary" 
                    style={{ width: "100%", background: "#4285f4", color: "white", marginBottom: "10px" }}
                    onClick={async () => {
                      openSidePanel().catch(console.error);
                      await chrome.storage.local.set({ sessionId, isLive: true });
                      setStatus("live");
                      chrome.tabs.create({ url: "https://meet.google.com/new" });
                    }}
                  >
                    🌐 Start New Google Meet
                  </button>
                </>
              ) : (
                <button className="btn live-btn" onClick={goLive}>
                  🔴 Go Live — Start Interview
                </button>
              )}
            </div>
          )}
        </>
      )}

      {/* Step 3: Live */}
      {status === "live" && (
        <div className="card live-card">
          <div className="live-pulse"></div>
          <h2>Interview In Progress</h2>
          <p>
            The side panel is open with your live dashboard. Focus on the
            interview — your AI copilot is monitoring everything.
          </p>
          <p className="session-tag">Session: {sessionId}</p>
        </div>
      )}
      {/* Footer Navigation */}
      <div className="popup-footer" style={{ marginTop: "15px", borderTop: "1px solid #333", paddingTop: "15px" }}>
        <button
          className="btn secondary"
          style={{ width: "100%" }}
          onClick={() => {
            chrome.tabs.create({ url: chrome.runtime.getURL("/dashboard.html") });
          }}
        >
          📊 Go to Dashboard
        </button>
      </div>
    </div>
  );
}
