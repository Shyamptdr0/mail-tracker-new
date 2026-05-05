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
        senderEmail: senderEmail.toLowerCase(),
        senderIp: req.ip,
        senderUa: req.get('User-Agent') || '',
        subject: subject || '(no subject)',
        recipients: recipients.map(email => ({
          email: email.toLowerCase(),
          status: 'sent'
        })),
        trackingId,
        trackingPixel,
        sentAt: sentAt || new Date(),
        ticks: 'gray'
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

// Get current status for a mail (for initial tick display)
router.get('/status', async (req, res) => {
  try {
    const { threadId, recipient } = req.query;
    let query = {};
    
    // Primary lookup by Thread ID (100% Accurate)
    if (threadId) {
      query.threadId = threadId;
    } else if (recipient) {
      // Fallback for older mails
      query['recipients.email'] = recipient;
    }

    const mail = await Mail.findOne(query).sort({ sentAt: -1 });
    
    if (mail) {
      res.json({ 
        success: true, 
        ticks: mail.ticks, 
        openCount: mail.openCount,
        trackingId: mail.trackingId 
      });
    } else {
      res.json({ success: false });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Tracking pixel endpoint (1x1 transparent image)
router.get('/pixel/:trackingId', async (req, res) => {
  // Always return pixel first (fast response for email clients)
  // Return 1x1 transparent PNG
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-cache, max-age=0');
  res.send(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));

  try {
    const { trackingId } = req.params;
    const userAgent = req.get('User-Agent') || '';
    const ipAddress = req.ip;
    const openedAt = new Date();

    // ─── INSTANT LOOKUP WITH RETRY ─────────────────────────────────────────
    let mail = await Mail.findOne({ trackingId });
    
    // If not found, it might be a race condition (pixel hit before register)
    if (!mail) {
      for (let i = 0; i < 3; i++) {
        console.log(`⏳ Retry ${i+1}: Waiting for mail record ${trackingId}...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        mail = await Mail.findOne({ trackingId });
        if (mail) break;
      }
    }

    if (!mail) return;

    // ─── HARDER FILTERING ──────────────────────────────────────────────────
    const isBot = userAgent.includes('GoogleImageProxy') || 
                  userAgent.includes('via ggpht.com') ||
                  userAgent.includes('Google-Proxy') ||
                  userAgent.includes('GmailImageProxy') ||
                  userAgent.includes('Bot') ||
                  userAgent.includes('Crawl');
    
    // Shield removed for instant testing

    // ─── SELF-OPEN SUPPRESSION ─────────────────────────────────────────────
    // If the hit matches the sender's IP and UA, it's likely a self-open
    const isSelfOpen = mail.senderIp === ipAddress && mail.senderUa === userAgent;
    
    if (isSelfOpen) {
      console.log(`🏠 SELF-OPEN: Ignored hit from sender's own device for ${trackingId}`);
      return;
    }

    // ─── DEVICE DETECTION ──────────────────────────────────────────────────
    let device = 'Desktop';
    if (/android|iphone|ipad|ipod|mobile/i.test(userAgent)) {
      device = 'Mobile';
    } else if (/macintosh|mac os x/i.test(userAgent)) {
      device = 'Mac';
    } else if (/windows/i.test(userAgent)) {
      device = 'Windows';
    }

    // Always update DB
    if (!mail.firstOpenedAt) mail.firstOpenedAt = openedAt;
    mail.lastOpenedAt = openedAt;
    mail.openCount += 1;
    mail.ticks = 'green'; 
    await mail.save();

    // 2. Notify only if NOT a bot
    if (!isBot) {
      const recipientEmail = mail.recipients && mail.recipients.length > 0 ? mail.recipients[0].email : 'Recipient';
      console.log(`📬 GENUINE OPEN: Notifying for ${trackingId} (Device: ${device})`);
      
      await TrackingEvent.createEvent({
        mailId: mail._id,
        trackingId,
        eventType: 'opened',
        senderEmail: mail.senderEmail,
        recipientEmail: recipientEmail,
        timestamp: openedAt,
        openDetails: { userAgent, ipAddress, device }
      });

      const notificationData = {
        type: 'EMAIL_OPENED_UPDATE',
        mailId: mail._id,
        trackingId,
        senderEmail: mail.senderEmail,
        recipientEmail: recipientEmail,
        openedAt,
        subject: mail.subject,
        device: device
      };
      const notificationString = JSON.stringify(notificationData);

      // WebSocket services
      const clients = req.app.locals.clients;
      const wss = req.app.locals.wss;

      if (clients && clients.has(mail.senderEmail)) {
        const client = clients.get(mail.senderEmail);
        if (client.readyState === 1) client.send(notificationString);
      }

      if (wss) {
        wss.clients.forEach((client) => {
          if (client.readyState === 1) client.send(notificationString);
        });
      }
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