import { useState, useEffect, useRef } from "react";

const API_BASE = "http://localhost:8000";

interface CandidateGroup {
  name: string;
  phone: string | null;
  sessions: any[];
  notes: any[];
}

export default function App() {
  const [candidates, setCandidates] = useState<CandidateGroup[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<CandidateGroup | null>(null);
  const [selectedSession, setSelectedSession] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [noteText, setNoteText] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  const fetchCandidates = async () => {
    try {
      const res = await fetch(`${API_BASE}/candidates`);
      if (!res.ok) throw new Error("Failed to fetch candidates");
      const data = await res.json();
      setCandidates(data);

      // Auto-update selected candidate if it has new data
      if (selectedCandidate) {
        const key = selectedCandidate.phone || selectedCandidate.name;
        const updated = data.find((c: CandidateGroup) =>
          (c.phone || c.name) === key
        );
        if (updated) {
          setSelectedCandidate(updated);
          // Also update selected session if it exists
          if (selectedSession) {
            const updatedSession = updated.sessions.find(
              (s: any) => s.session_id === selectedSession.session_id
            );
            if (updatedSession) setSelectedSession(updatedSession);
          }
        }
      }
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  };

  // Initial fetch + auto-refresh every 5 seconds
  useEffect(() => {
    fetchCandidates();
    const interval = setInterval(fetchCandidates, 5000);
    return () => clearInterval(interval);
  }, []);

  const saveNote = async () => {
    if (!noteText.trim() || !selectedCandidate) return;
    setSavingNote(true);
    try {
      const key = selectedCandidate.phone || selectedCandidate.name;
      const form = new FormData();
      form.append("candidate_key", key);
      form.append("note_text", noteText);
      await fetch(`${API_BASE}/notes`, { method: "POST", body: form });
      setNoteText("");
      // Refresh to get new notes
      await fetchCandidates();
    } catch (e) {
      console.error("Failed to save note:", e);
    }
    setSavingNote(false);
  };

  const handlePrint = () => window.print();

  const getVerdictClass = (verdict?: string) => {
    if (!verdict) return "";
    const v = verdict.toLowerCase().replace(/\s+/g, "_");
    if (v.includes("strong_hire")) return "verdict-strong-hire";
    if (v.includes("hire") && !v.includes("no")) return "verdict-hire";
    if (v.includes("maybe")) return "verdict-maybe";
    if (v.includes("strong_no")) return "verdict-strong-no";
    if (v.includes("no_hire")) return "verdict-no-hire";
    return "";
  };

  if (loading) return <div className="loading">Loading dashboard...</div>;
  if (error) return <div className="error">{error}</div>;

  const report = selectedSession?.final_report;
  const summary = report?.summary;
  const initialScorecard = selectedSession?.initial_scorecard || report?.initial_scorecard;

  return (
    <div className="dashboard-container">
      <header className="dashboard-header no-print">
        <h1>🎙️ Interview Intel Dashboard</h1>
        <p>Review candidates, compare interview rounds, and make decisions</p>
      </header>

      <div className="dashboard-layout">
        {/* Left Sidebar: Candidate List */}
        <div className="session-list no-print">
          <h2>Candidates</h2>
          {candidates.length === 0 ? (
            <p className="empty-text">No interviews found.</p>
          ) : (
            candidates.map((c, idx) => {
              const key = c.phone || c.name;
              const isActive = selectedCandidate && (selectedCandidate.phone || selectedCandidate.name) === key;
              const latestSession = c.sessions[0];
              const latestVerdict = latestSession?.final_report?.summary?.hire_verdict;

              return (
                <div
                  key={key + idx}
                  className={`session-card ${isActive ? "active" : ""}`}
                  onClick={() => {
                    setSelectedCandidate(c);
                    setSelectedSession(c.sessions[0]);
                  }}
                >
                  <h3>{c.name || "Unknown Candidate"}</h3>
                  {c.phone && <p className="phone-tag">📱 {c.phone}</p>}
                  <p className="rounds-count">{c.sessions.length} interview round{c.sessions.length !== 1 ? "s" : ""}</p>
                  {latestVerdict && (
                    <span className={`verdict-badge ${getVerdictClass(latestVerdict)}`}>
                      {latestVerdict}
                    </span>
                  )}
                  <span className={`status-badge ${latestSession?.status || ""}`}>
                    {latestSession?.status === "summarized" ? "✅ Complete" : latestSession?.status || "Unknown"}
                  </span>
                </div>
              );
            })
          )}
        </div>

        {/* Right Panel: Detailed View */}
        <div className="session-detail">
          {selectedCandidate ? (
            <div className="report-container">
              {/* Candidate Header */}
              <div className="candidate-header">
                <div className="candidate-info">
                  <h2>{selectedCandidate.name}</h2>
                  {selectedCandidate.phone && <span className="phone-display">📱 {selectedCandidate.phone}</span>}
                </div>

                {/* Round Selector */}
                {selectedCandidate.sessions.length > 1 && (
                  <div className="round-selector">
                    {selectedCandidate.sessions.map((s: any, i: number) => (
                      <button
                        key={s.session_id}
                        className={`round-btn ${selectedSession?.session_id === s.session_id ? "active" : ""}`}
                        onClick={() => setSelectedSession(s)}
                      >
                        Round {selectedCandidate.sessions.length - i}
                        <span className="round-date">{new Date(s.created_at).toLocaleDateString()}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Report Actions */}
              <div className="report-actions no-print">
                <button className="btn primary" onClick={handlePrint}>📄 Download PDF</button>
                <button className="btn secondary" onClick={fetchCandidates}>🔄 Refresh</button>
              </div>

              {selectedSession && (
                <div id="report-content" className="report-content">
                  <p><strong>Session:</strong> {selectedSession.session_id} · <strong>Date:</strong> {new Date(selectedSession.created_at).toLocaleString()}</p>

                  {summary ? (
                    <>
                      {/* Hire Verdict Banner */}
                      <div className={`verdict-banner ${getVerdictClass(summary.hire_verdict)}`}>
                        <div className="verdict-main">
                          <span className="verdict-label">{summary.hire_verdict || summary.overall_recommendation?.replace(/_/g, " ").toUpperCase()}</span>
                          <span className="verdict-confidence">{summary.confidence_level}% confidence</span>
                        </div>
                        {summary.hire_reasoning && <p className="verdict-reasoning">{summary.hire_reasoning}</p>}
                      </div>

                      {/* TLDR */}
                      <div className="report-section">
                        <h3>Summary</h3>
                        <p>{summary.tldr}</p>
                        {summary.interview_narrative && (
                          <>
                            <h4 style={{ marginTop: "12px" }}>Interview Narrative</h4>
                            <p className="narrative-text">{summary.interview_narrative}</p>
                          </>
                        )}
                        <div className="grid-2" style={{ marginTop: "16px" }}>
                          <div>
                            <p><strong>Mood:</strong> <span style={{ textTransform: "capitalize" }}>{summary.overall_mood || "Neutral"}</span></p>
                            <p><strong>Attitude:</strong> <span style={{ textTransform: "capitalize" }}>{summary.overall_attitude || "Professional"}</span></p>
                          </div>
                          <div>
                            <p><strong>Recommendation:</strong> <span className={`recommendation ${summary.overall_recommendation}`}>{summary.overall_recommendation?.replace(/_/g, " ").toUpperCase()}</span></p>
                            <p><strong>Confidence:</strong> {summary.confidence_level}%</p>
                          </div>
                        </div>
                      </div>

                      {/* Competency Scores: Initial vs Final */}
                      <div className="report-section">
                        <h3>Competency Scores — Initial vs Final</h3>
                        <div className="comp-comparison-grid">
                          {summary.competency_scores?.map((c: any, i: number) => {
                            const initialScore = c.initial_score ?? initialScorecard?.competencies?.find(
                              (ic: any) => ic.skill?.toLowerCase() === c.competency?.toLowerCase()
                            )?.score ?? "—";
                            const finalScore = c.final_score ?? c.score ?? "—";
                            return (
                              <div key={i} className="comp-comparison-item">
                                <span className="comp-comparison-name">{c.competency}</span>
                                <div className="comp-comparison-scores">
                                  <span className="score-initial" title="From resume">📄 {initialScore}/10</span>
                                  <span className="score-arrow">→</span>
                                  <span className="score-final" title="After interview">🎤 {finalScore}/10</span>
                                </div>
                                <p className="comp-evidence">{c.evidence}</p>
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      {/* Strengths & Concerns */}
                      <div className="report-section">
                        <h3>Strengths & Concerns</h3>
                        <div className="grid-2">
                          <div>
                            <h4>✅ Strengths</h4>
                            <ul>{summary.strengths?.map((s: string, i: number) => <li key={i}>{s}</li>)}</ul>
                          </div>
                          <div>
                            <h4>⚠️ Concerns</h4>
                            <ul>{summary.concerns?.map((c: string, i: number) => <li key={i}>{c}</li>)}</ul>
                          </div>
                        </div>
                      </div>

                      {/* Hiring Risks */}
                      {summary.hiring_risks?.length > 0 && (
                        <div className="report-section">
                          <h3>🚨 Hiring Risks</h3>
                          <ul>{summary.hiring_risks.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul>
                        </div>
                      )}

                      {/* Contradictions */}
                      {summary.contradictions_found?.length > 0 && (
                        <div className="report-section">
                          <h3>🔴 Contradictions Found</h3>
                          <ul>{summary.contradictions_found.map((c: string, i: number) => <li key={i}>{c}</li>)}</ul>
                        </div>
                      )}

                      {/* Engagement */}
                      <div className="report-section">
                        <h3>Engagement & Communication</h3>
                        <div className="grid-2">
                          <div>
                            <p><strong>Talk Ratio (Candidate):</strong> {(report.engagement?.talk_time_balance?.candidate_percentage || summary.engagement_analysis?.candidate_talk_ratio || 0)}%</p>
                            <p><strong>Total Exchanges:</strong> {report.engagement?.total_exchanges || "—"}</p>
                          </div>
                          <div>
                            <p><strong>Enthusiasm:</strong> {summary.engagement_analysis?.enthusiasm_level || "—"}</p>
                            <p><strong>Clarity:</strong> {summary.engagement_analysis?.communication_clarity || "—"}</p>
                          </div>
                        </div>
                      </div>

                      {/* Next Steps */}
                      {summary.recommended_next_steps?.length > 0 && (
                        <div className="report-section">
                          <h3>📋 Recommended Next Steps</h3>
                          <ul>{summary.recommended_next_steps.map((s: string, i: number) => <li key={i}>{s}</li>)}</ul>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="pending-report">
                      <div className="pending-spinner"></div>
                      <p>Report is being generated... Dashboard refreshes automatically every 5 seconds.</p>
                    </div>
                  )}
                </div>
              )}

              {/* Notes Section */}
              <div className="notes-section no-print">
                <h3>📝 Interviewer Notes</h3>
                <div className="note-input-area">
                  <textarea
                    placeholder="Add a note about this candidate..."
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    rows={3}
                  />
                  <button className="btn primary" onClick={saveNote} disabled={savingNote || !noteText.trim()}>
                    {savingNote ? "Saving..." : "Save Note"}
                  </button>
                </div>
                <div className="notes-list">
                  {selectedCandidate.notes.length === 0 ? (
                    <p className="empty-note">No notes yet for this candidate.</p>
                  ) : (
                    selectedCandidate.notes.map((n: any, i: number) => (
                      <div key={i} className="note-card">
                        <p className="note-text">{n.text}</p>
                        <span className="note-time">{new Date(n.created_at).toLocaleString()}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="empty-selection no-print">
              <p>Select a candidate from the list to view interview reports and add notes.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
