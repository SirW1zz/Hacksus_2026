"""
Analysis service for vague-answer detection, contradiction flagging,
bias warnings, and engagement analytics.
"""

import json
from services.gemini_service import call_gemini


async def analyze_live_insights(text: str, resume_data: dict, history: str = "") -> dict:
    """Analyze mood, attitude, speaker, and generate live suggestions in one call."""
    prompt = f"""You are an expert interview psychologist and coach. Analyze the latest interview segment.

SEGMENT:
{text}

CONTEXT HISTORY (LAST 1000 WORDS):
{history[-3000:]}

RESUME SUMMARY:
{json.dumps(resume_data, indent=2, default=str)[:2000]}

Return EXACTLY this JSON:
{{
  "speaker": "Candidate | Interviewer | Both",
  "mood": "e.g., Chill, Focused, Tense, Academic, Conversational",
  "attitude": "e.g., Confident, Nervous, Evasive, Enthusiastic",
  "honesty": "e.g., Authentic, Exaggerating, Scripted, Honest",
  "suggestions": [
    {{
      "type": "icebreaker | follow-up | probe | transition",
      "text": "The exact question or phrase to say",
      "reason": "Why this is suggested now",
      "priority": "high | medium | low"
    }}
  ],
  "competency_updates": [
    {{"skill": "skill_name", "match_level": "strong|moderate|weak", "score_change": -1 to 1, "reason": "..."}}
  ]
}}

If the segment is silent or very short, prioritize an "icebreaker" suggesting how to resume or break the tension."""

    text_resp = await call_gemini(prompt)
    try:
        data = json.loads(text_resp)
        # Sanitize competency updates to ensure they have expected fields
        if "competency_updates" not in data:
            data["competency_updates"] = []
        return data
    except Exception:
        return {
            "speaker": "Unknown",
            "mood": "Neutral",
            "attitude": "Neutral",
            "suggestions": [],
            "competency_updates": []
        }

async def analyze_transcript_chunk_consolidated(text: str, resume_data: dict) -> dict:
    """Consolidated endpoint to flag vagueness, contradictions, and generate questions in ONE Gemini call."""
    prompt = f"""You are an advanced interview copilot AI. Analyze the candidate's latest verbal statement and compare it to their resume.

VERBAL STATEMENT:
{text}

RESUME DATA:
{json.dumps(resume_data, indent=2, default=str)[:3000]}

Perform tasks and return ONE comprehensive JSON:
1. Vagueness check: Is the answer vague or deflecting?
2. Contradiction check: Does the verbal claim contradict the resume?
3. Insights: Mood and Attitude detection.
4. Suggestions: 1-2 sharp follow-up or icebreaker questions.

Return EXACTLY this JSON structure:
{{
  "vagueness": {{
    "is_vague": true/false,
    "vague_phrases": [
      {{"phrase": "...", "issue": "..."}}
    ]
  }},
  "contradictions": {{
    "contradictions": [
      {{"verbal_claim": "what they said", "resume_fact": "what resume shows", "suggested_probe": "question to clarify"}}
    ]
  }},
  "insights": {{
    "mood": "convo mood",
    "attitude": "candidate attitude",
    "honesty": "candidate honesty",
    "speaker": "who's talking"
  }},
  "suggestions": [
     {{"question": "...", "reason": "...", "priority": "high|medium"}}
  ]
}}"""

    text_resp = await call_gemini(prompt)

    try:
        return json.loads(text_resp)
    except Exception:
        return {"vagueness": {}, "contradictions": {}, "insights": {}, "suggestions": []}

async def detect_vague_answers(text: str) -> dict:
    """Flag non-specific or evasive answers in a transcript chunk."""
    prompt = f"""Analyze the following candidate response for vagueness and evasiveness.

RESPONSE:
{text}

Return JSON:
{{
  "is_vague": true/false,
  "confidence": 0-100,
  "vague_phrases": [
    {{"phrase": "...", "issue": "lacks specificity|no metrics|no timeline|deflection"}}
  ],
  "suggested_probes": [
    "Specific follow-up question to get concrete details"
  ]
}}"""

    text_resp = await call_gemini(prompt)

    try:
        return json.loads(text_resp)
    except json.JSONDecodeError:
        return {"raw": text_resp}


async def detect_contradictions(speech_text: str, resume_data: dict) -> dict:
    """Compare spoken claims against resume data for contradictions."""
    prompt = f"""Compare the candidate's verbal statement to their resume data.
Flag any contradictions or inconsistencies.

VERBAL STATEMENT:
{speech_text}

RESUME DATA:
{json.dumps(resume_data, indent=2, default=str)[:4000]}

Return JSON:
{{
  "contradictions": [
    {{
      "verbal_claim": "what they said",
      "resume_fact": "what resume shows",
      "type": "dates|role|skills|education|achievement",
      "severity": "high|medium|low",
      "suggested_probe": "question to clarify"
    }}
  ],
  "unverifiable_claims": [
    {{"claim": "...", "reason": "not mentioned in resume"}}
  ]
}}"""

    text_resp = await call_gemini(prompt)

    try:
        return json.loads(text_resp)
    except json.JSONDecodeError:
        return {"raw": text_resp}


async def detect_bias(transcript_history: str) -> dict:
    """Analyze interview transcript for interviewer bias patterns."""
    prompt = f"""Analyze the following interview transcript for signs of interviewer bias.

TRANSCRIPT:
{transcript_history[-4000:]}

Look for signs of bias (halo, affinity, confirmation, off-topic). 
Return JSON: {{"bias_detected": bool, "warnings": [...]}}"""

    text_resp = await call_gemini(prompt)

    try:
        return json.loads(text_resp)
    except json.JSONDecodeError:
        return {"raw": text_resp}


async def calculate_engagement(transcript_chunks: list) -> dict:
    """Calculate engagement metrics from transcript data."""
    if not transcript_chunks:
        return {
            "talk_time_balance": {"interviewer": 0, "candidate": 0},
            "total_exchanges": 0,
        }

    interviewer_words = 0
    candidate_words = 0
    total_exchanges = len(transcript_chunks)

    for chunk in transcript_chunks:
        word_count = len(chunk.get("text", "").split())
        speaker = chunk.get("speaker", "").lower()
        if "interviewer" in speaker or "speaker 0" in speaker:
            interviewer_words += word_count
        else:
            candidate_words += word_count

    total_words = interviewer_words + candidate_words
    if total_words == 0:
        total_words = 1

    return {
        "talk_time_balance": {
            "interviewer_percentage": round(interviewer_words / total_words * 100, 1),
            "candidate_percentage": round(candidate_words / total_words * 100, 1),
        },
        "total_exchanges": total_exchanges,
        "total_words": total_words,
        "interviewer_words": interviewer_words,
        "candidate_words": candidate_words,
        "balance_quality": (
            "good" if 30 <= (candidate_words / total_words * 100) <= 70
            else "candidate_dominated" if (candidate_words / total_words * 100) > 70
            else "interviewer_dominated"
        ),
    }
