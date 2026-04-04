from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import cv2
import numpy as np
from collections import deque, Counter
import mediapipe as mp
import webrtcvad
import pyaudio
from ultralytics import YOLO
from deepface import DeepFace
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

ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",")
# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==== CONFIG ====
MOOD_ANALYZE_EVERY_N_FRAMES = 15
NEUTRAL_IGNORE_THRESHOLD = 95.0
MOOD_HISTORY_LEN = 9
SPEECH_DETECTION_THRESHOLD = 0.3
LIPSYNC_THRESHOLD = 0.035
BGVOICE_THRESHOLD = 0.02
FACE_VERIFICATION_THRESHOLD = 0.7

class AIDetector:
    def __init__(self):
        self.running = True
        self.interview_active = False  # Track interview state
        
        # Mediapipe
        self.mp_face_mesh = mp.solutions.face_mesh
        self.mp_detection = mp.solutions.face_detection
        self.face_mesh = self.mp_face_mesh.FaceMesh(
            max_num_faces=2,
            refine_landmarks=True,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5
        )
        self.face_detector = self.mp_detection.FaceDetection(min_detection_confidence=0.5)
        
        # Detection variables
        self.eye_movement_count = 0
        self.prev_eye_x = None
        self.frame_counter = 0
        self.last_detected_face_count = 0
        self.face_alert = ""
        self.face_count = 0
        
        # Gender detection
        try:
            self.model = YOLO("best (6).pt")
            try:
                self.model.to("cuda")
                logger.info("✅ YOLO model loaded on GPU")
            except:
                logger.info("✅ YOLO model loaded on CPU")
        except Exception as e:
            logger.error(f"❌ YOLO model loading failed: {e}")
            self.model = None
        self.latest_gender = "Unknown"
        
        # Mood detection
        self.mood_history = deque(maxlen=MOOD_HISTORY_LEN)
        self.current_mood = "neutral"
        self.mood_frame_counter = 0
        
        # Audio setup
        self.RATE = 16000
        self.FRAME_MS = 20
        self.SAMPLES_PER_FRAME = int(self.RATE * self.FRAME_MS / 1000)
        self.vad = webrtcvad.Vad(3)
        self.speech_deque = deque(maxlen=10)
        self.recent_speech_flag = False
        
        try:
            self.p = pyaudio.PyAudio()
            self.stream = self.p.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=self.RATE,
                input=True,
                frames_per_buffer=self.SAMPLES_PER_FRAME,
                input_device_index=None  # Use default device
            )
            logger.info("✅ Audio input initialized successfully")
        except Exception as e:
            logger.error(f"❌ Audio setup failed: {e}")
            self.stream = None
        
        # Noise detection face mesh
        self.noise_face_mesh = mp.solutions.face_mesh.FaceMesh(max_num_faces=1, refine_landmarks=True)
        self.bg_voice = False
        self.lipsync = False
        self.mouth_ratio_debug = 0.0
        
        # Verification
        self.face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
        self.reference_face = None
        self.verification_status = "Not set"
        
        # Store the latest frame from frontend
        self.latest_frame = None
        self.frame_lock = asyncio.Lock()
        
        # Enhanced speech detection
        self.speech_detected = False
        self.speech_confidence = 0.0
        
        # Start audio thread
        self.start_audio_thread()

    def start_audio_thread(self):
        """Start only audio processing thread"""
        if self.stream:
            import threading
            self.audio_thread = threading.Thread(target=self.audio_vad_worker, daemon=True)
            self.audio_thread.start()
            logger.info("✅ Audio processing thread started")

    async def set_frame_from_frontend(self, frame_data: str):
        """Receive frame from frontend as base64"""
        try:
            # Convert base64 to image
            if frame_data.startswith('data:image/'):
                image_data = base64.b64decode(frame_data.split(',')[1])
            else:
                image_data = base64.b64decode(frame_data)
                
            nparr = np.frombuffer(image_data, np.uint8)
            frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            
            if frame is None:
                logger.warning("⚠️ Failed to decode frame from base64")
                return False
                
            async with self.frame_lock:
                self.latest_frame = frame
            return True
        except Exception as e:
            logger.error(f"❌ Error processing frame from frontend: {e}")
            return False

    def get_latest_frame(self):
        """Get the latest frame from frontend"""
        return self.latest_frame

    def process_face(self, frame):
        """Process face detection and eye movements"""
        if frame is None:
            return None
            
        try:
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            detection_results = self.face_detector.process(rgb)
            self.face_count = len(detection_results.detections) if detection_results and detection_results.detections else 0
            mesh_results = self.face_mesh.process(rgb)
            self.face_alert = ""
            
            if mesh_results and mesh_results.multi_face_landmarks:
                self.frame_counter += 1
                for face_landmarks in mesh_results.multi_face_landmarks:
                    # Eye movement detection using specific landmarks
                    eye_x = face_landmarks.landmark[33].x  # Right eye corner
                    if self.prev_eye_x is not None and self.frame_counter % 10 == 0:
                        if abs(eye_x - self.prev_eye_x) > 0.015:
                            self.eye_movement_count += 1
                    self.prev_eye_x = eye_x
                
                current_face_count = len(mesh_results.multi_face_landmarks)
                if self.last_detected_face_count != 0 and current_face_count != self.last_detected_face_count:
                    self.face_alert = "Face transition detected!"
                self.last_detected_face_count = current_face_count

            if self.face_count > 1:
                self.face_alert += " | Multiple people!" if self.face_alert else "Multiple people detected!"

            return mesh_results
            
        except Exception as e:
            logger.error(f"❌ Face processing error: {e}")
            return None

    def process_gender(self, frame):
        """Process gender detection using YOLO"""
        if self.model is None or frame is None:
            self.latest_gender = "Unknown"
            return
            
        try:
            # Resize for faster processing
            small = cv2.resize(frame, (320, 240))
            results = self.model(small, verbose=False)
            
            if len(results) > 0 and hasattr(results[0], "boxes"):
                boxes_np = results[0].boxes.data.cpu().numpy()
                if len(boxes_np) > 0:
                    # Get the highest confidence detection
                    x1, y1, x2, y2, conf, cls = sorted(boxes_np, key=lambda x: x[4], reverse=True)[0]
                    if conf >= 0.4:  # Confidence threshold
                        self.latest_gender = self.model.names[int(cls)] if hasattr(self.model, "names") else str(cls)
                        logger.debug(f"✅ Gender detected: {self.latest_gender} (confidence: {conf:.2f})")
        except Exception as e:
            logger.error(f"❌ Gender detection error: {e}")

    def process_mood(self, frame, mesh_results):
        """Process mood/emotion detection using DeepFace"""
        if frame is None:
            return
            
        self.mood_frame_counter += 1
        if self.mood_frame_counter % MOOD_ANALYZE_EVERY_N_FRAMES != 0:
            return

        try:
            if not (mesh_results and mesh_results.multi_face_landmarks):
                return

            ih, iw, _ = frame.shape
            face = mesh_results.multi_face_landmarks[0]
            xs = [lm.x for lm in face.landmark]
            ys = [lm.y for lm in face.landmark]
            x1 = int(min(xs) * iw); x2 = int(max(xs) * iw)
            y1 = int(min(ys) * ih); y2 = int(max(ys) * ih)
            pad_px = 40
            x1 = max(0, x1 - pad_px); y1 = max(0, y1 - pad_px)
            x2 = min(iw, x2 + pad_px); y2 = min(ih, y2 + pad_px)

            if x2 - x1 < 30 or y2 - y1 < 30:
                return

            face_crop = frame[y1:y2, x1:x2].copy()
            if face_crop.size == 0:
                return

            face_rgb = cv2.cvtColor(face_crop, cv2.COLOR_BGR2RGB)
            result = DeepFace.analyze(face_rgb, actions=['emotion'], enforce_detection=False)

            if isinstance(result, list) and len(result) > 0:
                res = result[0]
            elif isinstance(result, dict):
                res = result
            else:
                return

            emotions = res.get('emotion') or {}
            if not emotions:
                return

            emotions_copy = dict(emotions)
            neutral_pct = emotions_copy.get('neutral', 0.0)
            if neutral_pct >= NEUTRAL_IGNORE_THRESHOLD:
                emotions_copy.pop('neutral', None)

            if emotions_copy:
                predicted = max(emotions_copy.items(), key=lambda kv: kv[1])[0]
            else:
                predicted = res.get('dominant_emotion', 'neutral')

            self.mood_history.append(predicted)
            most_common = Counter(self.mood_history).most_common(1)[0][0]

            if most_common != self.current_mood:
                logger.info(f"🎭 Mood changed: {self.current_mood} -> {most_common}")
                self.current_mood = most_common

        except Exception as e:
            logger.error(f"❌ Mood detection error: {e}")

    def audio_vad_worker(self):
        """Audio processing worker for speech detection"""
        if self.stream is None:
            return
            
        while self.running:
            try:
                frame_bytes = self.stream.read(self.SAMPLES_PER_FRAME, exception_on_overflow=False)
                is_speech = self.vad.is_speech(frame_bytes, self.RATE)
                self.speech_deque.append(1 if is_speech else 0)
                
                # Calculate speech confidence
                speech_ratio = sum(self.speech_deque) / len(self.speech_deque) if len(self.speech_deque) > 0 else 0
                self.speech_confidence = speech_ratio
                self.recent_speech_flag = speech_ratio > SPEECH_DETECTION_THRESHOLD
                self.speech_detected = self.recent_speech_flag
                
            except Exception as e:
                logger.error(f"❌ Audio processing error: {e}")
                break

    def process_noise(self, frame):
        """Process background voice and lip sync detection"""
        if frame is None:
            self.bg_voice = False
            self.lipsync = False
            return
            
        try:
            self.bg_voice = False
            self.lipsync = False
            speech = self.recent_speech_flag
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            results = self.noise_face_mesh.process(rgb)
            
            if results and getattr(results, 'multi_face_landmarks', None):
                lm = results.multi_face_landmarks[0].landmark
                ih, iw, _ = frame.shape
                
                try:
                    # Calculate mouth openness ratio
                    top_y = lm[13].y * ih  # Upper lip
                    bot_y = lm[14].y * ih  # Lower lip
                    face_h = abs(lm[152].y*ih - lm[10].y*ih)  # Face height
                    mouth_open_ratio = max(0.0, (bot_y - top_y) / max(1.0, face_h))
                except:
                    mouth_open_ratio = 0.0
                    
                self.mouth_ratio_debug = mouth_open_ratio
                
                # Enhanced lip sync and background voice detection
                if speech:
                    self.lipsync = mouth_open_ratio > LIPSYNC_THRESHOLD  # Higher ratio = better lip sync
                    self.bg_voice = mouth_open_ratio < BGVOICE_THRESHOLD  # Low ratio during speech = background voice
                else:
                    self.lipsync = False
                    self.bg_voice = False
            else:
                # No face detected but speech detected = likely background voice
                self.bg_voice = True if speech else False
                self.mouth_ratio_debug = 0.0
                
        except Exception as e:
            logger.error(f"❌ Noise processing error: {e}")
            self.bg_voice = False
            self.lipsync = False

    def process_verification(self, frame):
        """Process face verification against reference face"""
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
                
                # Resize both faces to same dimensions
                gray1 = cv2.resize(cv2.cvtColor(self.reference_face, cv2.COLOR_BGR2GRAY), (100, 100))
                gray2 = cv2.resize(cv2.cvtColor(current, cv2.COLOR_BGR2GRAY), (100, 100))
                
                # Calculate histogram similarity
                hist1 = cv2.normalize(cv2.calcHist([gray1], [0], None, [256], [0, 256]), None).flatten()
                hist2 = cv2.normalize(cv2.calcHist([gray2], [0], None, [256], [0, 256]), None).flatten()
                sim = cv2.compareHist(hist1, hist2, cv2.HISTCMP_CORREL)
                
                self.verification_status = "MATCH" if sim > FACE_VERIFICATION_THRESHOLD else "NOT MATCH"
                logger.debug(f"🔍 Face verification similarity: {sim:.3f}")
                
        except Exception as e:
            logger.error(f"❌ Face verification error: {e}")
            self.verification_status = "Error"

    def get_detection_data(self) -> Dict[str, Any]:
        """Get comprehensive detection data"""
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
            "speech_confidence": round(self.speech_confidence, 3),
            "mouth_ratio": round(float(self.mouth_ratio_debug), 4),
            "interview_active": self.interview_active,
            "timestamp": time.time()
        }

    def set_reference_face(self):
        """Set reference face for verification"""
        frame = self.get_latest_frame()
        if frame is not None:
            try:
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                faces = self.face_cascade.detectMultiScale(gray, 1.3, 5)
                if len(faces) > 0:
                    (x, y, w, h) = faces[0]
                    self.reference_face = frame[y:y+h, x:x+w].copy()
                    self.verification_status = "Reference Set"
                    logger.info("✅ Reference face captured successfully")
                    return True
                else:
                    logger.warning("⚠️ No face detected for reference capture")
                    return False
            except Exception as e:
                logger.error(f"❌ Error capturing reference face: {e}")
                return False
        else:
            logger.warning("⚠️ No frame available for reference capture")
            return False

    def process_frame(self):
        """Process the latest frame from frontend and return detection data"""
        frame = self.get_latest_frame()
        
        # Return default data when no frame available
        if frame is None:
            return {
                "faces": 0,
                "eye_moves": self.eye_movement_count,
                "face_alert": "Waiting for video feed",
                "gender": self.latest_gender,
                "mood": self.current_mood,
                "bg_voice": self.bg_voice,
                "lipsync": self.lipsync,
                "verification": self.verification_status,
                "speech": self.speech_detected,
                "speech_confidence": round(self.speech_confidence, 3),
                "mouth_ratio": 0.0,
                "interview_active": self.interview_active,
                "timestamp": time.time()
            }
        
        # Process all detection components
        try:
            mesh_results = self.process_face(frame)
            self.process_noise(frame)
            self.process_verification(frame)
            self.process_gender(frame)
            self.process_mood(frame, mesh_results)
        except Exception as e:
            logger.error(f"❌ Error processing frame: {e}")
        
        return self.get_detection_data()

    def start_interview(self):
        """Start interview session"""
        self.interview_active = True
        logger.info("🎬 Interview session started")
        # Reset counters for new session
        self.eye_movement_count = 0
        self.face_alert = ""

    def stop_interview(self):
        """Stop interview and reset states"""
        self.interview_active = False
        # Reset some detection states but keep historical data
        self.face_count = 0
        self.face_alert = ""
        self.latest_frame = None
        logger.info("🛑 Interview session stopped")

    def cleanup(self):
        """Cleanup resources"""
        self.running = False
        self.stop_interview()
        if self.stream:
            self.stream.stop_stream()
            self.stream.close()
        if self.p:
            self.p.terminate()
        logger.info("✅ AI Detector cleanup completed")

# Initialize AI detector
logger.info("🚀 Initializing AI Detection System...")
ai_detector = AIDetector()

active_connections = []

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    active_connections.append(websocket)
    logger.info(f"✅ New WebSocket connection. Total connections: {len(active_connections)}")
    
    try:
        while True:
            # Wait for data from frontend
            data = await websocket.receive_text()
            
            try:
                # Try to parse as JSON first (could be a command or frame data)
                json_data = json.loads(data)
                
                if json_data.get('type') == 'participant_frame':
                    # It's a participant frame data
                    frame_data = json_data.get('image')
                    room_id = json_data.get('roomId')
                    user_id = json_data.get('userId')
                    session_id = json_data.get('sessionId')
                    
                    if frame_data:
                        success = await ai_detector.set_frame_from_frontend(frame_data)
                        if not success:
                            logger.warning("⚠️ Failed to process frame from frontend")
                    
                    # Process detection and send back results
                    detection_data = ai_detector.process_frame()
                    detection_data['room_id'] = room_id
                    detection_data['user_id'] = user_id
                    detection_data['session_id'] = session_id
                    
                    await websocket.send_json(detection_data)
                    
                elif json_data.get('type') == 'command':
                    # Handle commands
                    command = json_data.get('command')
                    if command == 'start_interview':
                        ai_detector.start_interview()
                    elif command == 'stop_interview':
                        ai_detector.stop_interview()
                    
            except json.JSONDecodeError:
                # If not JSON, assume it's base64 frame data (legacy format)
                if data.startswith('data:image/') or len(data) > 1000:
                    await ai_detector.set_frame_from_frontend(data)
                    
                    # Send detection data back
                    detection_data = ai_detector.process_frame()
                    if detection_data:
                        await websocket.send_json(detection_data)
                
    except WebSocketDisconnect:
        active_connections.remove(websocket)
        logger.info(f"❌ WebSocket disconnected. Remaining connections: {len(active_connections)}")
    except Exception as e:
        logger.error(f"❌ WebSocket error: {e}")
        if websocket in active_connections:
            active_connections.remove(websocket)

@app.post("/start_interview")
async def start_interview():
    """Start interview session"""
    try:
        logger.info("🎬 Starting interview via API...")
        ai_detector.start_interview()
        
        response_data = {
            "status": "success",
            "message": "Interview started successfully",
            "room_id": f"room_{int(time.time())}",
            "session_id": f"session_{int(time.time())}",
            "timestamp": time.time(),
            "detection_active": True
        }
        logger.info(f"✅ Interview started: {response_data}")
        return response_data
        
    except Exception as e:
        response_data = {
            "status": "error",
            "message": f"Error starting interview: {str(e)}",
            "timestamp": time.time()
        }
        logger.error(f"❌ Interview start error: {response_data}")
        return response_data

@app.post("/stop_interview")
async def stop_interview():
    """Stop interview session"""
    try:
        logger.info("🛑 Stopping interview via API...")
        ai_detector.stop_interview()
        
        response_data = {
            "status": "success",
            "message": "Interview stopped successfully",
            "timestamp": time.time(),
            "final_stats": {
                "total_eye_movements": ai_detector.eye_movement_count,
                "final_mood": ai_detector.current_mood,
                "face_alerts_detected": ai_detector.face_alert != "",
                "speech_detected": ai_detector.speech_detected
            }
        }
        logger.info(f"✅ Interview stopped: {response_data}")
        return response_data
        
    except Exception as e:
        response_data = {
            "status": "error",
            "message": f"Error stopping interview: {str(e)}",
            "timestamp": time.time()
        }
        logger.error(f"❌ Interview stop error: {response_data}")
        return response_data

@app.post("/end_interview")
async def end_interview():
    """Alternative endpoint for ending interview"""
    return await stop_interview()

@app.post("/set_reference_face")
async def set_reference_face():
    """Set reference face for verification"""
    try:
        success = ai_detector.set_reference_face()
        if success:
            return {
                "status": "success", 
                "message": "Reference face set successfully",
                "timestamp": time.time()
            }
        else:
            return {
                "status": "error", 
                "message": "Failed to set reference face - no face detected in current frame",
                "timestamp": time.time()
            }
    except Exception as e:
        return {
            "status": "error", 
            "message": f"Error setting reference face: {str(e)}",
            "timestamp": time.time()
        }

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "message": "AI Detection API is running",
        "interview_active": ai_detector.interview_active,
        "active_connections": len(active_connections),
        "audio_initialized": ai_detector.stream is not None,
        "model_loaded": ai_detector.model is not None,
        "timestamp": time.time()
    }

@app.get("/stats")
async def get_stats():
    """Get current detection statistics"""
    return ai_detector.get_detection_data()

@app.get("/")
async def root():
    """Root endpoint with API information"""
    return {
        "message": "AI Interview Detection API v2.0",
        "description": "Real-time AI-powered interview monitoring system",
        "endpoints": {
            "start_interview": "POST /start_interview",
            "stop_interview": "POST /stop_interview", 
            "end_interview": "POST /end_interview",
            "set_reference_face": "POST /set_reference_face",
            "health": "GET /health",
            "stats": "GET /stats",
            "websocket": "WS /ws"
        },
        "features": [
            "Face detection and counting",
            "Eye movement tracking", 
            "Gender detection",
            "Emotion/mood analysis",
            "Speech detection",
            "Background voice detection",
            "Lip sync analysis",
            "Face verification",
            "Real-time WebSocket streaming"
        ]
    }

@app.on_event("startup")
async def startup_event():
    """Initialize on application startup"""
    logger.info("🚀 AI Interview Detection API starting up...")

@app.on_event("shutdown")
async def shutdown_event():
    """Cleanup on application shutdown"""
    logger.info("🛑 Application shutdown initiated...")
    ai_detector.cleanup()
    logger.info("✅ Application shutdown completed")

# if __name__ == "__main__":
#    print("=" * 60)
#    print("🚀 AI Interview Detection FastAPI Server")
#    print("=" * 60)
#    print("📡 Server URL: http://localhost:8001")
#    print("📱 Frontend URL: http://localhost:5173") 
#    print("🔧 Available endpoints:")
#    print("   - POST /start_interview")
#    print("   - POST /stop_interview")
#    print("   - POST /end_interview")
#    print("   - POST /set_reference_face")
#    print("   - GET  /health")
#    print("   - GET  /stats")
#    print("   - WebSocket /ws")
#    print("=" * 60)
    
#    uvicorn.run(
#        app, 
#        host="0.0.0.0", 
#        port=8001, 
#        log_level="info",
#        access_log=True
#    )