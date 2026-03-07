"""
AI-Powered Interview Intelligence Agent — FastAPI Backend
"""

import uuid
import json
import asyncio
import traceback
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import FastAPI, UploadFile, File, Form, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from services import db_service
from services.resume_parser import parse_resume, parse_jd, generate_competency_scorecard
from services.gemini_service import (
    generate_interview_guide,
    analyze_response,
    generate_followup,
    generate_summary,
    generate_proactive_question,
)
from services.analysis_service import (
    detect_vague_answers,
    detect_contradictions,
    detect_bias,
    calculate_engagement,
    analyze_transcript_chunk_consolidated,
    analyze_live_insights,
)
from services.deepgram_service import DeepgramTranscriber

# ─────────────────────── App Setup ───────────────────────

app = FastAPI(
    title="Interview Intelligence Agent",
    description="AI-powered real-time interview copilot",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory state for active sessions
active_sessions: dict = {}

# ─────────────────────── Health Check ───────────────────────

@app.on_event("startup")
async def startup_event():
    """Check connectivity to downstream services."""
    print("\n🚀 Starting Interview Intelligence Agent...")
    
    # Check MongoDB
    try:
        db_service.client.admin.command('ping')
        print("✅ MongoDB: Connected")
    except Exception as e:
        print(f"❌ MongoDB: Connection failed ({e})")
        
    print("✨ Backend ready at http://localhost:8000\n")


@app.get("/")
async def root():
    return {"status": "online", "service": "Interview Intelligence Agent"}


@app.get("/health")
async def health():
    return {"status": "healthy", "timestamp": datetime.now(timezone.utc).isoformat()}


# ─────────────────────── Session Management ───────────────────────

@app.post("/session/create")
async def create_session(interviewer: str = Form("default"), candidate: str = Form("")):
    """Create a new interview session."""
    session_id = str(uuid.uuid4())[:8]
    session = db_service.create_session(session_id, interviewer, candidate)
    active_sessions[session_id] = {
        "status": "preparing",
        "resume_data": None,
        "jd_data": None,
        "interview_guide": None,
        "scorecard": None,
    }
    return {"session_id": session_id, "session": session}


@app.get("/session/{session_id}")
async def get_session(session_id: str):
    """Get session details."""
    session = db_service.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@app.get("/sessions")
async def get_all_sessions():
    """Get all past sessions."""
    return db_service.get_all_sessions()


# ─────────────────────── Resume & JD Upload ───────────────────────

@app.post("/upload-resume")
async def upload_resume(
    session_id: str = Form(...),
    file: UploadFile = File(...),
):
    """Upload and parse a resume PDF."""
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported")

    pdf_bytes = await file.read()

    try:
        parsed = await parse_resume(pdf_bytes)
    except Exception as e:
        error_msg = str(e)
        if error_msg == "GEMINI_QUOTA_EXCEEDED":
            raise HTTPException(status_code=429, detail="Gemini API quota exceeded. Please wait a minute and try again.")
        if error_msg == "GEMINI_AUTH_FAILED":
            raise HTTPException(status_code=401, detail="Gemini API key is invalid or unauthorized.")
        
        print(f"[upload-resume] Unexpected Error: {error_msg}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Resume parsing failed: {error_msg}")

    # Store in DB
    db_service.store_resume(session_id, parsed)
    db_service.update_session(session_id, {"resume_uploaded": True})

    # Store in memory for live use
    if session_id in active_sessions:
        active_sessions[session_id]["resume_data"] = parsed

    return {"session_id": session_id, "parsed_resume": parsed}


@app.post("/upload-jd")
async def upload_jd(
    session_id: str = Form(...),
    jd_text: str = Form(...),
):
    """Upload a job description text."""
    try:
        parsed_jd = await parse_jd(jd_text)
    except Exception as e:
        error_msg = str(e)
        if error_msg == "GEMINI_QUOTA_EXCEEDED":
            raise HTTPException(status_code=429, detail="Gemini API quota exceeded. Please wait a minute and try again.")
        if error_msg == "GEMINI_AUTH_FAILED":
            raise HTTPException(status_code=401, detail="Gemini API key is invalid or unauthorized.")
            
        print(f"[upload-jd] Unexpected Error: {error_msg}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"JD parsing failed: {error_msg}")

    db_service.update_session(session_id, {"jd_uploaded": True, "jd_data": parsed_jd})

    if session_id not in active_sessions:
        active_sessions[session_id] = {
            "status": "preparing",
            "resume_data": None,
            "jd_data": parsed_jd,
            "interview_guide": None,
            "scorecard": None,
        }
    else:
        active_sessions[session_id]["jd_data"] = parsed_jd

    # Get resume data (look in memory first, then DB)
    resume_data = active_sessions[session_id].get("resume_data")
    if not resume_data:
        resume_doc = db_service.get_resume(session_id)
        if resume_doc:
            resume_data = resume_doc.get("parsed_data")
            active_sessions[session_id]["resume_data"] = resume_data

    # If resume found, auto-generate scorecard + guide
    if resume_data:

        try:
            scorecard = await generate_competency_scorecard(resume_data, parsed_jd)
            active_sessions[session_id]["scorecard"] = scorecard

            guide = await generate_interview_guide(
                resume_data.get("raw_text", json.dumps(resume_data)),
                jd_text,
            )
            active_sessions[session_id]["interview_guide"] = guide
            db_service.update_session(session_id, {"interview_guide": guide})

            return {
                "session_id": session_id,
                "parsed_jd": parsed_jd,
                "scorecard": scorecard,
                "interview_guide": guide,
            }
        except Exception as e:
            error_msg = str(e)
            if error_msg == "GEMINI_QUOTA_EXCEEDED":
                return {
                    "session_id": session_id,
                    "parsed_jd": parsed_jd,
                    "warning": "JD parsed successfully but Gemini quota exceeded. Guide will be generated once quota resets.",
                }
            
            print(f"[upload-jd] Scorecard/guide generation error: {error_msg}")
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=f"Guide generation failed: {error_msg}")

    return {"session_id": session_id, "parsed_jd": parsed_jd}

@app.post("/dev-mock")
async def dev_mock(session_id: str = Form(...)):
    """Developer mode: injects a dummy resume, JD, and scorecard to skip setup."""
    dummy_resume = {
        "raw_text": "John Doe. Experienced Software Engineer with 5 years in Python and React. Built scalable web apps and led a team of 3 developers.",
        "skills": ["Python", "React", "TypeScript", "Node.js", "MongoDB"],
        "experience": [{"title": "Senior Software Engineer", "company": "Tech Corp", "years": 5}]
    }
    dummy_jd = "Looking for a Senior Software Engineer with strong Python and frontend frameworks (React/Vue). Must have leadership experience."
    dummy_scorecard = {
        "overall_match_score": 85,
        "match_level": "Strong Match",
        "competencies": [
            {"skill": "Python", "score": 9, "match_level": "strong", "reason": "5 years experience listed."},
            {"skill": "React", "score": 8, "match_level": "strong", "reason": "Built scalable web apps."},
            {"skill": "Leadership", "score": 7, "match_level": "moderate", "reason": "Led team of 3."}
        ]
    }
    dummy_guide = {
        "overview": "Strong candidate, focus on system design and leadership depth.",
        "sections": [
            {"title": "Technical Depth", "questions": ["Describe a scalable system you built in Python.", "How do you manage state in large React apps?"]}
        ]
    }
    
    # Update memory
    active_sessions[session_id] = {
        "status": "preparing",
        "resume_data": dummy_resume,
        "jd_data": dummy_jd,
        "scorecard": dummy_scorecard,
        "interview_guide": dummy_guide
    }
    
    # Update DB
    db_service.store_resume(session_id, dummy_resume)
    db_service.update_session(session_id, {"resume_uploaded": True, "jd_uploaded": True, "jd_data": dummy_jd, "interview_guide": dummy_guide, "status": "preparing"})
    
    return {
        "session_id": session_id,
        "status": "success",
        "message": "Developer mode activated. Dummy data injected."
    }

# ─────────────────────── Analysis Endpoints ───────────────────────

@app.post("/analyze-response")
async def analyze_response_endpoint(
    session_id: str = Form(...),
    transcript_chunk: str = Form(...),
    question_asked: str = Form(""),
):
    """Analyze a candidate's response chunk."""
    resume_data = {}
    if session_id in active_sessions:
        resume_data = active_sessions[session_id].get("resume_data", {}) or {}

    full_transcript = db_service.get_transcript_text(session_id)

    analysis = await analyze_response(transcript_chunk, resume_data, question_asked, full_transcript)

    # Also check for vagueness and contradictions
    vagueness = await detect_vague_answers(transcript_chunk)
    contradictions = await detect_contradictions(transcript_chunk, resume_data)

    return {
        "analysis": analysis,
        "vagueness_check": vagueness,
        "contradiction_check": contradictions,
    }


@app.post("/generate-summary")
async def generate_summary_endpoint(session_id: str = Form(...)):
    """Generate a post-interview summary report."""
    full_transcript = db_service.get_transcript_text(session_id)
    if not full_transcript:
        raise HTTPException(status_code=400, detail="No transcript data found for this session")

    resume_data = {}
    if session_id in active_sessions:
        resume_data = active_sessions[session_id].get("resume_data", {}) or {}

    # Get engagement metrics
    transcript_chunks = db_service.get_full_transcript(session_id)
    engagement = await calculate_engagement(transcript_chunks)

    # Check for bias
    bias_report = await detect_bias(full_transcript)

    # Generate the final summary
    summary = await generate_summary(full_transcript, resume_data)

    final_report = {
        "summary": summary,
        "engagement": engagement,
        "bias_report": bias_report,
    }
    
    # Store in database
    db_service.update_session(session_id, {"final_report": final_report, "status": "summarized"})

    return final_report


# ─────────────────────── Interview Guide ───────────────────────

@app.get("/interview-guide/{session_id}")
async def get_interview_guide(session_id: str):
    """Get the generated interview guide for a session."""
    if session_id in active_sessions and active_sessions[session_id].get("interview_guide"):
        return active_sessions[session_id]["interview_guide"]

    session = db_service.get_session(session_id)
    if session and session.get("interview_guide"):
        return session["interview_guide"]

    raise HTTPException(status_code=404, detail="Interview guide not found. Upload resume and JD first.")


# ─────────────────────── WebSocket: Real-Time Interview ───────────────────────

@app.websocket("/ws/interview/{session_id}")
async def websocket_interview(websocket: WebSocket, session_id: str):
    """
    WebSocket endpoint for real-time interview monitoring.

    Accepts messages:
    - {"type": "cc_text", "speaker": "...", "text": "..."}   → CC-scraped text
    - {"type": "audio", "data": "<base64>"}                   → Raw audio for Deepgram
    - {"type": "request_followup"}                             → Request follow-up questions

    Sends messages:
    - {"type": "transcript", "speaker": "...", "text": "...", "is_final": bool}
    - {"type": "analysis", ...analysis results...}
    - {"type": "followup", ...followup questions...}
    - {"type": "warning", ...bias/contradiction warning...}
    """
    await websocket.accept()

    # Ensure session exists in memory
    if session_id not in active_sessions:
        active_sessions[session_id] = {
            "status": "interviewing",
            "resume_data": None,
            "jd_data": None,
            "interview_guide": None,
            "scorecard": None,
        }
        # Try to load resume from DB
        resume_doc = db_service.get_resume(session_id)
        if resume_doc:
            active_sessions[session_id]["resume_data"] = resume_doc.get("parsed_data")

    db_service.update_session(session_id, {"status": "interviewing"})
    active_sessions[session_id]["status"] = "interviewing"

    # Analysis state
    analysis_buffer = []
    last_interaction_time = datetime.now()
    analysis_task = None
    recent_texts: set = set()  # Dedup: track recently stored texts

    async def run_periodic_analysis():
        """Run analysis periodically, purely driven by new transcript data in the database."""
        last_bias_check = datetime.now()
        last_analyzed_index = 0
        last_analysis_time = datetime.now()
        
        while True:
            await asyncio.sleep(12)  # Check DB for new transcripts periodically
            
            if session_id not in active_sessions or active_sessions[session_id].get("status") != "interviewing":
                break # Exit if session ended
                
            full_transcript = db_service.get_full_transcript(session_id)
            if len(full_transcript) <= last_analyzed_index:
                continue # No new text to analyze
                
            new_chunks = full_transcript[last_analyzed_index:]
            new_text = " ".join([c.get("text", "") for c in new_chunks]).strip()
            
            now = datetime.now()
            time_since_analysis = (now - last_analysis_time).total_seconds()
            word_count = len(new_text.split())
            
            # Analyze if we have enough words or it's been a while with some text
            if word_count >= 10 or (time_since_analysis > 25 and word_count > 0):
                last_analyzed_index = len(full_transcript)
                last_analysis_time = now
                
                resume_data = active_sessions.get(session_id, {}).get("resume_data", {}) or {}
                
                try:
                    # 1. Consolidated Analysis: Insights, Suggestions, Mood, Attitude, etc.
                    # We pass the new text as the focal point, but it's analyzed against the resume.
                    analysis_res = await analyze_transcript_chunk_consolidated(new_text, resume_data)
                    
                    # Normalize suggestions — keep them SHORT and CRISP
                    raw_suggestions = analysis_res.get("suggestions", [])
                    normalized_suggestions = []
                    for s in raw_suggestions:
                        text = s.get("text") or s.get("question", "")
                        words = text.split()
                        if len(words) > 18:
                            text = " ".join(words[:15]) + "...?"
                        normalized_suggestions.append({
                            "text": text,
                            "reason": s.get("reason", ""),
                            "priority": s.get("priority", "medium"),
                        })
                    
                    await websocket.send_json({
                        "type": "live_insights",
                        "data": {
                            "mood": analysis_res.get("insights", {}).get("mood", "Conversational"),
                            "attitude": analysis_res.get("insights", {}).get("attitude", "Interested"),
                            "honesty": analysis_res.get("insights", {}).get("honesty", "Neutral"),
                            "speaker": analysis_res.get("insights", {}).get("speaker", "Both"),
                            "suggestions": normalized_suggestions,
                            "competency_updates": analysis_res.get("competency_updates", [])
                        }
                    })

                    # 2. Vagueness / Incomplete answer warnings
                    if analysis_res.get("vagueness", {}).get("is_vague"):
                        await websocket.send_json({
                            "type": "warning",
                            "subtype": "vague_answer",
                            "data": analysis_res["vagueness"],
                        })
                        
                    # 3. Resume contradiction / dishonesty detection
                    contradictions = analysis_res.get("contradictions", {}).get("contradictions", [])
                    if contradictions:
                        await websocket.send_json({
                            "type": "warning",
                            "subtype": "contradiction",
                            "data": analysis_res["contradictions"],
                        })

                except Exception as e:
                    print(f"[Analysis] Main loop error: {e}")

            # Periodic bias check (~every 90 seconds)
            bias_elapsed = (now - last_bias_check).total_seconds()
            if bias_elapsed > 90:
                last_bias_check = now
                history = db_service.get_transcript_text(session_id)
                if history and len(history.split()) > 50:
                    try:
                        bias_result = await detect_bias(history)
                        if bias_result.get("bias_detected"):
                            for warning in bias_result.get("warnings", []):
                                await websocket.send_json({
                                    "type": "warning",
                                    "subtype": "bias",
                                    "data": {
                                        "message": warning.get("message", str(warning)),
                                        "type": warning.get("type", "unknown"),
                                        "severity": warning.get("severity", "medium"),
                                    },
                                })
                    except Exception as e:
                        print(f"[Analysis] Bias check error: {e}")

    # Start periodic analysis
    analysis_task = asyncio.create_task(run_periodic_analysis())

    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")
            last_interaction_time = datetime.now() # Reset silence timer

            if msg_type == "cc_text":
                # Handle CC-scraped text from Google Meet
                speaker = data.get("speaker", "Unknown")
                text = data.get("text", "")

                # Dedup: skip if we've already stored this exact text recently
                dedup_key = f"{speaker}:{text}"
                if dedup_key in recent_texts:
                    continue
                recent_texts.add(dedup_key)
                # Keep dedup set manageable
                if len(recent_texts) > 200:
                    recent_texts.clear()

                # Store transcript chunk
                db_service.store_transcript_chunk(session_id, {
                    "speaker": speaker,
                    "text": text,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })

                # Add to analysis buffer
                analysis_buffer.append(text)

                # Echo transcript back to extension
                await websocket.send_json({
                    "type": "transcript",
                    "speaker": speaker,
                    "text": text,
                    "is_final": True,
                })

            elif msg_type == "request_followup":
                # Generate follow-up questions on demand
                full_transcript = db_service.get_transcript_text(session_id)
                recent = full_transcript[-1500:] if full_transcript else ""

                context = {
                    "role": active_sessions.get(session_id, {}).get("jd_data", {}).get("title", "Unknown"),
                    "skills_to_verify": active_sessions.get(session_id, {}).get("jd_data", {}).get("required_skills", []),
                    "covered_topics": [],
                }

                followup = await generate_followup(recent, context)
                await websocket.send_json({
                    "type": "followup",
                    "data": followup,
                })

            elif msg_type == "end_interview":
                # End the interview
                db_service.update_session(session_id, {"status": "completed"})
                active_sessions[session_id]["status"] = "completed"
                await websocket.send_json({"type": "session_ended"})
                break

    except WebSocketDisconnect:
        print(f"[WS] Client disconnected from session {session_id}")
    except Exception as e:
        print(f"[WS] Error in session {session_id}: {e}")
    finally:
        if analysis_task:
            analysis_task.cancel()
        if session_id in active_sessions:
            active_sessions[session_id]["status"] = "disconnected"


# ─────────────────────── Startup ───────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=settings.backend_host, port=settings.backend_port, reload=True)
