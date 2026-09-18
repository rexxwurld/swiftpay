// src/modules/recipient/recipient.routes.js
const express = require('express');
const router = express.Router();
const { requireApiKey } = require('../../middleware/auth.middleware');
const { create, list, getOne, deactivate } = require('./recipient.controller');

router.post('/', requireApiKey, create);
router.get('/', requireApiKey, list);
router.get('/:id', requireApiKey, getOne);
router.delete('/:id', requireApiKey, deactivate);

module.exports = router;
