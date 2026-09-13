import superjson from 'superjson';

// Type-preserving serialization for persistent journals. A real provider's doGenerate
// result may carry fields like Date / undefined / Map; plain JSON loses these, superjson preserves them.

export function serialize(value: unknown): string {
  return superjson.stringify(value);
}

export function deserialize<T = unknown>(text: string): T {
  return superjson.parse(text) as T;
}
