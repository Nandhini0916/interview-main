import React from 'react'
import ReactDOM from 'react-dom/client'
import { GoogleOAuthProvider } from '@react-oauth/google'
import App from './App'
import './index.css'

const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID

console.log('=== Google Auth Initialization ===')
console.log('VITE_GOOGLE_CLIENT_ID:', googleClientId)
console.log('VITE_NODE_API_URL:', import.meta.env.VITE_NODE_API_URL)
console.log('===================================')

if (!googleClientId) {
  console.error('❌ Google Client ID is missing! Check Vercel environment variables.')
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <GoogleOAuthProvider clientId={googleClientId}>
      <App />
    </GoogleOAuthProvider>
  </React.StrictMode>,
)