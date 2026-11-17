import { BINARIZERS, DecodedMessage, Partial, Pt } from './core/decode';
import { Conversation, encodeWithLayout, layoutKey, LayoutRequest, layoutRequest, MAX_MESSAGES, Message, messageSize } from './core/encode';
import { DATA_BYTES, Layout, PORTS } from './core/layout';
import type { LayoutJob, LayoutReply } from './layout-worker';
import { imageSize, INKS, renderConversation, WALLS, wallTheme } from './core/render';
import type { DecodeRequest, DecodeResponse } from './worker';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

// ---------- tabs ----------
document.querySelectorAll<HTMLButtonElement>('nav [data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll<HTMLButtonElement>('nav [data-tab]').forEach((b) => {
      const on = b === btn;
      b.setAttribute('aria-selected', String(on));
      $(`tab-${b.dataset.tab}`).hidden = !on;
    });
  });
});

/** Indices of `messages` in depth-first order, with their depth, so replies sit under what they answer. */
function threadOrder(messages: Array<{ parent: number }>, roots: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const visit = (i: number, d: number) => {
    out.push([i, d]);
    messages.forEach((m, c) => m.parent === i && visit(c, d + 1));
  };
  for (const r of roots) visit(r, 0);
  return out;
}

// ---------- write ----------
const STORAGE_KEY = 'nomaian.conversation';
const PREVIEW_SIDE = 1200;
const threadEl = $<HTMLOListElement>('thread');
const themeEl = $<HTMLSelectElement>('theme');
const inkEl = $<HTMLSelectElement>('ink');
const glyphCanvas = $<HTMLCanvasElement>('glyph');
const writeError = $('write-error');

function freshConversation(): Conversation {
  return {
    thread: Math.floor(Math.random() * 0x10000),
    messages: [{ author: 'Solanum', text: 'We do not have much connection, you and I. Still, this encounter feels special. I hope you wont mind if I think of you as a friend.', parent: -1, ink: INKS[0].id }],
  };
}

function isConversation(c: unknown): c is Conversation {
  const v = c as Conversation;
  return (
    typeof v?.thread === 'number' &&
    Array.isArray(v.messages) &&
    v.messages.length > 0 &&
    v.messages[0].parent === -1 &&
    v.messages.every(
      (m, i) =>
        typeof m.author === 'string' && typeof m.text === 'string' && Number.isInteger(m.parent) && m.parent < i &&
        (i === 0 || m.parent >= 0) && (m.ink === undefined || typeof m.ink === 'string'),
    )
  );
}

/** The conversation saved on this device last time, if any; only read, not laid out (that can be slow). */
function savedConversation(): Conversation | null {
  try {
    const c = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (isConversation(c)) {
      // Conversations saved before each message had its own colour take the one picked for all of them.
      const old = localStorage.getItem('nomaian.ink');
      const ink = INKS.some((k) => k.id === old) ? old! : INKS[0].id;
      for (const m of c.messages) if (!INKS.some((k) => k.id === m.ink)) m.ink = ink;
      return c;
    }
  } catch {
    /* storage unavailable or corrupt */
  }
  return null;
}

/** Whether a conversation is just the opening one every new conversation starts with. */
function untouched(c: Conversation): boolean {
  const fresh = freshConversation().messages[0];
  return c.messages.length === 1 && c.messages[0].author === fresh.author && c.messages[0].text === fresh.text;
}

// Every visit starts with a new conversation, so a big saved one never holds up the page. A saved one is
// offered instead (see offerRestore); until the user has answered, nothing is saved over it.
let conv = freshConversation();
let previous = savedConversation();
if (previous && untouched(previous)) previous = null;

function saveConversation() {
  if (previous) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conv));
  } catch {
    /* storage unavailable */
  }
}

const displayName = (i: number) => conv.messages[i].author.trim() || `#${i + 1}`;
const replies = (i: number) => conv.messages.filter((m) => m.parent === i).length;

/** Removes message `i` and every reply under it, renumbering the rest. */
function removeSubtree(i: number) {
  const gone = new Set<number>([i]);
  conv.messages.forEach((m, k) => gone.has(m.parent) && gone.add(k));
  const renumber = new Map<number, number>();
  const kept: Message[] = [];
  conv.messages.forEach((m, k) => {
    if (gone.has(k)) return;
    renumber.set(k, kept.length);
    kept.push({ ...m, parent: m.parent < 0 ? -1 : renumber.get(m.parent)! });
  });
  conv.messages = kept;
}

/**
 * Stops a field from taking its message past DATA_BYTES: whatever was just typed or pasted is cut down to
 * what still fits (none of it, once the message is full). The size is measured, not counted, since the text
 * is compressed and a character can take more or less than a byte. Text that was already over the limit
 * (saved before the limit was lowered) can still be shortened. Must be added before the field's own input
 * handler, so that handler sees the trimmed value.
 */
function keepWithinLimit(field: HTMLInputElement | HTMLTextAreaElement, initial: string, sizeOf: (value: string) => number) {
  let last = initial;
  const apply = () => {
    const now = field.value;
    if (sizeOf(now) <= DATA_BYTES || sizeOf(now) <= sizeOf(last)) {
      last = now;
      return;
    }
    // What changed: the text between the part both share at the start and the part they share at the end.
    let head = 0;
    while (head < last.length && head < now.length && last[head] === now[head]) head++;
    let tail = 0;
    while (tail < last.length - head && tail < now.length - head && last[last.length - 1 - tail] === now[now.length - 1 - tail]) tail++;
    const before = now.slice(0, head);
    const after = now.slice(now.length - tail);
    const added = Array.from(now.slice(head, now.length - tail));
    // The longest start of the added text that still fits.
    let lo = 0;
    let hi = added.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (sizeOf(before + added.slice(0, mid).join('') + after) <= DATA_BYTES) lo = mid;
      else hi = mid - 1;
    }
    const kept = added.slice(0, lo).join('');
    field.value = before + kept + after;
    const caret = before.length + kept.length;
    field.setSelectionRange(caret, caret);
    last = field.value;
  };
  field.addEventListener('input', (e) => {
    // Wait for a composed character (dead keys, IMEs) to be finished.
    if (!(e as InputEvent).isComposing) apply();
  });
  field.addEventListener('compositionend', () => {
    apply();
    field.dispatchEvent(new Event('input'));
  });
}

function updateCard(li: HTMLElement, i: number) {
  const size = messageSize(conv.messages[i]);
  const count = li.querySelector<HTMLElement>('.count')!;
  count.textContent = `${size} / ${DATA_BYTES} bayt`;
  count.classList.toggle('over', size > DATA_BYTES);
}

function buildEditor() {
  threadEl.replaceChildren();
  for (const [i, depth] of threadOrder(conv.messages, [0])) {
    const m = conv.messages[i];
    const li = el('li', 'msg');
    li.style.setProperty('--depth', String(Math.min(depth, 4)));

    if (m.parent >= 0) {
      const note = el('p', 'reply-to');
      note.dataset.parent = String(m.parent);
      note.textContent = `↳ ${displayName(m.parent)} mesajına cevap`;
      li.append(note);
    }

    const author = el('input', 'author');
    author.placeholder = 'Yazar';
    author.maxLength = 24;
    author.value = m.author;
    author.setAttribute('aria-label', 'Yazar');
    keepWithinLimit(author, m.author, (v) => messageSize({ ...m, author: v }));
    author.addEventListener('input', () => {
      m.author = author.value;
      updateCard(li, i);
      threadEl.querySelectorAll<HTMLElement>(`.reply-to[data-parent="${i}"]`).forEach((n) => {
        n.textContent = `↳ ${displayName(i)} mesajına cevap`;
      });
      changed();
    });

    const text = el('textarea');
    text.rows = 3;
    text.value = m.text;
    text.placeholder = 'Gezgin, bu mesajı yalnızca Nomai okuyabilir…';
    text.setAttribute('aria-label', 'Mesaj');
    keepWithinLimit(text, m.text, (v) => messageSize({ ...m, text: v }));
    text.addEventListener('input', () => {
      m.text = text.value;
      updateCard(li, i);
      changed();
    });

    const meta = el('div', 'meta');
    const reply = el('button', 'small', 'Cevap yaz');
    const full = replies(i) >= PORTS || conv.messages.length >= MAX_MESSAGES;
    reply.disabled = full;
    if (full) reply.title = `Bir mesaja en fazla ${PORTS} cevap verilebilir`;
    reply.addEventListener('click', () => {
      // A reply starts in the colour of the message it answers.
      conv.messages.push({ author: '', text: '', parent: i, ink: m.ink });
      structureChanged();
      threadEl.querySelector<HTMLInputElement>(`.msg[data-index="${conv.messages.length - 1}"] input`)?.focus();
    });
    const actions = el('span', 'buttons');
    actions.append(reply);
    if (i > 0) {
      const del = el('button', 'small', 'Sil');
      del.addEventListener('click', () => {
        removeSubtree(i);
        structureChanged();
      });
      actions.append(del);
    }
    meta.append(el('span', 'count'), inkPicker(i), actions);

    li.dataset.index = String(i);
    li.append(author, text, meta);
    threadEl.append(li);
    updateCard(li, i);
  }
}

// The wall is picked for the whole drawing; each message has its own writing colour (see inkPicker), and
// the "all writing" list sets every message's at once.
for (const w of WALLS) themeEl.add(new Option(w.name, w.id));
const MIXED = 'karisik';
const mixedOption = new Option('Karışık', MIXED);
mixedOption.disabled = true;
inkEl.add(mixedOption);
for (const k of INKS) inkEl.add(new Option(k.name.replace(' yazı', ''), k.id));
try {
  themeEl.value = localStorage.getItem('nomaian.wall') ?? WALLS[0].id;
} catch {
  /* storage unavailable */
}
if (!themeEl.value) themeEl.value = WALLS[0].id;

function currentTheme() {
  // Messages carry their own ink; this one only fills in for any that do not.
  return wallTheme(themeEl.value, INKS[0].id);
}

/** Shows in the "all writing" list the colour every message shares, or "mixed". */
function syncInkAll() {
  const inks = new Set(conv.messages.map((m) => m.ink ?? INKS[0].id));
  const one = inks.size === 1 ? [...inks][0] : MIXED;
  inkEl.value = one;
  mixedOption.hidden = one !== MIXED;
}

/** A message's colour swatches: one round button per ink, the chosen one ringed. */
function inkPicker(i: number): HTMLElement {
  const group = el('span', 'inks');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'Yazı rengi');
  for (const k of INKS.filter((x) => !x.allOnly)) {
    const b = el('button', 'swatch');
    b.type = 'button';
    b.style.setProperty('--swatch', k.swatch);
    b.style.setProperty('--swatch-glow', k.glow ?? 'transparent');
    b.title = k.name;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', k.name);
    b.dataset.ink = k.id;
    b.addEventListener('click', () => {
      conv.messages[i].ink = k.id;
      markSwatches(group, k.id);
      syncInkAll();
      changed();
    });
    group.append(b);
  }
  markSwatches(group, conv.messages[i].ink ?? INKS[0].id);
  return group;
}

function markSwatches(group: HTMLElement, ink: string) {
  group.querySelectorAll<HTMLElement>('.swatch').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.ink === ink)));
}

// ---------- layout, worked out in the background ----------
//
// Laying out a big conversation can take seconds, so it is done by a worker while the page keeps
// responding; the drawing waits for it. Only one layout is worked on at a time, and of the ones asked for
// meanwhile only the latest is kept: typing on while one is being worked out does not pile up work.
const layoutWorker = new Worker(new URL('./layout-worker.ts', import.meta.url), { type: 'module' });
const layouts = new Map<string, Layout>();
const layoutErrors = new Map<string, string>();
let layoutJobs = 0;
let working: { id: number; key: string } | null = null;
let queued: LayoutRequest | null = null;
/** Callers waiting for a layout (the PNG export), by key. */
const waiting = new Map<string, Array<{ resolve: (l: Layout) => void; reject: (e: Error) => void }>>();

function requestLayout(req: LayoutRequest) {
  const key = layoutKey(req);
  if (layouts.has(key) || layoutErrors.has(key) || working?.key === key) return;
  if (working) {
    // A newer state replaces an older one still waiting its turn; anyone waiting for that one is told so.
    if (queued && layoutKey(queued) !== key) settle(layoutKey(queued), new Error('Konuşma değişti'));
    queued = req;
    return;
  }
  working = { id: ++layoutJobs, key };
  const job: LayoutJob = { id: working.id, ...req };
  layoutWorker.postMessage(job);
}

/** Hands a finished layout (or what went wrong) to whoever waits for it. */
function settle(key: string, result: Layout | Error) {
  for (const w of waiting.get(key) ?? []) {
    if (result instanceof Error) w.reject(result);
    else w.resolve(result);
  }
  waiting.delete(key);
}

layoutWorker.onmessage = (e: MessageEvent<LayoutReply>) => {
  const reply = e.data;
  if (!working || reply.id !== working.id) return;
  const { key } = working;
  working = null;
  if ('layout' in reply) {
    if (layouts.size > 30) layouts.clear();
    layouts.set(key, reply.layout);
    settle(key, reply.layout);
  } else {
    layoutErrors.set(key, reply.error);
    settle(key, new Error(reply.error));
  }
  if (queued) {
    const next = queued;
    queued = null;
    requestLayout(next);
  }
  redraw();
};

/** The layout of `c`, once it has been worked out. */
function layoutFor(c: Conversation): Promise<Layout> {
  const req = layoutRequest(c);
  const key = layoutKey(req);
  const have = layouts.get(key);
  if (have) return Promise.resolve(have);
  const error = layoutErrors.get(key);
  if (error) return Promise.reject(new Error(error));
  return new Promise((resolve, reject) => {
    waiting.set(key, [...(waiting.get(key) ?? []), { resolve, reject }]);
    requestLayout(req);
  });
}

const glyphBusy = $('glyph-busy');

/**
 * Draws the conversation, or explains why it cannot. Returns whether it drew it now; if its layout is still
 * being worked out, the last drawing stays up, marked as being updated, and this runs again when it is in.
 */
function redraw(): boolean {
  const over = conv.messages.findIndex((m) => messageSize(m) > DATA_BYTES);
  if (over >= 0) {
    writeError.textContent = `${displayName(over)} mesajı bir spirale sığmıyor, biraz kısalt.`;
    writeError.hidden = false;
    glyphBusy.hidden = true;
    return false;
  }
  const req = layoutRequest(conv);
  const key = layoutKey(req);
  const error = layoutErrors.get(key);
  if (error) {
    writeError.textContent = error.includes('room')
      ? 'Bu konuşmada yeni spirale yer bulunamadı. Son cevabı silmeyi ya da başka bir mesaja cevap vermeyi dene.'
      : `Konuşma çizilemedi: ${error}`;
    writeError.hidden = false;
    glyphBusy.hidden = true;
    return false;
  }
  writeError.hidden = true;
  const layout = layouts.get(key);
  if (!layout) {
    glyphBusy.hidden = false;
    requestLayout(req);
    return false;
  }
  glyphBusy.hidden = true;
  const enc = encodeWithLayout(conv, layout);
  const { width, height, scale } = imageSize(enc, PREVIEW_SIDE);
  glyphCanvas.width = width;
  glyphCanvas.height = height;
  renderConversation(glyphCanvas.getContext('2d')!, enc, scale, currentTheme());
  return true;
}

let pending = 0;
function changed() {
  saveConversation();
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(redraw);
}

function structureChanged() {
  buildEditor();
  syncInkAll();
  changed();
}

themeEl.addEventListener('change', () => {
  try {
    localStorage.setItem('nomaian.wall', themeEl.value);
  } catch {
    /* storage unavailable */
  }
  redraw();
});

inkEl.addEventListener('change', () => {
  if (inkEl.value === MIXED) return;
  for (const m of conv.messages) m.ink = inkEl.value;
  threadEl.querySelectorAll<HTMLElement>('.inks').forEach((g) => markSwatches(g, inkEl.value));
  syncInkAll();
  changed();
});

$('reset').addEventListener('click', () => {
  if (conv.messages.length > 1 && !confirm('Bu konuşma silinsin ve yenisi başlasın mı?')) return;
  conv = freshConversation();
  structureChanged();
});

/** Full-resolution PNG of the conversation (the preview canvas is scaled down). */
async function glyphBlob(): Promise<Blob> {
  if (conv.messages.some((m) => messageSize(m) > DATA_BYTES)) throw new Error('Mesaj sığmıyor');
  const snapshot = conv;
  const enc = encodeWithLayout(snapshot, await layoutFor(snapshot));
  const { width, height, scale } = imageSize(enc);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  renderConversation(canvas.getContext('2d')!, enc, scale, currentTheme());
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG oluşturulamadı'))), 'image/png'),
  );
}

$('download').addEventListener('click', async () => {
  const url = URL.createObjectURL(await glyphBlob());
  const a = document.createElement('a');
  a.href = url;
  a.download = 'nomaian.png';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

const shareBtn = $<HTMLButtonElement>('share');
const probe = new File([new Blob()], 'x.png', { type: 'image/png' });
if (navigator.canShare?.({ files: [probe] })) {
  shareBtn.hidden = false;
  shareBtn.addEventListener('click', async () => {
    const file = new File([await glyphBlob()], 'nomaian.png', { type: 'image/png' });
    try {
      await navigator.share({ files: [file], title: 'Nomaian' });
    } catch {
      /* user cancelled */
    }
  });
}

buildEditor();
syncInkAll();
redraw();
offerRestore();

/** Asks whether to bring back the conversation saved last time, or start afresh and forget it. */
function offerRestore() {
  if (!previous) return;
  const box = $('restore');
  const text = $('restore-text');
  const yes = $<HTMLButtonElement>('restore-yes');
  const no = $<HTMLButtonElement>('restore-no');
  const n = previous.messages.length;
  text.textContent =
    n > 1
      ? `Önceki konuşman kayıtlı (${n} mesaj). Yüklemek ister misin? Büyük konuşmaların yüklenmesi biraz sürebilir.`
      : 'Önceki mesajın kayıtlı. Yüklemek ister misin?';
  box.hidden = false;
  yes.onclick = () => {
    // The editor comes back at once; the drawing follows when its layout is worked out.
    conv = previous!;
    previous = null;
    box.hidden = true;
    structureChanged();
  };
  no.onclick = () => {
    previous = null;
    box.hidden = true;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
    saveConversation();
  };
}

// ---------- read ----------
const MAX_SIDE = 2400;
/** Camera frames are decoded a little smaller, so each one is quick; the writing is fine, so not much smaller. */
const SCAN_SIDE = 1600;
const fileEl = $<HTMLInputElement>('file');
const statusEl = $('read-status');
const resultEl = $<HTMLOListElement>('result');
const copyBtn = $<HTMLButtonElement>('copy');
const photoCanvas = $<HTMLCanvasElement>('photo');
const scanBtn = $<HTMLButtonElement>('scan');
const scanner = $('scanner');
const video = $<HTMLVideoElement>('video');
const overlay = $<HTMLCanvasElement>('overlay');
const progressEl = $('scan-progress');
const hintEl = $('read-hint');

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let requestId = 0;
let readText = '';
let onResult: (r: DecodeResponse) => void = () => {};
worker.onmessage = (e: MessageEvent<DecodeResponse>) => {
  if (e.data.id === requestId) onResult(e.data);
};

function setStatus(msg: string, kind: '' | 'ok' | 'error' = '') {
  statusEl.textContent = msg;
  statusEl.className = `status ${kind}`;
  statusEl.hidden = false;
}

/** Messages of the conversation being read, by index. A read sticks to the first conversation it sees. */
let collected = new Map<number, DecodedMessage>();
let thread: number | null = null;

function resetCollected() {
  collected = new Map();
  thread = null;
  resultEl.hidden = true;
  copyBtn.hidden = true;
}

/** Adds newly read spirals; returns how many were new. */
function collect(msgs: DecodedMessage[]): number {
  let added = 0;
  for (const m of msgs) {
    thread ??= m.thread;
    if (m.thread !== thread || collected.has(m.index)) continue;
    collected.set(m.index, m);
    added++;
  }
  return added;
}

const totalOf = () => Math.max(0, ...[...collected.values()].map((m) => m.total));

// ----- photo -----
fileEl.addEventListener('change', async () => {
  const file = fileEl.files?.[0];
  fileEl.value = '';
  if (!file) return;
  stopScan();
  resetCollected();
  setStatus('Spiraller çözülüyor…');

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    setStatus('Bu görsel açılamadı.', 'error');
    return;
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  photoCanvas.width = Math.round(bitmap.width * scale);
  photoCanvas.height = Math.round(bitmap.height * scale);
  const ctx = photoCanvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, photoCanvas.width, photoCanvas.height);
  bitmap.close();
  photoCanvas.hidden = false;

  const { data, width, height } = ctx.getImageData(0, 0, photoCanvas.width, photoCanvas.height);
  onResult = (r) => {
    if (!r.messages.length) {
      setStatus('Spiral bulunamadı. Daha yakından, net ve düz bir açıyla tekrar dene.', 'error');
      return;
    }
    // A photo could catch spirals of more than one conversation; show the best represented one.
    const byThread = new Map<number, DecodedMessage[]>();
    for (const m of r.messages) byThread.set(m.thread, [...(byThread.get(m.thread) ?? []), m]);
    collect([...byThread.values()].sort((a, b) => b.length - a.length)[0]);
    const total = totalOf();
    const corrected = [...collected.values()].reduce((s, m) => s + m.corrected, 0);
    const missing = collected.size < total;
    setStatus(
      `${collected.size} / ${total} mesaj okundu · ${corrected ? `${corrected} bayt onarıldı · ` : ''}${Math.round(r.ms)} ms` +
        (missing ? ' · eksikler için kamerayla tarayabilirsin' : ''),
      missing ? '' : 'ok',
    );
    showConversation();
    drawChains(photoCanvas, r.chains, 1);
  };
  const req: DecodeRequest = { type: 'photo', id: ++requestId, rgba: data, width, height };
  worker.postMessage(req, [data.buffer]);
});

// ----- camera -----
let stream: MediaStream | null = null;
let scanning = false;
let busy = false;
let pass = 0;
/** Segments read so far of messages not yet complete. */
let partial: Partial[] = [];
const frame = document.createElement('canvas');

scanBtn.addEventListener('click', startScan);
$('stop').addEventListener('click', () => {
  stopScan();
  if (collected.size) setStatus(`Tarama durduruldu · ${collected.size} / ${totalOf()} mesaj okundu.`);
});

async function startScan() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('Kamera için sayfanın https:// ile açılması gerekiyor.', 'error');
    return;
  }
  resetCollected();
  photoCanvas.hidden = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  } catch {
    setStatus('Kameraya erişilemedi. Tarayıcıda kamera iznini kontrol et.', 'error');
    return;
  }
  video.srcObject = stream;
  await video.play();
  scanner.hidden = false;
  scanBtn.hidden = true;
  hintEl.hidden = true;
  statusEl.hidden = true;
  scanning = true;
  busy = false;
  partial = [];
  const reset: DecodeRequest = { type: 'reset' };
  worker.postMessage(reset);
  updateProgress();
  requestAnimationFrame(scanFrame);
}

function stopScan() {
  scanning = false;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  scanner.hidden = true;
  scanBtn.hidden = false;
  hintEl.hidden = false;
}

function updateProgress() {
  const total = totalOf();
  // Messages seen only in part: how many of their pieces are in.
  const pieces = partial.map((p) => `${p.have}/${p.segments} parça`).join(' · ');
  const head = total ? `${collected.size} / ${total} mesaj` : collected.size ? `${collected.size} mesaj` : 'Spiral aranıyor…';
  progressEl.textContent = pieces ? `${head} · ${pieces}` : head;
}

/** Hands the current frame to the worker whenever it is free. */
function scanFrame() {
  if (!scanning) return;
  requestAnimationFrame(scanFrame);
  if (busy || video.readyState < 2 || !video.videoWidth) return;
  const scale = Math.min(1, SCAN_SIDE / Math.max(video.videoWidth, video.videoHeight));
  frame.width = Math.round(video.videoWidth * scale);
  frame.height = Math.round(video.videoHeight * scale);
  const ctx = frame.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0, frame.width, frame.height);
  const { data, width, height } = ctx.getImageData(0, 0, frame.width, frame.height);
  onResult = (r) => {
    busy = false;
    if (!scanning) return;
    overlay.width = width;
    overlay.height = height;
    drawChains(overlay, r.chains, 0.9);
    partial = r.partial;
    if (collect(r.messages)) {
      navigator.vibrate?.(40);
      showConversation();
    }
    updateProgress();
    const total = totalOf();
    if (total && collected.size >= total) {
      stopScan();
      setStatus(`Tamamlandı · ${total} mesajın hepsi okundu.`, 'ok');
    }
  };
  // One thresholding pass per frame, cycling through them, keeps the scan responsive.
  const req: DecodeRequest = { type: 'frame', id: ++requestId, rgba: data, width, height, passes: [pass++ % BINARIZERS] };
  busy = true;
  worker.postMessage(req, [data.buffer]);
}

function showConversation() {
  const msgs = [...collected.values()].sort((a, b) => a.index - b.index);
  const local = msgs.map((m) => ({ ...m, parent: msgs.findIndex((p) => p.index === m.parent) }));
  // Messages whose parent has not been read start their own branch.
  const roots = local.map((m, i) => [m, i] as const).filter(([m]) => m.parent < 0).map(([, i]) => i);
  resultEl.replaceChildren();
  const lines: string[] = [];
  for (const [i, depth] of threadOrder(local, roots)) {
    const m = msgs[i];
    const li = el('li', 'msg');
    li.style.setProperty('--depth', String(Math.min(depth, 4)));
    if (local[i].parent < 0 && m.parent >= 0) li.append(el('p', 'reply-to', `↳ henüz okunmamış #${m.parent + 1} mesajına cevap`));
    const author = m.author.trim() || `#${m.index + 1}`;
    li.append(el('strong', 'author', author), el('p', 'text', m.text));
    resultEl.append(li);
    lines.push(`${'  '.repeat(depth)}${author}: ${m.text}`);
  }
  readText = lines.join('\n');
  resultEl.hidden = !msgs.length;
  copyBtn.hidden = !msgs.length;
}

/** Draws the chains of writing found in a frame: the line through their markers, and the markers. */
function drawChains(canvas: HTMLCanvasElement, chains: Pt[][], alpha: number) {
  const ctx = canvas.getContext('2d')!;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = '#8cf0b8';
  ctx.fillStyle = '#8cf0b8';
  ctx.lineWidth = Math.max(2, canvas.width / 300);
  ctx.lineJoin = 'round';
  const r = Math.max(4, canvas.width / 180);
  for (const chain of chains) {
    ctx.beginPath();
    chain.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
    for (const p of chain) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

// Leaving the tab or the page turns the camera off.
document.querySelector('nav [data-tab="write"]')?.addEventListener('click', stopScan);
document.addEventListener('visibilitychange', () => {
  if (document.hidden && scanning) stopScan();
});

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(readText);
    copyBtn.textContent = 'Kopyalandı';
    setTimeout(() => (copyBtn.textContent = 'Kopyala'), 1500);
  } catch {
    /* clipboard unavailable */
  }
});
