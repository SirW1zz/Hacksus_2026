import React from "react";

interface Competency {
  skill: string;
  score: number;
  match_level: string;
}

interface Props {
  competencies: Competency[];
}

export default function CompetencyTracker({ competencies }: Props) {
  return (
    <div className="competency-tracker">
      {competencies.map((c, i) => (
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
  );
}
