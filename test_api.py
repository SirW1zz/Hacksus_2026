import requests
import json
from reportlab.pdfgen import canvas

# Generate a dummy PDF
pdf_path = "dummy_resume.pdf"
c = canvas.Canvas(pdf_path)
c.drawString(100, 750, "John Doe")
c.drawString(100, 730, "Software Engineer with 10 years experience in Python and React.")
c.save()

# 1. Create session
res = requests.post("http://localhost:8000/session/create", data={"interviewer": "test"})
print("Create session:", res.status_code, res.text)
session_id = res.json()["session_id"]

# 2. Upload resume
with open(pdf_path, "rb") as f:
    res = requests.post("http://localhost:8000/upload-resume", data={"session_id": session_id}, files={"file": ("dummy_resume.pdf", f, "application/pdf")})
print("Upload resume:", res.status_code)
print(res.text[:200])

# 3. Upload JD
res = requests.post("http://localhost:8000/upload-jd", data={"session_id": session_id, "jd_text": "Looking for a Python developer with React experience."})
print("Upload JD:", res.status_code)
print(res.text[:200])
