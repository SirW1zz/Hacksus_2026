"""
Gemini 2.0 Flash service for LLM-powered interview intelligence.
"""

import json
import google.generativeai as genai
from config import settings

# Configure the Gemini API
genai.configure(api_key=settings.gemini_api_key)

model = genai.GenerativeModel("gemini-2.5-flash")


async def call_gemini(prompt: str) -> str:
    """Wrapper to call Gemini with specific error handling and markdown stripping."""
    try:
        response = await model.generate_content_async(prompt)
        text = response.text.strip()
        
        # Strip markdown code fences if present
        if text.startswith("```"):
            lines = text.split("\n")
            if lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].startswith("```"):
                lines = lines[:-1]
            text = "\n".join(lines).strip()
            
        return text
    except Exception as e:
        err_msg = str(e)
        if "429" in err_msg or "ResourceExhausted" in err_msg or "quota" in err_msg.lower():
            raise Exception("GEMINI_QUOTA_EXCEEDED")
        if "401" in err_msg or "403" in err_msg or "API_KEY_INVALID" in err_msg:
            raise Exception("GEMINI_AUTH_FAILED")
        raise e


async def generate_interview_guide(resume_text: str, jd_text: str) -> dict:
    """Generate a structured interview guide from resume + JD."""
    prompt = f"""You are an expert technical interviewer. Analyze the resume and job description below,
then produce a structured interview guide in JSON format.

RESUME:
{resume_text}

JOB DESCRIPTION:
{jd_text}

Return a JSON object with these keys:
{{
  "competency_scorecard": [
    {{"skill": "...", "resume_evidence": "...", "match_level": "strong|moderate|weak|missing", "score": 0-10}}
  ],
  "interview_sections": [
    {{
      "section": "...",
      "duration_minutes": 10,
      "questions": [
        {{"question": "...", "purpose": "...", "follow_ups": ["..."], "red_flags": ["..."]}}
      ]
    }}
  ],
  "trap_questions": [
    {{"question": "...", "expected_honest_answer": "...", "deception_indicator": "..."}}
  ],
  "technical_cheat_sheet": [
    {{"topic": "...", "key_concepts": ["..."], "depth_check_question": "..."}}
  ]
}}

Be thorough but concise. Focus on verifying claims and assessing real depth of knowledge."""

    text = await call_gemini(prompt)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"raw_guide": text}


async def analyze_response(
    transcript_chunk: str,
    resume_data: dict,
    question_asked: str,
    full_context: str = "",
) -> dict:
    """Analyze a candidate's response for quality, contradictions, and bias signals."""
    prompt = f"""You are an interview analysis AI. Evaluate the candidate's response.

QUESTION ASKED: {question_asked}

CANDIDATE'S RESPONSE:
{transcript_chunk}

RESUME DATA:
{json.dumps(resume_data, indent=2)}

INTERVIEW CONTEXT SO FAR:
{full_context[-2000:] if full_context else "Start of interview"}

Return a JSON object:
{{
  "response_quality": "strong|adequate|vague|evasive",
  "vague_phrases": ["phrases that lack specificity"],
  "contradictions": [
    {{"claim": "what they said", "resume_fact": "what resume shows", "severity": "high|medium|low"}}
  ],
  "suggested_followups": [
    {{"question": "...", "reason": "..."}}
  ],
  "bias_warnings": [
    {{"type": "halo_effect|affinity_bias|confirmation_bias", "description": "..."}}
  ],
  "competency_signals": [
    {{"competency": "...", "signal": "positive|negative|neutral", "evidence": "..."}}
  ]
}}"""

    text = await call_gemini(prompt)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"raw_analysis": text}


async def generate_followup(transcript_chunk: str, context: dict) -> dict:
    """Generate real-time follow-up questions based on latest transcript."""
    prompt = f"""You are a real-time interview copilot. Based on the latest exchange, generate
intelligent follow-up questions the interviewer should ask next.

LATEST TRANSCRIPT:
{transcript_chunk}

CONTEXT:
- Role: {context.get('role', 'Unknown')}
- Key skills to verify: {json.dumps(context.get('skills_to_verify', []))}
- Already covered topics: {json.dumps(context.get('covered_topics', []))}

Return JSON:
{{
  "immediate_followup": {{"question": "...", "reason": "..."}},
  "probing_questions": [
    {{"question": "...", "targets": "...", "priority": "high|medium|low"}}
  ],
  "warning": "any red flag or null"
}}"""

    text = await call_gemini(prompt)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"raw_followup": text}


async def generate_summary(full_transcript: str, resume_data: dict) -> dict:
    """Generate a post-interview synthesis report."""
    prompt = f"""You are a hiring decision support AI. Generate a comprehensive post-interview report.

FULL INTERVIEW TRANSCRIPT:
{full_transcript[-8000:]}

RESUME DATA:
{json.dumps(resume_data, indent=2)}

Return JSON:
{{
  "tldr": "2-3 sentence summary of the interview",
  "overall_recommendation": "strong_hire|hire|maybe|no_hire|strong_no_hire",
  "confidence_level": 0-100,
  "competency_scores": [
    {{"competency": "...", "score": 0-10, "evidence": "..."}}
  ],
  "strengths": ["..."],
  "concerns": ["..."],
  "contradictions_found": ["..."],
  "engagement_analysis": {{
    "candidate_talk_ratio": 0.0,
    "enthusiasm_level": "high|moderate|low",
    "communication_clarity": "excellent|good|fair|poor"
  }},
  "hiring_risks": ["..."],
  "recommended_next_steps": ["..."]
}}"""

    text = await call_gemini(prompt)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"raw_summary": text}
