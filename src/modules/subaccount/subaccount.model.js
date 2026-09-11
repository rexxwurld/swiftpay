// src/modules/subaccount/subaccount.model.js
//
// A Subaccount is a sub-merchant a parent Merchant can automatically
// route a percentage of an incoming payment to (Paystack-style split
// payments). It is NOT a Merchant - it has no login, no API keys, no
// wallet. Its accumulated share lives in the ledger only
// (accountType: 'subaccount_settlement', accountRef: subaccount._id)
// until the parent merchant settles it out to the subaccount's own
// bank account.

const mongoose = require('mongoose');

const subaccountSchema = new mongoose.Schema(
  {
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },
    subaccountCode: { type: String, required: true, unique: true }, // e.g. sub_xxxxx, referenced at checkout time

    businessName: { type: String, required: true },

    settlementBankCode: { type: String, required: true },
    settlementAccountNumber: { type: String, required: true },
    settlementAccountName: { type: String, required: true },

    // Used when a checkout doesn't specify an explicit splitPercentage.
    defaultSplitPercentage: { type: Number, min: 1, max: 100, default: null },

    active: { type: Boolean, default: true },
    settlementVersion: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Subaccount', subaccountSchema);
