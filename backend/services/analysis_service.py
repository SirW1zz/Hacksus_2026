"""
Analysis service for vague-answer detection, contradiction flagging,
bias warnings, and engagement analytics.
"""

import json
from services.gemini_service import model


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

    response = await model.generate_content_async(prompt)
    text_resp = response.text.strip()
    if text_resp.startswith("```"):
        text_resp = text_resp.split("\n", 1)[1]
        if text_resp.endswith("```"):
            text_resp = text_resp[:-3]
        text_resp = text_resp.strip()

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

    response = await model.generate_content_async(prompt)
    text_resp = response.text.strip()
    if text_resp.startswith("```"):
        text_resp = text_resp.split("\n", 1)[1]
        if text_resp.endswith("```"):
            text_resp = text_resp[:-3]
        text_resp = text_resp.strip()

    try:
        return json.loads(text_resp)
    except json.JSONDecodeError:
        return {"raw": text_resp}


async def detect_bias(transcript_history: str) -> dict:
    """Analyze interview transcript for interviewer bias patterns."""
    prompt = f"""Analyze the following interview transcript for signs of interviewer bias.

TRANSCRIPT:
{transcript_history[-4000:]}

Look for:
- Halo effect (over-weighting one positive trait)
- Affinity bias (bonding over shared backgrounds)
- Confirmation bias (only seeking evidence for initial impression)
- Non-evidence-based discussions (too much small talk / off-topic)

Return JSON:
{{
  "bias_detected": true/false,
  "warnings": [
    {{
      "type": "halo_effect|affinity_bias|confirmation_bias|off_topic",
      "severity": "high|medium|low",
      "description": "...",
      "evidence": "specific quote or pattern",
      "recommendation": "what interviewer should do"
    }}
  ],
  "topic_balance": {{
    "technical_percentage": 0-100,
    "behavioral_percentage": 0-100,
    "small_talk_percentage": 0-100
  }}
}}"""

    response = await model.generate_content_async(prompt)
    text_resp = response.text.strip()
    if text_resp.startswith("```"):
        text_resp = text_resp.split("\n", 1)[1]
        if text_resp.endswith("```"):
            text_resp = text_resp[:-3]
        text_resp = text_resp.strip()

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
