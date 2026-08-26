// OpenNodes client SDK (REQ-002 subset): discover, estimate, invoke with pinning + receipt verification.
import { verifyJws, keyFromJwk, validateCard, verifyCardSignature, costForUsage, round6 } from '@opennodes/core';

export class OnpClient {
  constructor({ registry, policy = {} }) {
    this.registry = registry.replace(/\/$/, '');
    this.policy = { max_input_per_mtok: Infinity, max_request_cost: Infinity, min_tier: 'unverified', ...policy };
    this.receipts = [];
  }

  async search(params = {}) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${this.registry}/v0/offerings?${qs}`);
    if (!res.ok) throw new Error(`search failed: ${res.status}`);
    return (await res.json()).offerings;
  }

  async estimate(steps) {
    const res = await fetch(`${this.registry}/v0/estimate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ steps }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`estimate failed: ${body.detail ?? res.status}`);
    return body;
  }

  async resolveCard(origin) {
    const res = await fetch(`${origin}/.well-known/open-node.json`);
    if (!res.ok) throw new Error(`card fetch failed: ${res.status}`);
    const card = await res.json();
    const errors = validateCard(card);
    if (errors.length) throw new Error('card invalid: ' + errors.join('; '));
    const jwks = await (await fetch(`${origin}/.well-known/jwks.json`)).json();
    verifyCardSignature(card, keyFromJwk(jwks.keys[0]));
    return { card, jwks };
  }

  checkPolicy(offering, maxTokens = 1024) {
    const tiers = ['unverified', 'community', 'verified', 'attested'];
    if (tiers.indexOf(offering.tier) < tiers.indexOf(this.policy.min_tier)) {
      throw new Error(`policy: tier ${offering.tier} below minimum ${this.policy.min_tier}`);
    }
    if ((offering.pricing.input_per_mtok ?? 0) > this.policy.max_input_per_mtok) {
      throw new Error(`policy: input price ${offering.pricing.input_per_mtok} above cap`);
    }
    const ceiling = costForUsage(offering.pricing, 8000, maxTokens);
    if (ceiling > this.policy.max_request_cost) {
      throw new Error(`policy: request ceiling ${ceiling} above cap ${this.policy.max_request_cost}`);
    }
  }

  /** Invoke an offering (onp.openai.chat/v1) with pinning, one price_changed retry, receipt verification. */
  async invoke(offering, messages, { maxTokens = 256, _retried = false } = {}) {
    this.checkPolicy(offering, maxTokens);
    const res = await fetch(`${offering.endpoints.openai}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'onp-offering': `${offering.node_id}/${offering.offering_id}`,
        'onp-card-revision': offering.card_revision,
      },
      body: JSON.stringify({ model: offering.binding.model_id, messages, max_tokens: maxTokens }),
    });

    if (res.status === 409 && !_retried) {
      // price_changed: re-resolve the card from origin, re-check policy, retry once (TC-INV-01).
      const origin = new URL(offering.endpoints.openai).origin;
      const { card } = await this.resolveCard(origin);
      const fresh = card.offerings.find((o) => o.offering_id === offering.offering_id);
      if (!fresh) throw new Error('offering disappeared in new card revision');
      const updated = { ...offering, pricing: fresh.pricing, card_revision: card.revision };
      return this.invoke(updated, messages, { maxTokens, _retried: true });
    }
    const body = await res.json();
    if (!res.ok) throw new Error(`invoke failed: ${res.status} ${body.detail ?? ''}`);

    const receiptJws = res.headers.get('onp-receipt');
    let receipt = null;
    if (receiptJws) {
      const origin = new URL(offering.endpoints.openai).origin;
      const jwks = await (await fetch(`${origin}/.well-known/jwks.json`)).json();
      receipt = verifyJws(receiptJws, keyFromJwk(jwks.keys[0]));
      const expected = costForUsage(offering.pricing, receipt.usage.prompt_tokens, receipt.usage.completion_tokens);
      if (round6(receipt.amount.value) !== round6(expected)) {
        throw new Error(`receipt amount ${receipt.amount.value} != usage x pinned price ${expected}`);
      }
      if (receipt.card_revision !== offering.card_revision) {
        throw new Error(`receipt pinned revision mismatch: ${receipt.card_revision}`);
      }
      this.receipts.push(receipt);
    }
    return { completion: body, receipt, repinned: _retried ? offering.card_revision : null };
  }

  spendTotal() {
    return round6(this.receipts.reduce((sum, r) => sum + r.amount.value, 0));
  }
}
