// remeshQueue.js — budgeted chunk rebuilds (siege claim tint, etc.)
// Spreads expensive buildChunk work across frames so mobile doesn't hitch
// when a Keepstone disc grows.

import { rebuildChunkOnly } from './render.js';

/** Chunks rebuilt per animation frame during a siege. */
const PER_FRAME = (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) || (typeof window !== 'undefined' && 'ontouchstart' in window) ? 2 : 5;

const queue = [];          // [[wx,wz], ...]
const queued = new Set();  // "cx,cz"

export function queueChunkRemesh(wx, wz){
  const cx = (wx >> 4), cz = (wz >> 4);
  const k = cx + ',' + cz;
  if(queued.has(k)) return;
  queued.add(k);
  queue.push([wx, wz]);
}

/** Process up to PER_FRAME pending chunk rebuilds. Call once per frame. */
export function flushRemeshQueue(){
  let n = 0;
  while(queue.length && n < PER_FRAME){
    const [wx, wz] = queue.shift();
    const k = (wx >> 4) + ',' + (wz >> 4);
    queued.delete(k);
    try{ rebuildChunkOnly(wx, wz); }catch(e){ console.warn('[remesh]', e); }
    n++;
  }
  return n;
}

export function remeshQueueLength(){ return queue.length; }

export function clearRemeshQueue(){
  queue.length = 0;
  queued.clear();
}
