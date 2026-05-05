import React, { useEffect, useState, useRef } from "react";
import "./InterviewRoom.css";
import { createDefaultWebRTCManager } from "../utils/webrtc";
import ReportModal from "./ReportModal";

function InterviewRoom({ room, onLeave }) {
  const [aiResults, setAiResults] = useState({
    faces: 0,
    eye_moves: 0,
    face_alert: "",
    gender: "Unknown",
    mood: "neutral",
    bg_voice: false,
    lipsync: false,
    verification: "Not set",
    speech: false,
    mouth_ratio: 0,
    interview_active: false
  });

  const [connectionStatus, setConnectionStatus] = useState("disconnected");
  const [interviewStatus, setInterviewStatus] = useState("not_started");
  const [mediaStream, setMediaStream] = useState(null);
  const [screenStream, setScreenStream] = useState(null);
  const [participantStream, setParticipantStream] = useState(null);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isMicOn, setIsMicOn] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isParticipantScreenSharing, setIsParticipantScreenSharing] = useState(false);
  const [activeParticipants, setActiveParticipants] = useState(0);
  const [showChat, setShowChat] = useState(false);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState("");
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const [referenceFaceSet, setReferenceFaceSet] = useState(false);
  const [capturingReference, setCapturingReference] = useState(false);
  const [chatConnected, setChatConnected] = useState(false);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [aiConnected, setAiConnected] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [finalReport, setFinalReport] = useState(null);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [sessionStartTime, setSessionStartTime] = useState(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [signalingConnected, setSignalingConnected] = useState(false);

  const videoRef = useRef(null);
  const participantVideoRef = useRef(null);
  const wsRef = useRef(null);
  const isConnectingRef = useRef(false);
  const chatMessagesRef = useRef(null);
  const canvasRef = useRef(null);
  const frameIntervalRef = useRef(null);
  const webrtcManagerRef = useRef(null);

  // VITE environment variables
  const PYTHON_API_URL = import.meta.env.VITE_PYTHON_API_URL || 'http://localhost:8001';
  const NODE_API_URL = import.meta.env.VITE_NODE_API_URL || 'http://localhost:8000';
  const PYTHON_WS_URL = import.meta.env.VITE_PYTHON_WS_URL || 'ws://localhost:8001';

  // Debug log for environment variables
  useEffect(() => {
    console.log('=== InterviewRoom Environment Variables (Vite) ===');
    console.log('VITE_PYTHON_API_URL:', import.meta.env.VITE_PYTHON_API_URL);
    console.log('VITE_NODE_API_URL:', import.meta.env.VITE_NODE_API_URL);
    console.log('VITE_PYTHON_WS_URL:', import.meta.env.VITE_PYTHON_WS_URL);
    console.log('PYTHON_API_URL:', PYTHON_API_URL);
    console.log('NODE_API_URL:', NODE_API_URL);
    console.log('PYTHON_WS_URL:', PYTHON_WS_URL);
    console.log('================================================');
  }, []);

  const updateConnectionStatus = (status) => {
    console.log(`🔗 Interviewer connection status updating to: ${status}`);
    setConnectionStatus(status);
  };

  const calculateDuration = () => {
    if (!sessionStartTime) return "00:00:00";
    const endTime = new Date();
    const diff = endTime - sessionStartTime;
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  const calculatePerformanceScore = (detectionData) => {
    let score = 50;
    if (detectionData.faces === 1) score += 15;
    if (detectionData.eye_moves < 10) score += 10;
    if (detectionData.lipsync) score += 10;
    if (!detectionData.bg_voice) score += 5;
    if (detectionData.speech) score += 5;
    if (detectionData.mood === 'happy' || detectionData.mood === 'neutral') score += 5;
    if (detectionData.faces === 0) score -= 20;
    if (detectionData.faces > 1) score -= 15;
    if (detectionData.eye_moves > 30) score -= 10;
    if (detectionData.face_alert) score -= 10;
    if (detectionData.bg_voice) score -= 10;
    return Math.max(0, Math.min(100, score));
  };

  const handleWebRTCMessage = (data) => {
    console.log('📨 Received WebRTC message:', data.type, data.fromDataChannel ? '(data channel)' : '(signaling)');
    
    switch (data.type) {
      case 'chat':
        const messageExists = messages.some(msg => 
          msg.id === data.id || 
          (msg.text === data.message && msg.sender === data.sender && Math.abs(new Date(msg.timestamp) - new Date(data.timestamp)) < 1000)
        );
        if (!messageExists) {
          console.log('💬 Adding chat message:', data.message);
          addMessage(data.message, data.sender, data.timestamp, data.id);
        }
        break;
      case 'screen_share_state':
        console.log('🖥️ Participant screen share state:', data.isSharing);
        setIsParticipantScreenSharing(data.isSharing);
        break;
      case 'ai_results':
        console.log('🤖 AI results from participant:', data.data);
        break;
      case 'data_channel_state':
        console.log('💬 Data channel state:', data.channel, data.state);
        if (data.channel === 'chat' && data.state === 'open') {
          setChatConnected(true);
        } else if (data.channel === 'chat' && data.state === 'closed') {
          setChatConnected(false);
        }
        break;
      default:
        console.log('📨 Unknown message type:', data.type);
    }
  };

  const initializeWebRTCManager = () => {
    const user = JSON.parse(localStorage.getItem('interviewUser'));
    const userId = user?.id || 'interviewer-' + Date.now();
    
    console.log('🚀 Initializing WebRTC manager for interviewer...');
    
    webrtcManagerRef.current = createDefaultWebRTCManager(
      room.id, 
      userId, 
      'interviewer',
      {
        onConnectionStateChange: (state) => {
          console.log('🔗 Interviewer WebRTC connection state:', state);
          switch (state) {
            case 'connected':
              updateConnectionStatus("connected");
              setChatConnected(true);
              setIsConnecting(false);
              console.log('✅ WebRTC connected with participant!');
              break;
            case 'connecting':
              updateConnectionStatus("connecting");
              setIsConnecting(true);
              console.log('🔄 Connecting to participant...');
              break;
            case 'disconnected':
            case 'failed':
              updateConnectionStatus("disconnected");
              setIsConnecting(false);
              setChatConnected(false);
              console.log('❌ WebRTC connection lost');
              break;
            default:
              console.log('🔗 WebRTC state:', state);
          }
        },
        onIceConnectionStateChange: (state) => {
          console.log('🧊 Interviewer ICE connection state:', state);
        },
        onTrack: (event) => {
          console.log('🎥 Interviewer received remote track from participant:', event.track.kind, event.streams);
          if (event.streams && event.streams.length > 0) {
            const remoteStream = event.streams[0];
            console.log('🔗 Setting participant stream:', remoteStream.id);
            setParticipantStream(remoteStream);
            setActiveParticipants(1);
            const setupVideo = () => {
              if (participantVideoRef.current && remoteStream) {
                participantVideoRef.current.srcObject = remoteStream;
                participantVideoRef.current.play().catch(error => {
                  console.warn('⚠️ Failed to play participant video, retrying...', error);
                  setTimeout(setupVideo, 500);
                });
              }
            };
            setTimeout(setupVideo, 100);
          }
        },
        onMessage: (data) => {
          console.log('📨 Interviewer received message:', data.type);
          handleWebRTCMessage(data);
        },
        onDataChannel: (channel) => {
          console.log('💬 Data channel created:', channel.label);
          if (channel.label === 'chat') {
            setChatConnected(true);
          }
        },
        onParticipantJoined: (data) => {
          console.log('👤 Participant joined room:', data.participantId);
          setActiveParticipants(1);
          setIsConnecting(true);
          updateConnectionStatus("connecting");
          setTimeout(async () => {
            if (webrtcManagerRef.current) {
              console.log('🎯 Creating offer for participant...');
              await webrtcManagerRef.current.createOffer();
            }
          }, 1000);
        },
        onOpen: () => {
          console.log('✅ Interviewer signaling connected');
          setSignalingConnected(true);
        },
        onClose: () => {
          console.log('🔌 Interviewer signaling closed');
          setSignalingConnected(false);
          setChatConnected(false);
        },
        onError: (error) => {
          console.error('❌ Interviewer WebRTC error:', error);
          updateConnectionStatus("error");
          setIsConnecting(false);
        }
      }
    );
  };

  // Enhanced WebSocket connection with test message and proper handling
  const connectWebSocket = () => {
    if (isConnectingRef.current || (wsRef.current && wsRef.current.readyState === WebSocket.OPEN)) {
      return;
    }

    try {
      isConnectingRef.current = true;
      if (wsRef.current) {
        wsRef.current.close();
      }
      
      const wsUrl = `${PYTHON_WS_URL}/ws`;
      console.log('🔗 Connecting to AI WebSocket:', wsUrl);
      
      const ws = new WebSocket(wsUrl);
      
      // Set connection timeout - INCREASED to 30s for better reliability with Render/slow networks
      const connectionTimeout = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          console.error('❌ AI WebSocket connection timeout after 30 seconds');
          ws.close();
          setAiConnected(false);
        }
      }, 30000);
      
      ws.onopen = () => {
        clearTimeout(connectionTimeout);
        isConnectingRef.current = false;
        console.log("✅ Interviewer connected to AI WebSocket");
        setAiConnected(true);
        
        // Send a test message to verify connection
        ws.send(JSON.stringify({
          type: 'test',
          message: 'Connection test',
          timestamp: Date.now()
        }));
        
        console.log('WebSocket open, waiting for participant video...');
      };
      
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          // Handle ping messages
          if (data.type === 'ping') {
            console.log('💓 Received ping from AI server');
            return;
          }
          
          if (data.type === 'test_response') {
            console.log('✅ AI WebSocket test successful!');
            return;
          }
          
          console.log("🤖 AI Analysis Data received:", data);
          
          const enhancedData = {
            faces: data.faces || 0,
            eye_moves: data.eye_moves || 0,
            face_alert: data.face_alert || "",
            gender: data.gender || "Unknown",
            mood: data.mood || "neutral",
            bg_voice: data.bg_voice || false,
            lipsync: data.lipsync || false,
            verification: data.verification || "Not set",
            speech: data.speech || false,
            mouth_ratio: data.mouth_ratio || 0,
            interview_active: data.interview_active || false
          };
          
          setAiResults(prev => ({ ...prev, ...enhancedData }));
          
          if (currentSessionId && enhancedData.faces > 0) {
            saveDetectionData(enhancedData);
          }
        } catch (err) {
          console.error("❌ Error parsing AI data:", err, "Raw data:", event.data);
        }
      };
      
      ws.onclose = (event) => {
        clearTimeout(connectionTimeout);
        isConnectingRef.current = false;
        console.log("🔌 AI WebSocket disconnected:", event.code, event.reason);
        setAiConnected(false);
        
        if (frameIntervalRef.current) {
          clearInterval(frameIntervalRef.current);
          frameIntervalRef.current = null;
        }
        
        // Attempt to reconnect if interview is active
        if (interviewStatus === "active") {
          console.log("🔄 Reconnecting to AI WebSocket in 3 seconds...");
          setTimeout(() => connectWebSocket(), 3000);
        }
      };
      
      ws.onerror = (error) => {
        clearTimeout(connectionTimeout);
        isConnectingRef.current = false;
        console.error("❌ AI WebSocket error:", error);
        console.error("WebSocket URL:", wsUrl);
        setAiConnected(false);
        
        // Attempt to reconnect on error too if interview is active
        if (interviewStatus === "active") {
          console.log("🔄 Reconnecting to AI WebSocket (after error) in 5 seconds...");
          setTimeout(() => connectWebSocket(), 5000);
        }
      };
      
      wsRef.current = ws;
    } catch (err) {
      console.error("❌ WebSocket connection failed:", err);
      setAiConnected(false);
    }
  };

  const startCamera = async () => {
    try {
      console.log('🎥 Interviewer starting camera...');
      setIsConnecting(true);
      
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { 
          width: { ideal: 1280 }, 
          height: { ideal: 720 }, 
          facingMode: "user", 
          frameRate: { ideal: 30, max: 60 } 
        },
        audio: { 
          echoCancellation: true, 
          noiseSuppression: true, 
          autoGainControl: true 
        }
      });
      
      console.log('✅ Interviewer camera stream obtained');
      setMediaStream(stream);
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.classList.add('mirror-effect');
        videoRef.current.onloadedmetadata = () => {
          console.log('✅ Interviewer video ready');
          videoRef.current.play().catch(console.warn);
        };
      }
      
      setIsCameraOn(true);
      setIsMicOn(true);
      
      initializeWebRTCManager();
      if (webrtcManagerRef.current) {
        await webrtcManagerRef.current.connect();
        await webrtcManagerRef.current.setLocalStream(stream);
        webrtcManagerRef.current.createDataChannel('chat', { ordered: true });
      }
      
      await createSession();
      
      console.log('✅ Interviewer camera started successfully');
      setIsConnecting(false);
    } catch (err) {
      console.error("❌ Interviewer error accessing media devices:", err);
      alert("Could not access camera. Please check permissions.");
      setIsConnecting(false);
      setIsCameraOn(false);
    }
  };

  const stopCamera = () => {
    console.log('🛑 Interviewer stopping camera...');
    
    if (frameIntervalRef.current) {
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }
    
    if (wsRef.current) {
      wsRef.current.close();
      setAiConnected(false);
    }
    
    if (webrtcManagerRef.current) {
      webrtcManagerRef.current.close();
    }
    
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop());
    }
    
    if (screenStream) {
      screenStream.getTracks().forEach(track => track.stop());
    }
    
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    if (participantVideoRef.current) {
      participantVideoRef.current.srcObject = null;
    }
    
    setIsCameraOn(false);
    setIsMicOn(false);
    setIsScreenSharing(false);
    setIsParticipantScreenSharing(false);
    setParticipantStream(null);
    setActiveParticipants(0);
    setConnectionStatus("disconnected");
    setChatConnected(false);
    setSignalingConnected(false);
    setIsConnecting(false);
    
    console.log('✅ Interviewer camera stopped');
  };

  const startInterview = async () => {
    try {
      console.log('🎬 Interviewer starting interview process...');
      setIsConnecting(true);
      
      await startCamera();
      
      const sessionId = await createSession();
      if (!sessionId) {
        alert('❌ Failed to create session');
        setIsConnecting(false);
        return;
      }
      
      // Notify Python backend
      try {
        const response = await fetch(`${PYTHON_API_URL}/start_interview`, {
          method: "POST",
          headers: { 'Content-Type': 'application/json' }
        });
        
        if (response.ok) {
          const result = await response.json();
          if (result.status === "success") {
            console.log('✅ Python backend notified');
          }
        }
      } catch (err) {
        console.warn('⚠️ Could not connect to Python backend:', err);
      }
      
      // Set interview as active
      setInterviewStatus("active");
      
      // Note: WebSocket will be connected by useEffect when participantStream is available
      
      setIsConnecting(false);
      console.log('✅ Interview started successfully!');
      
    } catch (err) {
      console.error("❌ Interviewer error starting interview:", err);
      alert("Error starting interview: " + err.message);
      setIsConnecting(false);
    }
  };

  const stopInterview = async () => {
    try {
      console.log('🛑 Interviewer stopping interview...');
      stopCamera();
      
      try {
        const response = await fetch(`${PYTHON_API_URL}/stop_interview`, {
          method: "POST",
          headers: { 'Content-Type': 'application/json' }
        });
        const result = await response.json();
        if (result.status === "success") {
          console.log('✅ Python backend notified');
        }
      } catch (err) {
        console.warn('⚠️ Could not notify Python backend');
      }
      
      setInterviewStatus("inactive");
      
      if (currentSessionId) {
        await generateFinalReport();
        try {
          await fetch(`${NODE_API_URL}/api/detections/session/end`, {
            method: "POST",
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: currentSessionId })
          });
        } catch (error) {
          console.warn('⚠️ Could not end session on server');
        }
      }
      
      alert('✅ Interview stopped successfully!');
    } catch (err) {
      console.error("❌ Interviewer error stopping interview:", err);
      alert("Error stopping interview: " + err.message);
    }
  };

  const createSession = async () => {
    try {
      const user = JSON.parse(localStorage.getItem('interviewUser'));
      if (!user) {
        console.error('No user found');
        return null;
      }
      
      const sessionId = `session-${room.id}-interviewer-${Date.now()}`;
      const response = await fetch(`${NODE_API_URL}/api/detections/session/start`, {
        method: "POST",
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionId,
          roomId: room.id,
          userId: user.id,
          userType: 'interviewer'
        })
      });
      
      const result = await response.json();
      if (result.success) {
        console.log('✅ Interviewer session created:', sessionId);
        setCurrentSessionId(sessionId);
        setSessionStartTime(new Date());
        return sessionId;
      } else {
        console.error('❌ Failed to create interviewer session:', result.message);
        return null;
      }
    } catch (error) {
      console.error('❌ Error creating interviewer session:', error);
      return null;
    }
  };

  const saveDetectionData = async (detectionData) => {
    try {
      if (!currentSessionId) return;
      await fetch(`${NODE_API_URL}/api/detections/save`, {
        method: "POST",
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: currentSessionId,
          roomId: room.id,
          userId: JSON.parse(localStorage.getItem('interviewUser'))?.id,
          timestamp: new Date(),
          ...detectionData
        })
      });
    } catch (error) {
      console.error('Error saving detection:', error);
    }
  };

  // Enhanced frame capture with better logging
  const captureAndSendFrame = () => {
    if (!participantVideoRef.current) {
      console.log('No participant video reference');
      return;
    }
    
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.log('WebSocket not open, state:', wsRef.current?.readyState);
      return;
    }
    
    try {
      const video = participantVideoRef.current;
      if (video.videoWidth === 0 || video.videoHeight === 0) {
        console.log('Video dimensions not ready');
        return;
      }
      
      if (video.readyState !== 4) {
        console.log('Video not ready, readyState:', video.readyState);
        return;
      }
      
      if (!canvasRef.current) {
        canvasRef.current = document.createElement('canvas');
      }
      
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      
      // Compress image to reduce payload size
      const imageData = canvas.toDataURL('image/jpeg', 0.7);
      
      if (wsRef.current.readyState === WebSocket.OPEN) {
        const frameData = {
          type: 'participant_frame',
          image: imageData,
          timestamp: Date.now(),
          roomId: room.id,
          sessionId: currentSessionId
        };
        wsRef.current.send(JSON.stringify(frameData));
        console.log('📤 Frame sent to AI at:', new Date().toISOString());
      }
    } catch (error) {
      console.error('Error capturing frame:', error);
    }
  };

  const isParticipantVideoReady = () => {
    if (!participantVideoRef.current) return false;
    const video = participantVideoRef.current;
    return video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= 2;
  };

  const addMessage = (text, sender, timestamp, id = null) => {
    const messageId = id || Date.now() + Math.random();
    const message = {
      id: messageId,
      text,
      sender,
      timestamp: timestamp ? new Date(timestamp).toLocaleTimeString() : new Date().toLocaleTimeString()
    };
    
    setMessages(prev => {
      const exists = prev.some(msg => msg.id === messageId);
      if (!exists) {
        return [...prev, message];
      }
      return prev;
    });
    
    if (sender === 'participant' && !showChat) setUnreadMessages(prev => prev + 1);
  };

  const sendMessage = () => {
    if (newMessage.trim() === "") return;
    
    const timestamp = new Date().toISOString();
    const messageText = newMessage.trim();
    const messageId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    console.log('📤 Sending message:', messageText);
    
    addMessage(messageText, 'interviewer', timestamp, messageId);
    setUnreadMessages(0);
    
    if (webrtcManagerRef.current) {
      const success = webrtcManagerRef.current.sendChatMessage(messageText, messageId);
      if (!success) {
        console.warn('⚠️ Failed to send message via WebRTC, will retry...');
        setTimeout(() => {
          webrtcManagerRef.current?.sendChatMessage(messageText, messageId);
        }, 500);
      }
    } else {
      console.error('❌ WebRTC manager not available');
    }
    
    setNewMessage("");
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') sendMessage();
  };

  const toggleChat = () => {
    setShowChat(!showChat);
    if (!showChat) setUnreadMessages(0);
  };

  const toggleCamera = () => {
    if (isCameraOn) stopCamera();
    else startCamera();
  };

  const toggleMic = () => {
    if (!mediaStream) {
      alert("Please turn on your camera first to enable microphone");
      return;
    }
    const audioTrack = mediaStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      setIsMicOn(audioTrack.enabled);
    }
  };

  const toggleScreenShare = async () => {
    if (!isScreenSharing) {
      try {
        console.log('🖥️ Interviewer starting screen share...');
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            cursor: "always",
            displaySurface: "window",
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30, max: 60 }
          },
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 48000,
            channelCount: 2
          }
        });
        setScreenStream(screenStream);
        if (videoRef.current) {
          videoRef.current.srcObject = screenStream;
          videoRef.current.classList.remove('mirror-effect');
          videoRef.current.play().catch(console.warn);
        }
        setIsScreenSharing(true);
        if (webrtcManagerRef.current) {
          const videoTrack = screenStream.getVideoTracks()[0];
          if (videoTrack) {
            await webrtcManagerRef.current.replaceVideoTrack(videoTrack);
          }
          const audioTrack = screenStream.getAudioTracks()[0];
          if (audioTrack) {
            await webrtcManagerRef.current.replaceAudioTrack(audioTrack);
          }
          webrtcManagerRef.current.sendScreenShareState(true);
        }
        screenStream.getVideoTracks()[0].onended = () => {
          console.log('Screen share track ended by user');
          stopScreenShare();
        };
        console.log('✅ Interviewer screen sharing started successfully');
      } catch (err) {
        console.error("❌ Interviewer error sharing screen:", err);
        if (err.name !== 'NotAllowedError') {
          setIsScreenSharing(false);
          alert("Failed to share screen: " + err.message);
        }
      }
    } else {
      stopScreenShare();
    }
  };

  const stopScreenShare = () => {
    console.log('🛑 Interviewer stopping screen share...');
    if (screenStream) {
      screenStream.getTracks().forEach(track => {
        track.stop();
        track.enabled = false;
      });
      setScreenStream(null);
    }
    if (videoRef.current && mediaStream) {
      videoRef.current.srcObject = mediaStream;
      videoRef.current.classList.add('mirror-effect');
      videoRef.current.play().catch(console.warn);
    }
    setIsScreenSharing(false);
    if (webrtcManagerRef.current && mediaStream) {
      const videoTrack = mediaStream.getVideoTracks()[0];
      if (videoTrack) {
        webrtcManagerRef.current.replaceVideoTrack(videoTrack);
      }
      const audioTrack = mediaStream.getAudioTracks()[0];
      if (audioTrack) {
        webrtcManagerRef.current.replaceAudioTrack(audioTrack);
      }
      webrtcManagerRef.current.sendScreenShareState(false);
    }
    console.log('✅ Interviewer screen share stopped');
  };

  const handleCaptureReference = () => {
    if (!isParticipantVideoReady()) {
      alert("Participant video is not ready.");
      return;
    }
    if (!activeParticipants) {
      alert("No participant connected.");
      return;
    }
    captureReferenceFace();
  };

  const captureReferenceFace = async () => {
    if (!participantVideoRef.current) {
      alert("No participant video available.");
      return;
    }
    
    try {
      setCapturingReference(true);
      const video = participantVideoRef.current;
      
      if (video.videoWidth === 0 || video.videoHeight === 0) {
        alert("Participant video not ready. Please wait a moment.");
        setCapturingReference(false);
        return;
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      
      const imageData = canvas.toDataURL('image/jpeg', 0.9);
      
      const response = await fetch(`${PYTHON_API_URL}/set_reference_face`, {
        method: "POST",
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ image: imageData })
      });
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const result = await response.json();
      console.log('Reference face capture result:', result);
      
      if (result.status === "success") {
        setReferenceFaceSet(true);
        alert('✅ Reference face captured successfully!');
      } else {
        alert(result.message || 'No face detected. Please ensure the participant\'s face is clearly visible.');
      }
    } catch (error) {
      console.error('Error capturing reference face:', error);
      alert(`Error capturing reference face: ${error.message}`);
    } finally {
      setCapturingReference(false);
    }
  };

  const generateFinalReport = async () => {
    if (!currentSessionId) {
      alert("No active session found. Cannot generate report.");
      return;
    }
    
    setIsGeneratingReport(true);
    try {
      const sessionDuration = calculateDuration();
      const performanceScore = calculatePerformanceScore(aiResults);
      
      const response = await fetch(`${NODE_API_URL}/api/detections/generate-report`, {
        method: "POST",
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: currentSessionId,
          roomId: room.id,
          includeChat: true,
          includeAiMetrics: true,
          duration: sessionDuration,
          sessionStartTime: sessionStartTime,
          sessionEndTime: new Date(),
          aiResults: {
            ...aiResults,
            performance_score: performanceScore
          },
          chatMessages: messages,
          performanceScore: performanceScore
        })
      });
      
      const result = await response.json();
      if (result.success) {
        setFinalReport(result.report);
        setShowReportModal(true);
        console.log("Final report generated successfully:", result.report);
      } else {
        alert("Failed to generate report: " + result.message);
      }
    } catch (error) {
      console.error("Error generating report:", error);
      alert("Error generating report: " + error.message);
    } finally {
      setIsGeneratingReport(false);
    }
  };

  const downloadReport = async () => {
    if (!finalReport) return;
    try {
      const response = await fetch(`${NODE_API_URL}/api/detections/download-report`, {
        method: "POST",
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: currentSessionId,
          report: finalReport,
          roomId: room.id
        })
      });
      if (response.ok) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `interview-report-${room.id}-${new Date().toISOString().split('T')[0]}.pdf`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        alert("Report downloaded successfully!");
      } else {
        const errorData = await response.json();
        alert("Failed to download report: " + (errorData.message || 'Unknown error'));
      }
    } catch (error) {
      console.error("Error downloading report:", error);
      alert("Error downloading report: " + error.message);
    }
  };

  const sendReportToParticipant = async () => {
    if (!finalReport) return;
    try {
      const response = await fetch(`${NODE_API_URL}/api/detections/share-report`, {
        method: "POST",
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: currentSessionId,
          roomId: room.id,
          report: finalReport,
          recipient: 'participant',
          sender: 'interviewer'
        })
      });
      const result = await response.json();
      if (result.success) {
        alert("Report sent to participant successfully!");
      } else {
        alert("Failed to send report to participant: " + result.message);
      }
    } catch (error) {
      console.error("Error sending report to participant:", error);
      alert("Error sending report: " + error.message);
    }
  };

  const copyRoomId = () => {
    navigator.clipboard.writeText(room.id)
      .then(() => alert('✅ Room ID copied to clipboard!'))
      .catch(err => {
        console.error('Failed to copy room ID: ', err);
        alert('Failed to copy Room ID. Please copy it manually.');
      });
  };

  const handleLeaveMeeting = async () => {
    console.log("🚪 handleLeaveMeeting called in InterviewRoom");
    
    try {
      if (interviewStatus === "active") {
        await stopInterview();
      } else if (currentSessionId) {
        await generateFinalReport();
      }
    } catch (error) {
      console.error("Error during cleanup:", error);
    }
    
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop());
      setMediaStream(null);
    }
    
    if (screenStream) {
      screenStream.getTracks().forEach(track => track.stop());
      setScreenStream(null);
    }
    
    if (webrtcManagerRef.current) {
      webrtcManagerRef.current.close();
      webrtcManagerRef.current = null;
    }
    
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    
    setChatConnected(false);
    setAiConnected(false);
    setSignalingConnected(false);
    setIsConnecting(false);
    setCurrentSessionId(null);
    setSessionStartTime(null);
    setMessages([]);
    setParticipantStream(null);
    setActiveParticipants(0);
    setConnectionStatus("disconnected");
    setInterviewStatus("not_started");
    setReferenceFaceSet(false);
    
    setAiResults({
      faces: 0,
      eye_moves: 0,
      face_alert: "",
      gender: "Unknown",
      mood: "neutral",
      bg_voice: false,
      lipsync: false,
      verification: "Not set",
      speech: false,
      mouth_ratio: 0,
      interview_active: false
    });
    
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    if (participantVideoRef.current) {
      participantVideoRef.current.srcObject = null;
    }
    
    console.log("✅ Cleanup complete, calling onLeave");
    
    if (onLeave) {
      onLeave();
    } else {
      console.error("❌ onLeave callback is not defined!");
    }
  };

  useEffect(() => {
    if (participantStream && participantVideoRef.current) {
      console.log('🎬 Setting up participant video element with stream');
      participantVideoRef.current.srcObject = participantStream;
      const playVideo = () => {
        if (participantVideoRef.current) {
          participantVideoRef.current.play().catch(error => {
            console.warn('⚠️ Failed to play participant video, retrying...', error);
            setTimeout(playVideo, 500);
          });
        }
      };
      playVideo();
    }
  }, [participantStream]);

  useEffect(() => {
    if (chatMessagesRef.current) {
      chatMessagesRef.current.scrollTop = chatMessagesRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (showChat) setUnreadMessages(0);
  }, [showChat]);

  // Auto-connect WebSocket when interview becomes active AND participant stream is available
  useEffect(() => {
    console.log('🔍 Checking WebSocket conditions:', {
      interviewStatus,
      hasParticipantStream: !!participantStream,
      aiConnected,
      wsReadyState: wsRef.current?.readyState
    });
    
    if (interviewStatus === "active" && participantStream && !aiConnected) {
      console.log('🎯 Conditions met - connecting WebSocket...');
      connectWebSocket();
    }
  }, [interviewStatus, participantStream, aiConnected]);

  // Start sending frames when participant video is ready and AI is connected
  useEffect(() => {
    let interval = null;
    
    // Check readiness inside the effect to respond to aiConnected/interviewStatus changes
    const checkAndStartCapture = () => {
      if (isParticipantVideoReady() && aiConnected && interviewStatus === "active" && wsRef.current?.readyState === WebSocket.OPEN) {
        console.log('🎬 All conditions met, starting frame capture');
        if (interval) clearInterval(interval);
        interval = setInterval(captureAndSendFrame, 500); // Increased to 2 FPS
      } else {
        if (interval) {
          clearInterval(interval);
          interval = null;
        }
      }
    };

    checkAndStartCapture();
    
    // Also check every 2 seconds if video isn't ready yet
    const readinessCheck = setInterval(() => {
      if (!interval && isParticipantVideoReady() && aiConnected && interviewStatus === "active") {
        checkAndStartCapture();
      }
    }, 2000);
    
    return () => {
      if (interval) clearInterval(interval);
      clearInterval(readinessCheck);
    };
  }, [aiConnected, interviewStatus, participantStream]);

  useEffect(() => {
    console.log('🏠 InterviewRoom mounted');
    return () => {
      console.log('🧹 InterviewRoom cleanup');
      stopCamera();
    };
  }, []);

  const GenerateReportButton = () => {
    if (interviewStatus === "active") return null;
    return (
      <button
        onClick={generateFinalReport}
        disabled={isGeneratingReport || !currentSessionId}
        className={`generate-report-button ${isGeneratingReport ? 'generating' : ''}`}
      >
        <span className="report-icon">{isGeneratingReport ? '⏳' : '📊'}</span>
        <span className="report-text">
          {isGeneratingReport ? 'Generating Report...' : 'Generate Final Report'}
        </span>
      </button>
    );
  };

  return (
    <div className="interview-room">
      <div className="room-header">
        <div className="header-left">
          <h2>True Hire</h2>
          <span className={`room-status ${room.isJoining ? 'joined' : 'hosting'}`}>
            {room.isJoining ? 'JOINED' : 'HOSTING'}
          </span>
          <span className={`connection-status ${connectionStatus}`}>
            {connectionStatus === 'connected' ? '● Connected' : 
             connectionStatus === 'connecting' ? '● Connecting...' : 
             '● Disconnected'}
          </span>
        </div>
        <div className="header-right">
          <GenerateReportButton />
          <div className="room-id"><span>Room ID:</span><span className="room-id-value">{room.id}</span></div>
          <button className="copy-room-id-button" onClick={copyRoomId}>Copy Room ID</button>
          <button className="leave-button" onClick={handleLeaveMeeting}>Leave Meeting</button>
        </div>
      </div>
      <div className="room-content">
        <div className="video-section">
          <div className="video-container">
            <div className={`video-grid ${isScreenSharing || isParticipantScreenSharing ? 'has-screen-share' : ''}`}>
              
              <div className={`video-tile interviewer-tile ${isScreenSharing ? 'screen-share' : ''}`}>
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className={`video-element ${isScreenSharing ? 'screen-share' : 'mirror-effect'}`}
                />
                <div className="video-info">
                  <div className="participant-name">
                    You (Interviewer) {isScreenSharing && ' - Screen Sharing'}
                  </div>
                  <div className="video-status">
                    {isMicOn ? '🎤' : '🔇'} 
                    {isScreenSharing ? ' 🖥️ Screen Sharing • LIVE' : 
                     isCameraOn ? ' 📹 Camera • LIVE' : ' 📷 Off'}
                  </div>
                </div>
                {!isCameraOn && !isScreenSharing && (
                  <div className="video-overlay"><div className="camera-icon">📹</div><div>Your camera is off</div></div>
                )}
                {isScreenSharing && (
                  <div className="screen-share-indicator">
                    <span>🖥️ You are sharing your screen</span>
                  </div>
                )}
              </div>
              
              <div className={`video-tile participant-tile ${isParticipantScreenSharing ? 'screen-share' : ''}`}>
                <video
                  ref={participantVideoRef}
                  autoPlay
                  playsInline
                  className={`video-element ${isParticipantScreenSharing ? 'screen-share' : ''}`}
                />
                <div className="video-info">
                  <div className="participant-name">
                    Participant {activeParticipants > 0 && participantStream ? 
                    (isParticipantScreenSharing ? ' - Screen Sharing' : '(Live)') : '(Offline)'}
                  </div>
                  <div className="video-status">
                    {activeParticipants > 0 && participantStream ? '🔊 Live' : 'Waiting for participant...'}
                    {isParticipantScreenSharing && ' 🖥️ Screen Sharing'}
                    {aiConnected && activeParticipants > 0 && (
                      <span style={{color: '#10b981', marginLeft: '5px'}}>• AI Analyzing</span>
                    )}
                  </div>
                </div>
                {activeParticipants === 0 && (
                  <div className="video-overlay"><div className="camera-icon">👤</div><div>Waiting for participant to join</div></div>
                )}
                {activeParticipants > 0 && !participantStream && (
                  <div className="video-overlay"><div className="camera-icon">📹</div><div>{isConnecting ? 'Connecting to participant video...' : 'Establishing video connection...'}</div></div>
                )}
                {participantStream && participantVideoRef.current && participantVideoRef.current.readyState < 3 && (
                  <div className="video-overlay"><div className="camera-icon">🔄</div><div>Loading participant video...</div></div>
                )}
                {isParticipantScreenSharing && (
                  <div className="screen-share-indicator">
                    <span>🖥️ Participant is sharing screen</span>
                  </div>
                )}
              </div>
            </div>
            
            <div className="start-interview-container">
              <button
                onClick={interviewStatus === "active" ? stopInterview : startInterview}
                disabled={isConnecting}
                className={`start-interview-button ${interviewStatus === "active" ? 'stop' : 'start'} ${isConnecting ? 'connecting' : ''}`}
              >
                <span className="start-button-icon">
                  {isConnecting ? '🔄' : (interviewStatus === "active" ? '⏹️' : '▶️')}
                </span>
                <span className="start-button-text">
                  {isConnecting ? 'Connecting...' : (interviewStatus === "active" ? "End Interview" : "Start Interview")}
                </span>
              </button>
            </div>
            
            <div className="bottom-controls">
              <button
                onClick={toggleMic}
                className={`control-button mic-button ${isMicOn ? 'active' : 'inactive'}`}
                title={isMicOn ? "Mute Microphone" : "Unmute Microphone"}
              >
                <span className="control-icon">{isMicOn ? "🎤" : "🔇"}</span>
              </button>
              <button
                onClick={toggleCamera}
                className={`control-button camera-button ${isCameraOn ? 'active' : 'inactive'}`}
                title={isCameraOn ? "Turn Off Camera" : "Turn On Camera"}
              >
                <span className="control-icon">{isCameraOn ? "📹" : "📷"}</span>
              </button>
              <button
                onClick={toggleScreenShare}
                className={`control-button share-button ${isScreenSharing ? 'active' : 'inactive'}`}
                title={isScreenSharing ? "Stop Screen Share" : "Share Screen"}
              >
                <span className="control-icon">{isScreenSharing ? "🖥️" : "📤"}</span>
              </button>
              <button
                onClick={handleCaptureReference}
                className={`control-button reference-button ${referenceFaceSet ? 'active' : 'inactive'}`}
                title={referenceFaceSet ? "Reference Face Captured" : "Capture Reference Face"}
                disabled={!activeParticipants || capturingReference || !isParticipantVideoReady()}
              >
                <span className="control-icon">{capturingReference ? "⏳" : (referenceFaceSet ? "✅" : "👤")}</span>
                {capturingReference && <span className="capturing-text">Capturing...</span>}
              </button>
              <button
                onClick={toggleChat}
                className={`control-button chat-button ${showChat ? 'active' : 'inactive'}`}
                title={showChat ? "Close Chat" : "Open Chat"}
              >
                <span className="control-icon">💬</span>
                {unreadMessages > 0 && <span className="chat-notification-badge">{unreadMessages}</span>}
              </button>
            </div>
          </div>
        </div>
        
        <div className="results-section">
          {showChat && (
            <div className="chat-container">
              <div className="chat-header">
                <h3>Chat {chatConnected ? '🟢' : '🔴'}</h3>
                <button className="close-chat" onClick={toggleChat}>×</button>
              </div>
              <div className="chat-messages" ref={chatMessagesRef}>
                {messages.length === 0 ? (
                  <div className="no-messages">No messages yet. Start a conversation!</div>
                ) : (
                  messages.map(message => (
                    <div key={message.id} className={`message ${message.sender}`}>
                      <div className="message-sender">{message.sender === 'interviewer' ? 'You' : 'Participant'}</div>
                      <div className="message-text">{message.text}</div>
                      <div className="message-time">{message.timestamp}</div>
                    </div>
                  ))
                )}
              </div>
              <div className="chat-input">
                <input
                  type="text"
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder={chatConnected ? "Type a message..." : "Connecting chat..."}
                  className="message-input"
                  disabled={!chatConnected}
                />
                <button
                  onClick={sendMessage}
                  className="send-button"
                  disabled={!chatConnected || !newMessage.trim()}
                >
                  Send
                </button>
              </div>
              <div className="chat-status">
                <span className={`status-indicator ${chatConnected ? 'online' : 'offline'}`}>
                  {chatConnected ? '🟢 Chat Online' : '🔴 Chat Offline'}
                </span>
                {signalingConnected && <span className="signaling-status"> | Signaling Connected</span>}
              </div>
            </div>
          )}
          
          <div className="results-container">
            <div className="results-header-row">
              <h3 className="results-title">AI Detection Results {aiConnected ? ' 🟢' : ' 🔴'}</h3>
              {!aiConnected && interviewStatus === "active" && (
                <button 
                  className="reconnect-ai-button" 
                  onClick={() => connectWebSocket()}
                  title="Retry AI Connection"
                >
                  🔄 Retry
                </button>
              )}
            </div>
            <div className="detection-source">
              {referenceFaceSet && <span className="verified-badge">✓ Verified</span>}
            </div>
            <div className="results-grid">
              <div className="result-item"><span className="result-label">Faces Detected</span><span className="result-value">{aiResults.faces}</span></div>
              <div className="result-item"><span className="result-label">Eye Movements</span><span className="result-value">{aiResults.eye_moves}</span></div>
              <div className="result-item"><span className="result-label">Gender</span><span className="result-value">{aiResults.gender}</span></div>
              <div className="result-item"><span className="result-label">Emotion</span><span className="result-value">{aiResults.mood}</span></div>
              <div className="result-item"><span className="result-label">Speech Detection</span><span className="result-value">{aiResults.speech ? "Detected" : "None"}</span></div>
              <div className="result-item"><span className="result-label">Lip Sync</span><span className="result-value">{aiResults.lipsync ? "Good" : "Poor"}</span></div>
              <div className="result-item"><span className="result-label">Background Voice</span><span className="result-value">{aiResults.bg_voice ? "Detected" : "None"}</span></div>
              <div className="result-item"><span className="result-label">Face Verification</span><span className="result-value">{referenceFaceSet ? "Match" : "Not Match"}</span></div>
            </div>
            {aiResults.face_alert && (
              <div className="alert-message"><strong>ALERT:</strong> {aiResults.face_alert}</div>
            )}
            <div className="debug-info">
              <small>
                Duration: {calculateDuration()} | AI: {aiConnected ? 'Connected' : 'Disconnected'} | 
                Participant: {activeParticipants > 0 ? 'Connected' : 'Disconnected'} | 
                Video: {participantStream ? 'Active' : 'Inactive'} | Status: {connectionStatus}
                {signalingConnected && ' | Signaling Connected'}
              </small>
            </div>
          </div>
        </div>
      </div>
      
      <ReportModal
        showReportModal={showReportModal}
        setShowReportModal={setShowReportModal}
        finalReport={finalReport}
        currentSessionId={currentSessionId}
        room={room}
        aiResults={aiResults}
        messages={messages}
        sessionStartTime={sessionStartTime}
        calculateDuration={calculateDuration}
        downloadReport={downloadReport}
        sendReportToParticipant={sendReportToParticipant}
      />
    </div>
  );
}

export default InterviewRoom;