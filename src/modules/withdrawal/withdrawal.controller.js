const { requestWithdrawal, listForMerchant, getForMerchant } = require('./withdrawal.service');

async function create(req, res) {
  try {
    if (!['test', 'live'].includes(req.merchant.mode)) return res.status(401).json({ status: false, message: 'api_key_required_for_withdrawals' });
    const withdrawal = await requestWithdrawal({
      merchantId: req.merchant.id,
      amount: req.body.amount,
      currency: req.body.currency,
      idempotencyKey: req.headers['idempotency-key'] || req.body.idempotencyKey || null,
      mode: req.merchant.mode,
    });
    return res.status(201).json({ status: true, data: withdrawal });
  } catch (err) { return res.status(400).json({ status: false, message: err.message }); }
}

async function list(req, res) {
  try {
    const mode = req.merchant.mode || (req.query.mode === 'live' ? 'live' : 'test');
    return res.json({ status: true, data: await listForMerchant(req.merchant.id, mode) });
  } catch (err) { return res.status(500).json({ status: false, message: err.message }); }
}

async function getOne(req, res) {
  try { return res.json({ status: true, data: await getForMerchant(req.merchant.id, req.params.id) }); }
  catch (err) { return res.status(404).json({ status: false, message: err.message }); }
}

module.exports = { create, list, getOne };
