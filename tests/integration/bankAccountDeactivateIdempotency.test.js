// tests/integration/bankAccountDeactivateIdempotency.test.js
//
// Covers a real production bug this codebase's own README had logged
// before this audit session: deactivating a live virtual account's
// RexxPay Bank pool account sometimes 404s, with no confirmed root
// cause (no access to RexxPay Bank's own logs/source to verify it
// directly). Working hypothesis, documented in
// bankPartner.service.js#syncBankAccountStatus: RexxPay Bank may already
// transition/reclaim a pool account server-side once a deposit lands on
// it, so by the time SwiftPay's own deactivate call arrives, the account
// is already gone/deactivated - a 404 that means "already done", not
// "failed". Fixed by treating a 404 specifically on the `deactivate`
// action as an idempotent success. Explicitly NOT applied to other
// actions (assign/release), which still treat 404 as a real failure -
// this test also proves that scoping holds.
//
// Mocks axios directly since this is the one live-mode (mode:'live')
// path being exercised - everything else in this test suite sticks to
// mode:'test' specifically to avoid needing to mock the bank client at
// all.

const mongoose = require('mongoose');
const { startTestDb, stopTestDb, clearTestDb } = require('./setup');

jest.mock('axios');
const axios = require('axios');

jest.setTimeout(30000);

let Merchant, Customer, BankPartner, VirtualAccount;
let deactivateVirtualAccount;
let deactivateBankPoolAccount, releaseBankPoolAccount;

beforeAll(async () => {
  await startTestDb();

  Merchant = require('../../src/modules/merchant/merchant.model');
  Customer = require('../../src/modules/customer/customer.model');
  BankPartner = require('../../src/modules/bankPartner/bankPartner.model');
  VirtualAccount = require('../../src/modules/virtualAccount/virtualAccount.model');

  ({ deactivateVirtualAccount } = require('../../src/modules/virtualAccount/virtualAccount.service'));
  ({ deactivateBankPoolAccount, releaseBankPoolAccount } = require('../../src/modules/bankPartner/bankPartner.service'));
});

afterAll(async () => {
  await stopTestDb();
});

afterEach(async () => {
  await clearTestDb();
  jest.clearAllMocks();
});

function make404Error() {
  const err = new Error('Request failed with status code 404');
  err.response = { status: 404, data: { message: 'not_found' } };
  return err;
}

function make500Error() {
  const err = new Error('Request failed with status code 500');
  err.response = { status: 500, data: { message: 'internal_error' } };
  return err;
}

describe('deactivate is idempotent on a 404 from RexxPay Bank', () => {
  it('deactivateBankPoolAccount resolves (does not throw) on a 404', async () => {
    axios.patch.mockRejectedValueOnce(make404Error());

    const result = await deactivateBankPoolAccount('1074337293');
    expect(result.success).toBe(true);
    expect(result.alreadyDeactivated).toBe(true);
  });

  it('a 500 on deactivate still throws as a real (ambiguous) failure - only 404 is treated as idempotent', async () => {
    axios.patch.mockRejectedValueOnce(make500Error());

    await expect(deactivateBankPoolAccount('1074337293')).rejects.toMatchObject({
      code: 'BANK_ACCOUNT_SYNC_FAILED',
      ambiguousOutcome: true,
    });
  });

  it('a 404 on release (a different action) is NOT treated as idempotent - the fix is scoped to deactivate only', async () => {
    axios.patch.mockRejectedValueOnce(make404Error());

    await expect(releaseBankPoolAccount('1074337293')).rejects.toMatchObject({
      code: 'BANK_ACCOUNT_SYNC_FAILED',
      status: 404,
      ambiguousOutcome: false, // a definite 404, not a timeout/5xx
    });
  });

  it('deactivateVirtualAccount completes successfully end-to-end when RexxPay 404s the deactivate call', async () => {
    const suffix = new mongoose.Types.ObjectId().toString();
    const merchant = await Merchant.create({
      businessName: 'Test Merchant',
      email: `merchant_${suffix}@example.com`,
      passwordHash: 'not_a_real_hash',
      testPublicKey: `pk_test_${suffix}`,
      testSecretKeyHash: `hash_test_${suffix}`,
      livePublicKey: `pk_live_${suffix}`,
      liveSecretKeyHash: `hash_live_${suffix}`,
    });
    const bank = await BankPartner.create({ name: 'RexxPay Bank', slug: 'rexxpay-bank' });
    const customer = await Customer.create({ merchant: merchant._id, fullName: 'Cust', email: `cust_${suffix}@example.com` });
    const account = await VirtualAccount.create({
      accountNumber: '1074337293',
      bank: bank._id,
      merchant: merchant._id,
      customer: customer._id,
      mode: 'live', // the fix only matters for live accounts - test-mode never calls RexxPay Bank at all
      status: 'assigned',
      assignedAt: new Date(),
    });
    await Customer.updateOne({ _id: customer._id }, { virtualAccount: account._id });

    axios.patch.mockRejectedValueOnce(make404Error());

    const result = await deactivateVirtualAccount({ merchantId: merchant._id, accountNumber: account.accountNumber });

    expect(result.status).toBe('deactivated');
    expect(result.bankSyncStatus).toBe('synced'); // not 'failed' or 'ambiguous'

    const reloadedCustomer = await Customer.findById(customer._id);
    expect(reloadedCustomer.virtualAccount).toBeNull();
  });
});
