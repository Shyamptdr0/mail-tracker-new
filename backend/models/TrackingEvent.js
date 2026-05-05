// models/TrackingEvent.js - Tracking events schema

const mongoose = require('mongoose');

const TrackingEventSchema = new mongoose.Schema({
  // Reference to mail
  mailId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Mail',
    required: true
  },
  
  // Tracking details
  trackingId: {
    type: String,
    required: true
  },
  
  // Event type
  eventType: {
    type: String,
    enum: ['sent', 'opened', 'clicked', 'bounced', 'failed'],
    required: true
  },
  
  // Email addresses
  senderEmail: {
    type: String,
    required: true,
    lowercase: true
  },
  recipientEmail: {
    type: String,
    required: true,
    lowercase: true
  },
  
  // Event details
  timestamp: {
    type: Date,
    default: Date.now
  },
  
  // Open event details
  openDetails: {
    userAgent: String,
    ipAddress: String,
    country: String,
    city: String,
    device: String,
    browser: String,
    os: String
  },
  
  // Click tracking
  clickUrl: String,
  clickedAt: Date,
  
  // Error details
  errorMessage: String,
  errorCode: String,
  
  // Custom metadata
  metadata: {
    type: Map,
    of: String
  },
  
  // Flag for real-time update sent
  realTimeNotified: {
    type: Boolean,
    default: false
  },
  
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
    expires: 2592000 // Auto-delete after 30 days
  }
}, {
  timestamps: true,
  collection: 'tracking_events'
});

// Indexes for performance
TrackingEventSchema.index({ trackingId: 1 });
TrackingEventSchema.index({ mailId: 1 });
TrackingEventSchema.index({ senderEmail: 1, timestamp: -1 });
TrackingEventSchema.index({ recipientEmail: 1 });
TrackingEventSchema.index({ eventType: 1 });
TrackingEventSchema.index({ timestamp: -1 });

// Static method to create event
TrackingEventSchema.statics.createEvent = async function(data) {
  try {
    const event = new this(data);
    await event.save();
    return event;
  } catch (error) {
    throw error;
  }
};

// Static method to get stats
TrackingEventSchema.statics.getStats = async function(senderEmail, days = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const stats = await this.aggregate([
    {
      $match: {
        senderEmail: senderEmail,
        timestamp: { $gte: startDate }
      }
    },
    {
      $group: {
        _id: '$eventType',
        count: { $sum: 1 }
      }
    }
  ]);

  return stats;
};

// Virtual for readable timestamp
TrackingEventSchema.virtual('readableTime').get(function() {
  return this.timestamp.toLocaleString();
});

module.exports = mongoose.model('TrackingEvent', TrackingEventSchema);