import React, { useState, useEffect } from 'react';
import { FaKeyboard, FaUser, FaGoogle, FaTimes, FaSignInAlt, FaUserPlus, FaSignOutAlt, FaLock } from 'react-icons/fa';
import InterviewRoom from './InterviewRoom';
import ParticipantRoom from './ParticipantRoom';
import './InterviewLandingPage.css';

const InterviewLandingPage = () => {
  const [interviewCode, setInterviewCode] = useState('');
  const [roomPassword, setRoomPassword] = useState('');
  const [joinRoomPassword, setJoinRoomPassword] = useState('');
  const [showOverlay, setShowOverlay] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [showAuthOverlay, setShowAuthOverlay] = useState(false);
  const [authMode, setAuthMode] = useState('signin');
  const [generatedRoomId, setGeneratedRoomId] = useState('');
  const [currentRoom, setCurrentRoom] = useState(null);
  const [joinError, setJoinError] = useState('');
  const [existingRooms, setExistingRooms] = useState([]);
  const [user, setUser] = useState(null);
  const [authForm, setAuthForm] = useState({
    email: '',
    password: '',
    confirmPassword: '',
    firstName: '',
    lastName: ''
  });

  // IMPORTANT: API_BASE_URL should NOT include /api at the end
  const API_BASE_URL = process.env.REACT_APP_NODE_API_URL || 'http://localhost:8000';

  // Load user data from localStorage on component mount
  useEffect(() => {
    const storedUser = localStorage.getItem('interviewUser');
    if (storedUser) {
      setUser(JSON.parse(storedUser));
    }

    // Load current room from localStorage to persist on refresh
    const storedCurrentRoom = localStorage.getItem('currentRoom');
    if (storedCurrentRoom) {
      const roomData = JSON.parse(storedCurrentRoom);
      setCurrentRoom(roomData);
    }
  }, []);

  // Save current room to localStorage whenever it changes
  useEffect(() => {
    if (currentRoom) {
      localStorage.setItem('currentRoom', JSON.stringify(currentRoom));
    } else {
      localStorage.removeItem('currentRoom');
    }
  }, [currentRoom]);

  // Close profile menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (showProfileMenu && !event.target.closest('.profile-menu-container')) {
        setShowProfileMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showProfileMenu]);

  const generateRoomId = () => {
    const min = 100000;
    const max = 999999;
    const roomId = Math.floor(Math.random() * (max - min + 1)) + min;
    setGeneratedRoomId(roomId.toString());
    return roomId.toString();
  };

  const handleCreateInterview = async () => {
    if (!user) {
      alert('Please login to create an interview room.');
      return;
    }
    const newRoomId = generateRoomId();
    setShowOverlay(true);
  };

  const handleCreateRoom = async () => {
    if (roomPassword.trim()) {
      try {
        const response = await fetch(`${API_BASE_URL}/api/rooms/create`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            roomId: generatedRoomId,
            password: roomPassword,
            createdBy: user.id,
            title: 'Interview Room',
            description: 'Interview session room'
          })
        });

        const result = await response.json();

        if (result.success) {
          const roomData = {
            id: generatedRoomId,
            password: roomPassword,
            createdAt: new Date().toISOString(),
            isJoining: false,
            participants: [],
            interviewer: {
              id: `interviewer-${Date.now()}`,
              joinedAt: new Date().toISOString(),
              isActive: true,
              user: user
            }
          };
          
          console.log(`Creating room ${generatedRoomId} with password: ${roomPassword}`);
          setCurrentRoom(roomData);
          setShowOverlay(false);
          setRoomPassword('');
          alert('Room created successfully!');
        } else {
          alert(result.message || 'Failed to create room');
        }
      } catch (error) {
        console.error('Error creating room:', error);
        alert('Error creating room. Please try again.');
      }
    }
  };

  const handleJoinInterview = async () => {
    if (!user) {
      alert('Please login to join an interview room.');
      return;
    }

    if (interviewCode.trim()) {
      if (!/^\d{6}$/.test(interviewCode.trim())) {
        setJoinError('Please enter a valid 6-digit room code');
        return;
      }

      try {
        const response = await fetch(`${API_BASE_URL}/api/rooms/join`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            roomId: interviewCode.trim(),
            password: joinRoomPassword,
            userId: user.id
          })
        });

        const result = await response.json();

        if (result.success) {
          console.log(`Joining interview as participant with code: ${interviewCode}`);
          
          const roomData = {
            id: interviewCode.trim(),
            password: joinRoomPassword,
            createdAt: result.room.createdAt,
            isJoining: true,
            participants: result.room.participants || []
          };

          setCurrentRoom(roomData);
          setJoinError('');
          setJoinRoomPassword('');
          setInterviewCode('');
          alert('Joined room successfully!');
        } else {
          setJoinError(result.message || 'Failed to join room');
        }
      } catch (error) {
        console.error('Error joining room:', error);
        setJoinError('Error joining room. Please try again.');
      }
    } else {
      setJoinError('Please enter a room code');
    }
  };

  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    
    try {
      if (authMode === 'signup') {
        if (authForm.password !== authForm.confirmPassword) {
          alert('Passwords do not match');
          return;
        }

        const response = await fetch(`${API_BASE_URL}/api/auth/signup`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            firstName: authForm.firstName,
            lastName: authForm.lastName,
            email: authForm.email,
            password: authForm.password
          })
        });

        const result = await response.json();

        if (result.success) {
          localStorage.setItem('interviewUser', JSON.stringify(result.user));
          localStorage.setItem('authToken', result.token);
          setUser(result.user);
          setShowAuthOverlay(false);
          setShowProfileMenu(false);
          setAuthForm({ email: '', password: '', confirmPassword: '', firstName: '', lastName: '' });
          alert('Account created successfully!');
        } else {
          alert(result.message || 'Sign up failed');
        }
      } else {
        // Sign in
        const response = await fetch(`${API_BASE_URL}/api/auth/signin`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            email: authForm.email,
            password: authForm.password
          })
        });

        const result = await response.json();

        if (result.success) {
          localStorage.setItem('interviewUser', JSON.stringify(result.user));
          localStorage.setItem('authToken', result.token);
          setUser(result.user);
          setShowAuthOverlay(false);
          setShowProfileMenu(false);
          setAuthForm({ email: '', password: '', confirmPassword: '', firstName: '', lastName: '' });
          alert('Login successful!');
        } else {
          alert(result.message || 'Invalid credentials');
        }
      }
    } catch (error) {
      console.error('Auth error:', error);
      alert('Authentication failed. Please try again.');
    }
  };

  const handleGoogleAuth = () => {
  // Check if Google script is loaded
    if (!window.google) {
      alert('Google Sign-In is loading. Please try again in a moment.');
      return;
    }

    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: process.env.REACT_APP_GOOGLE_CLIENT_ID,
      scope: 'email profile openid',
      callback: async (tokenResponse) => {
        try {
          // Fetch user info using the access token
          const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: {
              'Authorization': `Bearer ${tokenResponse.access_token}`
            }
          });
          const userInfo = await userInfoResponse.json();
        
          console.log('Google user info:', userInfo); // Debug log
        
          // Send to backend
          const response = await fetch(`${API_BASE_URL}/api/auth/google`, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              email: userInfo.email,
              firstName: userInfo.given_name || 'Google',
              lastName: userInfo.family_name || 'User',
              googleId: userInfo.sub
            })
          });

          const result = await response.json();
          console.log('Backend response:', result); // Debug log

          if (result.success) {
            localStorage.setItem('interviewUser', JSON.stringify(result.user));
            localStorage.setItem('authToken', result.token);
            setUser(result.user);
            setShowAuthOverlay(false);
            setShowProfileMenu(false);
            alert('Successfully authenticated with Google!');
          } else {
            alert(result.message || 'Google authentication failed');
          }
        } catch (error) {
          console.error('Google auth error:', error);
          alert('Google authentication failed. Please try again.');
        }
      },
    });
  
    client.requestAccessToken();
  };

  const handleLogout = () => {
    localStorage.removeItem('interviewUser');
    localStorage.removeItem('authToken');
    setUser(null);
    setShowProfileMenu(false);
    
    // If user was in a room, leave it
    if (currentRoom) {
      leaveMeeting();
    }
    
    alert('Logged out successfully!');
  };

  const closeOverlay = () => {
    setShowOverlay(false);
    setRoomPassword('');
  };

  const closeAuthOverlay = () => {
    setShowAuthOverlay(false);
    setAuthForm({ email: '', password: '', confirmPassword: '', firstName: '', lastName: '' });
  };

  const switchAuthMode = () => {
    setAuthMode(authMode === 'signin' ? 'signup' : 'signin');
    setAuthForm({ email: '', password: '', confirmPassword: '', firstName: '', lastName: '' });
  };

  const toggleProfileMenu = () => {
    setShowProfileMenu(!showProfileMenu);
  };

  const leaveMeeting = async () => {
    if (currentRoom) {
      try {
        // Notify backend that user is leaving
        const response = await fetch(`${API_BASE_URL}/api/rooms/${currentRoom.id}/leave`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            userId: user?.id
          })
        });

        if (!response.ok) {
          console.error('Failed to notify backend about leaving room');
        }
      } catch (error) {
        console.error('Error leaving room:', error);
      }
    }

    setCurrentRoom(null);
    setInterviewCode('');
    setJoinRoomPassword('');
    setJoinError('');
  };

  if (currentRoom) {
    if (currentRoom.isJoining) {
      return <ParticipantRoom room={currentRoom} onLeave={leaveMeeting} />;
    } else {
      return <InterviewRoom room={currentRoom} onLeave={leaveMeeting} />;
    }
  }

  return (
    <div className="landing-container">
      {/* Room Creation Overlay */}
      {showOverlay && (
        <div className="overlay">
          <div className="overlay-content">
            <div className="room-creation">
              <h3>Create New Interview Room</h3>
              <div className="room-id-display">
                <span className="room-id-label">Room ID:</span>
                <span className="room-id-value">{generatedRoomId}</span>
              </div>
              <div className="password-input-container">
                <input
                  type="password"
                  placeholder="Set room password"
                  value={roomPassword}
                  onChange={(e) => setRoomPassword(e.target.value)}
                  className="password-input"
                />
              </div>
              <button 
                className="create-room-button"
                onClick={handleCreateRoom}
                disabled={!roomPassword.trim()}
              >
                Create Room
              </button>
            </div>
            <button className="overlay-close" onClick={closeOverlay}>
              <FaTimes />
            </button>
          </div>
        </div>
      )}

      {/* Authentication Overlay */}
      {showAuthOverlay && (
        <div className="overlay">
          <div className="overlay-content auth-overlay">
            <div className="auth-content">
              <h3>{authMode === 'signin' ? 'Sign In' : 'Sign Up'}</h3>
              
              <form onSubmit={handleAuthSubmit} className="auth-form">
                {authMode === 'signup' && (
                  <div className="name-fields">
                    <input
                      type="text"
                      placeholder="First Name"
                      value={authForm.firstName}
                      onChange={(e) => setAuthForm({...authForm, firstName: e.target.value})}
                      required
                    />
                    <input
                      type="text"
                      placeholder="Last Name"
                      value={authForm.lastName}
                      onChange={(e) => setAuthForm({...authForm, lastName: e.target.value})}
                      required
                    />
                  </div>
                )}
                
                <input
                  type="email"
                  placeholder="Email address"
                  value={authForm.email}
                  onChange={(e) => setAuthForm({...authForm, email: e.target.value})}
                  required
                />
                
                <input
                  type="password"
                  placeholder="Password"
                  value={authForm.password}
                  onChange={(e) => setAuthForm({...authForm, password: e.target.value})}
                  required
                />
                
                {authMode === 'signup' && (
                  <input
                    type="password"
                    placeholder="Confirm Password"
                    value={authForm.confirmPassword}
                    onChange={(e) => setAuthForm({...authForm, confirmPassword: e.target.value})}
                    required
                  />
                )}
                
                <button type="submit" className="auth-submit-button">
                  {authMode === 'signin' ? 'Sign In' : 'Sign Up'}
                </button>
              </form>

              <div className="auth-divider">
                <span>or continue with</span>
              </div>

              <button className="google-auth-button" onClick={handleGoogleAuth}>
                <FaGoogle className="google-icon" />
                Google
              </button>

              <div className="auth-switch">
                <p>
                  {authMode === 'signin' ? "Don't have an account? " : "Already have an account? "}
                  <button type="button" className="auth-switch-button" onClick={switchAuthMode}>
                    {authMode === 'signin' ? 'Sign Up' : 'Sign In'}
                  </button>
                </p>
              </div>
            </div>
            <button className="overlay-close" onClick={closeAuthOverlay}>
              <FaTimes />
            </button>
          </div>
        </div>
      )}

      <div className="header">True Hire</div>
      
      {/* Profile Icon with Dropdown Menu */}
      <div className="profile-menu-container">
        <div 
          className="profile-icon"
          onClick={toggleProfileMenu}
        >
          <FaUser />
        </div>

        {/* Profile Dropdown Menu */}
        {showProfileMenu && (
          <div className="profile-dropdown">
            {user ? (
              <>
                <div className="profile-header">
                  <div className="user-avatar">
                    {user.firstName?.charAt(0)}{user.lastName?.charAt(0)}
                  </div>
                  <div className="user-info">
                    <div className="user-name">{user.firstName} {user.lastName}</div>
                    <div className="user-email">{user.email}</div>
                  </div>
                </div>
                <div className="dropdown-divider"></div>
                <button className="dropdown-item" onClick={handleLogout}>
                  <FaSignOutAlt className="dropdown-icon" />
                  Logout
                </button>
              </>
            ) : (
              <>
                <button 
                  className="dropdown-item" 
                  onClick={() => {
                    setShowAuthOverlay(true);
                    setAuthMode('signin');
                    setShowProfileMenu(false);
                  }}
                >
                  <FaSignInAlt className="dropdown-icon" />
                  Sign In
                </button>
                <button 
                  className="dropdown-item" 
                  onClick={() => {
                    setShowAuthOverlay(true);
                    setAuthMode('signup');
                    setShowProfileMenu(false);
                  }}
                >
                  <FaUserPlus className="dropdown-icon" />
                  Sign Up
                </button>
                <div className="dropdown-divider"></div>
                <button className="dropdown-item google-auth-dropdown" onClick={handleGoogleAuth}>
                  <FaGoogle className="dropdown-icon" />
                  Continue with Google
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <div className="landing-content">
        <div className="text-section">
          <h1 className="landing-title">As interviews meet innovation</h1>
          <p className="landing-subtitle">
            Meet the best, work together seamlessly, hire without stress
          </p>
        </div>
        
        <div className="action-section">
          <div className="action-buttons">
            <button className="primary-button" onClick={handleCreateInterview}>
              Create an Interview
            </button>
            
            <div className="divider">
              <span>or</span>
            </div>
            
            <div className="join-section">
              <div className="join-inputs-container">
                <div className="input-container">
                  <FaKeyboard className="input-icon" />
                  <input
                    type="text"
                    placeholder="Enter interview room ID"
                    value={interviewCode}
                    onChange={(e) => {
                      setInterviewCode(e.target.value);
                      setJoinError('');
                    }}
                    className="code-input"
                    maxLength="6"
                  />
                </div>
                
                <div className="input-container">
                  <FaLock className="input-icon" />
                  <input
                    type="password"
                    placeholder="Room password"
                    value={joinRoomPassword}
                    onChange={(e) => {
                      setJoinRoomPassword(e.target.value);
                      setJoinError('');
                    }}
                    className="code-input"
                  />
                </div>
              </div>
              
              <button 
                className="secondary-button"
                onClick={handleJoinInterview}
                disabled={!interviewCode.trim() || !joinRoomPassword.trim()}
              >
                Join Interview
              </button>
            </div>
            
            {joinError && (
              <div className="error-message">
                {joinError}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default InterviewLandingPage;