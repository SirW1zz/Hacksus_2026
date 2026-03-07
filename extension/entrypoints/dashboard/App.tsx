import { useState, useEffect } from "react";

const API_BASE = "http://localhost:8000";

interface Session {
  session_id: string;
  candidate: string;
  status: string;
  created_at: string;
  final_report?: any;
}

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchSessions = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/sessions`);
      if (!res.ok) throw new Error("Failed to fetch sessions");
      const data = await res.json();
      setSessions(data);
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchSessions();
  }, []);

  const handlePrint = () => {
    window.print();
  };

  if (loading) return <div className="loading">Loading dashboard...</div>;
  if (error) return <div className="error">{error}</div>;

  return (
    <div className="dashboard-container">
      <header className="dashboard-header no-print">
        <h1>🎙️ Interview Intel Dashboard</h1>
        <p>Review and download past interview summaries</p>
      </header>

      <div className="dashboard-layout">
        {/* Left Sidebar: Session List */}
        <div className="session-list no-print">
          <h2>Past Interviews</h2>
          {sessions.length === 0 ? (
            <p className="empty-text">No interviews found.</p>
          ) : (
            sessions.map((s) => (
              <div
                key={s.session_id}
                className={`session-card ${
                  selectedSession?.session_id === s.session_id ? "active" : ""
                }`}
                onClick={() => setSelectedSession(s)}
              >
                <h3>{s.candidate || "Unknown Candidate"}</h3>
                <p>Session ID: {s.session_id}</p>
                <p className="date-text">
                  {new Date(s.created_at).toLocaleString()}
                </p>
                <span className={`status-badge ${s.status}`}>
                  {s.status === "summarized" ? "Completed & Summarized" : s.status}
                </span>
              </div>
            ))
          )}
        </div>

        {/* Right Panel: Detailed View */}
        <div className="session-detail">
          {selectedSession ? (
            <div className="report-container">
              <div className="report-actions no-print">
                <button className="btn primary" onClick={handlePrint}>
                  📄 Download PDF
                </button>
              </div>

              <div id="report-content" className="report-content">
                <h2>Interview Report: {selectedSession.final_report?.summary?.candidate_name || selectedSession.candidate || "Unknown Candidate"}</h2>
                <p><strong>Session ID:</strong> {selectedSession.session_id}</p>
                <p><strong>Date:</strong> {new Date(selectedSession.created_at).toLocaleString()}</p>
                
                {selectedSession.final_report ? (
                  <>
                    <div className="report-section">
                      <h3>Summary</h3>
                      <p>{selectedSession.final_report.summary?.tldr}</p>
                      
                      <div className="grid-2" style={{ marginTop: '16px' }}>
                        <div>
                          <p><strong>Mood:</strong> <span style={{ textTransform: 'capitalize' }}>{selectedSession.final_report.summary?.overall_mood || "Neutral"}</span></p>
                          <p><strong>Attitude:</strong> <span style={{ textTransform: 'capitalize' }}>{selectedSession.final_report.summary?.overall_attitude || "Professional"}</span></p>
                        </div>
                        <div>
                          <p><strong>Recommendation:</strong> <span className={`recommendation ${selectedSession.final_report.summary?.overall_recommendation}`}>{selectedSession.final_report.summary?.overall_recommendation?.replace(/_/g, ' ').toUpperCase()}</span></p>
                          <p><strong>Confidence:</strong> {selectedSession.final_report.summary?.confidence_level}%</p>
                        </div>
                      </div>
                    </div>

                    <div className="report-section">
                      <h3>Strengths & Concerns</h3>
                      <div className="grid-2">
                        <div>
                          <h4>Strengths</h4>
                          <ul>
                            {selectedSession.final_report.summary?.strengths?.map((s: string, i: number) => <li key={i}>{s}</li>)}
                          </ul>
                        </div>
                        <div>
                          <h4>Concerns</h4>
                          <ul>
                            {selectedSession.final_report.summary?.concerns?.map((c: string, i: number) => <li key={i}>{c}</li>)}
                          </ul>
                        </div>
                      </div>
                    </div>

                    <div className="report-section">
                      <h3>Competency Scores</h3>
                      {selectedSession.final_report.summary?.competency_scores?.map((c: any, i: number) => (
                        <div key={i} className="comp-score-item">
                          <span className="comp-name">{c.competency}</span>
                          <span className="comp-score">{c.score}/10</span>
                          <p className="comp-evidence">{c.evidence}</p>
                        </div>
                      ))}
                    </div>

                    <div className="report-section">
                      <h3>Engagement & Communication</h3>
                      <p><strong>Talk Ratio (Candidate):</strong> {(selectedSession.final_report.engagement?.talk_time_balance?.candidate_percentage || 0).toFixed(0)}%</p>
                      <p><strong>Enthusiasm:</strong> {selectedSession.final_report.summary?.engagement_analysis?.enthusiasm_level}</p>
                      <p><strong>Clarity:</strong> {selectedSession.final_report.summary?.engagement_analysis?.communication_clarity}</p>
                    </div>
                  </>
                ) : (
                  <div className="pending-report">
                    <p>Report is currently pending or the interview was not fully summarized.</p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="empty-selection no-print">
              <p>Select an interview from the list to view the full report.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
