"""
MongoDB service for storing resumes, sessions, and transcripts.
"""

from datetime import datetime, timezone
from typing import Optional
from pymongo import MongoClient
from config import settings

# MongoDB client
client = MongoClient(settings.mongodb_uri)
db = client[settings.mongodb_db_name]

# Collections
resumes_col = db["resumes"]
sessions_col = db["sessions"]
transcripts_col = db["transcripts"]


# ──────────────── Resume Operations ────────────────

def store_resume(session_id: str, parsed_data: dict) -> str:
    """Store a parsed resume linked to a session."""
    doc = {
        "session_id": session_id,
        "parsed_data": parsed_data,
        "created_at": datetime.now(timezone.utc),
    }
    result = resumes_col.insert_one(doc)
    return str(result.inserted_id)


def get_resume(session_id: str) -> Optional[dict]:
    """Retrieve the parsed resume data for a session."""
    doc = resumes_col.find_one({"session_id": session_id}, {"_id": 0})
    return doc


# ──────────────── Session Operations ────────────────

def create_session(session_id: str, interviewer: str = "default", candidate: str = "") -> dict:
    """Create a new interview session."""
    doc = {
        "session_id": session_id,
        "interviewer": interviewer,
        "candidate": candidate,
        "status": "preparing",
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
        "resume_uploaded": False,
        "jd_uploaded": False,
        "interview_guide": None,
    }
    sessions_col.update_one(
        {"session_id": session_id},
        {"$set": doc},
        upsert=True,
    )
    return doc


def update_session(session_id: str, updates: dict) -> bool:
    """Update session fields."""
    updates["updated_at"] = datetime.now(timezone.utc)
    result = sessions_col.update_one(
        {"session_id": session_id},
        {"$set": updates},
    )
    return result.modified_count > 0


def get_session(session_id: str) -> Optional[dict]:
    """Get session by ID."""
    return sessions_col.find_one({"session_id": session_id}, {"_id": 0})


def get_all_sessions() -> list:
    """Retrieve all sessions ordered by creation time."""
    docs = sessions_col.find({}, {"_id": 0}).sort("created_at", -1)
    return list(docs)


# ──────────────── Transcript Operations ────────────────

def store_transcript_chunk(session_id: str, chunk: dict) -> str:
    """Store a transcript chunk (speaker + text + timestamp)."""
    doc = {
        "session_id": session_id,
        "speaker": chunk.get("speaker", "unknown"),
        "text": chunk.get("text", ""),
        "timestamp": chunk.get("timestamp", datetime.now(timezone.utc).isoformat()),
        "created_at": datetime.now(timezone.utc),
    }
    result = transcripts_col.insert_one(doc)
    return str(result.inserted_id)


def get_full_transcript(session_id: str) -> list:
    """Get the full transcript for a session, ordered by time."""
    docs = transcripts_col.find(
        {"session_id": session_id},
        {"_id": 0},
    ).sort("created_at", 1)
    return list(docs)


def get_transcript_since(session_id: str, since_dt: datetime) -> list:
    """Get transcript chunks created after a specific time."""
    docs = transcripts_col.find(
        {
            "session_id": session_id,
            "created_at": {"$gt": since_dt}
        },
        {"_id": 0},
    ).sort("created_at", 1)
    return list(docs)


def get_transcript_text(session_id: str) -> str:
    """Get the full transcript as a plain text string."""
    chunks = get_full_transcript(session_id)
    lines = []
    for c in chunks:
        speaker = c.get("speaker", "Unknown")
        text = c.get("text", "")
        lines.append(f"[{speaker}]: {text}")
    return "\n".join(lines)


# ──────────────── Cleanup ────────────────

def delete_session_data(session_id: str):
    """Remove all data for a session."""
    resumes_col.delete_many({"session_id": session_id})
    transcripts_col.delete_many({"session_id": session_id})
    sessions_col.delete_one({"session_id": session_id})


# ──────────────── Notes Operations ────────────────

notes_col = db["candidate_notes"]


def save_note(candidate_key: str, note_text: str) -> str:
    """Save a note for a candidate (keyed by phone or name)."""
    doc = {
        "candidate_key": candidate_key,
        "text": note_text,
        "created_at": datetime.now(timezone.utc),
    }
    result = notes_col.insert_one(doc)
    return str(result.inserted_id)


def get_notes(candidate_key: str) -> list:
    """Get all notes for a candidate."""
    docs = notes_col.find(
        {"candidate_key": candidate_key},
        {"_id": 0},
    ).sort("created_at", -1)
    return list(docs)
