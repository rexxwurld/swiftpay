// src/modules/webhook/webhookEvent.model.js
//
// The raw webhook is persisted BEFORE we try to act on it. If processing
// then throws (DB blip, bug, downstream call failing), the event is still
// safely on disk with status 'failed' and can be retried - instead of
// being lost because it only ever existed in a request's memory.
//
// In production this collection would typically be backed by a real queue
// (SQS, BullMQ + Redis, etc.) rather than polled from Mongo - see
// webhook.processor.js for where that swap happens.

const mongoose = require('mongoose');

const webhookEventSchema = new mongoose.Schema(
  {
    source: { type: String, default: 'bank_partner' },
    providerEventId: {
  type: String,
  required: true
},
    rawBody: { type: mongoose.Schema.Types.Mixed, required: true },
    signature: { type: String },

    status: {
      type: String,
      enum: ['queued', 'processing', 'processed', 'failed'],
      default: 'queued',
      index: true,
    },
    attempts: { type: Number, default: 0 },
    lastError: { type: String },
    processedAt: { type: Date },
  },
  { timestamps: true }
  webhookEventSchema.index(
  { source: 1, providerEventId: 1 },
  { unique: true }
);
);

module.exports = mongoose.model('WebhookEvent', webhookEventSchema);
