// src/modules/merchant/merchant.routes.js
const express = require('express');
const router = express.Router();
const { requireApiKey } = require('../../middleware/auth.middleware');
const multer = require('multer');
const { authLimiter } = require('../../middleware/rateLimit.middleware');
const { profile, updateWebhook, regenerateKey, regenerateWebhook, updateSettlementAccount, sessionOnly, kycStatus, kycUpload, kycSubmit } = require('./merchant.controller');

// In-memory (max 5 MB, one file). The file is validated by magic bytes in
// the service and goes straight to private R2 storage - never to local disk.
const uploadOne = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 4 } }).single('file');
function handleUpload(req, res, next) {
  uploadOne(req, res, (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'file_too_large' : 'invalid_upload';
      return res.status(400).json({ status: false, message });
    }
    next();
  });
}

router.get('/me', requireApiKey, profile);
router.patch('/webhook-url', requireApiKey, updateWebhook);
router.patch('/settlement-account', requireApiKey, updateSettlementAccount);
router.get('/kyc', requireApiKey, sessionOnly, kycStatus);
router.post('/kyc/documents', authLimiter, requireApiKey, sessionOnly, handleUpload, kycUpload);
router.post('/kyc/submit', authLimiter, requireApiKey, sessionOnly, kycSubmit);
router.post('/regenerate-key', requireApiKey, regenerateKey);
router.post('/regenerate-webhook-secret', requireApiKey, regenerateWebhook);

module.exports = router;
