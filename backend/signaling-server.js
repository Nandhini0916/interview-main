const WebSocket = require('ws');

// Use PORT from environment variable for Render
const PORT = process.env.PORT || 8081;
const wss = new WebSocket.Server({ port: PORT });
console.log(`🚀 WebRTC Signaling Server started on port ${PORT}`);

const rooms = new Map();
const clients = new Map();

let clientIdCounter = 0;

// Helper function for safe message sending
const safeSend = (ws, message) => {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        ...message,
        timestamp: Date.now()
      }));
      return true;
    }
  } catch (error) {
    console.error('❌ Error sending message:', error);
  }
  return false;
};

wss.on('connection', (ws) => {
  const clientId = ++clientIdCounter;
  console.log(`✅ Client ${clientId} connected`);
  
  clients.set(ws, { 
    id: clientId, 
    ws, 
    room: null, 
    role: null,
    userId: null,
    joinedAt: new Date().toISOString()
  });

  setupHeartbeat(ws, clientId);

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      const client = clients.get(ws);
      
      console.log(`📨 [Client ${clientId}] ${message.type} for room ${message.room}`);

      switch (message.type) {
        case 'join':
          handleJoin(ws, message, clientId);
          break;
        case 'offer':
        case 'answer':
        case 'ice-candidate':
          handleWebRTCMessage(ws, message, clientId);
          break;
        case 'chat':
          handleChatMessage(ws, message, clientId);
          break;
        case 'screen_share_state':
          handleScreenShareState(ws, message, clientId);
          break;
        case 'ping':
          safeSend(ws, { type: 'pong', timestamp: Date.now() });
          break;
        default:
          console.warn(`⚠️ Unknown message type: ${message.type}`);
          safeSend(ws, { type: 'error', message: 'Unknown message type' });
      }
    } catch (error) {
      console.error('❌ Error parsing message:', error);
      safeSend(ws, { type: 'error', message: 'Invalid message format' });
    }
  });

  ws.on('close', (code, reason) => {
    const client = clients.get(ws);
    if (client) {
      console.log(`🔌 ${client.role} ${client.id} disconnected from room ${client.room}`);
      handleDisconnect(ws);
      clients.delete(ws);
    }
  });

  ws.on('error', (error) => {
    console.error(`❌ WebSocket error for client ${clientId}:`, error);
  });

  safeSend(ws, { 
    type: 'welcome', 
    message: 'Connected to signaling server',
    clientId: clientId,
    timestamp: Date.now()
  });
});

function handleJoin(ws, message, clientId) {
  const { room, role, userType, userId } = message;
  const client = clients.get(ws);

  if (!room || !role) {
    safeSend(ws, { type: 'error', message: 'Room and role are required' });
    return;
  }

  console.log(`👤 ${role} ${clientId} joining room ${room}`);

  if (client.room && client.room !== room) {
    handleLeaveRoom(ws, client.room);
  }

  let roomData = rooms.get(room);
  if (!roomData) {
    roomData = { 
      id: room,
      clients: [],
      createdAt: new Date().toISOString(),
      interviewer: null,
      participants: []
    };
    rooms.set(room, roomData);
    console.log(`🏠 New room created: ${room}`);
  }

  if (role === 'interviewer') {
    if (roomData.interviewer) {
      safeSend(ws, { type: 'error', message: 'Interviewer already exists' });
      return;
    }
    roomData.interviewer = client;
  } else if (role === 'participant') {
    roomData.participants.push(client);
  }

  client.room = room;
  client.role = role;
  client.userType = userType || role;
  client.userId = userId || `user-${clientId}`;
  
  if (!roomData.clients.find(c => c.ws === ws)) {
    roomData.clients.push(client);
  }

  console.log(`✅ ${role} ${clientId} joined room ${room}. ${roomData.clients.length} clients`);

  safeSend(ws, { 
    type: 'joined', 
    room: room,
    role: role,
    clientId: clientId,
    userId: client.userId,
    timestamp: Date.now()
  });

  roomData.clients.forEach(otherClient => {
    if (otherClient.ws !== ws && otherClient.ws.readyState === WebSocket.OPEN) {
      if (role === 'participant' && otherClient.role === 'interviewer') {
        safeSend(otherClient.ws, { 
          type: 'participant_joined',
          room: room,
          participantId: clientId,
          userId: client.userId,
          timestamp: Date.now()
        });
      } else if (role === 'interviewer' && otherClient.role === 'participant') {
        safeSend(otherClient.ws, { 
          type: 'interviewer_joined',
          room: room,
          interviewerId: clientId,
          userId: client.userId,
          timestamp: Date.now()
        });
      }
    }
  });

  const roomState = {
    type: 'room_state',
    room: room,
    clients: roomData.clients.map(c => ({
      id: c.id,
      role: c.role,
      userId: c.userId
    })),
    timestamp: Date.now()
  };
  safeSend(ws, roomState);
}

function handleWebRTCMessage(senderWs, message, senderId) {
  const client = clients.get(senderWs);
  if (!client || !client.room) return;

  const roomData = rooms.get(client.room);
  if (!roomData) return;

  let targetClients = [];
  
  if (message.type === 'offer') {
    if (client.role === 'interviewer') {
      targetClients = roomData.participants;
    }
  } else if (message.type === 'answer') {
    if (client.role === 'participant' && roomData.interviewer) {
      targetClients = [roomData.interviewer];
    }
  } else if (message.type === 'ice-candidate') {
    targetClients = roomData.clients.filter(c => c.ws !== senderWs);
  }

  targetClients.forEach(targetClient => {
    if (targetClient.ws.readyState === WebSocket.OPEN) {
      safeSend(targetClient.ws, {
        ...message,
        senderId: senderId,
        senderRole: client.role
      });
    }
  });
}

function handleChatMessage(senderWs, message, senderId) {
  const client = clients.get(senderWs);
  if (!client || !client.room) return;

  const roomData = rooms.get(client.room);
  if (!roomData) return;

  const chatMessage = {
    type: 'chat',
    message: message.message || message.text,
    sender: client.role,
    senderId: senderId,
    senderUserId: client.userId,
    timestamp: message.timestamp || Date.now(),
    room: client.room,
    fromSignaling: true
  };

  roomData.clients.forEach(targetClient => {
    if (targetClient.ws !== senderWs && targetClient.ws.readyState === WebSocket.OPEN) {
      safeSend(targetClient.ws, chatMessage);
    }
  });
}

function handleScreenShareState(senderWs, message, senderId) {
  const client = clients.get(senderWs);
  if (!client || !client.room) return;

  const roomData = rooms.get(client.room);
  if (!roomData) return;

  const screenMessage = {
    type: 'screen_share_state',
    isSharing: message.isSharing,
    role: client.role,
    senderId: senderId,
    senderUserId: client.userId,
    timestamp: Date.now(),
    room: client.room,
    fromSignaling: true
  };

  roomData.clients.forEach(targetClient => {
    if (targetClient.ws !== senderWs && targetClient.ws.readyState === WebSocket.OPEN) {
      safeSend(targetClient.ws, screenMessage);
    }
  });
}

function handleDisconnect(ws) {
  const client = clients.get(ws);
  if (!client || !client.room) return;

  const roomData = rooms.get(client.room);
  if (!roomData) return;

  roomData.clients = roomData.clients.filter(c => c.ws !== ws);
  
  if (client.role === 'interviewer') {
    roomData.interviewer = null;
  } else if (client.role === 'participant') {
    roomData.participants = roomData.participants.filter(p => p.ws !== ws);
  }

  roomData.clients.forEach(otherClient => {
    if (otherClient.ws.readyState === WebSocket.OPEN) {
      safeSend(otherClient.ws, {
        type: 'peer_disconnected',
        role: client.role,
        senderId: client.id,
        room: client.room,
        timestamp: Date.now()
      });
    }
  });

  if (roomData.clients.length === 0) {
    rooms.delete(client.room);
    console.log(`🏚️ Room ${client.room} deleted`);
  }
}

function handleLeaveRoom(ws, roomId) {
  const roomData = rooms.get(roomId);
  if (!roomData) return;

  const client = clients.get(ws);
  if (!client) return;

  roomData.clients = roomData.clients.filter(c => c.ws !== ws);
  
  if (client.role === 'interviewer') {
    roomData.interviewer = null;
  } else if (client.role === 'participant') {
    roomData.participants = roomData.participants.filter(p => p.ws !== ws);
  }
}

function setupHeartbeat(ws, clientId) {
  const interval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      safeSend(ws, { type: 'ping', timestamp: Date.now() });
    } else {
      clearInterval(interval);
    }
  }, 30000);

  ws.on('close', () => clearInterval(interval));
  ws.on('error', () => clearInterval(interval));
}

// Periodic stats
setInterval(() => {
  console.log(`📊 Stats: ${rooms.size} rooms, ${clients.size} clients`);
}, 60000);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('🛑 Shutting down signaling server...');
  clients.forEach((client, ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      safeSend(ws, { type: 'server_shutdown', message: 'Server is shutting down' });
    }
  });
  setTimeout(() => {
    wss.close(() => {
      console.log('✅ Signaling server shut down');
      process.exit(0);
    });
  }, 1000);
});

console.log('✅ WebRTC Signaling Server ready!');