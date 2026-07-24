// Knowledge base: policy documents → vector store (RAG). Embeds are cross-run cached via @gnl/cache.
import { InMemoryVectorStore, indexDocuments, createRagTool } from '@gnl/rag';
import { createCache } from '@gnl/cache';
import type { CacheStore } from '@gnl/durable';

const DIMS = ['return', 'shipping', 'warranty', 'invoice', 'account', 'password'];
const rawEmbed = (t: string): number[] => {
  const s = t.toLowerCase();
  return DIMS.map((k) => s.split(k).length - 1);
};

const DOCS = [
  { id: 'p1', text: 'return policy: products can be returned within 14 days of delivery, the amount is refunded to your card within 3 business days' },
  { id: 'p2', text: 'shipping: standard shipping takes 3 business days, express shipping 1 day; the shipping tracking number is sent via SMS' },
  { id: 'p3', text: 'warranty: all devices carry a 2-year warranty, contact service with your invoice' },
  { id: 'p4', text: 'account: password reset is done via email, 2FA is recommended for account security' },
];

export interface OrderRow { total: number; status: string; customer: string }
export const ORDERS: Record<string, OrderRow> = {
  'ORD-1042': { total: 80, status: 'delivered', customer: 'cust-1' },
  'ORD-2001': { total: 250, status: 'in transit', customer: 'cust-2' },
};

export async function buildKnowledge(cacheStore: CacheStore) {
  const cache = createCache(cacheStore, 'embed');
  const embed = async (t: string) => cache.getOrCompute(t, () => rawEmbed(t)); // cross-run cached
  const store = new InMemoryVectorStore();
  await indexDocuments(store, embed, DOCS);
  const searchPolicy = createRagTool({ store, embed, topK: 2, description: 'Searches return/shipping/warranty/account policies' });
  return { searchPolicy, embed };
}
