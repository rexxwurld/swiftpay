// src/modules/recipient/recipient.model.js
const mongoose = require('mongoose');

const recipientSchema = new mongoose.Schema(
  {
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },
    recipientCode: { type: String, required: true, unique: true }, // e.g. rcp_xxxxx, referenced at payout time

    label: { type: String, required: true }, // merchant's own name for this recipient, e.g. "Jane - Payroll"
    bankCode: { type: String, required: true },
    accountNumber: { type: String, required: true },
    accountName: { type: String, required: true },

    // A recipient is not payable (see payout.service.js) until verified.
    // 'provider' means resolveBankAccount() confirmed the account name
    // against the bank at creation time and accountName above was
    // overwritten with the provider's own value (never the merchant's
    // unverified input). 'admin' means the provider lookup was
    // unavailable and an operator confirmed the details out of band -
    // see PATCH /api/admin/recipients/:id/verify. This mirrors
    // merchant.settlementAccount's verified/verifiedAt fields.
    verified: { type: Boolean, default: false },
    verifiedAt: { type: Date, default: null },
    verificationMethod: { type: String, enum: ['provider', 'admin', null], default: null },

    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Recipient', recipientSchema);
