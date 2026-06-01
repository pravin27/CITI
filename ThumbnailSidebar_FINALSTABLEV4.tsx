// ─────────────────────────────────────────────────────────────────────────────
// ThumbnailSidebar
//
// TWO MODES — decided by whether categories JSON was loaded:
//
//   NO CATEGORIES  → flat scrollable list, same as before. Zero overhead.
//
//   WITH CATEGORIES → collapsible accordion groups (Variant C style):
//       • thick left border (4px) in category colour
//       • light tinted header background matching colour
//       • each group collapses independently (local React state, no store)
//       • pages not assigned to any category → "Others" group at bottom
//       • badge shows page count per group
//
// PERFORMANCE:
//   • pageCategoryMap built once with useMemo — O(pages)
//   • groups array built once with useMemo — O(categories + pages)
//   • ThumbnailItem canvas drawn lazily on first render via useEffect
//   • onPageRendered callback registered once per item, never re-registered
//   • No virtualization needed for typical doc sizes (<500 pages);
//     for very large docs the accordion collapse naturally hides DOM nodes.
// ─────────────────────────────────────────────────────────────────────────────

import { navigatePdfPage } from './PDFViewer';
import React, { useEffect, useRef, useMemo, useState, useCallback, memo } from 'react';
import { useThumbnailRenderer } from '../hooks/useThumbnailRenderer';
import { useAppStore } from '../store/appStore';
import { PALETTE_MAP, PALETTE_BG_OPACITY, PALETTE_COLORS } from '../adapters/types';
import type { PaletteColor, Category } from '../adapters/types';
import type { AdapterInstance } from '../store/appStore';

// ── Colour helpers ─────────────────────────────────────────────────────────────

// Light tint + dark text for header background (Variant C style)
// Returns { headerBg, borderColor, textColor, badgeBg, badgeText }
// Color source rules:
//   - Palette key ('blue','teal',...): opacity from PALETTE_MAP (30% bg). Dark text (#111).
//   - Raw hex/CSS from parent app: used full-strength. White text.
//   - No color: grey fallback.
function resolveHeaderColors(color?: string): {
  headerBg: string; borderColor: string; textColor: string;
  badgeBg: string; badgeText: string;
} {
  const OTHERS = {
    headerBg:    '#6b7280',
    borderColor: '#4b5563',
    textColor:   '#ffffff',
    badgeBg:     '#4b5563',
    badgeText:   '#ffffff',
  };
  if (!color) return OTHERS;

  // Named palette key — color was NOT sent by parent, use opacity (PALETTE_MAP.bg = rgba at 30%)
  if (color in PALETTE_MAP) {
    const p = PALETTE_MAP[color as PaletteColor];
    return {
      headerBg:    p.bg,          // rgba at 30% opacity
      borderColor: p.divText,     // full saturated hex for left border accent
      textColor:   p.text,        // '#111111' — dark, readable on lightened bg
      // Page count badge: solid coloured pill with dark text so it's always visible
      badgeBg:     p.divText,     // full saturated hex as solid bg
      badgeText:   '#ffffff',     // white text on saturated bg
    };
  }

  // Hex color (from categoryColor hash or parent) — light bg + vivid border
  // Matches the reference design: pastel background, full-strength border/icon
  if (color.startsWith('#') && color.length >= 7) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return {
      headerBg:    `rgba(${r},${g},${b},${PALETTE_BG_OPACITY})`,  // light pastel fill
      borderColor: color,                          // vivid border accent
      textColor:   '#1a1a1a',                      // dark text on light bg
      badgeBg:     color,                          // solid vivid badge
      badgeText:   '#ffffff',
    };
  }

  // Fallback for any other format
  return {
    headerBg:    color,
    borderColor: color,
    textColor:   '#ffffff',
    badgeBg:     'rgba(255,255,255,0.25)',
    badgeText:   '#ffffff',
  };
}

// Badge for the page thumbnail bottom strip
// Palette key → opacity chip with saturated text. Raw color → tinted chip.
function resolveBadgeColors(color?: string): { bg: string; text: string } | null {
  if (!color) return null;
  if (color in PALETTE_MAP) {
    const p = PALETTE_MAP[color as PaletteColor];
    return { bg: p.divBg, text: p.divText };
  }
  return { bg: color + '33', text: color };
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface GroupDef {
  label:    string;
  color?:   string;
  pages:    number[];
  isOthers: boolean;
}

// ── Accordion group component ──────────────────────────────────────────────────

interface AccordionGroupProps {
  group:       GroupDef;
  adapter:     AdapterInstance | null;
  defaultOpen: boolean;
  registerThumb:   (page: number, canvas: HTMLCanvasElement | null, root?: Element | null) => void;
  unregisterThumb: (page: number, canvas: HTMLCanvasElement | null) => void;
  scrollRoot:  React.RefObject<Element | null>;
}

const AccordionGroup = memo(function AccordionGroup({
  group, adapter, defaultOpen, registerThumb, unregisterThumb, scrollRoot,
}: AccordionGroupProps) {
  const [open, setOpen] = useState(defaultOpen);
  const colors = resolveHeaderColors(group.isOthers ? undefined : group.color);
  const setCurrentPage = useAppStore(s => s.setCurrentPage);

  const handlePageClick = useCallback((page: number) => {
    const liveAdapter = useAppStore.getState().adapter;
    console.log('[NAV] AccordionGroup handlePageClick:', page,
      '| adapter:', liveAdapter ? liveAdapter.constructor.name : 'NULL',
      '| navigateToPage:', typeof (liveAdapter as any)?.navigateToPage);
    useAppStore.getState().setCurrentPage(page);
    // For PDF: use module-level fn (survives adapter instance swaps)
    if (useAppStore.getState().format === 'pdf') {
      navigatePdfPage(page);
    } else {
      liveAdapter?.navigateToPage(page);
    }
  }, []);

  return (
    <div style={{ borderBottom: '0.5px solid #1a2740' }}>
      {/* Accordion header — sticky on the wrapper so nothing bleeds through */}
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          display:         'flex',
          alignItems:      'center',
          gap:             8,
          width:           '100%',
          padding:         '7px 10px 7px 8px',
          cursor:          'pointer',
          // Stack the tint colour over a solid white base so the sticky
          // header is fully opaque while scrolling. Without this, the
          // rgba() headerBg lets thumbnail content bleed through.
          background:      '#ffffff',
          backgroundImage: `linear-gradient(${colors.headerBg}, ${colors.headerBg})`,
          border:          'none',
          borderLeft:      `4px solid ${colors.borderColor}`,
          borderBottom:    '0.5px solid rgba(0,0,0,0.2)',
          textAlign:       'left',
          userSelect:      'none',
          position:        'sticky',
          top:             0,
          zIndex:          10,
          outline:         'none',
        }}
      >
        {/* Chevron — SVG rotates 90° when open */}
        <span style={{
          display: 'flex', flexShrink: 0,
          color: colors.textColor,
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 0.18s ease',
        }}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M3 2l4 3-4 3" stroke="currentColor" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </span>

        {/* Label */}
        <span style={{
          flex:       1,
          fontSize:   11,
          fontWeight: 500,
          color:      colors.textColor,
          overflow:   'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {group.label}
        </span>

        {/* Page count badge */}
        <span style={{
          fontSize:     10,
          padding:      '1px 6px',
          borderRadius: 10,
          background:   colors.badgeBg,
          color:        colors.badgeText,
          fontWeight:   500,
          flexShrink:   0,
        }}>
          {group.pages.length}
        </span>
      </button>

      {/* Virtual list — sharedScrollRoot = outer scroll container so IO fires correctly */}
      {open && (
        <VirtualThumbList
          pages={group.pages}
          adapter={adapter}
          categoryByPage={new Map(group.pages.map(p => [p, group.isOthers ? null : { label: group.label, color: group.color }]))}
          registerThumb={registerThumb}
          unregisterThumb={unregisterThumb}
          onPageClick={handlePageClick}
          hasBadge={false}
          sharedScrollRoot={scrollRoot}
        />
      )}
    </div>
  );
});

// ── Main sidebar ───────────────────────────────────────────────────────────────

export function ThumbnailSidebar() {
  const adapter        = useAppStore(s => s.adapter);
  const categoriesRaw  = useAppStore(s => s.categories);
  // useDeferredValue: React will keep showing old accordion groups during
  // navigation and update them asynchronously — prevents blocking pdfjs nav
  const categories     = React.useDeferredValue(categoriesRaw);
  const isSplitScreen         = useAppStore(s => s.isSplitScreen);
  const hasReclassification   = useAppStore(s => s.hasReclassification);
  const fileName              = useAppStore(s => s.fileName);
  console.log('[ThumbnailSidebar] isSplitScreen=', isSplitScreen, 'retriggerState=', typeof (globalThis as any).__retriggerState);
  const sidebarTab     = useAppStore(s => s.sidebarTab);
  const setCurrentPage = useAppStore(s => s.setCurrentPage);
  const pageCount      = useAppStore(s => s.pageCount) || adapter?.pageCount || 0;

  const hasCategories = categories.length > 0;

  // ALL hooks must be called before any conditional return (Rules of Hooks)
  const scrollRef = useRef<Element | null>(null);
  const { registerThumb, unregisterThumb, pauseRendering } = useThumbnailRenderer(adapter);

  // Expose pauseRendering globally so PDFViewer can call it from navigateToPage
  // without prop drilling. Called before pdfjs page change to yield main thread.
  React.useEffect(() => {
    (window as any).__doccapture_pauseThumbRender = pauseRendering;
    return () => { delete (window as any).__doccapture_pauseThumbRender; };
  }, [pauseRendering]);

  // Build ordered group list — memoised
  const groups = useMemo<GroupDef[]>(() => {
    if (!hasCategories) return [];

    // Build catSet in O(total_pages_in_categories) — avoid flatMap which copies all arrays
    const catSet = new Set<number>();
    for (const cat of categories) {
      for (const p of cat.pages) catSet.add(p);
    }

    // Build otherPages only up to BG_MAX_PAGES to avoid O(pageCount) loop on huge docs
    const BG_MAX = Math.min(pageCount, 500);
    const otherPages: number[] = [];
    for (let p = 1; p <= BG_MAX; p++) {
      if (!catSet.has(p)) otherPages.push(p);
    }
    // If pageCount > 500, add remaining as a range placeholder
    if (pageCount > 500) {
      for (let p = 501; p <= pageCount; p++) {
        if (!catSet.has(p)) otherPages.push(p);
      }
    }

    // Preserve parent-defined page order — do NOT sort
    // Parent sends pages in a specific order (e.g. [5,3,1]) and expects
    // thumbnails to appear in exactly that order in the sidebar.
    const result: GroupDef[] = categories
      .filter(c => c.pages.length > 0)
      .map(c => ({
        label: c.label, color: c.color,
        pages: [...c.pages],           // preserve original order
        isOthers: false,
      }));

    if (otherPages.length > 0) {
      result.push({ label: 'Others', pages: otherPages, isOthers: true });
    }
    return result;
  }, [categories, pageCount, hasCategories]);

  // Early returns AFTER all hooks (Rules of Hooks requires all hooks run first)
  if (sidebarTab !== 'thumbnails') return null;
  // Guard: adapter null = doc switching in progress (old disposed, new not ready).
  // Move ALL hooks before any conditional returns (Rules of Hooks)
  const flatScrollRef = useRef<HTMLDivElement | null>(null);
  const flatScrollRootRef = flatScrollRef as React.RefObject<Element | null>;

  const [retriggerState, setRetriggerState] = React.useState<'idle'|'success'|'done'>('idle');
  React.useEffect(() => {
    (window as any).__doccapture_retriggerSuccess = () => {
      setRetriggerState('success');
      setTimeout(() => setRetriggerState('done'), 2000);
    };
    // Reset bar to idle — called when SM_RECLASSIFY brings back new data
    // so the bar reappears even if it was previously in 'done' state
    (window as any).__doccapture_resetRetriggerBar = () => {
      setRetriggerState('idle');
    };
    // Set bar to 'done' directly — used by Reset confirm to hide without "Successfully sent"
    (window as any).__doccapture_setRetriggerDone = () => {
      setRetriggerState('done');
    };
    return () => {
      delete (window as any).__doccapture_retriggerSuccess;
      delete (window as any).__doccapture_resetRetriggerBar;
      delete (window as any).__doccapture_setRetriggerDone;
      delete (window as any).__doccapture_doDiscard;
    };
  }, []);

  // When hasReclassification becomes true (SM sent new data),
  // reset retriggerState so the bar becomes visible again.
  React.useEffect(() => {
    if (hasReclassification) {
      setRetriggerState('idle');
    }
  }, [hasReclassification]);

  const handleDiscard = React.useCallback(() => {
    const st = useAppStore.getState();
    const original = st.originalCategories;
    if (original?.length) {
      st.setCategories(original as any);
    }
    st.setHasReclassification(false);
    window.parent.postMessage({
      type:       'DISCARD_CLICKED',
      fileName:   st.fileName,
      page:       st.currentPage,
      pageCount:  st.pageCount,
      categories: original ?? st.categories,
    }, '*');
    setRetriggerState('done');
  }, []);

  // Keep __doccapture_doDiscard always pointing to latest handleDiscard
  React.useEffect(() => {
    (window as any).__doccapture_doDiscard = handleDiscard;
    return () => { delete (window as any).__doccapture_doDiscard; };
  }, [handleDiscard]);

  // Step 1 — button click: open confirmation popup
  const handleRetrigger = React.useCallback(() => {
    (window as any).__doccapture_openRetriggerConfirm?.();
  }, []);


  // Returning null prevents any child component from accessing a disposed adapter.
  if (!adapter || !pageCount) return null;

  const scrollRootRef = scrollRef as React.RefObject<Element | null>;

  // ── WITH CATEGORIES: accordion mode ──────────────────────────────────────────
  if (hasCategories) {
    return (
      <div style={{ width: 172, display: 'flex', flexDirection: 'column',
        height: '100%', overflow: 'hidden', position: 'relative',
        background: '#eef2f7', borderRight: '1px solid #d4dce8' }}>
        <div style={{ padding: '7px 10px', borderBottom: '1px solid #d4dce8',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0, background: '#eef2f7' }}>
          <span style={{ fontSize: 11, color: 'rgb(55,65,81)', fontWeight: 500 }}>
            {pageCount} pages · {groups.filter(g => !g.isOthers).length} types
          </span>
          <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 10,
            background: 'rgba(0,0,0,0.08)', color: 'rgb(55,65,81)', fontWeight: 600 }}>
            {pageCount}
          </span>
        </div>
        <div ref={el => { scrollRef.current = el; }}
          style={{ flex: 1, overflowY: 'auto', background: '#f0f2f4',
             }}>
          {groups.map((group, idx) => (
            <AccordionGroup
              key={`${group.label}__${idx}`}
              group={group}
              adapter={adapter}
              defaultOpen={idx === 0}
              registerThumb={registerThumb}
              unregisterThumb={unregisterThumb}
              scrollRoot={scrollRootRef}
            />
          ))}
          {pageCount === 0 && (
            <div style={{ textAlign:'center', color:'#3a4a5a', fontSize:10, paddingTop:32 }}>
              No pages
            </div>
          )}
        </div>
        {isSplitScreen && retriggerState !== 'done' && (
          <div style={{
            flexShrink: 0, borderTop: '1px solid #152434',
            background: '#1e2d3d', padding: '5px 6px',
            display: 'flex', flexDirection: 'column', gap: 4,
          }}>
            {retriggerState === 'success' ? (
              <>
                <i className="ti ti-circle-check" aria-hidden="true"
                  style={{ fontSize: 15, color: '#4ade80', marginRight: 6 }} />
                <span style={{ fontSize: '11px', fontWeight: 500, color: '#bbf7d0', flex: 1 }}>
                  Successfully sent
                </span>
              </>
            ) : (
              <>
                {/* Retrigger label row */}
                <div style={{
                  width: '100%', textAlign: 'center',
                  fontSize: '9px', fontWeight: 500, color: '#ffffff',
                  letterSpacing: '.04em',
                }}>⇅ Retrigger</div>
                <div style={{ height: '0.5px', background: 'rgba(255,255,255,.15)', width: '100%' }} />
                {/* Two buttons */}
                <div style={{ display: 'flex', gap: 5, width: '100%' }}>
                  <button
                    onClick={() => (window as any).__doccapture_openRetriggerConfirm?.('without_idp')}
                    style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      gap: '3px', flex: 1, padding: '4px 4px', borderRadius: '4px',
                      border: '0.5px solid rgba(255,255,255,.28)',
                      background: 'rgba(255,255,255,.10)',
                      fontSize: '9px', fontWeight: 500, color: '#e8ecf0', cursor: 'pointer',
                    }}
                  >w/o IDP</button>
                  <button
                    onClick={() => (window as any).__doccapture_openRetriggerConfirm?.('with_idp')}
                    style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      gap: '3px', flex: 1, padding: '4px 4px', borderRadius: '4px',
                      border: 'none', background: '#185FA5',
                      fontSize: '9px', fontWeight: 500, color: '#e8f2fb', cursor: 'pointer',
                    }}
                  >with IDP</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── NO CATEGORIES: flat list ──────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#f0f2f4] border-r border-[#dde3ea]"
      style={{ width: 160, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: '#f0f2f4', borderRight: '1px solid #dde3ea' }}>
      {pageCount === 0
        ? <div className="flex-1 flex items-center justify-center text-[#3a4a5a] text-[10px]">No pages</div>
        : <div
            ref={flatScrollRef}
            style={{ flex: 1, overflowY: 'auto' }}
            onScroll={() => {}}
          >
            <VirtualThumbList
              pages={Array.from({ length: pageCount }, (_, i) => i + 1)}
              adapter={adapter}
              categoryByPage={new Map()}
              registerThumb={registerThumb}
              unregisterThumb={unregisterThumb}
              onPageClick={page => {
                console.log('[NAV] flat onPageClick:', page, '| adapter:', adapter ? adapter.constructor.name : 'NULL');
                setCurrentPage(page);
                if (useAppStore.getState().format === 'pdf') { navigatePdfPage(page); }
                else { adapter?.navigateToPage(page); }
              }}
              hasBadge={false}
              sharedScrollRoot={flatScrollRootRef}
            />
          </div>
      }
      {/* Retrigger bar — flat mode */}
      {isSplitScreen && retriggerState !== 'done' && (
        <div style={{
          flexShrink: 0, borderTop: '1px solid #152434',
          background: '#1e2d3d', padding: '6px 8px',
          display: 'flex', alignItems: 'center',
        }}>
          {retriggerState === 'success' ? (
            <>
              <i className="ti ti-circle-check" aria-hidden="true"
                style={{ fontSize: 15, color: '#4ade80', marginRight: 6 }} />
              <span style={{ fontSize: '11px', fontWeight: 500, color: '#bbf7d0', flex: 1 }}>
                Successfully sent
              </span>
            </>
          ) : (
            <div style={{ display:'flex', gap: 6, width:'100%' }}>
              <button
                onClick={() => (window as any).__doccapture_openResetConfirm?.()}
                title="Reset to original classification"
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  gap: '4px', flex: 1, padding: '4px 6px', borderRadius: '5px',
                  border: '1px solid #b0bec5',
                  background: '#ffffff',
                  fontSize: '10px', fontWeight: 500,
                  color: '#374151', cursor: 'pointer',
                }}
              >
                ↺ Reset
              </button>
              <button onClick={handleRetrigger} style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                gap: '4px', flex: 1, padding: '4px 6px', borderRadius: '5px',
                border: '0.5px solid rgba(255,255,255,.2)', background: '#185FA5',
                fontSize: '10px', fontWeight: 500, color: '#e8f2fb', cursor: 'pointer',
              }}>
                ⇅ Retrigger
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Thumbnail item ─────────────────────────────────────────────────────────────
// Memoized — only re-renders when page, currentPage, or adapter changes.
// Canvas draw runs once on mount and again whenever the adapter fires
// onPageRendered for this specific page. The callback is registered once
// and cleaned up on unmount to avoid accumulation over many renders.


// ── VirtualThumbList ──────────────────────────────────────────────────────────
// Renders only the items visible in the viewport + OVERSCAN rows above/below.
// Off-screen items are replaced by spacer divs — the scrollbar stays accurate.
// Mounting cost: O(visible) not O(total). 2000 pages → ~15 components mounted.

const ITEM_H_DEFAULT = 130; // fallback item height before adapter dims available
const BADGE_H        = 18;   // category badge height
const ITEM_PADDING   = 10;   // top+bottom padding inside each ThumbnailItem
// ── Thumbnail base height ──────────────────────────────────────────────────────
// Adjust THUMB_BASE_H to control thumbnail preview size (default: 100).
// Original was 140. Smaller = more thumbs visible, less scrolling.
const THUMB_BASE_H   = 60;   // px — base height before aspect ratio scaling (configurable)
const OVERSCAN       = 6;   // extra items rendered outside the viewport

export interface VirtualThumbListProps {
  pages:           number[];
  adapter:         AdapterInstance | null;
  categoryByPage:  Map<number, { label: string; color?: string } | null>;
  registerThumb:   (page: number, canvas: HTMLCanvasElement | null, root?: Element | null) => void;
  unregisterThumb: (page: number, canvas: HTMLCanvasElement | null) => void;
  onPageClick:     (page: number) => void;
  hasBadge:        boolean;
  /** When provided, VirtualThumbList uses this as the scroll container
   *  instead of creating its own — for shared-scroll accordion layouts. */
  sharedScrollRoot?: React.RefObject<Element | null>;
}

export function VirtualThumbList({
  pages, adapter, categoryByPage,
  registerThumb, unregisterThumb, onPageClick, hasBadge,
  sharedScrollRoot,
}: VirtualThumbListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH,     setViewH]     = useState(600);

  // Compute each item's pixel height from page aspect ratio
  const itemHeights = useMemo(() => {
    return pages.map(page => {
      const dims = (adapter as any)?.getPageDimensions?.(page);
      const aspect = dims ? dims.height / Math.max(dims.width, 1) : 1.4;
      return Math.round(THUMB_BASE_H * aspect) + ITEM_PADDING + (hasBadge ? BADGE_H : 0);
    });
  }, [pages, adapter, hasBadge]);

  // Prefix-sum array for O(1) offset/height lookups
  const offsets = useMemo(() => {
    const arr = new Array<number>(pages.length + 1);
    arr[0] = 0;
    for (let i = 0; i < itemHeights.length; i++) arr[i + 1] = arr[i] + itemHeights[i];
    return arr;
  }, [itemHeights, pages.length]);

  const totalH = offsets[pages.length];

  // Binary search: first index whose bottom > scrollTop
  const findFirst = (target: number): number => {
    let lo = 0, hi = pages.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid + 1] <= target) lo = mid + 1; else hi = mid;
    }
    return lo;
  };

  const firstVis = findFirst(Math.max(0, scrollTop));
  const startIdx = Math.max(0, firstVis - OVERSCAN);
  let   endIdx   = firstVis;
  while (endIdx < pages.length - 1 && offsets[endIdx + 1] < scrollTop + viewH) endIdx++;
  endIdx = Math.min(pages.length - 1, endIdx + OVERSCAN);

  // Track viewport height — use shared scroll root height if available,
  // since the VirtualThumbList itself has no fixed height in accordion mode
  useEffect(() => {
    const el = (sharedScrollRoot?.current as HTMLElement | null) ?? scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, [sharedScrollRoot]);

  const scrollRootRef = useRef<Element | null>(null);
  useEffect(() => {
    // Use provided shared root or own scroll div
    scrollRootRef.current = sharedScrollRoot?.current ?? scrollRef.current;
  }, [sharedScrollRoot]);

  const topSpace    = offsets[startIdx];
  const bottomSpace = totalH - offsets[endIdx + 1];

  // When sharing a parent scroll, listen to parent scroll events
  useEffect(() => {
    if (!sharedScrollRoot) return;
    const el = sharedScrollRoot.current as HTMLElement | null;
    if (!el) return;
    const getLocal = () => {
      // Compute scrollTop relative to THIS list's position in the scroll container.
      // With multiple accordion groups, each VirtualThumbList sits at a different
      // offsetTop within the shared scroll container. Using raw el.scrollTop would
      // treat all lists as if they start at y=0, making items in groups 3+ invisible.
      const listEl = scrollRef.current;
      if (!listEl) return Math.max(0, el.scrollTop);
      // offsetTop gives position of listEl relative to its offsetParent chain
      // Walk up to find position relative to the scroll container
      let top = 0;
      let cur: HTMLElement | null = listEl;
      while (cur && cur !== el) {
        top += cur.offsetTop;
        cur = cur.offsetParent as HTMLElement | null;
      }
      return Math.max(0, el.scrollTop - top);
    };
    const onScroll = () => setScrollTop(getLocal());
    el.addEventListener('scroll', onScroll, { passive: true });
    setScrollTop(getLocal());
    return () => el.removeEventListener('scroll', onScroll);
  }, [sharedScrollRoot]);

  const content = (
    <div>
      {topSpace > 0 && <div style={{ height: topSpace }} />}
      {pages.slice(startIdx, endIdx + 1).map((page) => {
        const cat = categoryByPage.get(page) ?? null;
        return (
          <ThumbnailItem
            key={page}
            page={page}
            adapter={adapter}
            categoryLabel={cat?.label ?? null}
            color={cat?.color}
            onClick={() => onPageClick(page)}
            registerThumb={registerThumb}
            unregisterThumb={unregisterThumb}
            scrollRoot={scrollRootRef as React.RefObject<Element | null>}
          />
        );
      })}
      {bottomSpace > 0 && <div style={{ height: bottomSpace }} />}
    </div>
  );

  if (sharedScrollRoot) {
    // Shared scroll: render as plain div inside parent's scroll container
    return <div ref={scrollRef}>{content}</div>;
  }

  // Own-scroll path
  return (
    <div
      ref={scrollRef}
      onScroll={e => setScrollTop((e.currentTarget as HTMLDivElement).scrollTop)}
      style={{ flex: 1, overflowY: 'auto', background: '#f0f2f4' }}
    >
      {content}
</div>
  );
}

export interface ThumbnailItemProps {
  page:          number;
  adapter:       AdapterInstance | null;
  categoryLabel: string | null;
  color?:        string;
  onClick:       () => void;
  registerThumb: (page: number, canvas: HTMLCanvasElement | null, root?: Element | null) => void;
  unregisterThumb: (page: number, canvas: HTMLCanvasElement | null) => void;
  scrollRoot:    React.RefObject<Element | null>;
}

export const ThumbnailItem = memo(function ThumbnailItem({
  page, adapter, categoryLabel, color, onClick,
  registerThumb, unregisterThumb, scrollRoot,
}: ThumbnailItemProps) {
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const buttonRef   = useRef<HTMLButtonElement>(null);

  // PERF: subscribe directly instead of useAppStore hook to avoid
  // re-rendering all 1000+ ThumbnailItems on every page navigation.
  // We imperatively update the button style when currentPage changes.
  useEffect(() => {
    const applyActive = (active: boolean) => {
      const btn = buttonRef.current;
      if (!btn) return;
      btn.style.background  = active ? '#dbeafe' : 'transparent';
      btn.style.borderLeft  = active ? '2px solid #2563eb' : '2px solid transparent';
      // Update canvas border
      const wrap = btn.querySelector<HTMLElement>('.thumb-wrap');
      if (wrap) wrap.style.borderColor = active ? '#2563eb' : '#dde3ea';
    };
    // Seed with current state
    applyActive(useAppStore.getState().currentPage === page);
    // Subscribe
    return useAppStore.subscribe(s => {
      applyActive(s.currentPage === page);
    });
  }, [page]);

  const badge = categoryLabel ? resolveBadgeColors(color) : null;

  // Register with thumbnail renderer — it handles all drawing.
  // Re-runs if scrollRoot.current changes from null → Element (parent mounts after children).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // If scrollRoot is not yet available, poll briefly until it is
    let raf = 0;
    const tryRegister = () => {
      const root = scrollRoot.current;
      registerThumb(page, canvas, root);
      // If root was null, retry next frame — parent scroll container may not be mounted yet
      if (!root) {
        raf = requestAnimationFrame(tryRegister);
      }
    };
    tryRegister();
    return () => {
      cancelAnimationFrame(raf);
      unregisterThumb(page, canvas);
    };
  }, [page, registerThumb, unregisterThumb, scrollRoot]);

  const initActive = useAppStore.getState().currentPage === page;

  return (
    <button
      ref={buttonRef}
      onClick={onClick}
      style={{
        display:       'flex',
        flexDirection: 'column',
        width:         '100%',
        padding:       '4px 8px',
        background:    initActive ? '#dbeafe' : 'transparent',
        border:        'none',
        borderLeft:    initActive ? '2px solid #2563eb' : '2px solid transparent',
        cursor:        'pointer',
        textAlign:     'left',
        transition:    'background 0.1s',
        flexShrink:    0,
      }}
      onMouseEnter={e => { const el = e.currentTarget as HTMLElement; if (el.style.background !== 'rgb(219, 234, 254)') el.style.background = '#e8edf2'; }}
      onMouseLeave={e => { const el = e.currentTarget as HTMLElement; if (el.style.background !== 'rgb(219, 234, 254)') el.style.background = 'transparent'; }}
    >
      {/* Thumbnail canvas wrapper — data-thumb-page enables IntersectionObserver */}
      <div
        data-thumb-page={page}
        style={{
          width:        '100%',
          maxWidth:     90,
          margin:       '0 auto',
          borderRadius: 4,
          overflow:     'hidden',
          border:       `1px solid ${initActive ? '#2563eb' : '#dde3ea'}`,
          background:   '#fff',
          marginBottom: 4,
          position:     'relative',
          minHeight:    20,
        }}
      >
        <canvas ref={canvasRef} style={{ width: '100%', display: 'block', minHeight: 20 }} />
        {/* Page number badge — top left */}
        <div style={{
          position:     'absolute',
          top:          3,
          left:         3,
          background:   'rgba(0,0,0,0.6)',
          color:        '#fff',
          fontSize:     9,
          padding:      '1px 5px',
          borderRadius: 3,
          lineHeight:   '14px',
        }}>{page}</div>
      </div>

      {/* Footer: category badge — hidden for cleaner thumbnail view */}
      {/* categoryLabel && (
        <div style={{
          fontSize:     9,
          padding:      '2px 6px',
          borderRadius: 8,
          background:   badge?.bg ?? '#3a3a37',
          color:        badge?.text ?? '#c4c0b8',
          fontWeight:   500,
          textAlign:    'center',
          overflow:     'hidden',
          textOverflow: 'ellipsis',
          whiteSpace:   'nowrap',
          width:        '100%',
        }}>
          {categoryLabel}
        </div>
      ) */}
    </button>
  );
});
