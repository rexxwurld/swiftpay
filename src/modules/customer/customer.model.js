// src/modules/customer/customer.model.js
const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema(
  {
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },
    fullName: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String },
    // Reference to the virtual account assigned to this customer (if any).
    virtualAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'VirtualAccount', default: null },
  },
  { timestamps: true }
);

// A merchant shouldn't have two customer records with the same email
customerSchema.index({ merchant: 1, email: 1 }, { unique: true });

module.exports = mongoose.model('Customer', customerSchema);
