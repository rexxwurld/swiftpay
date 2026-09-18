// src/modules/subscription/subscription.model.js
const mongoose = require('mongoose');
const { nanoid } = require('nanoid');

const subscriptionSchema = new mongoose.Schema(
  {
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    plan: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', required: true },
    // Copied from plan.mode at subscribe time - see plan.model.js.
    mode: { type: String, enum: ['test', 'live'], required: true },
    subscriptionCode: { type: String, required: true, unique: true, default: () => `sub_${nanoid(14)}` },

    status: {
      type: String,
      // 'past_due' means the most recent invoice wasn't paid by its due
      // date - still active, one missed cycle. 'cancelled' is terminal.
      enum: ['active', 'past_due', 'cancelled'],
      default: 'active',
    },

    currentPeriodStart: { type: Date, required: true },
    currentPeriodEnd: { type: Date, required: true },
    nextBillingDate: { type: Date, required: true },

    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

subscriptionSchema.index({ merchant: 1, status: 1 });
subscriptionSchema.index({ nextBillingDate: 1, status: 1 }); // for the invoice-generation sweep

module.exports = mongoose.model('Subscription', subscriptionSchema);
