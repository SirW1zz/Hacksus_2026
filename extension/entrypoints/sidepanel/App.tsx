import { useState, useEffect, useRef } from "react";

const API_BASE = import.meta.env.WXT_API_BASE || "http://localhost:8000";

interface TranscriptEntry {
  speaker: string;
  text: string;
  timestamp: string;
}

interface Warning {
  type: string;
  subtype: string;
  data: any;
  timestamp: string;
}

interface Followup {
  question: string;
  reason?: string;
  targets?: string;
  priority?: string;
}

export default function App() {
  const [sessionId, setSessionId] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [followups, setFollowups] = useState<Followup[]>([]);
  const [competencies, setCompetencies] = useState<any[]>([]);
  const [guide, setGuide] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<
    "transcript" | "questions" | "alerts"
  >("transcript");
  const [elapsedTime, setElapsedTime] = useState(0);
  const [liveQuestion, setLiveQuestion] = useState<{question: string, reason: string} | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Load session and connect
  useEffect(() => {
    chrome.storage.local.get(["sessionId", "isLive"], async (data) => {
      if (data.sessionId) {
        setSessionId(data.sessionId);

        // Load interview guide
        try {
          const res = await fetch(
            `${API_BASE}/interview-guide/${data.sessionId}`
          );
          if (res.ok) {
            const guideData = await res.json();
            setGuide(guideData);
            if (guideData.competency_scorecard) {
              setCompetencies(guideData.competency_scorecard);
            }
          }
        } catch {}

        // Connect WebSocket
        if (data.isLive) {
          connectWs(data.sessionId);
        }
      }
    });

    return () => {
      wsRef.current?.close();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

  const connectWs = (sid: string) => {
    const WS_BASE = API_BASE.replace("http", "ws");
    const ws = new WebSocket(`${WS_BASE}/ws/interview/${sid}`);

    ws.onopen = () => {
      setIsConnected(true);
      // Start timer
      timerRef.current = setInterval(() => {
        setElapsedTime((t) => t + 1);
      }, 1000);
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === "transcript") {
        setTranscript((prev) => [
          ...prev,
          {
            speaker: msg.speaker,
            text: msg.text,
            timestamp: new Date().toLocaleTimeString(),
          },
        ]);
      } else if (msg.type === "warning") {
        setWarnings((prev) => [
          ...prev,
          {
            type: msg.type,
            subtype: msg.subtype,
            data: msg.data,
            timestamp: new Date().toLocaleTimeString(),
          },
        ]);
      } else if (msg.type === "followup") {
        const data = msg.data;
        const items: Followup[] = [];
        if (data.immediate_followup?.question) {
          items.push({
            question: data.immediate_followup.question,
            reason: data.immediate_followup.reason,
            priority: "high",
          });
        }
        if (data.probing_questions) {
          items.push(...data.probing_questions);
        }
        setFollowups(items);
      } else if (msg.type === "live_question") {
        setLiveQuestion({
          question: msg.data.question,
          reason: msg.data.reason
        });
        // Auto-dismiss after 20 seconds
        setTimeout(() => {
          setLiveQuestion(null);
        }, 20000);
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      if (timerRef.current) clearInterval(timerRef.current);
    };

    wsRef.current = ws;
  };

  const requestFollowup = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "request_followup" }));
    }
  };

  const endInterview = async () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "end_interview" }));
    }
    
    // Trigger summary generation gracefully in background
    const form = new FormData();
    form.append("session_id", sessionId);
    fetch(`${API_BASE}/generate-summary`, {
      method: "POST",
      body: form,
    }).catch(console.error);

    await chrome.storage.local.set({ isLive: false, sessionId: "" });
    window.close();
  };

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  };

  const warningCount = warnings.length;

  return (
    <div className="sidepanel-container">
      {/* Header */}
      <header className="sp-header">
        <div className="sp-title-row">
          <span className="sp-logo">🧠</span>
          <h1>Interview Copilot</h1>
          <div className={`connection-dot ${isConnected ? "connected" : ""}`} />
        </div>
        <div className="sp-meta">
          <span className="sp-timer">{formatTime(elapsedTime)}</span>
          <span className="sp-session">#{sessionId}</span>
        </div>
      </header>

      {/* Tab Bar */}
      <nav className="tab-bar">
        <button
          className={`tab ${activeTab === "transcript" ? "active" : ""}`}
          onClick={() => setActiveTab("transcript")}
        >
          💬 Transcript
        </button>
        <button
          className={`tab ${activeTab === "questions" ? "active" : ""}`}
          onClick={() => setActiveTab("questions")}
        >
          🎯 Questions
        </button>
        <button
          className={`tab ${activeTab === "alerts" ? "active" : ""}`}
          onClick={() => setActiveTab("alerts")}
        >
          ⚠️ Alerts
          {warningCount > 0 && (
            <span className="alert-badge">{warningCount}</span>
          )}
        </button>
      </nav>

      {/* Content Area */}
      <div className="sp-content">
        {/* Transcript Tab */}
        {activeTab === "transcript" && (
          <div className="transcript-feed">
            {transcript.length === 0 ? (
              <div className="empty-state">
                <span className="empty-icon">🎙️</span>
                <p>Waiting for conversation...</p>
                <p className="empty-sub">
                  Transcript will appear as the interview progresses
                </p>
              </div>
            ) : (
              transcript.map((entry, i) => (
                <div key={i} className={`transcript-entry ${entry.speaker.includes("0") ? "interviewer" : "candidate"}`}>
                  <div className="entry-header">
                    <span className="entry-speaker">{entry.speaker}</span>
                    <span className="entry-time">{entry.timestamp}</span>
                  </div>
                  <p className="entry-text">{entry.text}</p>
                </div>
              ))
            )}
            <div ref={transcriptEndRef} />
          </div>
        )}

        {/* Questions Tab */}
        {activeTab === "questions" && (
          <div className="questions-panel">
            <button className="btn-suggest" onClick={requestFollowup}>
              ✨ Get AI Suggestions
            </button>

            {followups.length > 0 && (
              <div className="followup-list">
                <h3>Suggested Follow-ups</h3>
                {followups.map((f, i) => (
                  <div key={i} className={`followup-card priority-${f.priority || "medium"}`}>
                    <p className="followup-q">{f.question}</p>
                    {f.reason && (
                      <p className="followup-reason">💡 {f.reason}</p>
                    )}
                    {f.targets && (
                      <span className="followup-target">🎯 {f.targets}</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Interview Guide Sections */}
            {guide?.interview_sections && (
              <div className="guide-sections">
                <h3>📋 Interview Guide</h3>
                {guide.interview_sections.map((section: any, i: number) => (
                  <div key={i} className="guide-section">
                    <div className="section-header">
                      <span>{section.section}</span>
                      <span className="section-time">
                        {section.duration_minutes}m
                      </span>
                    </div>
                    {section.questions?.map((q: any, j: number) => (
                      <div key={j} className="guide-question">
                        <p>{q.question}</p>
                        <span className="q-purpose">{q.purpose}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {/* Trap Questions */}
            {guide?.trap_questions && (
              <div className="trap-section">
                <h3>🪤 Trap Questions</h3>
                {guide.trap_questions.map((t: any, i: number) => (
                  <div key={i} className="trap-card">
                    <p className="trap-q">{t.question}</p>
                    <p className="trap-expect">
                      Expected: {t.expected_honest_answer}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Alerts Tab */}
        {activeTab === "alerts" && (
          <div className="alerts-panel">
            {warnings.length === 0 ? (
              <div className="empty-state">
                <span className="empty-icon">✅</span>
                <p>No alerts yet</p>
                <p className="empty-sub">
                  Bias warnings and contradictions will appear here
                </p>
              </div>
            ) : (
              warnings.map((w, i) => (
                <div key={i} className={`alert-card alert-${w.subtype}`}>
                  <div className="alert-header">
                    <span className="alert-type">
                      {w.subtype === "contradiction" && "🔴 Contradiction"}
                      {w.subtype === "vague_answer" && "🟡 Vague Answer"}
                      {w.subtype === "bias" && "🟠 Bias Warning"}
                    </span>
                    <span className="alert-time">{w.timestamp}</span>
                  </div>
                  <div className="alert-body">
                    {w.subtype === "vague_answer" &&
                      w.data?.vague_phrases?.map((p: any, j: number) => (
                        <p key={j}>
                          <strong>"{p.phrase}"</strong> — {p.issue}
                        </p>
                      ))}
                    {w.subtype === "vague_answer" &&
                      w.data?.suggested_probes?.map(
                        (s: string, j: number) => (
                          <p key={j} className="probe-suggest">
                            💡 Ask: {s}
                          </p>
                        )
                      )}
                    {w.subtype === "contradiction" &&
                      w.data?.contradictions?.map((c: any, j: number) => (
                        <div key={j} className="contradiction-item">
                          <p>
                            Said: <strong>"{c.verbal_claim}"</strong>
                          </p>
                          <p>
                            Resume: <strong>{c.resume_fact}</strong>
                          </p>
                          <p className="probe-suggest">
                            💡 {c.suggested_probe}
                          </p>
                        </div>
                      ))}
                    {w.subtype === "bias" &&
                      w.data?.warnings?.map((b: any, j: number) => (
                        <div key={j}>
                          <p>
                            <strong>{b.type}</strong>: {b.description}
                          </p>
                          <p className="probe-suggest">
                            📌 {b.recommendation}
                          </p>
                        </div>
                      ))}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Competency Tracker */}
      {competencies.length > 0 && (
        <div className="competency-section">
          <h3>📊 Competency Tracker</h3>
          {competencies.slice(0, 6).map((c: any, i: number) => (
            <div key={i} className="comp-row">
              <span className="comp-label">{c.skill}</span>
              <div className="comp-track">
                <div
                  className="comp-bar-fill"
                  style={{ width: `${(c.score / 10) * 100}%` }}
                />
              </div>
              <span className={`comp-level ${c.match_level}`}>
                {c.match_level}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Live Question Popup (Toast) */}
      {liveQuestion && (
        <div className="live-question-toast slide-up">
          <div className="toast-header">
            <span className="toast-icon">✨</span>
            <strong>Suggested Question</strong>
            <button className="close-toast" onClick={() => setLiveQuestion(null)}>×</button>
          </div>
          <p className="toast-question">{liveQuestion.question}</p>
          {liveQuestion.reason && <p className="toast-reason">💡 {liveQuestion.reason}</p>}
        </div>
      )}

      {/* Footer Actions */}
      <footer className="sp-footer">
        <button className="btn-end" onClick={endInterview}>
          ⏹️ End Interview
        </button>
      </footer>
    </div>
  );
}
