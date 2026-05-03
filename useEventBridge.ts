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
}

// Config sent by parent in response to viewer's READY event
export interface ReadyConfig {
  /** Show the right-side capture debug panel (fields panel, legends etc.) */
  enableCaptureDebug?: boolean;
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

export interface EventBridgeCallbacks {
  onLoadSingleDoc: (buffer: ArrayBuffer, fileName: string, meta: SingleDocMeta) => void;
  onLoadManifest:  (manifest: DocumentManifest, activeDocId?: string, activeBuffer?: ArrayBuffer, meta?: SingleDocMeta) => void;
  onHighlight:     (payload: HighlightPayload) => void;
  onCaptureAck:     (tempId: string, realId: string) => void;
  onCaptureDelete?: (id: string) => void;
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
          if (multiDoc?.clearMultiDoc) multiDoc.clearMultiDoc();
          break;
        }

        case 'LOAD_SINGLEDOC': {
          const { buffer, fileName = 'document.pdf', fullPageOCR, wordIndex, categories, captures, Click2Pick, debugArea, showFieldsPanel, showAnnotation, showThumbnailView } = data;
          if (!buffer) return;
          cbRef.current.onLoadSingleDoc(buffer as ArrayBuffer, fileName, {
            wordIndex: fullPageOCR ?? wordIndex, categories, captures,
            Click2Pick: !!Click2Pick,
            showFieldsPanel:    showFieldsPanel    !== undefined ? !!showFieldsPanel    : undefined,
            showAnnotation:     showAnnotation     !== undefined ? !!showAnnotation     : undefined,
            showThumbnailView:  showThumbnailView  !== undefined ? !!showThumbnailView  : undefined,
          });
          break;
        }

        case 'LOAD_MANIFEST': {
          const { manifest, activeDocId, activeBuffer, fullPageOCR, wordIndex, categories, captures, Click2Pick, debugArea, showFieldsPanel, showAnnotation, showThumbnailView } = data;
          if (!manifest) return;
          const meta: SingleDocMeta | undefined =
            (wordIndex || categories || captures || Click2Pick !== undefined || showFieldsPanel !== undefined)
              ? { wordIndex: fullPageOCR ?? wordIndex, categories, captures,
                  Click2Pick: !!Click2Pick,
                  debugArea:          debugArea          !== undefined ? !!debugArea          :
                                      showFieldsPanel    !== undefined ? !!showFieldsPanel    : undefined,
                  showAnnotation:     showAnnotation     !== undefined ? !!showAnnotation     : undefined,
                  showThumbnailView:  showThumbnailView  !== undefined ? !!showThumbnailView  : undefined,
                }
              : undefined;
          cbRef.current.onLoadManifest(manifest as DocumentManifest, activeDocId, activeBuffer, meta);
          break;
        }

        case 'DOC_RESPONSE': {
          const { docId, buffer, fullPageOCR, wordIndex, categories, captures } = data;
          const pending = pendingDocs.current.get(docId);
          if (!pending) return;
          clearTimeout(pending.timer);
          pendingDocs.current.delete(docId);
          pending.resolve(buffer as ArrayBuffer);
          // Fire optional meta callback if any meta fields were included
          const resolvedOCR = fullPageOCR ?? wordIndex;
          if (cbRef.current.onDocMeta && (resolvedOCR || categories || captures)) {
            cbRef.current.onDocMeta(docId, { wordIndex: resolvedOCR, categories, captures });
          }
          break;
        }

        case 'CAPTURE_ACK': {
          const { tempId, id: realId, delete: shouldDelete, x, y, width, height } = data;
          if (!tempId) break;

          // No valid id → reject, preview clears without saving
          if (!realId || typeof realId !== 'string' || realId.trim() === '') {
            console.warn('[EventBridge] CAPTURE_ACK has no valid id — preview cleared without saving.');
            const pending = pendingAcks.current.get(tempId);
            if (pending) { clearTimeout(pending.timer); pendingAcks.current.delete(tempId); pending.reject(new Error('no valid id')); }
            break;
          }

          // Parent signals delete: explicit flag OR coords are all zero/missing
          const hasCoords = (typeof x === 'number' && x !== 0) ||
                            (typeof y === 'number' && y !== 0) ||
                            (typeof width === 'number' && width > 0) ||
                            (typeof height === 'number' && height > 0);
          if (shouldDelete || (data.hasOwnProperty('x') && !hasCoords)) {
            cbRef.current.onCaptureDelete?.(realId as string);
            const pending = pendingAcks.current.get(tempId);
            if (pending) { clearTimeout(pending.timer); pendingAcks.current.delete(tempId); pending.reject(new Error('delete')); }
            break;
          }

          cbRef.current.onCaptureAck(tempId, realId as string);
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
        reject(new Error(
          `Document "${docId}" could not be loaded — the parent application ` +
          `did not respond within 60 seconds. Please try again.`
        ));
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

  return { requestDocBuffer, emitCapturePreview, emitDocLoaded, waitForAck, resolveAck, handleCaptureResult, respondCaptures };
}
