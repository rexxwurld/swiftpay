// src/utils/generateAccountNumber.js
// Simulates a bank's own account-numbering scheme.
// Real banks assign these when an account is opened on their core banking
// system - your platform never invents a "real" account number, it only
// draws from a pool that the (mock) bank partner has provisioned.

function generateAccountNumber() {
  // 10-digit numeric string, NUBAN-style (Nigerian bank account format)
  let number = '';
  for (let i = 0; i < 10; i++) {
    number += Math.floor(Math.random() * 10);
  }
  return number;
}

module.exports = generateAccountNumber;
