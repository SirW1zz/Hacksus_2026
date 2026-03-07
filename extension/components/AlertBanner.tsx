import React from "react";

interface Props {
  type: "contradiction" | "vague_answer" | "bias";
  message: string;
  details?: string;
  severity?: "high" | "medium" | "low";
}

const ICONS = {
  contradiction: "🔴",
  vague_answer: "🟡",
  bias: "🟠",
};

const LABELS = {
  contradiction: "Contradiction Detected",
  vague_answer: "Vague Answer",
  bias: "Bias Warning",
};

export default function AlertBanner({
  type,
  message,
  details,
  severity = "medium",
}: Props) {
  return (
    <div className={`alert-banner alert-${type} severity-${severity}`}>
      <div className="alert-banner-header">
        <span>
          {ICONS[type]} {LABELS[type]}
        </span>
      </div>
      <p className="alert-banner-msg">{message}</p>
      {details && <p className="alert-banner-details">💡 {details}</p>}
    </div>
  );
}
