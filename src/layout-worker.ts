// Lays conversations out away from the page: placing many spirals can take seconds, and the page should
// keep responding meanwhile. One request at a time; the page only asks for the latest state it needs.
import type { LayoutRequest } from './core/encode';
import { Layout, layoutConversation } from './core/layout';

export interface LayoutJob extends LayoutRequest {
  id: number;
}

export type LayoutReply = { id: number; layout: Layout } | { id: number; error: string };

self.onmessage = (e: MessageEvent<LayoutJob>) => {
  const { id, parents, need, seed } = e.data;
  let reply: LayoutReply;
  try {
    reply = { id, layout: layoutConversation(parents, need, seed) };
  } catch (err) {
    reply = { id, error: err instanceof Error ? err.message : String(err) };
  }
  (self as unknown as Worker).postMessage(reply);
};
