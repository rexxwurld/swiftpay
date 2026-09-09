// src/modules/merchant/merchant.controller.js
const { getProfile, updateWebhookUrl, regenerateSecretKey, regenerateWebhookSecret } = require('./merchant.service');

async function profile(req, res) {
  const merchant = await getProfile(req.merchant.id);
  res.json({ status: true, data: merchant });
}

async function updateWebhook(req, res) {
  try {
    const { webhookUrl } = req.body;
    const merchant = await updateWebhookUrl(req.merchant.id, webhookUrl);
    res.json({ status: true, data: merchant });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

async function regenerateKey(req, res) {
  try {
    const { mode } = req.body;
    const result = await regenerateSecretKey(req.merchant.id, mode);
    res.json({
      status: true,
      message: `New ${mode} secret key generated. Store it now - it will not be shown again. Your old ${mode} key no longer works.`,
      data: result,
    });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

async function regenerateWebhook(req, res) {
  try {
    const result = await regenerateWebhookSecret(req.merchant.id);
    res.json({
      status: true,
      message: 'New webhook secret generated. Store it now - it will not be shown again. Any webhook already in flight will fail signature verification until you update your receiving app with this value.',
      data: result,
    });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

module.exports = { profile, updateWebhook, regenerateKey, regenerateWebhook };
