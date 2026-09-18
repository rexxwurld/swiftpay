// src/modules/bankPartner/bankPartner.model.js
// Represents a partner bank (like Wema, Titan Trust, Providus for Paystack).
// In real life you never touch their core banking system directly - you
// call their API. Here we simulate that partner locally.

const mongoose = require('mongoose');

const bankPartnerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true }, // e.g. "Wema Bank"
    slug: { type: String, required: true, unique: true }, // e.g. "wema-bank"
  },
  { timestamps: true }
);

module.exports = mongoose.model('BankPartner', bankPartnerSchema);
