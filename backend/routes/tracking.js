// routes/tracking.js - Tracking API routes

const express = require('express');
const router = express.Router();
const Mail = require('../models/Mail');
const TrackingEvent = require('../models/TrackingEvent');
const { v4: uuidv4 } = require('uuid');

// Send tracking request (called when email is sent)
router.post('/send', async (req, res) => {
  try {
    const { senderEmail, recipients, subject, sentAt, trackingId: clientTrackingId } = req.body;

    if (!senderEmail || !recipients || !Array.isArray(recipients)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request: senderEmail and recipients array required'
      });
    }

    // Use client-provided trackingId (pixel already injected) or generate one
    const trackingId = clientTrackingId || uuidv4();
    const trackingPixel = `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/tracking/pixel/${trackingId}`;

    // Check if already registered (idempotent)
    let mail = await Mail.findOne({ trackingId });
    if (!mail) {
      mail = new Mail({
        senderEmail,
        subject: subject || '(no subject)',
        recipients: recipients.map(email => ({
          email: email.toLowerCase(),
          status: 'sent'
        })),
        trackingId,
        trackingPixel,
        sentAt: sentAt || new Date()
      });
      await mail.save();

      // Create tracking events for each recipient
      for (const recipientEmail of recipients) {
        await TrackingEvent.createEvent({
          mailId: mail._id,
          trackingId,
          eventType: 'sent',
          senderEmail,
          recipientEmail: recipientEmail.toLowerCase(),
          timestamp: new Date()
        });
      }
    }

    console.log(`✅ Tracking registered [${trackingId}] for ${recipients.length} recipient(s) — ${subject}`);

    res.json({
      success: true,
      mailId: mail._id,
      trackingId,
      trackingPixel,
      message: 'Email tracking enabled'
    });
  } catch (error) {
    console.error('Error in /send:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


// Report email open (called when recipient opens email)
router.post('/report-open', async (req, res) => {
  try {
    const { mailId, trackingId, openedAt, userAgent } = req.body;

    if (!mailId && !trackingId) {
      return res.status(400).json({
        success: false,
        error: 'mailId or trackingId required'
      });
    }

    // Find the mail document
    let mail;
    if (mailId) {
      mail = await Mail.findById(mailId);
    } else if (trackingId) {
      mail = await Mail.findOne({ trackingId });
    }

    if (!mail) {
      return res.status(404).json({
        success: false,
        error: 'Mail not found'
      });
    }

    // Update mail status
    if (!mail.firstOpenedAt) {
      mail.firstOpenedAt = openedAt || new Date();
    }
    mail.lastOpenedAt = openedAt || new Date();
    mail.openCount += 1;
    mail.ticks = 'green';

    // Update recipient status
    const recipientIndex = mail.recipients.findIndex(r => r.email === req.body.recipientEmail);
    if (recipientIndex !== -1) {
      mail.recipients[recipientIndex].status = 'opened';
    }

    await mail.save();

    // Create tracking event
    const trackingEvent = await TrackingEvent.createEvent({
      mailId: mail._id,
      trackingId: mail.trackingId,
      eventType: 'opened',
      senderEmail: mail.senderEmail,
      recipientEmail: req.body.recipientEmail || 'unknown',
      timestamp: openedAt || new Date(),
      openDetails: {
        userAgent: userAgent,
        ipAddress: req.ip
      }
    });

    // Send real-time notification via WebSocket
    const clients = req.app.locals.clients;
    const wss = req.app.locals.wss;

    if (clients.has(mail.senderEmail)) {
      const client = clients.get(mail.senderEmail);
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(JSON.stringify({
          type: 'EMAIL_OPENED',
          mailId: mail._id,
          trackingId: mail.trackingId,
          senderEmail: mail.senderEmail,
          recipientEmail: trackingEvent.recipientEmail,
          openedAt: trackingEvent.timestamp,
          subject: mail.subject
        }));
      }
    }

    // Broadcast to all connected clients
    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.send(JSON.stringify({
          type: 'TRACKING_UPDATE',
          mailId: mail._id,
          status: 'opened',
          recipientEmail: trackingEvent.recipientEmail
        }));
      }
    });

    console.log(`📬 Email opened by ${trackingEvent.recipientEmail}`);

    res.json({
      success: true,
      message: 'Email open recorded',
      mailId: mail._id,
      openCount: mail.openCount
    });
  } catch (error) {
    console.error('Error in /report-open:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Tracking pixel endpoint (1x1 transparent image)
router.get('/pixel/:trackingId', async (req, res) => {
  // Always return pixel first (fast response for email clients)
  const pixel = Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00,
    0x01, 0x00, 0x80, 0x00, 0x00, 0xFF, 0xFF, 0xFF,
    0x00, 0x00, 0x00, 0x21, 0xF9, 0x04, 0x01, 0x0A,
    0x00, 0x01, 0x00, 0x2C, 0x00, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44,
    0x01, 0x00, 0x3B
  ]);

  res.type('image/gif');
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('ngrok-skip-browser-warning', 'true');
  res.send(pixel);

  // Process tracking asynchronously (don't block the pixel response)
  try {
    const { trackingId } = req.params;
    const userAgent = req.get('User-Agent') || '';
    const ipAddress = req.ip;
    const openedAt = new Date();

    // ─── INSTANT MODE (No filters, no shields) ──────────────────────────────
    let mail = await Mail.findOne({ trackingId });

    if (!mail) {
      // Auto-create if not exists (safeguard)
      mail = new Mail({
        trackingId,
        senderEmail: 'unknown@sender.com',
        subject: 'Tracked Email',
        recipients: [{ email: 'recipient@unknown.com', status: 'opened' }],
        ticks: 'green'
      });
    }

    // ─── SIMPLE RELIABLE FILTERING ──────────────────────────────────────────
    const isGoogleProxy = userAgent.includes('GoogleImageProxy') || 
                          userAgent.includes('via ggpht.com');
    
    // Always update DB (Ticks Green)
    if (!mail.firstOpenedAt) mail.firstOpenedAt = openedAt;
    mail.lastOpenedAt = openedAt;
    mail.openCount += 1;
    mail.ticks = 'green'; 
    await mail.save();

    // Notify for EVERYTHING except Google Proxy
    if (!isGoogleProxy) {
      console.log(`📬 OPEN DETECTED! Notifying for ${trackingId}`);
      await TrackingEvent.createEvent({
        mailId: mail._id,
        trackingId,
        eventType: 'opened',
        senderEmail: mail.senderEmail,
        recipientEmail: 'Recipient',
        timestamp: openedAt,
        openDetails: { userAgent, ipAddress }
      });
      
      // ... (WebSocket code follows)
      await TrackingEvent.createEvent({
        mailId: mail._id,
        trackingId,
        eventType: 'opened',
        senderEmail: mail.senderEmail,
        recipientEmail: 'unknown@recipient.com',
        timestamp: openedAt,
        openDetails: { userAgent, ipAddress }
      });

      // Send WebSocket notification to sender
      const clients = req.app.locals.clients;
      const wss = req.app.locals.wss;

      const notification = JSON.stringify({
        type: 'EMAIL_OPENED',
        mailId: mail._id,
        trackingId,
        senderEmail: mail.senderEmail,
        recipientEmail: 'recipient',
        openedAt,
        subject: mail.subject
      });

      // Try to notify the specific sender
      if (clients.has(mail.senderEmail)) {
        const client = clients.get(mail.senderEmail);
        if (client.readyState === 1) client.send(notification);
      }

      // Broadcast to ALL connected clients (catches any logged-in user)
      wss.clients.forEach((client) => {
        if (client.readyState === 1) {
          client.send(JSON.stringify({
            type: 'EMAIL_OPENED',
            mailId: mail._id,
            trackingId,
            openedAt,
            subject: mail.subject
          }));
        }
      });

      console.log(`📬 Instant notification sent! Track ID: ${trackingId}`);
    }

  } catch (error) {
    console.error('Error processing pixel:', error.message);
  }
});


// Get tracking history for a sender
router.get('/history/:senderEmail', async (req, res) => {
  try {
    const { senderEmail } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const mails = await Mail.find({
      senderEmail: senderEmail.toLowerCase()
    })
    .sort({ sentAt: -1 })
    .skip(parseInt(offset))
    .limit(parseInt(limit));

    const total = await Mail.countDocuments({
      senderEmail: senderEmail.toLowerCase()
    });

    res.json({
      success: true,
      data: mails,
      total,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Error in /history:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get detailed tracking info for a mail
router.get('/details/:mailId', async (req, res) => {
  try {
    const { mailId } = req.params;

    const mail = await Mail.findById(mailId);
    if (!mail) {
      return res.status(404).json({
        success: false,
        error: 'Mail not found'
      });
    }

    const events = await TrackingEvent.find({ mailId }).sort({ timestamp: -1 });

    res.json({
      success: true,
      mail,
      events,
      openRate: mail.openRate
    });
  } catch (error) {
    console.error('Error in /details:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;