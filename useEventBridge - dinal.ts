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
  const bufferCache = useRef<Map<string, ArrayBuffer>>(new Map());

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

    const handler = (event: MessageEvent) => {
      if (!originAllowed(event.origin)) return;
      const { type, ...data } = event.data ?? {};
      if (!type) return;

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
          const { buffer, fileName = 'document.pdf', fullPageOCR, wordIndex, categories, captures, Click2Pick, debugArea, showFieldsPanel, showAnnotation, showThumbnailView, initialZoom } = data;
          // Resolve the buffer — use cache if incoming buffer is detached
          let resolvedBuffer = buffer as ArrayBuffer | undefined;
          const isDetached = !resolvedBuffer ||
            !(resolvedBuffer instanceof ArrayBuffer) ||
            resolvedBuffer.byteLength === 0;

          if (isDetached) {
            // Incoming buffer is detached (parent sent as Transferable and reused).
            // Recover from cache if we loaded this file before.
            const cached = bufferCache.current.get(fileName);
            if (cached && cached.byteLength > 0) {
              console.warn('[DocCapture] LOAD_SINGLEDOC: incoming buffer detached — using cached copy for', fileName);
              resolvedBuffer = cached.slice(0); // fresh copy from cache
            } else {
              const reason = 'LOAD_SINGLEDOC received an empty/detached ArrayBuffer. ' +
                'Cache miss — file was never successfully loaded before. ' +
                'FIX in parent: do not use Transferable list, or keep a copy of the buffer.';
              console.error('[DocCapture]', reason);
              postToParent({ type: 'DOC_LOAD_ERROR', code: 'INVALID_BUFFER', reason, fileName });
              return;
            }
          } else {
            // Fresh valid buffer — store in cache for future re-opens
            bufferCache.current.set(fileName, (resolvedBuffer as ArrayBuffer).slice(0));
          }

          cbRef.current.onLoadSingleDoc(resolvedBuffer as ArrayBuffer, fileName, {
            wordIndex: fullPageOCR ?? wordIndex, categories, captures,
            Click2Pick: !!Click2Pick,
            showFieldsPanel:    showFieldsPanel    !== undefined ? !!showFieldsPanel    : undefined,
            showAnnotation:     showAnnotation     !== undefined ? !!showAnnotation     : undefined,
            showThumbnailView:  showThumbnailView  !== undefined ? !!showThumbnailView  : undefined,
            initialZoom:        initialZoom        !== undefined ? initialZoom          : undefined,
          });
          break;
        }

        case 'LOAD_MANIFEST': {
          const { manifest, activeDocId, activeBuffer, fullPageOCR, wordIndex, categories, captures, Click2Pick, debugArea, showFieldsPanel, showAnnotation, showThumbnailView, initialZoom } = data;
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
             showFieldsPanel !== undefined || initialZoom !== undefined)
              ? { wordIndex: fullPageOCR ?? wordIndex, categories, captures,
                  Click2Pick: !!Click2Pick,
                  debugArea:          debugArea          !== undefined ? !!debugArea          :
                                      showFieldsPanel    !== undefined ? !!showFieldsPanel    : undefined,
                  showAnnotation:     showAnnotation     !== undefined ? !!showAnnotation     : undefined,
                  showThumbnailView:  showThumbnailView  !== undefined ? !!showThumbnailView  : undefined,
                  initialZoom:        initialZoom        !== undefined ? initialZoom          : undefined,
                }
              : undefined;
          cbRef.current.onLoadManifest(manifest as DocumentManifest, activeDocId, activeBuffer, meta);
          break;
        }

        case 'DOC_RESPONSE': {
          const { docId, buffer, fullPageOCR, wordIndex, categories, captures } = data;
          const pending = pendingDocs.current.get(docId);
          if (!pending) {
            // Unexpected docId — likely a response to an already-timed-out request
            console.warn(`[EventBridge] DOC_RESPONSE for unknown docId="${docId}" — already timed out or duplicate response.`);
            return;
          }
          // Validate buffer — recover from cache if detached
          let docBuffer = buffer as ArrayBuffer | undefined;
          const docDetached = !docBuffer ||
            !(docBuffer instanceof ArrayBuffer) ||
            docBuffer.byteLength === 0;

          if (docDetached) {
            const cached = bufferCache.current.get(docId);
            if (cached && cached.byteLength > 0) {
              console.warn('[DocCapture] DOC_RESPONSE: buffer detached — using cache for', docId);
              docBuffer = cached.slice(0);
            } else {
              clearTimeout(pending.timer);
              pendingDocs.current.delete(docId);
              const reason = `DOC_RESPONSE for "${docId}" had an empty/detached ArrayBuffer. No cache available.`;
              postToParent({ type: 'DOC_LOAD_ERROR', code: 'INVALID_BUFFER', reason, docId });
              pending.reject(new Error(reason));
              return;
            }
          } else {
            // Cache the buffer keyed by docId for MultiDoc re-opens
            bufferCache.current.set(docId, (docBuffer as ArrayBuffer).slice(0));
          }
          clearTimeout(pending.timer);
          pendingDocs.current.delete(docId);
          pending.resolve(docBuffer as ArrayBuffer);
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
          // Parent responds to READY with optional config properties
          const config: ReadyConfig = {
            enableCaptureDebug: !!data.enableCaptureDebug,
            Click2Pick:         !!data.Click2Pick,
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
