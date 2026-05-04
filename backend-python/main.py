from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
import cv2
import numpy as np
from collections import deque, Counter
import mediapipe as mp
import asyncio
import uvicorn
from typing import Dict, Any, Optional
import base64
import time
import json
import logging
import os
import torch
from pathlib import Path

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="AI Interview Detection API", version="3.0.0")

# Get allowed origins from environment variable
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:3000,https://interview-main-pink.vercel.app").split(",")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins for debugging
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==== CONFIG ====
MOOD_HISTORY_LEN = 9
FACE_VERIFICATION_THRESHOLD = 0.7
GENDER_CONFIDENCE_THRESHOLD = 0.6
EYE_MOVEMENT_THRESHOLD = 0.02
MULTIPLE_FACE_THRESHOLD = 1

# Model paths
MODEL_DIR = Path(__file__).parent
GENDER_MODEL_PATH = MODEL_DIR / "best (6).pt"

class GenderDetector:
    """Wrapper for YOLOv8 gender detection model"""
    def __init__(self, model_path: str):
        self.model = None
        self.model_path = model_path
        self.loaded = False
        self.class_names = {0: "Female", 1: "Male"}
        self.load_model()
    
    def load_model(self):
        """Load YOLO model with fallback"""
        try:
            from ultralytics import YOLO
            if os.path.exists(self.model_path):
                self.model = YOLO(str(self.model_path))
                self.loaded = True
                logger.info(f"✅ Gender detection model loaded from {self.model_path}")
            else:
                logger.warning(f"Gender model not found at {self.model_path}")
                self.loaded = False
        except ImportError:
            logger.warning("Ultralytics not installed. Gender detection disabled.")
            self.loaded = False
        except Exception as e:
            logger.error(f"Failed to load gender model: {e}")
            self.loaded = False
    
    def detect_gender(self, face_roi: np.ndarray) -> Dict[str, Any]:
        if not self.loaded or self.model is None or face_roi is None or face_roi.size == 0:
            return {"gender": "Unknown", "confidence": 0.0, "success": False}
        
        try:
            h, w = face_roi.shape[:2]
            if h < 32 or w < 32:
                return {"gender": "Unknown", "confidence": 0.0, "success": False}
            
            results = self.model(face_roi, verbose=False)
            
            if len(results) > 0 and results[0].boxes is not None:
                boxes = results[0].boxes
                if len(boxes) > 0:
                    cls = boxes.cls[0].item()
                    conf = boxes.conf[0].item()
                    
                    if conf >= GENDER_CONFIDENCE_THRESHOLD:
                        gender = self.class_names.get(int(cls), "Unknown")
                        return {"gender": gender, "confidence": conf, "success": True}
            
            return {"gender": "Unknown", "confidence": 0.0, "success": False}
            
        except Exception as e:
            logger.error(f"Gender detection error: {e}")
            return {"gender": "Unknown", "confidence": 0.0, "success": False}

class MoodAnalyzer:
    """Simplified mood analysis using facial landmarks"""
    def __init__(self):
        self.mood_history = deque(maxlen=MOOD_HISTORY_LEN)
    
    def analyze_mood(self, face_landmarks) -> str:
        if face_landmarks is None:
            return "neutral"
        
        try:
            # Get mouth landmarks
            mouth_left = face_landmarks.landmark[61]
            mouth_right = face_landmarks.landmark[291]
            mouth_top = face_landmarks.landmark[13]
            mouth_bottom = face_landmarks.landmark[14]
            
            # Calculate mouth aspect ratio (MAR)
            mouth_width = abs(mouth_right.x - mouth_left.x)
            mouth_height = abs(mouth_bottom.y - mouth_top.y)
            mouth_ratio = mouth_height / (mouth_width + 0.001)
            
            # Get eyebrow landmarks
            left_brow_inner = face_landmarks.landmark[55].y
            left_brow_outer = face_landmarks.landmark[70].y
            right_brow_inner = face_landmarks.landmark[285].y
            
            # Get eye landmarks for squinting/widening
            eye_top = face_landmarks.landmark[159].y
            eye_bottom = face_landmarks.landmark[145].y
            eye_openness = abs(eye_bottom - eye_top)

            # Enhanced rule-based mood detection
            if mouth_ratio > 0.5:
                if eye_openness > 0.03:
                    return "surprised"
                return "happy"
            elif mouth_ratio > 0.2:
                if left_brow_inner > left_brow_outer: # Inner brows raised
                    return "sad"
                return "happy"
            elif left_brow_inner < left_brow_outer - 0.01: # Brows furrowed
                return "angry"
            else:
                return "neutral"
                
        except Exception as e:
            logger.error(f"Mood analysis error: {e}")
            return "neutral"

class AIDetector:
    def __init__(self):
        self.running = True
        self.interview_active = False
        
        # Initialize MediaPipe FaceMesh
        self.mp_face_mesh = mp.solutions.face_mesh
        self.face_mesh = self.mp_face_mesh.FaceMesh(
            max_num_faces=2,
            refine_landmarks=True,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5
        )
        
        # Initialize gender detector
        self.gender_detector = GenderDetector(str(GENDER_MODEL_PATH))
        
        # Initialize mood analyzer
        self.mood_analyzer = MoodAnalyzer()
        
        # Detection variables
        self.eye_movement_count = 0
        self.prev_eye_x = None
        self.frame_counter = 0
        self.face_count = 0
        self.face_alert = ""
        
        # Gender detection
        self.latest_gender = "Unknown"
        self.gender_confidence = 0.0
        
        # Mood detection
        self.current_mood = "neutral"
        self.mood_history = deque(maxlen=MOOD_HISTORY_LEN)
        
        # Audio detection
        self.speech_detected = False
        self.speech_confidence = 0.0
        self.bg_voice = False
        self.lipsync = True
        self.mouth_ratio_debug = 0.0
        
        # Verification
        self.face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
        self.reference_face = None
        self.verification_status = "Not set"
        
        # Frame storage
        self.latest_frame = None
        self.frame_lock = asyncio.Lock()
        
        # Performance metrics
        self.processing_times = deque(maxlen=30)
        
        logger.info("✅ AI Detector initialized")

    async def set_frame_from_frontend(self, frame_data: str) -> bool:
        """Decode and store frame from frontend"""
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

    def extract_face_roi(self, frame) -> Optional[np.ndarray]:
        if frame is None:
            return None
        
        try:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = self.face_cascade.detectMultiScale(gray, 1.3, 5)
            
            if len(faces) > 0:
                (x, y, w, h) = faces[0]
                padding = int(0.2 * max(w, h))
                x = max(0, x - padding)
                y = max(0, y - padding)
                w = min(frame.shape[1] - x, w + 2 * padding)
                h = min(frame.shape[0] - y, h + 2 * padding)
                
                face_roi = frame[y:y+h, x:x+w]
                return face_roi
            return None
        except Exception as e:
            logger.error(f"Face ROI extraction error: {e}")
            return None

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
                    # Eye movement tracking
                    eye_x = face_landmarks.landmark[33].x
                    if self.prev_eye_x is not None and self.frame_counter % 5 == 0:
                        if abs(eye_x - self.prev_eye_x) > EYE_MOVEMENT_THRESHOLD:
                            self.eye_movement_count += 1
                    self.prev_eye_x = eye_x
                    
                    # Mouth movement tracking (for speech/lipsync)
                    mouth_top = face_landmarks.landmark[13].y
                    mouth_bottom = face_landmarks.landmark[14].y
                    m_ratio = abs(mouth_bottom - mouth_top) * 100 # Scaling for easier thresholding
                    self.mouth_ratio_debug = round(m_ratio, 2)
                    
                    # If mouth opens significantly, detect speech
                    if m_ratio > 1.5: 
                        self.speech_detected = True
                        self.lipsync = True
                    else:
                        self.speech_detected = False
                        # If mouth is closed, lipsync is "good" by default
                        self.lipsync = True
                    
                    # Update mood
                    if len(mesh_results.multi_face_landmarks) == 1:
                        self.current_mood = self.mood_analyzer.analyze_mood(face_landmarks)
                        self.mood_history.append(self.current_mood)
                
                if self.face_count > MULTIPLE_FACE_THRESHOLD:
                    self.face_alert = "Multiple people detected!"
                else:
                    self.face_alert = ""
                    
            return mesh_results
        except Exception as e:
            logger.error(f"Face processing error: {e}")
            return None

    def process_gender(self, frame):
        if frame is None:
            return
        
        try:
            face_roi = self.extract_face_roi(frame)
            if face_roi is not None:
                result = self.gender_detector.detect_gender(face_roi)
                if result["success"]:
                    self.latest_gender = result["gender"]
                    self.gender_confidence = result["confidence"]
        except Exception as e:
            logger.error(f"Gender detection error: {e}")

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
        if len(self.mood_history) > 0:
            dominant_mood = max(set(self.mood_history), key=self.mood_history.count)
        else:
            dominant_mood = self.current_mood
            
        return {
            "faces": self.face_count,
            "eye_moves": self.eye_movement_count,
            "face_alert": self.face_alert,
            "gender": self.latest_gender,
            "gender_confidence": round(self.gender_confidence, 2),
            "mood": dominant_mood,
            "bg_voice": self.bg_voice,
            "lipsync": self.lipsync,
            "verification": self.verification_status,
            "speech": self.speech_detected,
            "speech_confidence": round(self.speech_confidence, 2),
            "mouth_ratio": self.mouth_ratio_debug,
            "interview_active": self.interview_active,
            "timestamp": time.time()
        }

    def process_frame(self) -> Dict[str, Any]:
        start_time = time.time()
        frame = self.get_latest_frame()
        
        if frame is None:
            data = self.get_detection_data()
            data["face_alert"] = "Waiting for video feed"
            return data
        
        try:
            self.process_face(frame)
            self.process_gender(frame)
            self.process_verification(frame)
            
        except Exception as e:
            logger.error(f"Error processing frame: {e}")
        
        elapsed = (time.time() - start_time) * 1000
        self.processing_times.append(elapsed)
        
        data = self.get_detection_data()
        data["processing_time_ms"] = round(np.mean(self.processing_times), 1) if self.processing_times else 0
        
        return data

    def start_interview(self):
        self.interview_active = True
        self.eye_movement_count = 0
        self.face_alert = ""
        self.mood_history.clear()
        logger.info("Interview session started")

    def stop_interview(self):
        self.interview_active = False
        self.face_count = 0
        self.face_alert = ""
        self.latest_frame = None
        logger.info("Interview session stopped")

    def set_reference_face(self) -> bool:
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
                else:
                    logger.warning("No face detected for reference capture")
                    return False
            except Exception as e:
                logger.error(f"Error capturing reference face: {e}")
                return False
        else:
            logger.warning("No frame available for reference capture")
            return False

    def get_stats(self) -> Dict[str, Any]:
        return {
            "gender_model_loaded": self.gender_detector.loaded,
            "processing_time_avg_ms": round(np.mean(self.processing_times), 1) if self.processing_times else 0,
            "frame_counter": self.frame_counter,
            "mood_history_len": len(self.mood_history),
            "interview_active": self.interview_active
        }

    def cleanup(self):
        self.running = False
        if self.gender_detector.model:
            del self.gender_detector.model
        if self.face_mesh:
            self.face_mesh.close()
        logger.info("Cleanup completed")

# Initialize AI detector
logger.info("Initializing AI Detection System...")
ai_detector = AIDetector()

active_connections = []

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    active_connections.append(websocket)
    client_host = websocket.client.host if websocket.client else "unknown"
    logger.info(f"✅ AI WebSocket connected from {client_host}. Total active: {len(active_connections)}")
    
    try:
        while True:
            try:
                # Set a timeout for receiving data (60 seconds)
                data = await asyncio.wait_for(websocket.receive_text(), timeout=60.0)
                
                try:
                    json_data = json.loads(data)
                    message_type = json_data.get('type', 'unknown')
                    logger.info(f"📨 Received message type: {message_type}")
                    
                    if message_type == 'participant_frame':
                        frame_data = json_data.get('image')
                        if frame_data:
                            logger.info("🖼️ Processing participant frame")
                            success = await ai_detector.set_frame_from_frontend(frame_data)
                            if success:
                                detection_data = ai_detector.process_frame()
                                logger.debug(f"📤 Sending detection results: faces={detection_data.get('faces')}")
                                await websocket.send_json(detection_data)
                            else:
                                logger.warning("⚠️ Failed to decode frame from frontend")
                    elif message_type == 'test':
                        logger.info("🧪 Test message received")
                        await websocket.send_json({"type": "test_response", "message": "OK", "timestamp": time.time()})
                    else:
                        logger.info(f"📨 Unknown message type: {message_type}")
                    
                except json.JSONDecodeError as e:
                    logger.error(f"❌ JSON decode error: {e}")
                    # Try to handle as raw image data
                    if data.startswith('data:image/') or len(data) > 1000:
                        logger.info("📸 Processing raw image data")
                        success = await ai_detector.set_frame_from_frontend(data)
                        if success:
                            detection_data = ai_detector.process_frame()
                            if detection_data:
                                await websocket.send_json(detection_data)
                        
            except asyncio.TimeoutError:
                # Send heartbeat to keep connection alive
                await websocket.send_json({"type": "ping", "timestamp": time.time()})
                continue
                
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
    logger.info("Interview started via API")
    return {"status": "success", "message": "Interview started"}

@app.post("/stop_interview")
async def stop_interview():
    ai_detector.stop_interview()
    logger.info("Interview stopped via API")
    return {"status": "success", "message": "Interview stopped"}

@app.post("/end_interview")
async def end_interview():
    return await stop_interview()

@app.post("/set_reference_face")
async def set_reference_face(request: Request):
    try:
        data = await request.json()
        image_data = data.get('image')
        
        if image_data:
            if image_data.startswith('data:image/'):
                image_data = image_data.split(',')[1]
            
            image_bytes = base64.b64decode(image_data)
            nparr = np.frombuffer(image_bytes, np.uint8)
            frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            
            if frame is not None:
                async with ai_detector.frame_lock:
                    ai_detector.latest_frame = frame
                
                success = ai_detector.set_reference_face()
                if success:
                    return {"status": "success", "message": "Reference face set successfully"}
                else:
                    return {"status": "error", "message": "No face detected. Please ensure face is clearly visible."}
            else:
                return {"status": "error", "message": "Failed to decode image"}
        
        return {"status": "error", "message": "No image provided"}
        
    except Exception as e:
        logger.error(f"Error setting reference face: {e}")
        return {"status": "error", "message": str(e)}

@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "interview_active": ai_detector.interview_active,
        "active_connections": len(active_connections),
        "gender_model_loaded": ai_detector.gender_detector.loaded,
        "timestamp": time.time()
    }

@app.get("/stats")
async def get_stats():
    return ai_detector.get_stats()

@app.get("/detection")
async def get_detection():
    return ai_detector.get_detection_data()

@app.get("/")
async def root():
    return {
        "message": "AI Interview Detection API",
        "status": "running",
        "version": "3.0.0",
        "features": [
            "Face detection",
            "Eye movement tracking",
            "Gender detection (YOLO)",
            "Mood analysis",
            "Face verification"
        ]
    }

@app.on_event("shutdown")
async def shutdown_event():
    ai_detector.cleanup()
    logger.info("Application shutdown completed")

# This is CRITICAL for Render deployment
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8001))
    print(f"🚀 Starting AI Interview Detection API on port {port}")
    print(f"📍 Health check: http://0.0.0.0:{port}/health")
    print(f"🎯 Gender model: {'✓ Loaded' if ai_detector.gender_detector.loaded else '✗ Not loaded'}")
    print(f"🔌 WebSocket endpoint: ws://localhost:{port}/ws")
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=port,
        log_level="info",
        access_log=True
    )