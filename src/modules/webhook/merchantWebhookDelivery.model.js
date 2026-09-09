const mongoose = require('mongoose');

const merchantWebhookDeliverySchema = new mongoose.Schema(
  {
    merchant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Merchant',
      required: true,
      index: true,
    },

    eventType: {
      type: String,
      required: true,
    },

    // The exact body that will be sent to the merchant.
    rawBody: {
      type: String,
      required: true,
    },

    signature: {
      type: String,
      required: true,
    },

    eventId: {
      type: String,
      required: true,
    },

    webhookUrl: {
      type: String,
      required: true,
    },

    status: {
      type: String,
      enum: ['pending', 'delivering', 'delivered', 'failed'],
      default: 'pending',
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

    nextAttemptAt: {
      type: Date,
    },

    deliveredAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model(
  'MerchantWebhookDelivery',
  merchantWebhookDeliverySchema
);
