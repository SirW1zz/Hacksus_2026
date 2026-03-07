import React from "react";

interface Props {
  entries: Array<{
    speaker: string;
    text: string;
    timestamp: string;
  }>;
}

export default function TranscriptFeed({ entries }: Props) {
  return (
    <div className="transcript-feed">
      {entries.map((entry, i) => (
        <div
          key={i}
          className={`transcript-entry ${
            entry.speaker.includes("0") ? "interviewer" : "candidate"
          }`}
        >
          <div className="entry-header">
            <span className="entry-speaker">{entry.speaker}</span>
            <span className="entry-time">{entry.timestamp}</span>
          </div>
          <p className="entry-text">{entry.text}</p>
        </div>
      ))}
    </div>
  );
}
