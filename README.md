# SHORTLIST.ai

The **Interview Intelligence Agent** is an AI-powered, real-time interview copilot that integrates directly into **Google Meet**. It provides real-time transcription, competency analysis, AI-suggested follow-up questions, and bias alerts — all within a native side panel.

---

## 🚀 Key Features

-   **Real-time Transcription**: Powered by Google Meet's Closed Captions and Deepgram.
-   **Competency Scorecard**: Automatically generates a scorecard from the JD and Resume.
-   **AI Interview Guide**: Provides structured questions tailored to the candidate's background.
-   **Live AI Suggestions**: Real-time follow-up questions based on the live conversation.
-   **Contradiction & Bias Alerts**: Flags discrepancies between verbal answers and the resume.

---

## 🛠️ Prerequisites

-   **Node.js**: v18.0.0 or higher.
-   **Python**: 3.9 or higher.
-   **Google Gemini API Key**: For core intelligence.
-   **Deepgram API Key**: For transcription features (optional but recommended).
-   **MongoDB**: An active cluster (Atlas or local) for session storage.

---

## ⚙️ How to Run

### 1. Backend API (Python/FastAPI)

1.  Navigate to the `backend` directory:
    ```bash
    cd backend
    ```
2.  (Optional) Create and activate a virtual environment:
    ```bash
    python -m venv venv
    venv\Scripts\activate   # Windows
    source venv/bin/activate # macOS/Linux
    ```
3.  Install dependencies:
    ```bash
    pip install -r requirements.txt
    ```
4.  Configure environment variables in a `.env` file in the **root** folder:
    ```env
    # .env
    GEMINI_API_KEY=your_gemini_key
    DEEPGRAM_API_KEY=your_deepgram_key
    MONGODB_URI=your_mongo_uri
    MONGODB_DB_NAME=interview_agent
    WXT_API_BASE=http://localhost:8000
    ```
5.  Start the backend server:
    ```bash
    python -m uvicorn main:app --reload --port 8000
    ```

### 2. Chrome Extension (React/WXT)

1.  Navigate to the `extension` directory:
    ```bash
    cd extension
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Build the extension:
    ```bash
    npm run build
    # OR run in development mode (recommended for hot reload)
    npm run dev
    ```
    *Note: WXT will generate a `.output/chrome-mv3` folder (or similar).*

---

## 🧩 Installing the Extension in Chrome

Once built, you must "unpack" the extension to use it in Google Meet:

1.  Open **Google Chrome**.
2.  Navigate to `chrome://extensions/`.
3.  Enable **"Developer mode"** in the top-right corner.
4.  Click the **"Load unpacked"** button in the top-left.
5.  Select the output directory of your build:
    -   Locate: `[project_root]/extension/.output/chrome-mv3` (if you ran `npm run dev`, it should be in `.output`).
6.  The **Interview Intelligence Agent** icon should now appear in your extension toolbar. **Pin it** for easy access.

---

## 🎙️ Starting an Interview Session

1.  **Open the Extension Popup**: Click the brain icon in your toolbar.
2.  **Create Session**: Click "🚀 Create Session".
3.  **Upload Documents**:
    -   Upload the candidate's **Resume** (PDF).
    -   Paste the **Job Description** (Text).
    -   Click "Analyze" to generate the guide/scorecard.
4.  **Join Google Meet**: Click "🌐 Start New Google Meet" (or join an existing one).
5.  **Go Live**: Click "🔴 Go Live".
6.  **Side Panel**: The side panel will automatically open once you are in the meeting and have "Go Live" active.
    -   *If the side panel doesn't open instantly, toggle to another Chrome tab and back to Google Meet — it will trigger automatically.*

---

## 📜 Repository Structure

-   `/backend`: FastAPI server, Gemini/Deepgram services, and MongoDB handlers.
-   `/extension`: WXT-based Chrome extension with React components for Popup, Dashboard, and Side Panel.
-   `/.env`: Central configuration for API keys.
