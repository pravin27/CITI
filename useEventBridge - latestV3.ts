// ─────────────────────────────────────────────────────────────────────────────
// useEventBridge — single owner of all parent ↔ viewer postMessage communication
//
// STANDALONE PROTECTION: every outbound/inbound path is gated behind
//   const isEmbedded = window.self !== window.top
// When running directly in a browser tab (standalone testing), this hook
// attaches no listeners and sends no messages. Zero behaviour change.
//
// ORIGIN CHECK: set VITE_PARENT_ORIGIN in .env for production.
// Leave unset (defaults to '*') for standalone / development testing.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useCallback } from 'react';
import type { DocumentManifest } from '../types/multiDoc';
import type { CaptureItem, Category, WordEntry } from '../adapters/types';
import { useAppStore } from '../store/appStore';

// ── Environment ───────────────────────────────────────────────────────────────
const ALLOWED_ORIGIN: string =
  (import.meta as any).env?.VITE_PARENT_ORIGIN ?? '*';

// Is this app running inside an iframe?
export const isEmbedded: boolean = (() => {
  try { return window.self !== window.top; }
  catch { return true; } // cross-origin parent → definitely embedded
})();

// ── Payload types ─────────────────────────────────────────────────────────────

export interface SingleDocMeta {
  /** fullPageOCR (previously wordIndex) — page OCR/text data for Click2Pick and search */
  fullPageOCR?: Record<number, WordEntry[]> | any[];
  /** @deprecated use fullPageOCR */
  wordIndex?: Record<number, WordEntry[]> | any[];
  categories?: Category[];
  captures?: CaptureItem[];
  /** If true, enable box-capture mode immediately on load (Click2Pick). */
  Click2Pick?: boolean;
  /**
   * Show or hide the right-side debug/fields panel.
   * Default: false (hidden) when loaded from a parent via iframe.
   *          true (shown) when running standalone.
   * Alias: showFieldsPanel (both names accepted, debugArea takes priority).
   */
  debugArea?: boolean;
  /** @deprecated alias for debugArea — still accepted */
  showFieldsPanel?: boolean;
  /** If true, show the annotation/draw button in toolbar. Default: hidden. */
  showAnnotation?: boolean;
  /** If false, hide thumbnail sidebar. Default: true (shown). */
  showThumbnailView?: boolean;
  /**
   * Show the Split & Merge icon in the toolbar for this document.
   * The SM app URL is configured via VITE_SPLIT_MERGE_URL in the viewer's .env.
   * Default: false (icon hidden).
   */
  showSplitMerge?: boolean;
  /**
   * Initial zoom mode on document load.
   * Accepted values (case-insensitive):
   *   'page-fit'   — fit full page in viewport (default when omitted)
   *   'page-width' — fit page width, scroll vertically
   *   'actual'     — 100% zoom (aliases: '100%', 'actual-size', 'actual size')
   *   1.5          — explicit numeric zoom level (1.0 = 100%)
   * Aliases: 'fit'/'fit-page' → page-fit, 'width'/'fit-width' → page-width
   */
  initialZoom?: string | number;
}

// Config sent by parent in response to viewer's READY event
export interface ReadyConfig {
  /** Show the right-side capture debug panel (fields panel, legends etc.) */
  enableCaptureDebug?: boolean;
  /** Initial zoom — same values as SingleDocMeta.initialZoom */
  initialZoom?: string | number;
  /** Enable box-capture mode on load */
  Click2Pick?: boolean;
  /** Show the Split & Merge icon in the toolbar. Default: false */
  showSplitMerge?: boolean;
}

// Optional metadata that can accompany DOC_RESPONSE for a specific document
export interface DocResponseMeta {
  wordIndex?: Record<number, import('../adapters/types').WordEntry[]>;
  categories?: import('../adapters/types').Category[];
  captures?: import('../adapters/types').CaptureItem[];
}

export interface HighlightPayload {
  id: string;
  label?: string;
  value?: string;
  page: number;
  x: number; y: number; width: number; height: number;
  docId?: string;
  color?: string;
  sourceFormat?: CaptureItem['sourceFormat'];
}

export interface CapturePreviewPayload {
  tempId: string;
  text: string;
  page: number;
  x: number; y: number; width: number; height: number;
  docId?: string;
  label?: string;
  color?: string;
  /** FORMAT 10 round-trip: original [page, x_min, y_min, width, height] bbox */
  bbox?: [number, number, number, number, number];
}

// ── DOC_LOAD_ERROR codes ────────────────────────────────────────────────────
// Parent can use the code for programmatic handling, and reason for display.
export type DocLoadErrorCode =
  | 'INVALID_BUFFER'    // buffer is null, empty, or not a valid file
  | 'CORRUPT_FILE'      // file parsed but content is corrupt / unreadable
  | 'UNSUPPORTED_FORMAT'// file format not supported by the viewer
  | 'DOC_REQUEST_TIMEOUT' // parent did not respond to DOC_REQUEST within 60s
  | 'RENDER_FAILED'     // file loaded OK but page rendering failed
  | 'UNKNOWN';          // catch-all for unexpected errors

export interface EventBridgeCallbacks {
  onLoadSingleDoc: (buffer: ArrayBuffer, fileName: string, meta: SingleDocMeta) => void;
  onLoadManifest:  (manifest: DocumentManifest, activeDocId?: string, activeBuffer?: ArrayBuffer, meta?: SingleDocMeta) => void;
  onReset?:        () => void;  // optional — called on RESET_VIEWER
  onHighlight:     (payload: HighlightPayload) => void;
  onCaptureAck:     (tempId: string, realId: string) => void;
  onCaptureDelete?:  (id: string) => void;
  /** Called when parent sends SET_CAPTURES to load/replace captures after doc load */
  onSetCaptures?:   (
    captures: import('../adapters/types').CaptureItem[],
    mode:     'replace' | 'merge',
    docId?:   string,
  ) => void;
  onDocMeta?:       (docId: string, meta: DocResponseMeta) => void;
  /** Parent sent EXPORT_CAPTURES — viewer should respond with current captures data. */
  onExportRequest?: () => void;
  /** Parent responded to READY with config — e.g. enableCaptureDebug */
  onReadyConfig?: (config: ReadyConfig) => void;
}

export interface EventBridgeAPI {
  requestDocBuffer:   (docId: string) => Promise<ArrayBuffer>;
  emitCapturePreview: (payload: CapturePreviewPayload) => void;
  emitDocLoaded:      (info: { fileName: string; pageCount: number; docId?: string | null }) => void;
  emitDocLoadError:   (info: { reason: string; code: DocLoadErrorCode; docId?: string | null; fileName?: string }) => void;
  waitForAck:         (tempId: string, timeoutMs?: number) => Promise<string>;
  resolveAck:         (tempId: string, realId: string) => void;
  /** Call when user draws a box or double-clicks.
   *  Fires CAPTURE_PREVIEW to parent, waits for ACK, then resolves with realId.
   *  Rejects after 15s if parent doesn't respond. */
  handleCaptureResult: (result: CapturePreviewPayload & { docId?: string }) => Promise<string>;
  /** Respond to parent's EXPORT_CAPTURES request with current captured fields. */
  respondCaptures: (captures: ExportedCapture[]) => void;
}

// Shape of each capture in the EXPORT_CAPTURES event — same as TopBar JSON export
export interface ExportedCapture {
  id: string;
  value: string;
  page: number;
  color?: string;
  // Coordinates in the same format as the source (x/y/w/h, bbox, rectangle, coordinates)
  x?: number; y?: number; width?: number; height?: number;
  bbox?: number[];
  rectangle?: number[];
  coordinates?: number[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let _tempIdCounter = 0;
export function generateTempId(): string {
  return `tmp_${Date.now()}_${++_tempIdCounter}`;
}

function postToParent(msg: Record<string, unknown>) {
  if (!isEmbedded) return;
  window.parent.postMessage(msg, ALLOWED_ORIGIN === '*' ? '*' : ALLOWED_ORIGIN);
}

function originAllowed(origin: string): boolean {
  if (ALLOWED_ORIGIN === '*') return true;
  return origin === ALLOWED_ORIGIN;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useEventBridge(callbacks: EventBridgeCallbacks): EventBridgeAPI {
  // Pending DOC_REQUEST promises: docId → { resolve, reject, timer }
  // Buffer cache: fileName/docId → ArrayBuffer copy
  // Allows recovery when parent re-sends an already-transferred (detached) buffer.
  // Capped at same size as MultiDoc LRU (10 slots) to bound memory usage.
  // When cap is reached, oldest entry is evicted (simple FIFO via Map insertion order).
  const BUFFER_CACHE_MAX = 10;
  const bufferCache = useRef<Map<string, ArrayBuffer>>(new Map());
  const addToBufferCache = (key: string, buf: ArrayBuffer) => {
    const cache = bufferCache.current;
    if (cache.has(key)) cache.delete(key); // re-insert at end (most recent)
    else if (cache.size >= BUFFER_CACHE_MAX) {
      // Evict oldest entry
      cache.delete(cache.keys().next().value as string);
    }
    cache.set(key, buf);
  };

  const pendingDocs = useRef<Map<string, {
    resolve: (buf: ArrayBuffer) => void;
    reject:  (err: Error) => void;
    timer:   ReturnType<typeof setTimeout>;
  }>>(new Map());

  // Pending CAPTURE_ACK promises: tempId → { resolve, reject, timer }
  const pendingAcks = useRef<Map<string, {
    resolve: (realId: string) => void;
    reject:  (err: Error) => void;
    timer:   ReturnType<typeof setTimeout>;
  }>>(new Map());

  // Keep callbacks ref stable
  const cbRef = useRef(callbacks);
  useEffect(() => { cbRef.current = callbacks; });

  // ── Message handler ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isEmbedded) return; // standalone — do nothing

    const handler = async (event: MessageEvent) => {
      if (!originAllowed(event.origin)) return;
      const { type, ...data } = event.data ?? {};
      if (!type) return;

      // When Split & Merge iframe is active:
      //   - DOC_RESPONSE, SET_CAPTURES, DELETE_CAPTURE, CAPTURE_ACK, ALL_DOC_RESPONSE
      //     are FORWARDED to the SM iframe (zero-copy for ArrayBuffer payloads)
      //     so the SM app receives exactly what the parent sent.
      //   - LOAD_SINGLEDOC, LOAD_MANIFEST, RESET_VIEWER close SM and restore viewer.
      //   - All other events handled normally.
      const smActive = (window as any).__doccapture_sm_active === true;

      // Events to forward to SM iframe when SM is active
      const SM_FORWARD = new Set([
        'DOC_RESPONSE', 'ALL_DOC_RESPONSE',
        'SET_CAPTURES', 'DELETE_CAPTURE', 'CAPTURE_ACK',
      ]);

      if (smActive && SM_FORWARD.has(type)) {
        // Forward to SM iframe — zero-copy transfer for ArrayBuffer payloads
        const smIframe = document.querySelector<HTMLIFrameElement>(
          'iframe[title="Split & Merge"]'
        );
        const smWin = smIframe?.contentWindow;
        if (smWin) {
          const raw = event.data as Record<string, unknown>;
          // Collect any ArrayBuffer fields for zero-copy Transferable transfer
          const transferables: ArrayBuffer[] = [];
          const msgCopy: Record<string, unknown> = { ...raw };
          for (const key of ['buffer', 'activeBuffer'] as const) {
            if (raw[key] instanceof ArrayBuffer && (raw[key] as ArrayBuffer).byteLength > 0) {
              const buf = (raw[key] as ArrayBuffer).slice(0);
              msgCopy[key] = buf;
              transferables.push(buf);
            }
          }
          if (transferables.length > 0) {
            smWin.postMessage(msgCopy, '*', transferables);
          } else {
            smWin.postMessage(raw, '*');
          }
        }
        return; // viewer does not process these while SM is active
      }

      // If SM is active and a new doc load arrives → close SM, restore viewer
      if (smActive && (type === 'LOAD_SINGLEDOC' || type === 'LOAD_MANIFEST' || type === 'RESET_VIEWER')) {
        (window as any).__doccapture_sm_active = false;
        (window as any).__doccapture_closeSplitMerge?.();
        // Continue processing so the viewer loads the new document
      }

      switch (type) {
        // ── RESET_VIEWER ────────────────────────────────────────────────────
        // Clears everything and returns the viewer to blank "no document" state.
        // Send this before loading a new document set, or when navigating away.
        case 'RESET_VIEWER': {
          useAppStore.getState().closeFile();
          bufferCache.current.clear(); // clear cached buffers on full reset
          cbRef.current.onReset?.();
          break;
        }

        case 'LOAD_SINGLEDOC': {
          const { buffer, url: fileUrl, fileName = 'document.pdf', fullPageOCR, wordIndex, categories, captures, Click2Pick, debugArea, showFieldsPanel, showAnnotation, showThumbnailView, initialZoom, showSplitMerge: sdShowSM } = data;

          // ── Resolve the ArrayBuffer — three paths in priority order ──────
          // Path 1: URL provided (blob: or https:) — viewer fetches itself, zero transfer risk
          // Path 2: ArrayBuffer provided and valid — use directly, cache for reopen
          // Path 3: Buffer detached — fall back to cache from previous load
          let resolvedBuffer: ArrayBuffer | null = null;

          if (fileUrl && typeof fileUrl === 'string') {
            // Path 1: URL-based — most reliable, no transfer/detach risk
            try {
              const resp = await fetch(fileUrl);
              if (!resp.ok) throw new Error('HTTP ' + resp.status);
              resolvedBuffer = await resp.arrayBuffer();
              addToBufferCache(fileName, resolvedBuffer.slice(0));
            } catch (e) {
              const reason = 'LOAD_SINGLEDOC: failed to fetch url "' + fileUrl + '": ' + String(e);
              postToParent({ type: 'DOC_LOAD_ERROR', code: 'INVALID_BUFFER', reason, fileName });
              return;
            }
          } else if (buffer instanceof ArrayBuffer && buffer.byteLength > 0) {
            // Path 2: Valid ArrayBuffer received — use it and cache for reopen
            resolvedBuffer = buffer;
            addToBufferCache(fileName, buffer.slice(0));
          } else {
            // Path 3: Buffer missing/detached — try cache
            const cached = bufferCache.current.get(fileName);
            if (cached && cached.byteLength > 0) {
              console.warn('[DocCapture] LOAD_SINGLEDOC: buffer missing/detached — using cache for', fileName);
              resolvedBuffer = cached.slice(0);
            } else {
              const reason =
                'LOAD_SINGLEDOC: no valid buffer or url received for "' + fileName + '". ' +
                'Send either: { buffer: ArrayBuffer } or { url: "blob:..." }. ' +
                'If using ArrayBuffer with transfer list, the buffer is detached after first send — ' +
                'use structuredClone(buffer) or omit the transfer list.';
              postToParent({ type: 'DOC_LOAD_ERROR', code: 'INVALID_BUFFER', reason, fileName });
              return;
            }
          }

          // Store the complete original payload for forwarding to SM iframe
          (window as any).__doccapture_last_parent_msg = { ...data, type: 'LOAD_SINGLEDOC', buffer: resolvedBuffer };

          cbRef.current.onLoadSingleDoc(resolvedBuffer!, fileName, {
            wordIndex: fullPageOCR ?? wordIndex, categories, captures,
            Click2Pick: !!Click2Pick,
            showFieldsPanel:    showFieldsPanel !== undefined ? !!showFieldsPanel    : undefined,
            showAnnotation:     showAnnotation  !== undefined ? !!showAnnotation     : undefined,
            showThumbnailView:  showThumbnailView !== undefined ? !!showThumbnailView : undefined,
            initialZoom:        initialZoom     !== undefined ? initialZoom          : undefined,
            showSplitMerge:     sdShowSM        !== undefined ? !!sdShowSM           : undefined,
          });
          break;
        }

        case 'LOAD_MANIFEST': {
          const { manifest, activeDocId, activeBuffer, fullPageOCR, wordIndex, categories, captures, Click2Pick, debugArea, showFieldsPanel, showAnnotation, showThumbnailView, initialZoom, showSplitMerge: mfShowSM } = data;
          if (!manifest || typeof manifest !== 'object') {
            postToParent({
              type: 'DOC_LOAD_ERROR', code: 'INVALID_BUFFER',
              reason: 'LOAD_MANIFEST received no manifest object. Ensure { type:"LOAD_MANIFEST", manifest: { mode, documents } } is sent.',
            });
            return;
          }
          if (!manifest.mode || !Array.isArray(manifest.documents)) {
            postToParent({
              type: 'DOC_LOAD_ERROR', code: 'INVALID_BUFFER',
              reason: `LOAD_MANIFEST manifest is missing required fields. Got: mode="${manifest.mode}", documents=${Array.isArray(manifest.documents) ? manifest.documents.length + ' items' : 'missing'}.`,
            });
            return;
          }
          if (activeBuffer instanceof ArrayBuffer && activeBuffer.byteLength === 0) {
            postToParent({
              type: 'DOC_LOAD_ERROR', code: 'INVALID_BUFFER',
              reason: `LOAD_MANIFEST activeBuffer for docId="${activeDocId}" is empty (byteLength=0). The buffer may have been transferred already.`,
              docId: activeDocId,
            });
            return;
          }
          const meta: SingleDocMeta | undefined =
            (wordIndex || categories || captures || Click2Pick !== undefined ||
             showFieldsPanel !== undefined || initialZoom !== undefined || mfShowSM !== undefined)
              ? { wordIndex: fullPageOCR ?? wordIndex, categories, captures,
                  Click2Pick: !!Click2Pick,
                  debugArea:         debugArea       !== undefined ? !!debugArea       :
                                     showFieldsPanel !== undefined ? !!showFieldsPanel : undefined,
                  showAnnotation:    showAnnotation    !== undefined ? !!showAnnotation    : undefined,
                  showThumbnailView: showThumbnailView !== undefined ? !!showThumbnailView : undefined,
                  initialZoom:       initialZoom       !== undefined ? initialZoom         : undefined,
                  showSplitMerge:    mfShowSM          !== undefined ? !!mfShowSM          : undefined,
                }
              : undefined;
          // Store the complete original payload for forwarding to SM iframe
          (window as any).__doccapture_last_parent_msg = {
            ...data, type: 'LOAD_MANIFEST',
            activeBuffer: activeBuffer ?? null,
          };
          cbRef.current.onLoadManifest(manifest as DocumentManifest, activeDocId, activeBuffer, meta);
          break;
        }

        case 'DOC_RESPONSE': {
          const { docId, buffer, url: docUrl, fullPageOCR, wordIndex, categories, captures } = data;
          const pending = pendingDocs.current.get(docId);
          if (!pending) {
            console.warn(`[EventBridge] DOC_RESPONSE for unknown docId="${docId}" — already timed out or duplicate.`);
            return;
          }

          // Resolve buffer — three paths (URL / ArrayBuffer / cache)
          let docBuffer: ArrayBuffer | null = null;

          if (docUrl && typeof docUrl === 'string') {
            // Path 1: URL — viewer fetches directly, no transfer risk
            try {
              const resp = await fetch(docUrl);
              if (!resp.ok) throw new Error('HTTP ' + resp.status);
              docBuffer = await resp.arrayBuffer();
              addToBufferCache(docId, docBuffer.slice(0));
            } catch (e) {
              clearTimeout(pending.timer); pendingDocs.current.delete(docId);
              const reason = 'DOC_RESPONSE: failed to fetch url for "' + docId + '": ' + String(e);
              postToParent({ type: 'DOC_LOAD_ERROR', code: 'INVALID_BUFFER', reason, docId });
              pending.reject(new Error(reason)); return;
            }
          } else if (buffer instanceof ArrayBuffer && buffer.byteLength > 0) {
            // Path 2: Valid ArrayBuffer
            docBuffer = buffer;
            addToBufferCache(docId, buffer.slice(0));
          } else {
            // Path 3: Cache fallback
            const cached = bufferCache.current.get(docId);
            if (cached && cached.byteLength > 0) {
              console.warn('[DocCapture] DOC_RESPONSE: buffer detached — using cache for', docId);
              docBuffer = cached.slice(0);
            } else {
              clearTimeout(pending.timer); pendingDocs.current.delete(docId);
              const reason = 'DOC_RESPONSE for "' + docId + '": no valid buffer or url. Send { buffer } or { url }.';
              postToParent({ type: 'DOC_LOAD_ERROR', code: 'INVALID_BUFFER', reason, docId });
              pending.reject(new Error(reason)); return;
            }
          }

          clearTimeout(pending.timer);
          pendingDocs.current.delete(docId);
          pending.resolve(docBuffer!);
          // Fire optional meta callback if any meta fields were included
          const resolvedOCR = fullPageOCR ?? wordIndex;
          if (cbRef.current.onDocMeta && (resolvedOCR || categories || captures)) {
            cbRef.current.onDocMeta(docId, { wordIndex: resolvedOCR, categories, captures });
          }
          break;
        }

        case 'CAPTURE_ACK': {
          const { tempId, id: realId, delete: shouldDelete, x, y, width, height } = data;

          // ── DELETE path: tempId is NOT required ──────────────────────────
          // Parent deletes an already-confirmed capture by its real ID.
          // tempId only exists during the preview round-trip and is not
          // available to the parent when deleting a pre-loaded capture.
          const hasCoords = (typeof x === 'number' && x !== 0) ||
                            (typeof y === 'number' && y !== 0) ||
                            (typeof width === 'number' && width > 0) ||
                            (typeof height === 'number' && height > 0);
          const isDelete  = shouldDelete || (data.hasOwnProperty('x') && !hasCoords);

          if (isDelete && realId && typeof realId === 'string' && realId.trim()) {
            cbRef.current.onCaptureDelete?.(realId.trim());
            // Also resolve any pending ACK for this tempId (preview round-trip)
            if (tempId) {
              const pending = pendingAcks.current.get(tempId);
              if (pending) { clearTimeout(pending.timer); pendingAcks.current.delete(tempId); pending.reject(new Error('delete')); }
            }
            break;
          }

          // ── NORMAL ACK path: tempId required ─────────────────────────────
          if (!tempId) break;

          if (!realId || typeof realId !== 'string' || realId.trim() === '') {
            console.warn('[EventBridge] CAPTURE_ACK has no valid id — preview cleared without saving.');
            const pending = pendingAcks.current.get(tempId);
            if (pending) { clearTimeout(pending.timer); pendingAcks.current.delete(tempId); pending.reject(new Error('no valid id')); }
            break;
          }

          cbRef.current.onCaptureAck(tempId, realId as string);
          break;
        }

        // ── DELETE_CAPTURE — dedicated event, no tempId needed ────────────
        // Simpler alternative to CAPTURE_ACK + delete:true.
        // Send from parent to delete any confirmed capture by its real ID.
        case 'DELETE_CAPTURE': {
          const { id } = data;
          if (!id || typeof id !== 'string' || !id.trim()) {
            console.warn('[EventBridge] DELETE_CAPTURE requires a valid id.');
            break;
          }
          cbRef.current.onCaptureDelete?.(id.trim());
          break;
        }

        // ── SET_CAPTURES ────────────────────────────────────────────────────
        // Load or replace captured fields at any time after the document loads.
        // Use this when captures are fetched from a backend after the PDF is
        // already shown — no need to reload the document.
        //
        // Payload:
        //   captures: CaptureItem[]  — array of capture objects (same format as
        //             the captures[] field in LOAD_SINGLEDOC / DOC_RESPONSE)
        //   mode?:    'replace' (default) — replaces all existing captures
        //             'merge'             — merges by id (upsert), keeps others
        //   docId?:   string — for MultiDoc, target a specific document
        //
        // Example:
        //   { type: 'SET_CAPTURES',
        //     captures: [{ id:'f1', label:'Invoice No', value:'INV-001',
        //                  page:1, x:0.1, y:0.12, width:0.25, height:0.03 }],
        //     mode: 'merge' }
        case 'SET_CAPTURES': {
          const { captures: incomingCaps, mode = 'replace', docId } = data;
          if (!Array.isArray(incomingCaps)) {
            console.warn('[EventBridge] SET_CAPTURES: captures must be an array.');
            break;
          }
          cbRef.current.onSetCaptures?.(
            incomingCaps as import('../adapters/types').CaptureItem[],
            mode as 'replace' | 'merge',
            docId as string | undefined,
          );
          break;
        }

        case 'EXPORT_CAPTURES': {
          // Parent is requesting the current captured fields
          cbRef.current.onExportRequest?.();
          break;
        }

        case 'READY_CONFIG': {
          const config: ReadyConfig = {
            enableCaptureDebug: !!data.enableCaptureDebug,
            Click2Pick:         !!data.Click2Pick,
            showSplitMerge:     !!data.showSplitMerge,
          };
          cbRef.current.onReadyConfig?.(config);
          break;
        }

        case 'HIGHLIGHT': {
          const { payload } = data;
          if (!payload) return;
          // id is required — without it we cannot deduplicate, navigate,
          // or add to captures. Silently ignore the entire event.
          const hid = payload?.id;
          if (!hid || typeof hid !== 'string' || hid.trim() === '') {
            console.warn('[EventBridge] HIGHLIGHT ignored — missing or empty id:', payload);
            return;
          }
          cbRef.current.onHighlight(payload as HighlightPayload);
          break;
        }
      }
    };

    window.addEventListener('message', handler);

    // Fire READY so parent knows iframe is listening
    postToParent({ type: 'READY' });

    return () => window.removeEventListener('message', handler);
  }, []); // mount once

  // ── API ─────────────────────────────────────────────────────────────────────

  const requestDocBuffer = useCallback((docId: string): Promise<ArrayBuffer> => {
    if (!isEmbedded) return Promise.reject(new Error('Not embedded'));

    // Return existing promise if already in-flight
    if (pendingDocs.current.has(docId)) {
      return new Promise((resolve, reject) => {
        const existing = pendingDocs.current.get(docId)!;
        const origResolve = existing.resolve;
        const origReject  = existing.reject;
        existing.resolve = (buf) => { origResolve(buf); resolve(buf); };
        existing.reject  = (err) => { origReject(err);  reject(err);  };
      });
    }

    return new Promise((resolve, reject) => {
      // DOC_REQUEST has NO hard cap — documents can be large and the parent
      // may need time to fetch from a backend. We show the existing loading
      // spinner for the full wait period.
      // After 60 s with no response we reject with a friendly error so the
      // user isn't stuck on a blank loader forever.
      const timer = setTimeout(() => {
        pendingDocs.current.delete(docId);
        const timeoutErr = `Document "${docId}" could not be loaded — parent did not respond within 60 seconds.`;
        postToParent({
          type: 'DOC_LOAD_ERROR',
          code: 'DOC_REQUEST_TIMEOUT',
          reason: timeoutErr,
          docId,
        });
        reject(new Error(timeoutErr));
      }, 60_000); // 60 s — generous for large files over slow connections

      pendingDocs.current.set(docId, { resolve, reject, timer });
      postToParent({ type: 'DOC_REQUEST', docId });
    });
  }, []);

  const emitCapturePreview = useCallback((payload: CapturePreviewPayload) => {
    postToParent({ type: 'CAPTURE_PREVIEW', ...payload });
  }, []);

  const emitDocLoaded = useCallback((info: { fileName: string; pageCount: number; docId?: string | null }) => {
    postToParent({ type: 'DOC_LOADED', ...info });
  }, []);

  const emitDocLoadError = useCallback((info: {
    reason: string;
    code: DocLoadErrorCode;
    docId?: string | null;
    fileName?: string;
  }) => {
    console.error('[DocCapture] DOC_LOAD_ERROR', info);
    postToParent({ type: 'DOC_LOAD_ERROR', ...info });
  }, []);

  // waitForAck — called by FieldsPanel after emitCapturePreview
  const waitForAck = useCallback((tempId: string, timeoutMs = 25_000): Promise<string> => {
    // Default 25 s for CAPTURE_ACK — parent needs time to call its backend
    // and return an id. Max recommended: 30 s. Caller can override timeoutMs.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingAcks.current.delete(tempId);
        reject(new Error(
          `Capture confirmation timed out after ${Math.round(timeoutMs / 1000)} s — ` +
          `the parent application did not acknowledge the capture. The preview has been cleared.`
        ));
      }, timeoutMs);
      pendingAcks.current.set(tempId, { resolve, reject, timer });
    });
  }, []);

  // resolveAck — called by App.tsx via onCaptureAck callback
  const resolveAck = useCallback((tempId: string, realId: string) => {
    const pending = pendingAcks.current.get(tempId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingAcks.current.delete(tempId);
    pending.resolve(realId);
  }, []);

  // Central capture handler — fires CAPTURE_PREVIEW, waits for CAPTURE_ACK
  const handleCaptureResult = useCallback((
    payload: CapturePreviewPayload & { docId?: string }
  ): Promise<string> => {
    const tempId = generateTempId();
    emitCapturePreview({ ...payload, tempId });
    return waitForAck(tempId, 25_000); // 25 s — within the 20-30 s window
  }, [emitCapturePreview, waitForAck]);

  // Respond to parent's EXPORT_CAPTURES request with current captured fields
  const respondCaptures = useCallback((captures: ExportedCapture[]) => {
    postToParent({ type: 'CAPTURES_DATA', captures });
  }, []);

  return { requestDocBuffer, emitCapturePreview, emitDocLoaded, emitDocLoadError, waitForAck, resolveAck, handleCaptureResult, respondCaptures };
}
