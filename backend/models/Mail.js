// models/Mail.js - Mail schema for MongoDB

const mongoose = require('mongoose');

const MailSchema = new mongoose.Schema({
  // Basic info
  senderEmail: {
    type: String,
    required: true,
    lowercase: true
  },
  recipients: [{
    email: {
      type: String,
      required: true,
      lowercase: true
    },
    name: String,
    status: {
      type: String,
      enum: ['sent', 'opened', 'clicked', 'bounced'],
      default: 'sent'
    }
  }],
  
  // Email content
  subject: {
    type: String,
    required: true
  },
  body: {
    type: String,
    default: ''
  },
  
  // Tracking info
  trackingId: {
    type: String,
    unique: true,
    sparse: true
  },
  trackingPixel: {
    type: String
  },
  trackingEnabled: {
    type: Boolean,
    default: true
  },
  
  // Ticks/Status
  ticks: {
    type: String,
    enum: ['gray', 'green'],
    default: 'gray'
  },
  
  // Timestamps
  sentAt: {
    type: Date,
    default: Date.now
  },
  firstOpenedAt: Date,
  lastOpenedAt: Date,
  
  // Metadata
  messageId: String,
  threadId: String,
  labels: [String],
  
  // Statistics
  openCount: {
    type: Number,
    default: 0
  },
  clickCount: {
    type: Number,
    default: 0
  },
  
  // IP tracking
  ipAddresses: [{
    ip: String,
    openedAt: Date
  }],
  
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true,
  collection: 'mails'
});

// Index for faster queries
MailSchema.index({ senderEmail: 1, sentAt: -1 });
MailSchema.index({ trackingId: 1 });
MailSchema.index({ 'recipients.email': 1 });

// Virtual for open rate
MailSchema.virtual('openRate').get(function() {
  if (this.recipients.length === 0) return 0;
  const openedCount = this.recipients.filter(r => r.status === 'opened').length;
  return Math.round((openedCount / this.recipients.length) * 100);
});

// Pre-save middleware to update timestamps
MailSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Mail', MailSchema);