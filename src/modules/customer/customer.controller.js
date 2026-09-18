// src/modules/customer/customer.controller.js
const { createCustomer, listCustomers } = require('./customer.service');

async function create(req, res) {
  try {
    const { fullName, email, phone } = req.body;
    const customer = await createCustomer({ merchantId: req.merchant.id, fullName, email, phone });
    res.status(201).json({ status: true, data: customer });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

async function list(req, res) {
  const customers = await listCustomers(req.merchant.id);
  res.json({ status: true, data: customers });
}

module.exports = { create, list };
