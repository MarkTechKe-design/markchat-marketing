/**
 * MarkChat Batch 9: Paystack Billing Portal & Payment Return Verification Tests
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const marketingRoot = path.resolve(__dirname, '..');

describe('Batch 9: Paystack Billing Portal & Payment Return Integration', () => {
  const billingPagePath = path.join(marketingRoot, 'src', 'pages', 'billing.astro');
  const returnPagePath = path.join(marketingRoot, 'src', 'pages', 'billing', 'return.astro');

  test('Billing portal and return pages exist in pages tree', () => {
    assert.ok(fs.existsSync(billingPagePath), 'billing.astro must exist');
    assert.ok(fs.existsSync(returnPagePath), 'billing/return.astro must exist');
  });

  test('Billing portal renders plan choices, payment methods, and API integration', () => {
    const src = fs.readFileSync(billingPagePath, 'utf8');

    // Canonical plans
    assert.match(src, /name="planSelect"\s+value="starter"/, 'Must include starter plan option');
    assert.match(src, /name="planSelect"\s+value="growth"/, 'Must include growth plan option');
    assert.match(src, /name="planSelect"\s+value="scale"/, 'Must include scale plan option');

    // Payment methods
    assert.match(src, /value="mpesa"/, 'Must include M-Pesa option');
    assert.match(src, /value="card"/, 'Must include Card option');
    assert.match(src, /id="billingPhone"/, 'Must include phone input for M-Pesa');

    // API integration
    assert.match(src, /\/api\/v1\/billing\/checkout/, 'Must dispatch to /api/v1/billing/checkout');
    assert.match(src, /billing\/return/, 'Must configure return callback URL');
  });

  test('Growth and Scale ingress denial redirects pre-select tier and show upgrade context', () => {
    const src = fs.readFileSync(billingPagePath, 'utf8');
    assert.ok(src.includes("intent.get('plan')"));
    assert.ok(src.includes("['starter', 'growth', 'scale'].includes(chosenPlan)"));
    assert.ok(src.includes('if (radio) radio.checked = true'));
    assert.ok(src.includes("chosenPlan === 'growth' || chosenPlan === 'scale'"));
    assert.ok(src.includes('billing-upgrade-context'));
    assert.ok(src.includes('Upgrade to '));
  });

  test('KES 82 verification return waits for provisioning before showing success', () => {
    const src = fs.readFileSync(returnPagePath, 'utf8');
    assert.ok(src.includes('markchat_verification_pending'));
    assert.ok(src.includes("tx.purpose !== 'account_verification'"));
    assert.ok(src.includes('tx.amountKesCents !== 8200'));
    assert.ok(src.includes("statusData?.status === 'completed'"));
    assert.ok(src.includes("statusData?.status === 'failed'"));
    assert.ok(src.includes('state-pending'));
    assert.ok(src.includes("tx.purpose !== 'subscription'"));
    assert.ok(!src.includes('launchBtn.href = tx.ssoUrl'));
    assert.ok(
      !src.includes(
        "stateSuccess?.classList.remove('hidden');\n        if (receiptRef) receiptRef.textContent = reference"
      )
    );
  });

  test('Payment return page verifies reference and facilitates Chatwoot launch', () => {
    const src = fs.readFileSync(returnPagePath, 'utf8');

    // Query parameters
    assert.match(src, /urlParams\.get\(['"]reference['"]\)/, 'Must extract reference from URL');
    assert.match(src, /urlParams\.get\(['"]trxref['"]\)/, 'Must extract trxref from URL');

    // Verification endpoint
    assert.match(src, /\/api\/v1\/billing\/status\/\$\{reference\}/, 'Must query status endpoint');

    // Success and handoff
    assert.match(src, /id="state-success"/, 'Must include success receipt state');
    assert.match(src, /id="launch-workspace-btn"/, 'Must include button to launch workspace');
    assert.match(src, /id="state-failed"/, 'Must include failed transaction state');
  });
});
