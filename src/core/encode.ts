import { bytesToBits, crc16, filler, maskBits } from './bits';
import {
  bitSymbol, CHUNK_BYTES, DATA_BYTES, Layout, layoutConversation, MAX_SEGMENTS, PARITY_BYTES, SEGMENT_BITS,
  SEGMENT_SYMBOLS, VARIANT_SLOTS,
} from './layout';
import { rsEncode } from './rs';
import { encodeText } from './textcodec';

export const CRC_BYTES = 2;
/** thread id (2 bytes), message index, parent index, message count (so a reader knows when it has them all) */
export const HEADER_BYTES = 5;
export const NO_PARENT = 0xff;
export const MAX_MESSAGES = NO_PARENT;

export interface Message {
  author: string;
  text: string;
  /** index of the message this one replies to, or -1 for the opening message */
  parent: number;
  /** colour its writing is drawn in (an INKS id); only for drawing, it is not written into the spiral */
  ink?: string;
}

export interface Conversation {
  /** random id, so spirals from different conversations are not mixed up */
  thread: number;
  messages: Message[];
}

export interface EncodedConversation {
  conversation: Conversation;
  layout: Layout;
  /** segments drawn along each message's spiral (its own, repeated to fill the line) */
  segments: number[];
  /** symbols for all the segments drawn, per message: per gap, a 4-bit value per data vertex, then a bit per bond */
  values: Uint8Array[];
}

/** header | author "\n" text, before CRC and filler. The author is a single line, so the first newline splits them. */
export function messagePayload(thread: number, index: number, total: number, m: Message): Uint8Array {
  const body = encodeText(`${m.author.replace(/\n/g, ' ')}\n${m.text}`);
  const out = new Uint8Array(HEADER_BYTES + body.length);
  out[0] = thread >> 8;
  out[1] = thread & 0xff;
  out[2] = index;
  out[3] = m.parent < 0 ? NO_PARENT : m.parent;
  out[4] = total;
  out.set(body, HEADER_BYTES);
  return out;
}

/** Bytes a message takes out of DATA_BYTES. */
export function messageSize(m: Message): number {
  return messagePayload(0, 0, 1, m).length + CRC_BYTES;
}

export const segmentsFor = (size: number) => Math.max(1, Math.ceil(size / CHUNK_BYTES));

/** Whitening, the same for every segment, so repetitive bytes do not draw repetitive writing. */
export const SEGMENT_MASK = maskBits(SEGMENT_BITS);

/** Segment codeword -> its symbols (see bitSymbol). */
export function segmentValues(codeword: ArrayLike<number>): Uint8Array {
  const bits = bytesToBits(codeword);
  const out = new Uint8Array(SEGMENT_SYMBOLS);
  for (let k = 0; k < SEGMENT_BITS; k++) {
    const [sym, shift] = bitSymbol(k);
    out[sym] |= ((k < bits.length ? bits[k] : 0) ^ SEGMENT_MASK[k]) << shift;
  }
  return out;
}

/** The vertex values of one message: its segments, innermost first. */
export function encodeMessage(thread: number, index: number, total: number, m: Message): Uint8Array {
  const payload = messagePayload(thread, index, total, m);
  const size = payload.length + CRC_BYTES;
  if (size > DATA_BYTES) throw new Error('Mesaj bir spirale sığmayacak kadar uzun');
  const segments = segmentsFor(size);

  const data = new Uint8Array(segments * CHUNK_BYTES);
  data.set(payload);
  const crc = crc16(payload);
  data[payload.length] = crc >> 8;
  data[payload.length + 1] = crc & 0xff;
  for (let i = size; i < data.length; i++) data[i] = filler(i - size);

  const values = new Uint8Array(segments * SEGMENT_SYMBOLS);
  for (let seg = 0; seg < segments; seg++) {
    const head = [((index & 3) << 6) | (seg << 3) | (segments - 1), ...data.subarray(seg * CHUNK_BYTES, (seg + 1) * CHUNK_BYTES)];
    values.set(segmentValues([...head, ...rsEncode(head, PARITY_BYTES)]), seg * SEGMENT_SYMBOLS);
  }
  return values;
}

/** The layout depends only on who replies to whom, how many segments each message takes and the thread id, and is slow for big threads, so it is kept between edits. */
const layoutCache = new Map<string, Layout>();

/** What a conversation's layout depends on: who replies to whom, how many segments each message takes, the thread. */
export interface LayoutRequest {
  parents: number[];
  need: number[];
  seed: number;
}

export function layoutRequest(conversation: Conversation): LayoutRequest {
  const { thread, messages } = conversation;
  return {
    parents: messages.map((m) => m.parent),
    need: messages.map((m) => Math.min(MAX_SEGMENTS, segmentsFor(messageSize(m)))),
    seed: thread,
  };
}

/** Two conversations with the same key have the same layout. */
export const layoutKey = (r: LayoutRequest) => `${r.seed}:${r.parents.join()}:${r.need.join()}`;

function cachedLayout({ parents, need, seed }: LayoutRequest): Layout {
  const key = layoutKey({ parents, need, seed });
  let layout = layoutCache.get(key);
  if (!layout) {
    layout = layoutConversation(parents, need, seed);
    if (layoutCache.size > 20) layoutCache.clear();
    layoutCache.set(key, layout);
  }
  return layout;
}

/** Encodes a conversation, laying it out here and now (which can take seconds for a big one). */
export function encodeConversation(conversation: Conversation): EncodedConversation {
  return encodeWithLayout(conversation, cachedLayout(layoutRequest(conversation)));
}

/** Encodes a conversation on a layout made for it elsewhere (see layoutRequest). */
export function encodeWithLayout(conversation: Conversation, layout: Layout): EncodedConversation {
  const { thread, messages } = conversation;
  if (messages.length > MAX_MESSAGES) throw new Error('Konuşma çok uzun');
  // Every spiral's line is as long as its shape makes it; a message that takes fewer segments is written
  // again and again until the line is full (the reader takes the copies as more readings of the same).
  const segments = layout.nodes.map((n) => VARIANT_SLOTS[n.placement.variant]);
  return {
    conversation,
    layout,
    segments,
    values: messages.map((m, i) => {
      const own = encodeMessage(thread, i, messages.length, m);
      const all = new Uint8Array(segments[i] * SEGMENT_SYMBOLS);
      for (let at = 0; at < all.length; at += own.length) all.set(own.subarray(0, Math.min(own.length, all.length - at)), at);
      return all;
    }),
  };
}
