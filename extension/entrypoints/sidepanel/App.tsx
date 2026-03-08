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
    "insights" | "questions" | "alerts"
  >("insights");
  const [elapsedTime, setElapsedTime] = useState(0);
  const [liveQuestion, setLiveQuestion] = useState<{question: string, reason: string} | null>(null);
  const [insights, setInsights] = useState<{
    mood: string;
    attitude: string;
    honesty: string;
    speaker: string;
    suggestions: any[];
  }>({
    mood: "Conversational",
    attitude: "Natural",
    honesty: "Authentic",
    speaker: "Ready",
    suggestions: []
  });

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const [meetEnded, setMeetEnded] = useState(false);
  const [isEnding, setIsEnding] = useState(false);

  // Truncate labels to max 5 words
  const truncateLabel = (text: string, maxWords = 5) => {
    const words = text.split(/\s+/);
    return words.length > maxWords ? words.slice(0, maxWords).join(" ") : text;
  };

  // Check if mood is tense/uncomfortable
  const isTenseMood = (mood: string) =>
    /tense|nervous|uncomfortable|anxious|stressed|awkward/i.test(mood);

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
      }
    });

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // Auto-scroll debug transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

  // Listen for messages from background script — register IMMEDIATELY on mount
  // so we don't miss early transcripts
  useEffect(() => {
    const messageListener = (msg: any) => {
      if (msg.type !== "WS_MESSAGE") return;

      const data = msg.data;
      if (data.type === "transcript") {
        setTranscript((prev) => {
          // Dedup: don't add if last entry has same text
          if (prev.length > 0 && prev[prev.length - 1].text === data.text) {
            return prev;
          }
          return [
            ...prev,
            {
              speaker: data.speaker,
              text: data.text,
              timestamp: new Date().toLocaleTimeString(),
            },
          ];
        });
        setInsights((prev) => ({ ...prev, speaker: data.speaker }));
      } else if (data.type === "live_insights") {
        setInsights((prev) => ({
          mood: data.data.mood || prev.mood,
          attitude: data.data.attitude || prev.attitude,
          honesty: data.data.honesty || prev.honesty,
          speaker: data.data.speaker || prev.speaker,
          suggestions: data.data.suggestions || [],
        }));

        if (data.data.competency_updates) {
          setCompetencies((prev) => {
            const next = [...prev];
            data.data.competency_updates.forEach((update: any) => {
              const idx = next.findIndex(
                (c) => c.skill.toLowerCase() === update.skill.toLowerCase()
              );
              if (idx !== -1) {
                next[idx] = {
                  ...next[idx],
                  score: Math.max(0, Math.min(10, next[idx].score + (update.score_change || 0))),
                  match_level: update.match_level || next[idx].match_level,
                };
              }
            });
            return next;
          });
        }
      } else if (data.type === "warning") {
        setWarnings((prev) => [
          ...prev,
          {
            type: data.type,
            subtype: data.subtype,
            data: data.data,
            timestamp: new Date().toLocaleTimeString(),
          },
        ]);
      } else if (data.type === "followup") {
        const payload = data.data;
        const items: Followup[] = [];
        if (payload.immediate_followup?.question) {
          items.push({
            question: payload.immediate_followup.question,
            reason: payload.immediate_followup.reason,
            priority: "high",
          });
        }
        if (payload.probing_questions) {
          items.push(...payload.probing_questions);
        }
        setFollowups(items);
      } else if (data.type === "live_question") {
        setLiveQuestion({
          question: data.data.question,
          reason: data.data.reason,
        });
        setTimeout(() => setLiveQuestion(null), 20000);
      } else if (data.type === "session_ended") {
        // Backend confirmed the session ended — show finished state
        setMeetEnded(true);
        setIsEnding(false);
        if (timerRef.current) clearInterval(timerRef.current);
      }
    };

    chrome.runtime.onMessage.addListener(messageListener);

    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
    };
  }, []); // Register once on mount, never re-register

  // When sessionId is resolved, connect WS and start scraping
  useEffect(() => {
    if (!sessionId) return;

    // Tell background to connect backend WebSocket
    chrome.runtime.sendMessage({ type: "CONNECT_WS", sessionId }).catch(() => {});
    setIsConnected(true);

    const startScraping = () => {
       chrome.tabs.query({ url: "https://meet.google.com/*" }).then((tabs) => {
         for (const tab of tabs) {
           if (tab.id) {
             chrome.tabs.sendMessage(tab.id, {
               type: "START_SCRAPING",
               sessionId,
             }).catch(() => {
                // Fails if content script isn't running (e.g. extension updated/reloaded during ongoing meeting).
                // Dynamically inject the WXT-built content script.
                if (chrome.scripting) {
                   console.log("[Interview Intel] Content script not found, injecting dynamically...");
                   chrome.scripting.executeScript({
                      target: { tabId: tab.id! },
                      files: ["content-scripts/content.js"]
                   }).then(() => {
                      setTimeout(() => {
                        chrome.tabs.sendMessage(tab.id!, {
                           type: "START_SCRAPING",
                           sessionId,
                        }).catch(err => console.error("[Interview Intel] Still failed after inject", err));
                      }, 500);
                   }).catch(err => console.error("[Interview Intel] Inject failed:", err));
                }
             });
           }
         }
       });
    };

    startScraping();

    // ROBUST TRIGGER: Ping every 10s to ensure content script is alive
    const pingInterval = setInterval(() => {
       chrome.tabs.query({ url: "https://meet.google.com/*" }).then((tabs) => {
         if (tabs.length === 0) {
            // No Meet tabs found — if we were interviewing, this is a sign it might have ended
            // but we'll let the background script handle the definitive end.
            return;
         }
         for (const tab of tabs) {
           if (tab.id) {
             chrome.tabs.sendMessage(tab.id, { type: "PING" })
               .then((resp) => {
                  if (!resp || resp.type !== "PONG") startScraping();
               })
               .catch(() => startScraping());
           }
         }
       });
    }, 10000);

    timerRef.current = setInterval(() => {
      setElapsedTime((t) => t + 1);
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      clearInterval(pingInterval);
    };
  }, [sessionId]);

  const requestFollowup = () => {
    chrome.runtime.sendMessage({ type: "REQUEST_FOLLOWUP", sessionId }).catch(() => {});
  };

  const endInterview = async () => {
    if (isEnding) return; // Prevent double-click
    setIsEnding(true);

    // 1. Tell background to end interview (sends WS end_interview + stops capture)
    chrome.runtime.sendMessage({ type: "END_INTERVIEW", sessionId }).catch(() => {});

    // 2. Stop content scripts from scraping
    try {
      const meetTabs = await chrome.tabs.query({ url: "https://meet.google.com/*" });
      for (const tab of meetTabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, { type: "STOP_SCRAPING" }).catch(() => {});
        }
      }
    } catch {}

    // 3. Trigger summary generation in backend
    const form = new FormData();
    form.append("session_id", sessionId);
    fetch(`${API_BASE}/generate-summary`, {
      method: "POST",
      body: form,
    }).catch(console.error);

    // 4. Mark ended locally
    setMeetEnded(true);
    setIsEnding(false);
    if (timerRef.current) clearInterval(timerRef.current);
    await chrome.storage.local.set({ isLive: false, sessionId: "" });
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
          className={`tab ${activeTab === "insights" ? "active" : ""}`}
          onClick={() => setActiveTab("insights")}
        >
          ✨ Insights
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
        {/* Insights Tab (New Main Tab) */}
        {activeTab === "insights" && (
          <div className="insights-panel">
            {/* Real-time Status Area */}
            <div className="live-status-grid">
              <div className="status-card speaker">
                <span className="sc-label">Speaking Now</span>
                <span className="sc-val">{truncateLabel(insights.speaker)}</span>
              </div>
              <div className="status-card mood">
                <span className="sc-label">Convo Mood</span>
                <span className="sc-val">{truncateLabel(insights.mood)}</span>
              </div>
              <div className="status-card attitude">
                <span className="sc-label">Candidate Attitude</span>
                <span className="sc-val">{truncateLabel(insights.attitude)}</span>
              </div>
              <div className="status-card honesty">
                <span className="sc-label">Candidate Honesty</span>
                <span className="sc-val">{truncateLabel(insights.honesty)}</span>
              </div>
            </div>

            {/* Mood-based comfort suggestions when tense */}
            {isTenseMood(insights.mood) && (
              <div className="comfort-banner">
                <span className="comfort-icon">🫶</span>
                <span>Mood seems tense — try a lighter question to ease the conversation</span>
              </div>
            )}

            {/* Dynamic Questions Area (expanded — replaces old debug transcript) */}
            <div className="suggestions-area">
              <h3>⚡ Dynamic Questions</h3>
              {insights.suggestions.length === 0 ? (
                <div className="suggestion-empty">
                  Monitoring conversation for suggestions...
                </div>
              ) : (
                insights.suggestions.slice(0, 5).map((s, i) => (
                  <div key={i} className={`suggest-item priority-${s.priority || 'medium'} ${s.is_addon ? 'is-addon' : ''}`}>
                    <div className="suggest-header">
                       <p className="suggest-text">{s.text}</p>
                       {s.is_addon && <span className="addon-badge">dig deeper</span>}
                    </div>
                    <span className="suggest-reason">💡 {s.reason}</span>
                  </div>
                ))
              )}
            </div>

            {/* Mini Live Competency Tracker at bottom of insights */}
            {competencies.length > 0 && (
              <div className="live-comp-tracker">
                <h3>📊 Competency Snapshot (Live)</h3>
                <div className="comp-grid">
                  {competencies.slice(0, 4).map((c: any, i: number) => (
                    <div key={i} className="comp-item">
                      <div className="comp-header">
                        <span className="comp-name">{c.skill}</span>
                        <span className="comp-score">{c.score}/10</span>
                      </div>
                      <div className="comp-bar-mini">
                        <div 
                          className="comp-fill-mini" 
                          style={{ 
                            width: `${(c.score / 10) * 100}%`,
                            background: c.score > 7 ? '#10b981' : c.score > 4 ? '#f59e0b' : '#ef4444'
                          }} 
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Mini Debug Transcript (small, at bottom) */}
            <div className="mini-transcript">
              <div className="mt-header">
                <span className="mt-label">📝 LIVE TRANSCRIPT</span>
                <span className="mt-count">{transcript.length} entries</span>
              </div>
              <div className="mt-scroll">
                {transcript.length > 0 ? (
                  transcript.slice(-10).map((t, i) => (
                    <div key={i} className="mt-entry">
                      <strong className={t.speaker === 'Interviewer' ? 'mt-interviewer' : 'mt-candidate'}>
                        [{t.speaker}]
                      </strong>
                      {' '}{t.text.substring(0, 100)}{t.text.length > 100 ? '...' : ''}
                    </div>
                  ))
                ) : (
                  <p className="mt-empty">Waiting for speech...</p>
                )}
                <div ref={transcriptEndRef} />
              </div>
            </div>
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
        {meetEnded ? (
          <div className="end-banner">
            <span>✅ Interview ended — report is being generated</span>
            <button className="btn-dashboard" onClick={() => window.open(chrome.runtime.getURL('dashboard.html'), '_blank')}>
              📊 Open Dashboard
            </button>
          </div>
        ) : (
          <button className="btn-end" onClick={endInterview} disabled={isEnding}>
            {isEnding ? "⏳ Ending..." : "⏹️ End Interview"}
          </button>
        )}
      </footer>
    </div>
  );
}
