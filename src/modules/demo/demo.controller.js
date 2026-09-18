// src/modules/demo/demo.controller.js
const { startDemoCheckout } = require('./demo.service');

async function startCheckout(req, res) {
  try {
    const { amount, name, email, phone } = req.body;
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const result = await startDemoCheckout({ amount, name, email, phone, baseUrl });
    res.status(201).json({ status: true, data: result });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

module.exports = { startCheckout };
