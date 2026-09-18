// src/modules/customer/customer.service.js
const Customer = require('./customer.model');

async function createCustomer({ merchantId, fullName, email, phone }) {
  const existing = await Customer.findOne({ merchant: merchantId, email });
  if (existing) return existing; // idempotent: same merchant + email returns the same customer

  return Customer.create({ merchant: merchantId, fullName, email, phone });
}

async function listCustomers(merchantId) {
  return Customer.find({ merchant: merchantId }).populate('virtualAccount');
}

module.exports = { createCustomer, listCustomers };
