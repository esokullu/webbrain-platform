import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/db/memory.js';
import { attemptAutoTopUp, reconcileBilling } from '../src/platform/billing.js';

function config(secretKey = '') {
  return {
    billing: {
      browserHourCents: 10,
      stripe: { secretKey },
    },
  };
}

test('billing reconciler prorates active browser usage without losing sub-cent time', async () => {
  const store = new MemoryStore();
  const createdAt = '2026-07-18T10:00:00.000Z';
  await store.createUser({
    id: 'usr_metered',
    email: 'metered@example.com',
    password_hash: 'hash',
    created_at: createdAt,
    updated_at: createdAt,
  });
  await store.ensureBillingAccount({ user_id: 'usr_metered', created_at: createdAt, updated_at: createdAt });
  await store.applyBillingCredit({
    id: 'btx_seed',
    user_id: 'usr_metered',
    amount_cents: 100,
    kind: 'credit_top_up',
    provider: 'test',
    provider_ref: 'seed_credit',
    description: 'Seed credit',
    created_at: createdAt,
  });
  await store.createBrowserSession({
    id: 'bs_metered',
    user_id: 'usr_metered',
    profile_mode: 'persistent',
    status: 'ready',
    droplet_id: 'droplet_1',
    billing_metered_at: createdAt,
    created_at: createdAt,
    updated_at: createdAt,
  });

  await reconcileBilling({
    store,
    config: config(),
    at: '2026-07-18T10:03:00.000Z',
  });
  assert.equal((await store.getBillingAccount('usr_metered')).credit_cents, 100);
  assert.equal((await store.getBillingAccount('usr_metered')).usage_remainder_units, 1800);

  await reconcileBilling({
    store,
    config: config(),
    at: '2026-07-18T10:06:00.000Z',
  });
  const account = await store.getBillingAccount('usr_metered');
  assert.equal(account.credit_cents, 99);
  assert.equal(account.usage_remainder_units, 0);
  const usage = (await store.listBillingTransactions('usr_metered')).find(row => row.kind === 'browser_usage');
  assert.equal(usage.amount_cents, -1);
});

test('automatic top-up charges the saved Stripe payment method idempotently', async () => {
  const store = new MemoryStore();
  const at = '2026-07-18T11:00:00.000Z';
  await store.createUser({
    id: 'usr_auto',
    email: 'auto@example.com',
    password_hash: 'hash',
    created_at: at,
    updated_at: at,
  });
  await store.ensureBillingAccount({ user_id: 'usr_auto', created_at: at, updated_at: at });
  await store.updateBillingAutoTopUp('usr_auto', {
    stripe_customer_id: 'cus_saved',
    stripe_payment_method_id: 'pm_saved',
    auto_top_up_enabled: true,
    auto_top_up_threshold_cents: 500,
    auto_top_up_amount_cents: 2500,
    auto_top_up_status: 'idle',
    updated_at: at,
  });
  let captured = null;
  const result = await attemptAutoTopUp({
    store,
    config: config('sk_test_secret'),
    account: await store.getBillingAccount('usr_auto'),
    at,
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({
        id: 'pi_auto_top_up',
        status: 'succeeded',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.equal(result.succeeded, true);
  assert.equal(captured.url, 'https://api.stripe.com/v1/payment_intents');
  assert.match(captured.options.headers['idempotency-key'], /^webbrain-auto-top-up-atu_/);
  const form = new URLSearchParams(captured.options.body);
  assert.equal(form.get('customer'), 'cus_saved');
  assert.equal(form.get('payment_method'), 'pm_saved');
  assert.equal(form.get('off_session'), 'true');
  assert.equal(form.get('confirm'), 'true');
  assert.equal((await store.getBillingAccount('usr_auto')).credit_cents, 2500);
  const transactions = await store.listBillingTransactions('usr_auto');
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].kind, 'auto_top_up');
  assert.equal(transactions[0].provider_ref, 'pi_auto_top_up');
});

test('automatic top-up reuses its attempt after Stripe succeeds but credit persistence fails', async () => {
  const store = new MemoryStore();
  const at = '2026-07-18T12:00:00.000Z';
  await store.createUser({
    id: 'usr_recovery',
    email: 'recovery@example.com',
    password_hash: 'hash',
    created_at: at,
    updated_at: at,
  });
  await store.ensureBillingAccount({ user_id: 'usr_recovery', created_at: at, updated_at: at });
  await store.updateBillingAutoTopUp('usr_recovery', {
    stripe_customer_id: 'cus_recovery',
    stripe_payment_method_id: 'pm_recovery',
    auto_top_up_enabled: true,
    auto_top_up_threshold_cents: 500,
    auto_top_up_amount_cents: 2500,
    auto_top_up_status: 'idle',
    updated_at: at,
  });

  const originalApply = store.applyBillingCredit.bind(store);
  let failCreditOnce = true;
  store.applyBillingCredit = async row => {
    if (failCreditOnce) {
      failCreditOnce = false;
      throw new Error('temporary database failure');
    }
    return await originalApply(row);
  };
  const idempotencyKeys = [];
  const fetchImpl = async (url, options) => {
    idempotencyKeys.push(options.headers['idempotency-key']);
    return new Response(JSON.stringify({
      id: 'pi_recovered_top_up',
      status: 'succeeded',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const first = await attemptAutoTopUp({
    store,
    config: config('sk_test_secret'),
    account: await store.getBillingAccount('usr_recovery'),
    at,
    fetchImpl,
  });
  const claimed = await store.getBillingAccount('usr_recovery');
  assert.equal(first.pending_credit, true);
  assert.equal(claimed.auto_top_up_status, 'charging');
  assert.match(claimed.auto_top_up_attempt_id, /^atu_/);

  const second = await attemptAutoTopUp({
    store,
    config: config('sk_test_secret'),
    account: claimed,
    at: '2026-07-18T12:01:00.000Z',
    fetchImpl,
  });
  assert.equal(second.succeeded, true);
  assert.equal(idempotencyKeys.length, 2);
  assert.equal(idempotencyKeys[0], idempotencyKeys[1]);
  assert.equal((await store.getBillingAccount('usr_recovery')).credit_cents, 2500);
});
