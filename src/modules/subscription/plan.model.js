// src/modules/subscription/plan.model.js
const mongoose = require('mongoose');
const { nanoid } = require('nanoid');

const planSchema = new mongoose.Schema(
  {
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },
    planCode: { type: String, required: true, unique: true, default: () => `plan_${nanoid(12)}` },
    name: { type: String, required: true },
    amount: { type: Number, required: true }, // minor units, charged each interval
    currency: { type: String, required: true, default: 'NGN' },

    // Which world this plan lives in - set once at creation from the API
    // key used to create it, never changes. A plan created with a live
    // secret key must only ever generate live invoices/virtual accounts;
    // otherwise a production billing job could silently create test-mode
    // (fake) virtual accounts that a real customer's bank transfer would
    // never actually reach (see audit report, High #11).
    mode: { type: String, enum: ['test', 'live'], required: true },

    interval: {
      type: String,
      enum: ['daily', 'weekly', 'monthly', 'yearly'],
      required: true,
    },
    // e.g. interval='monthly', intervalCount=3 -> billed every 3 months
    intervalCount: { type: Number, default: 1, min: 1 },

    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

planSchema.index({ merchant: 1, active: 1 });

module.exports = mongoose.model('Plan', planSchema);
