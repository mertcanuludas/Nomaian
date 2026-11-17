import { FrameResult, Reader } from './core/decode';

/**
 * 'photo' reads one image on its own. 'frame' adds a camera frame to the running scan, whose Reader
 * remembers what earlier frames showed, so a spiral can be read piece by piece; 'reset' starts a new scan.
 */
export type DecodeRequest =
  | { type: 'photo'; id: number; rgba: Uint8ClampedArray; width: number; height: number }
  | { type: 'frame'; id: number; rgba: Uint8ClampedArray; width: number; height: number; passes: number[] }
  | { type: 'reset' };

export interface DecodeResponse extends FrameResult {
  id: number;
}

let scan = new Reader();

self.onmessage = (e: MessageEvent<DecodeRequest>) => {
  const req = e.data;
  if (req.type === 'reset') {
    scan = new Reader();
    return;
  }
  const result =
    req.type === 'photo'
      ? new Reader().addFrame(req.rgba, req.width, req.height)
      : scan.addFrame(req.rgba, req.width, req.height, { passes: req.passes });
  const res: DecodeResponse = { id: req.id, ...result };
  (self as unknown as Worker).postMessage(res);
};
