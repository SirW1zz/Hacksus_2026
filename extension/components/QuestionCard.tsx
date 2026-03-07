import React from "react";

interface Props {
  question: string;
  reason?: string;
  targets?: string;
  priority?: "high" | "medium" | "low";
}

export default function QuestionCard({
  question,
  reason,
  targets,
  priority = "medium",
}: Props) {
  return (
    <div className={`followup-card priority-${priority}`}>
      <p className="followup-q">{question}</p>
      {reason && <p className="followup-reason">💡 {reason}</p>}
      {targets && <span className="followup-target">🎯 {targets}</span>}
    </div>
  );
}
