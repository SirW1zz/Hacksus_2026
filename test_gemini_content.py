import google.generativeai as genai
import os
from dotenv import load_dotenv

load_dotenv(r'c:\Users\CraftingTable\Desktop\hacksus_brandnew\.env')
api_key = os.getenv('GEMINI_API_KEY')
genai.configure(api_key=api_key)
model = genai.GenerativeModel("gemini-2.5-flash")

jd_text = "software engineer"
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

try:
    response = model.generate_content(prompt)
    print(response.text)
except Exception as e:
    print(e)
