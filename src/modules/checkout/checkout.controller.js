const Checkout = require('./checkout.model');
const Transaction = require('../transaction/transaction.model');
const { simulateBankTransfer } = require('../mockBank/mockBank.service');

async function getStatus(req, res) {
  try {
    const { token } = req.params;

    const checkout = await Checkout.findOne({ token });

    if (!checkout) {
      return res.status(404).json({
        status: false,
        message: 'checkout_not_found',
      });
    }

    const latestTransaction = await Transaction.findOne({
      virtualAccount: checkout.virtualAccount,
    }).sort({
      createdAt: -1,
    });

    let paymentStatus = latestTransaction?.status || 'pending';

    // If payment already happened, retain that result even if
    // the virtual account has already been returned to the pool.
    if (
      latestTransaction &&
      ['success', 'over', 'flagged', 'failed', 'partial'].includes(
        latestTransaction.status
      )
    ) {
      paymentStatus = latestTransaction.status;
    }

    // Checkout expired only if payment hasn't already completed.
    if (
      !latestTransaction &&
      Date.now() > checkout.expiresAt.getTime()
    ) {
      return res.status(410).json({
        status: false,
        message: 'checkout_expired',
      });
    }

    return res.json({
      status: true,

      data: {
        // Deliberately NOT returning:
        // merchant ID
        // tx_ref
        // redirectUrl
        // customer email
        // customer phone
        // API keys
        // MongoDB IDs

        accountNumber: checkout.accountNumber,
        bankName: checkout.bankName,
        amountExpected: checkout.amountExpected,

        // Lets pay.html decide whether to show the "simulate transfer"
        // button - only ever true for a test-mode checkout, never live.
        mode: checkout.mode,

        paymentStatus,

        amountReceived:
          latestTransaction?.amountReceived ?? null,
      },
    });
  } catch (err) {
    console.error('[checkout] status error:', err);

    return res.status(500).json({
      status: false,
      message: 'checkout_status_failed',
    });
  }
}


// Lets a visitor on the hosted pay.html page complete a TEST-mode
// checkout themselves, since no real bank webhook will ever arrive for
// a fake test account number. Public like getStatus/complete above -
// the unguessable checkout token is the auth, same trust model already
// used for this whole route file. simulateBankTransfer independently
// re-checks the account is mode:'test' before doing anything, so even a
// bug here can't touch a live checkout.
async function simulate(req, res) {
  try {
    const { token } = req.params;

    const checkout = await Checkout.findOne({ token });

    if (!checkout) {
      return res.status(404).json({
        status: false,
        message: 'checkout_not_found',
      });
    }

    if (checkout.mode !== 'test') {
      return res.status(403).json({
        status: false,
        message: 'simulate_only_available_for_test_mode_checkouts',
      });
    }

    if (Date.now() > checkout.expiresAt.getTime()) {
      return res.status(410).json({
        status: false,
        message: 'checkout_expired',
      });
    }

    const result = await simulateBankTransfer({
      accountNumber: checkout.accountNumber,
    });

    return res.json({
      status: true,
      data: {
        paymentStatus: result.transaction?.status || 'pending',
      },
    });
  } catch (err) {
    console.error('[checkout] simulate error:', err);

    return res.status(400).json({
      status: false,
      message: err.message,
    });
  }
}


// This endpoint performs the merchant redirect server-side.
// The redirect URL is never supplied by the browser.
async function complete(req, res) {
  try {
    const { token } = req.params;

    const checkout = await Checkout.findOne({ token });

    if (!checkout) {
      return res.status(404).send('Checkout not found');
    }

    const transaction = await Transaction.findOne({
      virtualAccount: checkout.virtualAccount,
    }).sort({
      createdAt: -1,
    });

    if (!transaction) {
      return res.status(409).send('Payment has not been confirmed');
    }

    if (transaction.status === 'flagged') {
      return res.status(409).send('Payment is under review');
    }

    if (!['success', 'over'].includes(transaction.status)) {
      return res.status(409).send('Payment is not successful');
    }

    // If merchant didn't provide a redirect URL,
    // just show a simple success response.
    if (!checkout.redirectUrl) {
      return res.send(`
        <!doctype html>
        <html>
          <head>
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <title>Payment Successful</title>
          </head>
          <body style="font-family:Arial;text-align:center;padding:60px">
            <h2>Payment successful</h2>
            <p>Your payment has been received.</p>
          </body>
        </html>
      `);
    }

    const redirect = new URL(checkout.redirectUrl);

    // These are generated by SwiftPay.
    // Merchant cannot manipulate them through the checkout page.
    redirect.searchParams.set(
      'tx_ref',
      checkout.txRef
    );

    redirect.searchParams.set(
      'status',
      'successful'
    );

    return res.redirect(303, redirect.toString());
  } catch (err) {
    console.error('[checkout] complete error:', err);

    return res.status(500).send(
      'Unable to complete checkout'
    );
  }
}

module.exports = {
  getStatus,
  simulate,
  complete,
};
