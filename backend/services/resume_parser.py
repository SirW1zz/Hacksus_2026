"""
Resume and JD parser service — extracts structured data from PDFs and generates
competency scorecards using Gemini.
"""

import json
import pdfplumber
from io import BytesIO
from services.gemini_service import call_gemini


def extract_text_from_pdf(pdf_bytes: bytes) -> str:
    """Extract all text from a PDF file."""
    text_parts = []
    with pdfplumber.open(BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            page_text = page.extract_text()
            if page_text:
                text_parts.append(page_text)
    return "\n\n".join(text_parts)


async def parse_resume(pdf_bytes: bytes) -> dict:
    """Parse a resume PDF into structured data using Gemini."""
    raw_text = extract_text_from_pdf(pdf_bytes)

    if not raw_text.strip():
        return {"error": "Could not extract text from PDF", "raw_text": ""}

    prompt = f"""Parse the following resume into a structured JSON format.

RESUME TEXT:
{raw_text}

Return JSON:
{{
  "name": "Full Name",
  "email": "email@example.com",
  "phone": "...",
  "linkedin": "...",
  "summary": "Professional summary if present",
  "skills": ["skill1", "skill2"],
  "experience": [
    {{
      "title": "Job Title",
      "company": "Company Name",
      "duration": "Date range",
      "responsibilities": ["..."],
      "key_achievements": ["..."]
    }}
  ],
  "education": [
    {{
      "degree": "...",
      "institution": "...",
      "year": "...",
      "gpa": "... or null"
    }}
  ],
  "certifications": ["..."],
  "projects": [
    {{"name": "...", "description": "...", "technologies": ["..."]}}
  ]
}}"""

    text = await call_gemini(prompt)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = {"raw_parsed": text}

    parsed["raw_text"] = raw_text
    return parsed


async def parse_jd(jd_text: str) -> dict:
    """Parse a job description into structured data."""
    prompt = f"""Parse the following job description into structured JSON.

JOB DESCRIPTION:
{jd_text}

Return JSON:
{{
  "title": "Job Title",
  "company": "Company name or null",
  "department": "...",
  "required_skills": ["..."],
  "preferred_skills": ["..."],
  "experience_required": "e.g. 3-5 years",
  "education_required": "...",
  "key_responsibilities": ["..."],
  "role_level": "junior|mid|senior|lead|principal"
}}"""

    text = await call_gemini(prompt)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"raw_parsed": text}


async def generate_competency_scorecard(resume_data: dict, jd_data: dict) -> dict:
    """Generate a scorecard matching resume skills against JD requirements."""
    prompt = f"""Compare the candidate's resume against the job description and produce a competency scorecard.

RESUME DATA:
{json.dumps(resume_data, indent=2, default=str)[:4000]}

JD DATA:
{json.dumps(jd_data, indent=2, default=str)[:2000]}

Return JSON:
{{
  "overall_match_score": 0-100,
  "match_level": "excellent|good|partial|poor",
  "competencies": [
    {{
      "skill": "...",
      "required_level": "required|preferred",
      "candidate_level": "expert|proficient|familiar|missing",
      "score": 0-10,
      "evidence": "from resume"
    }}
  ],
  "gaps": ["skills the candidate lacks"],
  "strengths": ["areas where candidate exceeds requirements"],
  "risk_areas": ["areas needing deeper verification in interview"]
}}"""

    text = await call_gemini(prompt)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"raw_scorecard": text}
