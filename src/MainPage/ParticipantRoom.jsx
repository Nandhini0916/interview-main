import React, { useEffect, useState, useRef } from "react";
import "./ParticipantRoom.css";
import { createDefaultWebRTCManager } from "../utils/webrtc";

function ParticipantRoom({ room, onLeave }) {
  const [mediaStream, setMediaStream] = useState(null);
  const [screenStream, setScreenStream] = useState(null);
  const [interviewerStream, setInterviewerStream] = useState(null);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isMicOn, setIsMicOn] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isInterviewerScreenSharing, setIsInterviewerScreenSharing] = useState(false);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState("");
  const [connectionStatus, setConnectionStatus] = useState("disconnected");
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const [chatOnline, setChatOnline] = useState(false);
  const [showChat, setShowChat] = useState(true);
  const [signalingConnected, setSignalingConnected] = useState(false);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [aiConnected, setAiConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [hasJoined, setHasJoined] = useState(false);
  const [interviewerConnected, setInterviewerConnected] = useState(false);

  const videoRef = useRef(null);
  const interviewerVideoRef = useRef(null);
  const chatMessagesRef = useRef(null);
  const canvasRef = useRef(null);
  const frameIntervalRef = useRef(null);
  const wsRef = useRef(null);
  const webrtcManagerRef = useRef(null);

  const PYTHON_API_URL = process.env.REACT_APP_PYTHON_API_URL || 'http://localhost:8001';
  const NODE_API_URL = process.env.REACT_APP_NODE_API_URL || 'http://localhost:8000/api';

  // Enhanced connection status management
  const updateConnectionStatus = (status) => {
    setConnectionStatus(status);
    console.log(`🔗 Participant connection status: ${status}`);
  };

  // Enhanced message handling with duplicate prevention
  const handleWebRTCMessage = (data) => {
    console.log('📨 Participant received WebRTC message:', data.type);
    
    if (data.fromSignaling && data.type === 'chat') {
      console.log('💬 Skipping duplicate chat message from signaling');
      return;
    }
    
    if (data.type === 'chat' && data.fromDataChannel) {
      const messageExists = messages.some(msg => 
        msg.id === data.id || 
        (msg.text === data.message && msg.sender === data.sender && Math.abs(new Date(msg.timestamp) - new Date(data.timestamp)) < 1000)
      );
      
      if (!messageExists) {
        addMessage(data.message, data.sender, data.timestamp, data.id);
      }
    } else if (data.type === 'screen_share_state') {
      console.log('🖥️ Interviewer screen share state update:', data.isSharing);
      setIsInterviewerScreenSharing(data.isSharing);
    } else if (data.type === 'ai_results') {
      console.log('🤖 Received AI results from interviewer:', data.data);
    }
  };

  // Enhanced WebRTC initialization using the manager
  const initializeWebRTCManager = () => {
    const user = JSON.parse(localStorage.getItem('interviewUser') || '{}');
    const userId = user?.id || 'participant-' + Date.now();
    
    webrtcManagerRef.current = createDefaultWebRTCManager(
      room.id, 
      userId, 
      'participant',
      {
        onConnectionStateChange: (state) => {
          console.log('🔗 Participant WebRTC connection state:', state);
          if (state === 'connected') {
            updateConnectionStatus("connected");
            setChatOnline(true);
            setIsConnecting(false);
            setSignalingConnected(true);
            console.log('✅ WebRTC connected with interviewer!');
          } else if (state === 'connecting') {
            updateConnectionStatus("connecting");
            setIsConnecting(true);
          } else if (state === 'disconnected' || state === 'failed') {
            updateConnectionStatus("disconnected");
            setIsConnecting(false);
            setChatOnline(false);
            setSignalingConnected(false);
          }
        },

        onIceConnectionStateChange: (state) => {
          console.log('🧊 Participant ICE connection state:', state);
        },

        onTrack: (event) => {
          console.log('🎥 Participant received remote track from interviewer:', event.track.kind, event.streams);
          
          if (event.streams && event.streams.length > 0) {
            const remoteStream = event.streams[0];
            console.log('🔗 Setting interviewer stream:', remoteStream.id);
            setInterviewerStream(remoteStream);
            setInterviewerConnected(true);
            
            const setupVideo = () => {
              if (interviewerVideoRef.current && remoteStream) {
                interviewerVideoRef.current.srcObject = remoteStream;
                interviewerVideoRef.current.play().catch(error => {
                  console.warn('⚠️ Failed to play interviewer video, retrying...', error);
                  setTimeout(setupVideo, 500);
                });
              }
            };
            setTimeout(setupVideo, 100);
          }
        },

        onMessage: (data) => {
          console.log('📨 Participant received message:', data.type);
          handleWebRTCMessage(data);
        },

        onInterviewerJoined: (data) => {
          console.log('🎯 Interviewer joined the room:', data.interviewerId);
          setInterviewerConnected(true);
        },

        onPeerDisconnected: (data) => {
          console.log('👋 Peer disconnected:', data.role);
          if (data.role === 'interviewer') {
            setInterviewerConnected(false);
            setInterviewerStream(null);
            setIsInterviewerScreenSharing(false);
            updateConnectionStatus("disconnected");
            setChatOnline(false);
          }
        },

        onOpen: () => {
          console.log('✅ Participant signaling connected');
          setSignalingConnected(true);
        },

        onClose: () => {
          console.log('🔌 Participant signaling closed');
          setSignalingConnected(false);
          setChatOnline(false);
        },

        onError: (error) => {
          console.error('❌ Participant WebRTC error:', error);
          updateConnectionStatus("error");
          setIsConnecting(false);
        }
      }
    );
  };

  // Enhanced WebSocket connection for AI analysis with reconnection logic
  const connectWebSocket = () => {
    try {
      if (wsRef.current) wsRef.current.close();
      
      const ws = new WebSocket(`${process.env.REACT_APP_PYTHON_WS_URL || 'ws://localhost:8001'}/ws`);
      
      ws.onopen = () => {
        console.log("✅ Participant WebSocket connected to AI backend");
        setAiConnected(true);
        if (isCameraOn && mediaStream) {
          if (frameIntervalRef.current) clearInterval(frameIntervalRef.current);
          frameIntervalRef.current = setInterval(captureAndSendFrame, 1000);
          console.log('🤖 AI frame capture started');
        }
      };
      
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log("🤖 Participant AI Detection Data:", data);
          
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
          
          if (currentSessionId && enhancedData.faces > 0) {
            saveDetectionData(enhancedData);
          }
          
          if (webrtcManagerRef.current && webrtcManagerRef.current.isDataChannelOpen('chat')) {
            const aiData = {
              type: 'ai_results',
              data: enhancedData,
              timestamp: new Date().toISOString()
            };
            webrtcManagerRef.current.sendData('chat', aiData);
          }
        } catch (err) {
          console.error("❌ Error parsing WebSocket message:", err);
        }
      };
      
      ws.onclose = (event) => {
        console.log("🔌 Participant WebSocket disconnected:", event.code, event.reason);
        setAiConnected(false);
        if (frameIntervalRef.current) {
          clearInterval(frameIntervalRef.current);
          frameIntervalRef.current = null;
        }
        
        if (isCameraOn) {
          console.log("🔄 Reconnecting to AI WebSocket in 3 seconds...");
          setTimeout(() => connectWebSocket(), 3000);
        }
      };
      
      ws.onerror = (error) => {
        console.error("❌ Participant WebSocket error:", error);
        setAiConnected(false);
      };

      wsRef.current = ws;
    } catch (err) {
      console.error("❌ Participant WebSocket connection failed:", err);
      setAiConnected(false);
    }
  };

  // Enhanced camera start with proper sequencing
  const startCamera = async () => {
    try {
      console.log('🎥 Starting camera...');
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

      console.log('✅ Camera stream obtained');
      setMediaStream(stream);
      
      if (videoRef.current && !isScreenSharing) {
        videoRef.current.srcObject = stream;
        videoRef.current.classList.add('mirror-effect');
        videoRef.current.onloadedmetadata = () => {
          console.log('✅ Participant video ready');
          videoRef.current.play().catch(err => console.warn('⚠️ Video play warning:', err));
        };
      }
      
      setIsCameraOn(true);
      setIsMicOn(true);
      setHasJoined(true);
      
      initializeWebRTCManager();
      if (webrtcManagerRef.current) {
        await webrtcManagerRef.current.connect();
        await webrtcManagerRef.current.setLocalStream(stream);
        
        webrtcManagerRef.current.createDataChannel('chat', {
          ordered: true
        });
      }
      
      connectWebSocket();
      await createSession();
      
      console.log('✅ Camera started successfully');
      setIsConnecting(false);
    } catch (err) {
      console.error("❌ Error accessing media devices:", err);
      alert("Could not access camera. Please check permissions.");
      setIsConnecting(false);
      setIsCameraOn(false);
    }
  };

  // Enhanced cleanup with proper resource management
  const stopCamera = () => {
    console.log('🛑 Stopping camera...');
    
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
      mediaStream.getTracks().forEach(track => {
        track.stop();
        track.enabled = false;
      });
      setMediaStream(null);
    }
    
    if (screenStream) {
      screenStream.getTracks().forEach(track => {
        track.stop();
        track.enabled = false;
      });
      setScreenStream(null);
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    if (interviewerVideoRef.current) {
      interviewerVideoRef.current.srcObject = null;
    }
    
    setIsCameraOn(false);
    setIsMicOn(false);
    setIsScreenSharing(false);
    setChatOnline(false);
    setInterviewerStream(null);
    setIsInterviewerScreenSharing(false);
    setIsConnecting(false);
    setHasJoined(false);
    setInterviewerConnected(false);
    setSignalingConnected(false);
    updateConnectionStatus("disconnected");
    
    console.log('✅ Camera stopped');
  };

  // FIXED: Enhanced screen sharing - replaces camera in the same video element
  const toggleScreenShare = async () => {
    if (!isScreenSharing) {
      try {
        console.log('🖥️ Starting screen share...');
        
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

        console.log('Screen stream obtained with tracks:', 
          screenStream.getVideoTracks().length, 'video,',
          screenStream.getAudioTracks().length, 'audio'
        );

        setScreenStream(screenStream);
        
        // Replace the camera video with screen share in the same video element
        if (videoRef.current) {
          videoRef.current.srcObject = screenStream;
          videoRef.current.classList.remove('mirror-effect'); // Remove mirror effect for screen share
          videoRef.current.play().catch(err => console.warn('⚠️ Screen share play warning:', err));
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
        
        console.log('✅ Screen sharing started');
      } catch (err) {
        console.error("❌ Error sharing screen:", err);
        if (err.name !== 'NotAllowedError') {
          setIsScreenSharing(false);
          alert("Failed to share screen: " + err.message);
        }
      }
    } else {
      stopScreenShare();
    }
  };

  // FIXED: Enhanced screen share stop - restores camera
  const stopScreenShare = () => {
    console.log('🛑 Stopping screen share...');
    
    if (screenStream) {
      screenStream.getTracks().forEach(track => {
        track.stop();
        track.enabled = false;
      });
      setScreenStream(null);
    }
    
    // Restore camera stream in the video element
    if (videoRef.current && mediaStream) {
      videoRef.current.srcObject = mediaStream;
      videoRef.current.classList.add('mirror-effect'); // Add mirror effect back for camera
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
    
    console.log('✅ Screen share stopped');
  };

  // Session management
  const createSession = async () => {
    try {
      const user = JSON.parse(localStorage.getItem('interviewUser') || '{}');
      const sessionId = `session-${room.id}-participant-${Date.now()}`;
      
      const response = await fetch(`${NODE_API_URL}/detections/session/start`, {
        method: "POST",
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionId,
          roomId: room.id,
          userId: user.id || 'participant',
          userType: 'participant'
        })
      });
      
      const result = await response.json();
      if (result.success) {
        console.log('✅ Participant session created:', sessionId);
        setCurrentSessionId(sessionId);
        return sessionId;
      } else {
        console.error('❌ Failed to create participant session:', result.message);
        return null;
      }
    } catch (error) {
      console.error('❌ Error creating participant session:', error);
      return null;
    }
  };

  const saveDetectionData = async (detectionData) => {
    try {
      if (!currentSessionId) {
        console.error('❌ No active session for saving detection');
        return;
      }

      await fetch(`${NODE_API_URL}/detections/save`, {
        method: "POST",
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: currentSessionId,
          roomId: room.id,
          userId: JSON.parse(localStorage.getItem('interviewUser') || '{}')?.id || 'participant',
          timestamp: new Date(),
          ...detectionData
        })
      });
    } catch (error) {
      console.error('❌ Error saving participant detection:', error);
    }
  };

  // Frame capture with better error handling
  const captureAndSendFrame = () => {
    if (!videoRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      const video = videoRef.current;
      if (video.videoWidth === 0 || video.videoHeight === 0 || video.readyState !== 4) {
        return;
      }
      
      if (!canvasRef.current) canvasRef.current = document.createElement('canvas');
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = canvas.toDataURL('image/jpeg', 0.8);
      
      if (wsRef.current.readyState === WebSocket.OPEN) {
        const frameData = {
          type: 'participant_frame',
          image: imageData,
          timestamp: Date.now(),
          roomId: room.id,
          userId: JSON.parse(localStorage.getItem('interviewUser') || '{}')?.id || 'participant',
          sessionId: currentSessionId
        };
        wsRef.current.send(JSON.stringify(frameData));
      }
    } catch (error) {
      console.error('❌ Error capturing participant frame:', error);
    }
  };

  // Chat functions with duplicate prevention
  const toggleChat = () => {
    setShowChat(!showChat);
    if (!showChat) setUnreadMessages(0);
  };

  // Enhanced message handling with unique IDs
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
    
    if (sender === 'interviewer' && !showChat) setUnreadMessages(prev => prev + 1);
  };

  // Enhanced message sending with unique IDs
  const sendMessage = () => {
    if (newMessage.trim() === "") return;
    const timestamp = new Date().toISOString();
    const messageText = newMessage.trim();
    const messageId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    addMessage(messageText, 'participant', timestamp, messageId);
    setUnreadMessages(0);

    if (webrtcManagerRef.current) {
      webrtcManagerRef.current.sendChatMessage(messageText, messageId);
    }

    setNewMessage("");
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') sendMessage();
  };

  // Toggle camera and mic
  const toggleCamera = () => {
    if (isCameraOn) stopCamera();
    else startCamera();
  };

  const toggleMic = () => {
    if (!mediaStream) {
      alert("Please turn on your camera first to enable microphone");
      return;
    }
    
    const currentStream = isScreenSharing ? screenStream : mediaStream;
    if (currentStream) {
      const audioTrack = currentStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMicOn(audioTrack.enabled);
        console.log(`🎤 Microphone ${audioTrack.enabled ? 'unmuted' : 'muted'}`);
      }
    }
  };

  const handleLeaveMeeting = async () => {
    console.log('🚪 Leaving meeting...');
    stopCamera();
    
    if (currentSessionId) {
      try {
        await fetch(`${NODE_API_URL}/detections/session/end`, {
          method: "POST",
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: currentSessionId })
        });
        console.log('✅ Session ended in database');
      } catch (error) {
        console.error('❌ Error ending session:', error);
      }
    }
    
    onLeave();
  };

  const copyRoomId = () => {
    navigator.clipboard.writeText(room.id)
      .then(() => alert('✅ Room ID copied to clipboard!'))
      .catch(err => {
        console.error('Failed to copy room ID: ', err);
        alert('Failed to copy Room ID. Please copy it manually.');
      });
  };

  // Enhanced UseEffects with proper dependencies
  useEffect(() => {
    if (chatMessagesRef.current) {
      chatMessagesRef.current.scrollTop = chatMessagesRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (showChat) setUnreadMessages(0);
  }, [showChat]);

  useEffect(() => {
    if (isCameraOn && aiConnected && mediaStream) {
      if (frameIntervalRef.current) clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = setInterval(captureAndSendFrame, 1000);
      console.log('🤖 Started AI frame capture');
    } else if (frameIntervalRef.current) {
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
      console.log('🤖 Stopped AI frame capture');
    }
    
    return () => {
      if (frameIntervalRef.current) {
        clearInterval(frameIntervalRef.current);
        frameIntervalRef.current = null;
      }
    };
  }, [isCameraOn, aiConnected, mediaStream]);

  // Enhanced video stream handling
  useEffect(() => {
    if (interviewerStream && interviewerVideoRef.current) {
      console.log('🎬 Setting up interviewer video element with stream');
      interviewerVideoRef.current.srcObject = interviewerStream;
      
      const playVideo = () => {
        if (interviewerVideoRef.current) {
          interviewerVideoRef.current.play().catch(error => {
            console.warn('⚠️ Failed to play interviewer video, retrying...', error);
            setTimeout(playVideo, 500);
          });
        }
      };
      
      playVideo();
    }
  }, [interviewerStream]);

  // Mount and cleanup with proper sequence
  useEffect(() => {
    console.log('🎯 Participant room mounted');
    
    return () => {
      console.log('🧹 Cleaning up participant room...');
      stopCamera();
    };
  }, []);

  return (
    <div className="participant-room">
      <div className="room-header">
        <div className="header-left">
          <h2>True Hire</h2>
          <span className="room-status participant">CANDIDATE</span>
          <span className={`connection-status ${connectionStatus}`}>
            {connectionStatus === 'connected' ? '● Connected' : 
             connectionStatus === 'connecting' ? '● Connecting...' : '● Disconnected'}
          </span>
        </div>
        <div className="header-right">
          <div className="room-id">
            <span>Room ID:</span>
            <span className="room-id-value">{room.id}</span>
          </div>
          <button className="copy-room-id-button" onClick={copyRoomId}>Copy Room ID</button>
          <button className="leave-button" onClick={handleLeaveMeeting}>Leave Meeting</button>
        </div>
      </div>

      <div className="room-content">
        <div className="video-section">
          <div className="video-container">
            {/* FIXED: Enhanced video grid with consistent sizing */}
            <div className={`video-grid ${isScreenSharing || isInterviewerScreenSharing ? 'has-screen-share' : ''}`}>
              
              {/* Interviewer Video - Always maintains consistent size */}
              <div className={`video-tile interviewer-tile ${isInterviewerScreenSharing ? 'screen-share' : ''}`}>
                <video
                  ref={interviewerVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className={`video-element ${isInterviewerScreenSharing ? 'screen-share' : ''}`}
                />
                <div className="video-info">
                  <div className="participant-name">
                    Interviewer {isInterviewerScreenSharing && ' - Screen Sharing'}
                  </div>
                  <div className="video-status">
                    {interviewerStream ? '🔊 Live' : 'Waiting for interviewer...'}
                    {isInterviewerScreenSharing && ' 🖥️ Screen Sharing'}
                  </div>
                </div>
                {!interviewerStream && (
                  <div className="video-overlay"><div className="camera-icon">👤</div><div>Interviewer will join shortly</div></div>
                )}
                {isInterviewerScreenSharing && (
                  <div className="screen-share-indicator">
                    <span>🖥️ Interviewer is sharing screen</span>
                  </div>
                )}
              </div>

              {/* Participant Video - Always maintains consistent size */}
              <div className={`video-tile participant-tile ${isScreenSharing ? 'screen-share' : ''}`}>
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className={`video-element ${isScreenSharing ? 'screen-share' : 'mirror-effect'}`}
                />
                <div className="video-info">
                  <div className="participant-name">
                    You {isScreenSharing && ' - Screen Sharing'}
                  </div>
                  <div className="video-status">
                    {isMicOn ? '🎤' : '🔇'} 
                    {isScreenSharing ? ' 🖥️ Screen Sharing • LIVE' : 
                     isCameraOn ? ' 📹 Camera • LIVE' : ' 📷 Off'}
                    {aiConnected && <span style={{marginLeft: '5px', color: '#10b981'}}>• AI Analyzing</span>}
                  </div>
                </div>
                {!isCameraOn && !isScreenSharing && (
                  <div className="video-overlay"><div className="camera-icon">📹</div><div>Your camera is off</div></div>
                )}
                {isConnecting && (
                  <div className="video-overlay"><div className="camera-icon">🔄</div><div>Connecting to interview...</div></div>
                )}
                {isScreenSharing && (
                  <div className="screen-share-indicator">
                    <span>🖥️ You are sharing your screen</span>
                  </div>
                )}
              </div>
            </div>

            <div className="join-call-container">
              <button
                onClick={toggleCamera}
                disabled={isConnecting}
                className={`join-call-button ${isCameraOn ? 'leave' : 'join'} ${isConnecting ? 'connecting' : ''}`}
              >
                <span className="call-button-icon">{isConnecting ? '🔄' : (isCameraOn ? '📹' : '🎥')}</span>
                <span className="call-button-text">{isConnecting ? "Connecting..." : (isCameraOn ? "Leave Call" : "Join Call")}</span>
              </button>
            </div>

            <div className="bottom-controls">
              <button
                onClick={toggleMic}
                className={`control-button mic-button ${isMicOn ? 'active' : 'inactive'}`}
                title={isMicOn ? "Mute Microphone" : "Unmute Microphone"}
                disabled={!isCameraOn || isConnecting}
              >
                <span className="control-icon">{isMicOn ? "🎤" : "🔇"}</span>
              </button>
              <button
                onClick={toggleCamera}
                className={`control-button camera-button ${isCameraOn ? 'active' : 'inactive'}`}
                title={isCameraOn ? "Turn Off Camera" : "Turn On Camera"}
                disabled={isConnecting}
              >
                <span className="control-icon">{isCameraOn ? "📹" : "📷"}</span>
              </button>
              <button
                onClick={toggleScreenShare}
                className={`control-button share-button ${isScreenSharing ? 'active' : 'inactive'}`}
                title={isScreenSharing ? "Stop Screen Share" : "Share Screen"}
                disabled={!isCameraOn || isConnecting}
              >
                <span className="control-icon">{isScreenSharing ? "🖥️" : "📤"}</span>
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

        {showChat && (
          <div className="chat-section">
            <div className="chat-container">
              <div className="chat-header">
                <h3>Chat with Interviewer {chatOnline ? '🟢' : '🔴'}</h3>
                <button className="close-chat" onClick={toggleChat}>×</button>
              </div>
              <div className="chat-messages" ref={chatMessagesRef}>
                {messages.length === 0 ? (
                  <div className="no-messages">
                    <p>No messages yet</p>
                    <span>Start a conversation with the interviewer</span>
                  </div>
                ) : (
                  messages.map(message => (
                    <div key={message.id} className={`message ${message.sender === 'participant' ? 'participant' : 'interviewer'}`}>
                      <div className="message-sender">{message.sender === 'participant' ? 'You' : 'Interviewer'}</div>
                      <div className="message-text">{message.text}</div>
                      <div className="message-time">{message.timestamp}</div>
                    </div>
                  ))
                )}
              </div>
              <div className="chat-input">
                <input
                  type="text"
                  placeholder={chatOnline ? "Type a message..." : "Connecting chat..."}
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  onKeyPress={handleKeyPress}
                  className="message-input"
                  disabled={!chatOnline}
                />
                <button
                  onClick={sendMessage}
                  className="send-button"
                  disabled={!chatOnline || !newMessage.trim()}
                >
                  Send
                </button>
              </div>
              <div className="chat-status">
                <span className={`status-indicator ${chatOnline ? 'online' : 'offline'}`}>
                  {chatOnline ? '🟢 Chat Online' : '🔴 Chat Offline'}
                </span>
                {signalingConnected && <span className="signaling-status"> | Signaling Connected</span>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default ParticipantRoom;