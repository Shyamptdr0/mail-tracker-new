// routes/mails.js - Mail management routes

const express = require('express');
const router = express.Router();
const Mail = require('../models/Mail');

// Get all mails for a user
router.get('/user/:userEmail', async (req, res) => {
  try {
    const { userEmail } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const mails = await Mail.find({
      senderEmail: userEmail.toLowerCase()
    })
    .sort({ sentAt: -1 })
    .skip(parseInt(offset))
    .limit(parseInt(limit))
    .lean();

    const total = await Mail.countDocuments({
      senderEmail: userEmail.toLowerCase()
    });

    res.json({
      success: true,
      data: mails,
      total,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Error fetching mails:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get mail by ID
router.get('/:mailId', async (req, res) => {
  try {
    const mail = await Mail.findById(req.params.mailId);

    if (!mail) {
      return res.status(404).json({
        success: false,
        error: 'Mail not found'
      });
    }

    res.json({
      success: true,
      data: mail
    });
  } catch (error) {
    console.error('Error fetching mail:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get mails with filter
router.post('/filter', async (req, res) => {
  try {
    const {
      senderEmail,
      recipientEmail,
      status,
      dateFrom,
      dateTo,
      limit = 50,
      offset = 0
    } = req.body;

    const filter = {};

    if (senderEmail) {
      filter.senderEmail = senderEmail.toLowerCase();
    }

    if (status) {
      filter['recipients.status'] = status;
    }

    if (recipientEmail) {
      filter['recipients.email'] = recipientEmail.toLowerCase();
    }

    if (dateFrom || dateTo) {
      filter.sentAt = {};
      if (dateFrom) {
        filter.sentAt.$gte = new Date(dateFrom);
      }
      if (dateTo) {
        filter.sentAt.$lte = new Date(dateTo);
      }
    }

    const mails = await Mail.find(filter)
      .sort({ sentAt: -1 })
      .skip(offset)
      .limit(limit)
      .lean();

    const total = await Mail.countDocuments(filter);

    res.json({
      success: true,
      data: mails,
      total,
      filter
    });
  } catch (error) {
    console.error('Error filtering mails:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get statistics
router.get('/stats/:userEmail', async (req, res) => {
  try {
    const { userEmail } = req.params;
    const { days = 30 } = req.query;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    const mails = await Mail.find({
      senderEmail: userEmail.toLowerCase(),
      sentAt: { $gte: startDate }
    });

    const stats = {
      totalMails: mails.length,
      totalRecipients: mails.reduce((sum, mail) => sum + mail.recipients.length, 0),
      opened: mails.reduce((sum, mail) => sum + mail.recipients.filter(r => r.status === 'opened').length, 0),
      unopened: mails.reduce((sum, mail) => sum + mail.recipients.filter(r => r.status === 'sent').length, 0),
      avgOpenRate: 0,
      openedByDay: {}
    };

    if (stats.totalRecipients > 0) {
      stats.avgOpenRate = Math.round((stats.opened / stats.totalRecipients) * 100);
    }

    // Calculate opens by day
    mails.forEach((mail) => {
      if (mail.firstOpenedAt) {
        const day = mail.firstOpenedAt.toISOString().split('T')[0];
        stats.openedByDay[day] = (stats.openedByDay[day] || 0) + 1;
      }
    });

    res.json({
      success: true,
      stats,
      period: `Last ${days} days`
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Mark mail as read/opened manually
router.put('/:mailId/mark-opened', async (req, res) => {
  try {
    const mail = await Mail.findByIdAndUpdate(
      req.params.mailId,
      {
        ticks: 'green',
        firstOpenedAt: req.body.openedAt || new Date()
      },
      { new: true }
    );

    if (!mail) {
      return res.status(404).json({
        success: false,
        error: 'Mail not found'
      });
    }

    res.json({
      success: true,
      data: mail
    });
  } catch (error) {
    console.error('Error updating mail:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Delete mail
router.delete('/:mailId', async (req, res) => {
  try {
    const mail = await Mail.findByIdAndDelete(req.params.mailId);

    if (!mail) {
      return res.status(404).json({
        success: false,
        error: 'Mail not found'
      });
    }

    // Also delete tracking events
    const TrackingEvent = require('../models/TrackingEvent');
    await TrackingEvent.deleteMany({ mailId: req.params.mailId });

    res.json({
      success: true,
      message: 'Mail and tracking events deleted'
    });
  } catch (error) {
    console.error('Error deleting mail:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Batch delete mails
router.post('/delete-batch', async (req, res) => {
  try {
    const { mailIds } = req.body;

    if (!Array.isArray(mailIds)) {
      return res.status(400).json({
        success: false,
        error: 'mailIds must be an array'
      });
    }

    const result = await Mail.deleteMany({
      _id: { $in: mailIds }
    });

    // Also delete tracking events
    const TrackingEvent = require('../models/TrackingEvent');
    await TrackingEvent.deleteMany({
      mailId: { $in: mailIds }
    });

    res.json({
      success: true,
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error('Error batch deleting mails:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Export for use in server.js
module.exports = router;