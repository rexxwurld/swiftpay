// src/modules/webhook/webhookEvent.model.js
//
// The raw webhook is persisted BEFORE we try to act on it. If processing
// then throws (DB blip, bug, downstream call failing), the event is still
// safely on disk and can be retried.

const mongoose = require('mongoose');

const webhookEventSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      default: 'bank_partner',
    },

    providerEventId: {
      type: String,
      required: true,
    },

    rawBody: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },

    signature: {
      type: String,
    },

    status: {
      type: String,
      enum: ['queued', 'processing', 'processed', 'failed'],
      default: 'queued',
      index: true,
    },

    attempts: {
      type: Number,
      default: 0,
    },

    lastError: {
      type: String,
    },
    processingStartedAt: {
      type: Date,
    },

    processedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Prevent the same provider event from being persisted twice.
webhookEventSchema.index(
  { source: 1, providerEventId: 1 },
  { unique: true }
);

module.exports = mongoose.model('WebhookEvent', webhookEventSchema);
