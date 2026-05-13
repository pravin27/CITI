import React, { useRef, useCallback, useEffect, useState } from 'react';
import { useAppStore } from '../store/appStore';

// ── Helpers ────────────────────────────────────────────────────────────────────
function Sep() {
  return <div className="w-px h-5 bg-white/25 mx-1 shrink-0" />;
}

function Ic({
  onClick, title, active = false, disabled = false, children, className = '',
}: {
  onClick?: () => void; title: string; active?: boolean;
  disabled?: boolean; children: React.ReactNode; className?: string;
}) {
  return (
    <button
      onClick={onClick} title={title} disabled={disabled}
      className={`w-8 h-8 rounded flex items-center justify-center
        border transition-all shrink-0 text-white
        ${active
          ? 'bg-[#0a84ff]/22 border-[#0a84ff]/60 opacity-100'
          : 'border-transparent opacity-90 hover:opacity-100 hover:bg-white/10 hover:border-white/20'}
        ${disabled ? '!opacity-25 cursor-not-allowed' : ''}
        ${className}`}
    >
      {children}
    </button>
  );
}

// ── Zoom control ──────────────────────────────────────────────────────────────
function ZoomControl({ applyPresetFn }: { applyPresetFn: (mode: string, z?: number) => void }) {
  const zoom        = useAppStore(s => s.zoom);
  const zoomMode    = useAppStore(s => s.zoomMode);
  const setZoom     = useAppStore(s => s.setZoom);
  const adapter     = useAppStore(s => s.adapter);
  const pageCount   = useAppStore(s => s.pageCount) || adapter?.pageCount || 0;

  // Reset to page-fit when no document
  useEffect(() => {
    if (!adapter) {
      const s = useAppStore.getState();
      if (s.zoomMode !== 'page-fit') useAppStore.setState({ zoomMode: 'page-fit', zoom: 1.0 });
    }
  }, [adapter]);

  // Non-PDF auto-apply
  useEffect(() => {
    if (!adapter) return;
    const format = useAppStore.getState().format;
    if (format === 'pdf') return;
    if (zoomMode !== 'page-fit' && zoomMode !== 'page-width') return;
    const mode = zoomMode;
    setTimeout(() => {
      const m = useAppStore.getState().zoomMode;
      if (m === 'page-fit' || m === 'page-width') applyPresetFn(m);
    }, 80);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter]);

  const label = (!adapter || zoomMode === 'page-fit') ? 'Page Fit'
    : zoomMode === 'page-width' ? 'Page Width'
    : zoomMode === 'actual'     ? 'Actual Size'
    : `${Math.round(zoom * 100)}%`;

  const currentVal = (!adapter || zoomMode === 'page-fit') ? 'page-fit'
    : zoomMode === 'page-width' ? 'page-width'
    : zoomMode === 'actual'     ? 'actual'
    : String(Math.round(zoom * 100) / 100);

  const numSteps = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0];

  const stepZoom = (dir: number) => {
    if (zoomMode !== 'custom') { applyPresetFn('custom', dir > 0 ? 1.25 : 0.75); return; }
    const idx = numSteps.findIndex(s => Math.abs(s - zoom) < 0.01);
    if (idx === -1) { applyPresetFn('custom', dir > 0 ? 1.25 : 0.75); return; }
    const next = numSteps[Math.max(0, Math.min(numSteps.length - 1, idx + dir))];
    applyPresetFn('custom', next);
  };

  const onSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    if (v === 'page-fit' || v === 'page-width' || v === 'actual') {
      applyPresetFn(v);
    } else {
      applyPresetFn('custom', parseFloat(v));
    }
  };

  return (
    <div className="flex items-center gap-0.5 shrink-0">
      <Ic onClick={() => stepZoom(-1)} title="Zoom out" disabled={zoom <= 0.1}>
        <svg width="19" height="19" viewBox="0 0 13 13" fill="none">
          <circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.1"/>
          <path d="M3.5 5.5h4M8.5 8.5l2.5 2.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
        </svg>
      </Ic>

      {/* White dropdown — matches reference screenshot */}
      <div className="relative shrink-0">
        <select
          value={currentVal}
          onChange={onSelect}
          className="h-[26px] pl-2 pr-6 bg-white border-none rounded text-[#1a2636] text-xs
            font-semibold outline-none cursor-pointer appearance-none w-[108px]"
          style={{ WebkitAppearance: 'none' }}
        >
          <option value="page-fit">Page Fit</option>
          <option value="page-width">Page Width</option>
          <option value="actual">Actual Size</option>
          <option disabled>──────────</option>
          <option value="0.5">50%</option>
          <option value="0.75">75%</option>
          <option value="1">100%</option>
          <option value="1.25">125%</option>
          <option value="1.5">150%</option>
          <option value="2">200%</option>
          <option value="3">300%</option>
        </select>
        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none text-[#1a2636]">
          <svg width="8" height="5" viewBox="0 0 8 5" fill="currentColor"><path d="M0 0l4 5 4-5z"/></svg>
        </span>
      </div>

      <Ic onClick={() => stepZoom(1)} title="Zoom in" disabled={zoom >= 5}>
        <svg width="19" height="19" viewBox="0 0 13 13" fill="none">
          <circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.1"/>
          <path d="M5.5 3.5v4M3.5 5.5h4M8.5 8.5l2.5 2.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
        </svg>
      </Ic>
    </div>
  );
}

// ── Page number input ─────────────────────────────────────────────────────────
function PageInput() {
  const currentPage    = useAppStore(s => s.currentPage);
  const adapter        = useAppStore(s => s.adapter);
  const setCurrentPage = useAppStore(s => s.setCurrentPage);
  const storePageCount = useAppStore(s => s.pageCount);
  const pageCount = storePageCount || adapter?.pageCount || 0;
  const [editing, setEditing] = useState(false);
  const [val, setVal]         = useState('');

  const commit = () => {
    const p = parseInt(val);
    if (!isNaN(p) && p >= 1 && p <= pageCount) {
      setCurrentPage(p);
      adapter?.navigateToPage(p);
    }
    setEditing(false);
  };

  const singlePage = pageCount <= 1;

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      {editing && !singlePage ? (
        <input
          autoFocus value={val}
          onChange={e => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
          className="w-9 h-[24px] text-center text-xs font-semibold bg-white text-[#1a2636]
            border-none rounded outline-none"
        />
      ) : (
        <button
          onClick={() => { if (!singlePage) { setVal(String(currentPage)); setEditing(true); } }}
          className={`w-9 h-[24px] text-center text-xs font-semibold rounded transition-colors
            bg-white text-[#1a2636]
            ${singlePage ? 'cursor-default opacity-70' : 'cursor-pointer hover:opacity-90'}`}
          title={singlePage ? undefined : 'Click to jump to page'}
        >
          {currentPage || 1}
        </button>
      )}
      <span className="text-white text-xs font-medium whitespace-nowrap">
        of {pageCount || 1}
      </span>
    </div>
  );
}

// ── Search panel ──────────────────────────────────────────────────────────────
function SearchPanel() {
  const search        = useAppStore(s => s.search);
  const setSearchOpen = useAppStore(s => s.setSearchOpen);
  const setQuery      = useAppStore(s => s.setSearchQuery);
  const setOption     = useAppStore(s => s.setSearchOption);
  const runSearch     = useAppStore(s => s.runSearch);
  const searchNext    = useAppStore(s => s.searchNext);
  const searchPrev    = useAppStore(s => s.searchPrev);
  const clearSearch   = useAppStore(s => s.clearSearch);
  const inputRef      = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (search.isOpen) setTimeout(() => inputRef.current?.focus(), 50);
  }, [search.isOpen]);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!search.query.trim()) return;
      if (e.shiftKey) { if (search.results.length === 0) runSearch(); else searchPrev(); }
      else            { if (search.results.length === 0) runSearch(); else searchNext(); }
    }
    if (e.key === 'Escape') { setSearchOpen(false); clearSearch(); }
  };

  if (!search.isOpen) return null;
  const hasResults = search.results.length > 0;
  const countLabel = hasResults ? `${search.currentIndex + 1} / ${search.results.length}` : search.query ? '0 results' : '';

  // ── Option D1 — dark, matches #2a4054 toolbar ──────────────────────────────
  const iconBtn = `w-[26px] h-[26px] flex items-center justify-center rounded
    border border-white/25 bg-white/10 text-white
    hover:bg-white/20 transition-colors disabled:opacity-30 shrink-0`;

  return (
    <div style={{ background:'#2a4054', borderTop:'1px solid rgba(255,255,255,.15)' }}
      className="flex flex-col gap-0 shrink-0 px-3 py-1.5 gap-[5px]">

      {/* ── Row 1: search icon, input, count, Find, prev/next/close ── */}
      <div className="flex items-center gap-1.5">
        {/* Search icon */}
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none"
          className="shrink-0 text-white opacity-70">
          <circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.5"/>
          <path d="M8.5 8.5l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>

        {/* Input */}
        <input
          ref={inputRef}
          value={search.query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Search in document…"
          spellCheck={false}
          className="flex-1 min-w-0 h-[26px] px-2 rounded text-white text-xs
            placeholder-white/40 focus:outline-none"
          style={{
            background: 'rgba(0,0,0,.25)',
            border: '1px solid rgba(255,255,255,.3)',
          }}
        />

        {/* Result count */}
        {search.query && (
          <span className={`text-[10px] font-medium shrink-0 ${
            hasResults ? 'text-white/70' : 'text-red-400'
          }`}>{countLabel}</span>
        )}

        {/* Find */}
        <button onClick={runSearch}
          className="h-[26px] px-2.5 rounded text-[11px] font-semibold text-white
            shrink-0 transition-colors hover:bg-[#0a84ff]/90"
          style={{ background: '#0a84ff', border: 'none' }}>
          Find
        </button>

        {/* Prev */}
        <button onClick={searchPrev} disabled={!hasResults} className={iconBtn}>
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
            <path d="M7 8L3 5l4-3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>

        {/* Next */}
        <button onClick={searchNext} disabled={!hasResults} className={iconBtn}>
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
            <path d="M3 2l4 3-4 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>

        {/* Close */}
        <button onClick={() => { setSearchOpen(false); clearSearch(); }} className={iconBtn}>
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
            <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      {/* ── Row 2: filter pills ── */}
      <div className="flex items-center gap-1.5 pl-[21px]">
        {[
          { label: 'Match case',    active: search.matchCase,                toggle: () => setOption('matchCase', !search.matchCase) },
          { label: 'Exact match',   active: search.matchType === 'exact',    toggle: () => setOption('matchType', search.matchType === 'exact' ? 'contains' : 'exact') },
          { label: 'Contains',      active: search.matchType === 'contains', toggle: () => setOption('matchType', 'contains') },
          { label: 'Highlight all', active: search.highlightAll,             toggle: () => setOption('highlightAll', !search.highlightAll) },
        ].map(opt => (
          <button key={opt.label} onClick={opt.toggle}
            className="text-[10px] px-2 py-0.5 rounded-full transition-colors font-medium"
            style={{
              border: opt.active ? '1px solid rgba(10,132,255,.6)' : '1px solid rgba(255,255,255,.25)',
              background: opt.active ? 'rgba(10,132,255,.2)' : 'rgba(255,255,255,.08)',
              color: opt.active ? '#6bbfff' : '#fff',
            }}>
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Overflow menu ─────────────────────────────────────────────────────────────
function OverflowMenu({
  onDownload, onPrint, annotateMode, onAnnotate, enableAnnotation,
  showPagination, currentPage, pageCount, onPrev, onNext, onFirst, onLast, onPageInput,
}: {
  onDownload: () => void;
  onPrint: () => void;
  annotateMode: boolean;
  onAnnotate: () => void;
  enableAnnotation?: boolean;
  showPagination?: boolean;
  currentPage?: number;
  pageCount?: number;
  onPrev?: () => void;
  onNext?: () => void;
  onFirst?: () => void;
  onLast?: () => void;
  onPageInput?: (p: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos]   = useState({ top: 0, right: 0 });
  const btnRef          = useRef<HTMLButtonElement>(null);
  const menuRef         = useRef<HTMLDivElement>(null);

  const toggle = useCallback(() => {
    if (!btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    // Position menu fixed so it escapes overflow:hidden parent
    setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    setOpen(v => !v);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        btnRef.current && !btnRef.current.contains(e.target as Node) &&
        menuRef.current && !menuRef.current.contains(e.target as Node)
      ) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="relative shrink-0">
      <button
        ref={btnRef}
        onClick={toggle}
        title="More actions"
        className={`w-7 h-7 rounded flex items-center justify-center border transition-all shrink-0
          text-white relative
          ${open ? 'bg-white/15 border-white/40 opacity-100' : 'border-white/25 opacity-90 hover:opacity-100 hover:bg-white/10'}`}
      >
        {/* Vertical three dots */}
        <svg width="4" height="16" viewBox="0 0 4 16" fill="currentColor">
          <circle cx="2" cy="2"  r="1.5"/>
          <circle cx="2" cy="8"  r="1.5"/>
          <circle cx="2" cy="14" r="1.5"/>
        </svg>
        {annotateMode && (
          <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-amber-400" />
        )}
      </button>

      {open && (
        <div
          ref={menuRef}
          style={{
            position: 'fixed',
            top: pos.top,
            right: pos.right,
            zIndex: 99999,
          }}
          className="bg-[#1e2d3d] border border-white/18 rounded-lg shadow-2xl py-1 min-w-[200px]"
        >
          {/* Pagination row — shown when toolbar width < 720px */}
          {showPagination && (
            <>
              <div className="flex items-center gap-1 px-3 py-2">
                <button onClick={onFirst} disabled={(currentPage??1)<=1}
                  className="w-6 h-6 flex items-center justify-center rounded border border-white/25 bg-white/10 text-white disabled:opacity-25">
                  <svg width="10" height="10" viewBox="0 0 13 13" fill="none"><path d="M3 2.5v8M5.5 6.5L10 2.5v8L5.5 6.5z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
                <button onClick={onPrev} disabled={(currentPage??1)<=1}
                  className="w-6 h-6 flex items-center justify-center rounded border border-white/25 bg-white/10 text-white disabled:opacity-25">
                  <svg width="10" height="10" viewBox="0 0 13 13" fill="none"><path d="M8.5 2.5L4 6.5l4.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
                <input
                  key={currentPage}
                  defaultValue={currentPage}
                  onKeyDown={e => { if (e.key==='Enter') { const p=parseInt((e.target as HTMLInputElement).value); if (!isNaN(p)) onPageInput?.(p); }}}
                  onBlur={e => { const p=parseInt(e.target.value); if (!isNaN(p)) onPageInput?.(p); }}
                  className="w-9 h-6 text-center text-xs font-semibold bg-white text-[#1a2636] rounded border-none outline-none"
                />
                <span className="text-xs text-white/70 font-medium whitespace-nowrap">of {pageCount??1}</span>
                <button onClick={onNext} disabled={(currentPage??1)>=(pageCount??1)}
                  className="w-6 h-6 flex items-center justify-center rounded border border-white/25 bg-white/10 text-white disabled:opacity-25">
                  <svg width="10" height="10" viewBox="0 0 13 13" fill="none"><path d="M4.5 2.5L9 6.5l-4.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
                <button onClick={onLast} disabled={(currentPage??1)>=(pageCount??1)}
                  className="w-6 h-6 flex items-center justify-center rounded border border-white/25 bg-white/10 text-white disabled:opacity-25">
                  <svg width="10" height="10" viewBox="0 0 13 13" fill="none"><path d="M10 2.5v8M7.5 6.5L3 2.5v8l4.5-4z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
              </div>
              <div className="h-px bg-white/10 my-1" />
            </>
          )}
          <div className="h-px bg-white/10 my-1" />
          <button
            onClick={() => { onDownload(); setOpen(false); }}
            className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-white/90
              hover:bg-white/8 hover:text-white transition-colors text-left"
          >
            <svg width="19" height="19" viewBox="0 0 14 14" fill="none">
              <path d="M7 1v8M4 6l3 3 3-3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M1 11h12" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
              <path d="M1 11v2h12v-2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Download
          </button>
          <button
            onClick={() => { onPrint(); setOpen(false); }}
            className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-white/90
              hover:bg-white/8 hover:text-white transition-colors text-left"
          >
            <svg width="19" height="19" viewBox="0 0 14 14" fill="none">
              <rect x="2" y="5" width="10" height="7" rx="1" stroke="currentColor" strokeWidth="1.1"/>
              <path d="M4 5V2h6v3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M4 9h6M4 11h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            Print
          </button>
          <div className="h-px bg-white/10 my-1" />
          
          {enableAnnotation && (<>
          <div className="h-px bg-white/10 my-1" />
          <button
            onClick={() => { onAnnotate(); setOpen(false); }}
            className={`w-full flex items-center gap-2.5 px-3.5 py-2 text-xs transition-colors text-left
              ${annotateMode ? 'text-[#ffa500] hover:bg-amber-500/10' : 'text-white/90 hover:bg-white/8 hover:text-white'}`}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 10L9 3l2 2-7 7H2v-2z" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Annotate / Draw
            {annotateMode && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-[#ffa500]" />}
          </button>
          </>)}
        </div>
      )}
    </div>
  );
}

// ── Main toolbar ──────────────────────────────────────────────────────────────
export function ViewerToolbar() {
  const sidebarOpen         = useAppStore(s => s.sidebarOpen);
  const setSidebarOpen      = useAppStore(s => s.setSidebarOpen);
  const enableThumbnailView = useAppStore(s => s.enableThumbnailView);
  const adapter        = useAppStore(s => s.adapter);
  const currentPage    = useAppStore(s => s.currentPage);
  const setCurrentPage = useAppStore(s => s.setCurrentPage);
  const rotateCW       = useAppStore(s => s.rotateCW);
  const rotateCCW      = useAppStore(s => s.rotateCCW);
  const rotation       = useAppStore(s => s.rotation);
  const showSplitMerge = useAppStore(s => s.showSplitMerge);
  const setSearchOpen  = useAppStore(s => s.setSearchOpen);
  const searchOpen     = useAppStore(s => s.search.isOpen);
  const downloadFile     = useAppStore(s => s.downloadFile);
  const annotateMode      = useAppStore(s => s.annotateMode);
  const setAnnotateMode   = useAppStore(s => s.setAnnotateMode);
  const enableAnnotation  = useAppStore(s => s.enableAnnotation);
  const printDocument  = useAppStore(s => s.printDocument);
  const openFile       = useAppStore(s => s.openFile);
  const fileName       = useAppStore(s => s.fileName);
  const zoom           = useAppStore(s => s.zoom);
  const zoomMode       = useAppStore(s => s.zoomMode);
  const setZoomMode    = useAppStore(s => s.setZoomMode);
  const setZoom        = useAppStore(s => s.setZoom);

  const pageCount = useAppStore(s => s.pageCount) || adapter?.pageCount || 0;

  const tbRef          = useRef<HTMLDivElement>(null);
  const fullActionsRef = useRef<HTMLDivElement>(null);
  const fileInputRef   = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [hideFitIcons, setHideFitIcons] = useState(false);
  const [hidePagination, setHidePagination] = useState(false);
  const fullWidthRef = useRef<number>(0);
  const FIT_ICON_BREAKPOINT  = 870;
  const PAGINATION_BREAKPOINT = 720;

  // Measure full width once on mount, then observe for collapses
  useEffect(() => {
    const tb = tbRef.current;
    const fa = fullActionsRef.current;
    if (!tb || !fa) return;

    // Force show full actions to get accurate scrollWidth measurement
    fa.style.display = 'flex';

    // Double rAF: first frame applies the display change, second frame has accurate layout
    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(() => {
        fullWidthRef.current = tb.scrollWidth + 24; // 24px safety buffer

        const ro = new ResizeObserver(entries => {
          for (const e of entries) {
            const available = Math.floor(e.contentRect.width);
            // Never collapse above 870px regardless of measured fullWidth
            const shouldCollapse = available < Math.min(fullWidthRef.current, 870);
            setCollapsed(prev => prev !== shouldCollapse ? shouldCollapse : prev);
            setHideFitIcons(available < FIT_ICON_BREAKPOINT);
            setHidePagination(available < PAGINATION_BREAKPOINT);
          }
        });
        ro.observe(tb);
        // Store disconnect fn for cleanup
        (tb as any)._roDisconnect = () => ro.disconnect();
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      const tb2 = tbRef.current;
      if (tb2 && (tb2 as any)._roDisconnect) (tb2 as any)._roDisconnect();
    };
  }, []);

  const prevPage = () => {
    if (currentPage > 1) { const p = currentPage - 1; setCurrentPage(p); adapter?.navigateToPage(p); }
  };
  const nextPage = () => {
    if (currentPage < pageCount) { const p = currentPage + 1; setCurrentPage(p); adapter?.navigateToPage(p); }
  };

  // Shared applyPreset used by ZoomControl and the two fit-mode icon buttons
  const applyPreset = useCallback((mode: string, customZ?: number) => {
    if (mode === 'custom' && customZ != null) { setZoom(customZ); return; }
    if (mode === 'actual') { setZoomMode('actual'); return; }

    const scrollEl = document.querySelector<HTMLElement>('[data-viewer-scroll]');
    const cW = scrollEl?.clientWidth  ?? window.innerWidth  * 0.6;
    const cH = scrollEl?.clientHeight ?? window.innerHeight * 0.85;

    const dims = adapter?.getPageDimensions(currentPage);
    let pW = dims?.width  ?? 595;
    let pH = dims?.height ?? 842;
    const format = useAppStore.getState().format;
    if (format === 'spreadsheet') { pW = pW / zoom; pH = pH / zoom; }

    setZoomMode(mode as any, cW, cH, pW, pH);
  }, [adapter, currentPage, zoom, setZoom, setZoomMode]);

  return (
    <>
      {/* Toolbar — overflow:hidden so content never causes scrollbar */}
      <div
        ref={tbRef}
        className="flex items-center h-10 px-2 bg-[#2a4054] border-b border-[#1e3045] shrink-0 overflow-hidden relative"
      >

        {/* ── LEFT ──────────────────────────────────── */}
        <div className="flex items-center gap-0.5 shrink-0">

          {enableThumbnailView && (
            <Ic onClick={() => setSidebarOpen(!sidebarOpen)} title="Toggle sidebar" active={sidebarOpen}>
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                <rect x="1" y="1.5" width="4.5" height="12" rx="1" stroke="currentColor" strokeWidth="1.4"/>
                <path d="M8 4.5h5.5M8 7.5h4M8 10.5h5.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              </svg>
            </Ic>
          )}

          <Ic onClick={() => setSearchOpen(!searchOpen)} title="Search (Ctrl+F)" active={searchOpen}>
            <svg width="19" height="19" viewBox="0 0 14 14" fill="none">
              <circle cx="5.8" cy="5.8" r="4" stroke="currentColor" strokeWidth="1.4"/>
              <path d="M9 9l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
          </Ic>

          {/* Page Fit + Page Width icons — hidden below 870px, zoom dropdown stays in sync */}
          {!hideFitIcons && (
            <>
              <Sep/>
              <button
                onClick={() => applyPreset('page-fit')}
                title="Page Fit"
                className={`w-8 h-8 rounded flex items-center justify-center border transition-all shrink-0 text-white
                  ${zoomMode === 'page-fit'
                    ? 'bg-white/20 border-white/45 opacity-100'
                    : 'border-white/20 opacity-90 hover:opacity-100 hover:bg-white/12'}`}
              >
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                  <rect x="3.5" y="1" width="8" height="11" rx="1" stroke="currentColor" strokeWidth="1.4"/>
                  <path d="M1 2v11M14 2v11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeDasharray="1.8 1.8"/>
                </svg>
              </button>
              <button
                onClick={() => applyPreset('page-width')}
                title="Page Width"
                className={`w-8 h-8 rounded flex items-center justify-center border transition-all shrink-0 text-white
                  ${zoomMode === 'page-width'
                    ? 'bg-white/20 border-white/45 opacity-100'
                    : 'border-white/20 opacity-90 hover:opacity-100 hover:bg-white/12'}`}
              >
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                  <rect x="1.5" y="3" width="12" height="9" rx="1" stroke="currentColor" strokeWidth="1.4"/>
                  <path d="M1 1v13M14 1v13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeDasharray="1.8 1.8"/>
                </svg>
              </button>
              <Sep/>
            </>
          )}

          {/* Pagination — hidden below 720px, moves into ⋮ menu */}
          {!hidePagination && (<>
          <Ic onClick={() => { setCurrentPage(1); adapter?.navigateToPage(1); }} title="First page"
            disabled={currentPage <= 1 || pageCount <= 1}>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M3 2.5v8M5.5 6.5L10 2.5v8L5.5 6.5z" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </Ic>
          <Ic onClick={prevPage} title="Previous page" disabled={currentPage <= 1 || pageCount <= 1}>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M8.5 2.5L4 6.5l4.5 4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </Ic>

          <PageInput/>

          <Ic onClick={nextPage} title="Next page" disabled={currentPage >= pageCount || pageCount <= 1}>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M4.5 2.5L9 6.5l-4.5 4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </Ic>
          <Ic onClick={() => { setCurrentPage(pageCount); adapter?.navigateToPage(pageCount); }} title="Last page"
            disabled={currentPage >= pageCount || pageCount <= 1}>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M10 2.5v8M7.5 6.5L3 2.5v8l4.5-4z" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </Ic>
          </>)}
        </div>

        {/* ── CENTRE — position:absolute so it's always truly centred regardless of left/right widths ── */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-0.5 pointer-events-auto z-10">
          <ZoomControl applyPresetFn={applyPreset} />
        </div>

        {/* ── RIGHT ─────────────────────────────────── */}
        <div className="flex items-center gap-0.5 shrink-0 ml-auto">

          <Sep/>

          {/* ── Split & Merge — scissors icon, always visible, amber tint ── */}
          {showSplitMerge && (<>
            <button
              onClick={() => (window as any).__doccapture_openSplitMerge?.()}
              title="Split & Merge"
              className="w-8 h-8 rounded flex items-center justify-center shrink-0
                border border-transparent bg-transparent
                text-white/80 opacity-90
                hover:bg-[#EF9F27]/18 hover:border-[#EF9F27]/50 hover:text-[#EF9F27] hover:opacity-100
                transition-all"
            >
              {/* Clean scissors icon — two blades crossing, two ring handles */}
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                {/* Top blade */}
                <path d="M8.5 8.5L17 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                {/* Bottom blade */}
                <path d="M8.5 11.5L17 17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                {/* Top ring handle */}
                <circle cx="5" cy="6" r="3" stroke="currentColor" strokeWidth="1.4"/>
                {/* Bottom ring handle */}
                <circle cx="5" cy="14" r="3" stroke="currentColor" strokeWidth="1.4"/>
                {/* Pivot point */}
                <circle cx="9.5" cy="10" r="1" fill="currentColor"/>
              </svg>
            </button>
            <Sep/>
          </>)}

          <Ic onClick={rotateCCW} title="Rotate counter-clockwise">
            <svg width="19" height="19" viewBox="0 0 14 14" fill="none">
              <path d="M2.5 7A4.5 4.5 0 1 1 7 11.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
              <path d="M2.5 3.5V7H6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </Ic>
          <Ic onClick={rotateCW} title="Rotate clockwise">
            <svg width="19" height="19" viewBox="0 0 14 14" fill="none">
              <path d="M11.5 7A4.5 4.5 0 1 0 7 11.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
              <path d="M11.5 3.5V7H8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </Ic>
          {rotation !== 0 && <span className="text-[10px] text-white/70 px-0.5">{rotation}°</span>}

          {/* Full actions — visible when wide */}
          <div ref={fullActionsRef} style={{display: collapsed ? 'none' : 'flex'}} className="items-center gap-0.5">
            <Sep/>

            <Ic onClick={downloadFile} title={fileName ? `Download ${fileName}` : 'Download'} disabled={!fileName}>
              <svg width="19" height="19" viewBox="0 0 14 14" fill="none">
                <path d="M7 1v8M4 6l3 3 3-3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M1 11h12" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
                <path d="M1 11v2h12v-2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </Ic>

            <Ic onClick={printDocument} title="Print">
              <svg width="19" height="19" viewBox="0 0 14 14" fill="none">
                <rect x="2" y="5" width="10" height="7" rx="1" stroke="currentColor" strokeWidth="1.1"/>
                <path d="M4 5V2h6v3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M4 9h6M4 11h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </Ic>

            {/* Pencil — Annotate button — hidden when enableAnnotation is false */}
            {enableAnnotation && (
            <button
              onClick={() => setAnnotateMode(!annotateMode)}
              title={annotateMode ? 'Annotation ON' : 'Annotate / Draw'}
              className={`w-8 h-8 rounded flex items-center justify-center border transition-all shrink-0 text-white
                ${annotateMode
                  ? 'bg-amber-500/25 border-amber-400/60 opacity-100'
                  : 'border-white/25 opacity-90 hover:opacity-100 hover:bg-white/10'}`}
            >
              <svg width="19" height="19" viewBox="0 0 14 14" fill="none">
                <path d="M2 10L9 3l2 2-7 7H2v-2z" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            )}
          </div>

          {/* Overflow ⋮ — visible when narrow */}
          {collapsed && (
            <>
              <Sep/>
              <OverflowMenu
                onDownload={downloadFile}
                onPrint={printDocument}
                annotateMode={annotateMode}
                onAnnotate={() => setAnnotateMode(!annotateMode)}
                enableAnnotation={enableAnnotation}
                showPagination={hidePagination}
                currentPage={currentPage}
                pageCount={pageCount}
                onFirst={() => { setCurrentPage(1); adapter?.navigateToPage(1); }}
                onPrev={prevPage}
                onNext={nextPage}
                onLast={() => { setCurrentPage(pageCount); adapter?.navigateToPage(pageCount); }}
                onPageInput={p => { const pg=Math.max(1,Math.min(pageCount,p)); setCurrentPage(pg); adapter?.navigateToPage(pg); }}
              />
            </>
          )}

        </div>
      </div>

      <SearchPanel />
      {/* Hidden file input for overflow menu Open action */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.tif,.tiff,.bmp,.jpg,.jpeg,.png,.xls,.xlsx,.csv,.docx,.doc,.txt"
        className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) openFile(f); e.currentTarget.value=''; }}
      />
    </>
  );
}
