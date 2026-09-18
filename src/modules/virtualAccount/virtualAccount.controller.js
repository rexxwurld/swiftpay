const {
  assignVirtualAccount,
  deactivateVirtualAccount,
  findByAccountNumberForMerchant,
} = require('./virtualAccount.service');

async function assign(req, res) {
  try {
    const {
      customerId,
      preferredBankSlug,
      amount,
      reference,
      subaccountCode,
      splitPercentage,
    } = req.body;

    const result = await assignVirtualAccount({
      merchantId: req.merchant.id,
      customerId,
      preferredBankSlug,
      amount,
      reference,
      subaccountCode,
      splitPercentage,
    });

    res.status(201).json({
      status: true,
      data: result.account,
    });
  } catch (err) {
    res.status(400).json({
      status: false,
      message: err.message,
    });
  }
}


async function deactivate(req, res) {
  try {
    const account =
      await deactivateVirtualAccount({
        merchantId: req.merchant.id,
        accountNumber: req.params.accountNumber,
      });

    res.json({
      status: true,
      data: account,
    });
  } catch (err) {
    res.status(400).json({
      status: false,
      message: err.message,
    });
  }
}


async function fetchOne(req, res) {
  const account =
    await findByAccountNumberForMerchant(
      req.merchant.id,
      req.params.accountNumber
    );

  if (!account) {
    return res.status(404).json({
      status: false,
      message: 'account_not_found',
    });
  }

  res.json({
    status: true,
    data: account,
  });
}


module.exports = {
  assign,
  deactivate,
  fetchOne,
};
