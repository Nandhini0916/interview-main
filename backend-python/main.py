from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import cv2
import numpy as np
from collections import deque, Counter
import mediapipe as mp
import asyncio
import uvicorn
from typing import Dict, Any
import base64
import time
import json
import logging
import os

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="AI Interview Detection API", version="2.0.0")

# Get allowed origins from environment variable
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,https://interview-main-pink.vercel.app").split(",")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==== CONFIG ====
MOOD_HISTORY_LEN = 9
FACE_VERIFICATION_THRESHOLD = 0.7

class AIDetector:
    def __init__(self):
        self.running = True
        self.interview_active = False
        
        # Mediapipe only (lightweight)
        self.mp_face_mesh = mp.solutions.face_mesh
        self.face_mesh = self.mp_face_mesh.FaceMesh(
            max_num_faces=2,
            refine_landmarks=True,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5
        )
        
        # Detection variables
        self.eye_movement_count = 0
        self.prev_eye_x = None
        self.frame_counter = 0
        self.face_count = 0
        self.face_alert = ""
        
        # Gender detection (disabled - saves memory)
        self.latest_gender = "Not detected"
        
        # Mood detection (simplified)
        self.current_mood = "neutral"
        
        # Audio detection (disabled - saves memory)
        self.speech_detected = False
        self.speech_confidence = 0.0
        self.bg_voice = False
        self.lipsync = False
        self.mouth_ratio_debug = 0.0
        
        # Verification
        self.face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
        self.reference_face = None
        self.verification_status = "Not set"
        
        # Frame storage
        self.latest_frame = None
        self.frame_lock = asyncio.Lock()
        
        logger.info("✅ AI Detector initialized (memory-optimized mode)")

    async def set_frame_from_frontend(self, frame_data: str):
        try:
            if frame_data.startswith('data:image/'):
                image_data = base64.b64decode(frame_data.split(',')[1])
            else:
                image_data = base64.b64decode(frame_data)
                
            nparr = np.frombuffer(image_data, np.uint8)
            frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            
            if frame is None:
                return False
                
            async with self.frame_lock:
                self.latest_frame = frame
            return True
        except Exception as e:
            logger.error(f"Error processing frame: {e}")
            return False

    def get_latest_frame(self):
        return self.latest_frame

    def process_face(self, frame):
        if frame is None:
            return None
            
        try:
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mesh_results = self.face_mesh.process(rgb)
            
            if mesh_results and mesh_results.multi_face_landmarks:
                self.frame_counter += 1
                self.face_count = len(mesh_results.multi_face_landmarks)
                
                for face_landmarks in mesh_results.multi_face_landmarks:
                    eye_x = face_landmarks.landmark[33].x
                    if self.prev_eye_x is not None and self.frame_counter % 10 == 0:
                        if abs(eye_x - self.prev_eye_x) > 0.015:
                            self.eye_movement_count += 1
                    self.prev_eye_x = eye_x
                
                if self.face_count > 1:
                    self.face_alert = "Multiple people detected!"
                else:
                    self.face_alert = ""
                    
            return mesh_results
        except Exception as e:
            logger.error(f"Face processing error: {e}")
            return None

    def process_verification(self, frame):
        if frame is None:
            return
            
        try:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = self.face_cascade.detectMultiScale(gray, 1.3, 5)
            
            if self.reference_face is None and len(faces) > 0:
                self.verification_status = "Reference Not Set"
            elif self.reference_face is not None and len(faces) > 0:
                (x, y, w, h) = faces[0]
                current = frame[y:y+h, x:x+w]
                
                gray1 = cv2.resize(cv2.cvtColor(self.reference_face, cv2.COLOR_BGR2GRAY), (100, 100))
                gray2 = cv2.resize(cv2.cvtColor(current, cv2.COLOR_BGR2GRAY), (100, 100))
                
                hist1 = cv2.normalize(cv2.calcHist([gray1], [0], None, [256], [0, 256]), None).flatten()
                hist2 = cv2.normalize(cv2.calcHist([gray2], [0], None, [256], [0, 256]), None).flatten()
                sim = cv2.compareHist(hist1, hist2, cv2.HISTCMP_CORREL)
                
                self.verification_status = "MATCH" if sim > FACE_VERIFICATION_THRESHOLD else "NOT MATCH"
        except Exception as e:
            logger.error(f"Verification error: {e}")

    def get_detection_data(self) -> Dict[str, Any]:
        return {
            "faces": self.face_count,
            "eye_moves": self.eye_movement_count,
            "face_alert": self.face_alert,
            "gender": self.latest_gender,
            "mood": self.current_mood,
            "bg_voice": self.bg_voice,
            "lipsync": self.lipsync,
            "verification": self.verification_status,
            "speech": self.speech_detected,
            "speech_confidence": self.speech_confidence,
            "mouth_ratio": self.mouth_ratio_debug,
            "interview_active": self.interview_active,
            "timestamp": time.time()
        }

    def process_frame(self):
        frame = self.get_latest_frame()
        
        if frame is None:
            data = self.get_detection_data()
            data["face_alert"] = "Waiting for video feed"
            return data
        
        try:
            self.process_face(frame)
            self.process_verification(frame)
        except Exception as e:
            logger.error(f"Error processing frame: {e}")
        
        return self.get_detection_data()

    def start_interview(self):
        self.interview_active = True
        self.eye_movement_count = 0
        self.face_alert = ""
        logger.info("Interview session started")

    def stop_interview(self):
        self.interview_active = False
        self.face_count = 0
        self.face_alert = ""
        self.latest_frame = None
        logger.info("Interview session stopped")

    def set_reference_face(self):
        frame = self.get_latest_frame()
        if frame is not None:
            try:
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                faces = self.face_cascade.detectMultiScale(gray, 1.3, 5)
                if len(faces) > 0:
                    (x, y, w, h) = faces[0]
                    self.reference_face = frame[y:y+h, x:x+w].copy()
                    self.verification_status = "Reference Set"
                    logger.info("Reference face captured")
                    return True
                return False
            except Exception as e:
                logger.error(f"Error capturing reference face: {e}")
                return False
        return False

    def cleanup(self):
        self.running = False
        logger.info("Cleanup completed")

# Initialize AI detector
logger.info("Initializing AI Detection System...")
ai_detector = AIDetector()

active_connections = []

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    active_connections.append(websocket)
    logger.info(f"WebSocket connected. Total: {len(active_connections)}")
    
    try:
        while True:
            data = await websocket.receive_text()
            
            try:
                json_data = json.loads(data)
                
                if json_data.get('type') == 'participant_frame':
                    frame_data = json_data.get('image')
                    if frame_data:
                        await ai_detector.set_frame_from_frontend(frame_data)
                    
                    detection_data = ai_detector.process_frame()
                    await websocket.send_json(detection_data)
                    
            except json.JSONDecodeError:
                if data.startswith('data:image/') or len(data) > 1000:
                    await ai_detector.set_frame_from_frontend(data)
                    detection_data = ai_detector.process_frame()
                    if detection_data:
                        await websocket.send_json(detection_data)
                
    except WebSocketDisconnect:
        if websocket in active_connections:
            active_connections.remove(websocket)
        logger.info(f"WebSocket disconnected. Remaining: {len(active_connections)}")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        if websocket in active_connections:
            active_connections.remove(websocket)

@app.post("/start_interview")
async def start_interview():
    ai_detector.start_interview()
    return {"status": "success", "message": "Interview started"}

@app.post("/stop_interview")
async def stop_interview():
    ai_detector.stop_interview()
    return {"status": "success", "message": "Interview stopped"}

@app.post("/end_interview")
async def end_interview():
    return await stop_interview()

@app.post("/set_reference_face")
async def set_reference_face():
    success = ai_detector.set_reference_face()
    if success:
        return {"status": "success", "message": "Reference face set"}
    return {"status": "error", "message": "No face detected"}

@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "interview_active": ai_detector.interview_active,
        "active_connections": len(active_connections),
        "timestamp": time.time()
    }

@app.get("/stats")
async def get_stats():
    return ai_detector.get_detection_data()

@app.get("/")
async def root():
    return {"message": "AI Interview Detection API", "status": "running"}

@app.on_event("shutdown")
async def shutdown_event():
    ai_detector.cleanup()

# This is CRITICAL for Render deployment
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    print(f"🚀 Starting AI Interview Detection API on port {port}")
    print(f"📍 Health check: http://0.0.0.0:{port}/health")
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=port,
        log_level="info",
        access_log=True
    )