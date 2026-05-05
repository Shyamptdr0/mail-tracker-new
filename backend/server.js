// server.js - Main Express server

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');

// Import routes
const mailRoutes = require('./routes/mails');
const trackingRoutes = require('./routes/tracking');

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// Ngrok free plan bypass — skip the browser warning interstitial
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI;

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
  .then(() => {
    console.log('✅ MongoDB connected');
  })
  .catch((error) => {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  });

// WebSocket Setup
const wss = new WebSocket.Server({ server });
const clients = new Map(); // Store connected clients

wss.on('connection', (ws) => {
  console.log('🔌 New WebSocket connection');

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);

      if (message.type === 'REGISTER') {
        // Register client with user email
        const { userEmail } = message;
        clients.set(userEmail, ws);
        console.log(`📍 Client registered: ${userEmail}`);
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  ws.on('close', () => {
    console.log('❌ WebSocket connection closed');
    // Remove client from map
    for (const [email, client] of clients.entries()) {
      if (client === ws) {
        clients.delete(email);
        console.log(`Removed client: ${email}`);
        break;
      }
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Export WebSocket functionality for use in routes
app.locals.wss = wss;
app.locals.clients = clients;

// Routes
app.use('/api/mails', mailRoutes);
app.use('/api/tracking', trackingRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    websockets: wss.clients.size
  });
});

// Stats endpoint
app.get('/api/stats', async (req, res) => {
  try {
    const Mail = require('./models/Mail');
    const TrackingEvent = require('./models/TrackingEvent');

    const totalMails = await Mail.countDocuments();
    const totalEvents = await TrackingEvent.countDocuments();
    const openedMails = await TrackingEvent.countDocuments({ eventType: 'opened' });

    res.json({
      totalMails,
      totalEvents,
      openedMails,
      openRate: totalMails > 0 ? Math.round((openedMails / totalMails) * 100) : 0,
      activeConnections: wss.clients.size
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.path,
    method: req.method
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('❌ Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    timestamp: new Date().toISOString()
  });
});

// Start server
const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║   📧 EMAIL TRACKER BACKEND STARTED  ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🔌 WebSocket available at ws://localhost:${PORT}`);
  console.log(`📊 MongoDB: ${MONGODB_URI}`);
  console.log(`\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n🛑 Shutting down server...');
  wss.close();
  mongoose.connection.close();
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

module.exports = { app, server, wss };