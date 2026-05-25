// Inject spin keyframe once for loading spinner
if (typeof document !== 'undefined' && !document.getElementById('mds-spin')) {
  const s = document.createElement('style');
  s.id = 'mds-spin';
  s.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(s);
}

import { useState, useRef, useEffect, useCallback } from 'react';
import { getCachedBitmap, setCachedBitmap, hasCachedBitmap, THUMB_W_EXPORT as THUMB_W } from '../hooks/useThumbnailRenderer';
import { useAppStore } from '../store/appStore';
import type { MultiDocState, ResolvedCategory } from '../types/multiDoc';
import { buildPageCatMap } from '../types/multiDoc';
import { MultiDocOutline } from './MultiDocOutline';
import { PALETTE_MAP } from '../adapters/types';
import type { PaletteColor } from '../adapters/types';

// ── Category color resolver ─────────────────────────────────────────────────
// Applies 30% opacity when color is a palette key (not sent by parent).
// When parent sends explicit hex/CSS, uses full strength.
function resolveCatColor(color: string): {
  bg: string; border: string; text: string;
  badgeBg: string; badgeText: string; dot: string;
} {
  if (color in PALETTE_MAP) {
    const p = PALETTE_MAP[color as PaletteColor];
    return {
      bg:        p.bg,       // rgba 30% opacity
      border:    p.divText,  // full saturated for left border accent
      text:      p.text,     // '#111111' dark
      badgeBg:   p.divText,  // solid saturated so badge is always visible
      badgeText: '#ffffff',
      dot:       p.divText,  // full saturated dot
    };
  }
  // Explicit color from parent — full strength, white text
  return {
    bg:        color,
    border:    color,
    text:      '#ffffff',
    badgeBg:   'rgba(255,255,255,0.22)',
    badgeText: '#ffffff',
    dot:       color,
  };
}

// Accept both legacy ('single'/'multi') and new ('MultiDoc:SinglePage'/'MultiDoc:MultiPage') mode strings
function isSinglePage(mode: string): boolean { return mode === 'single' || mode === 'MultiDoc:SinglePage'; }
function isMultiPage(mode: string): boolean  { return mode === 'multi'  || mode === 'MultiDoc:MultiPage';  }


// ── Page thumbnail row (mode:multi thumbnail tab) ─────────────────────────────

// ── Full-size page thumbnail matching SingleDoc style ─────────────────────────
function PageThumbRow({ pageNum, isActive, cat, onClick, adapterKey }: {
  pageNum: number;
  isActive: boolean;
  cat: ResolvedCategory | undefined;
  onClick: () => void;
  adapterKey: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const paint = useCallback((bm: ImageBitmap) => {
    const cv = canvasRef.current;
    if (!cv) return;
    cv.width = bm.width; cv.height = bm.height;
    cv.getContext('2d')?.drawImage(bm, 0, 0);
  }, []);

  useEffect(() => {
    if (!adapterKey) return;
    if (hasCachedBitmap(adapterKey, pageNum)) {
      const bm = getCachedBitmap(adapterKey, pageNum);
      if (bm) { paint(bm); return; }
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      if (cancelled) return;
      try {
        // Use adapter.renderThumbnail if available (handles PDF, TIF, images uniformly)
        const adapter = useAppStore.getState().adapter as any;
        if (!adapter) return;

        let bm: ImageBitmap | null = null;

        // Check if this is an ImageAdapter (TIF, PNG, JPG etc.)
        const { ImageAdapter } = await import('../adapters/ImageAdapter');
        if (adapter instanceof ImageAdapter) {
          const frame = await (adapter as any).getFrameAsync(pageNum);
          if (!frame?.bitmap || (frame.bitmap as any).width === 0) return;
          const h = Math.round((frame.bitmap.height / frame.bitmap.width) * THUMB_W);
          const offscreen = new OffscreenCanvas(THUMB_W, h);
          (offscreen.getContext('2d') as any).drawImage(frame.bitmap, 0, 0, THUMB_W, h);
          bm = offscreen.transferToImageBitmap();
        } else {
          // PDF path — use __tovPdfDoc (set by PDFViewer when PDF is loaded)
          const doc = (window as any).__tovPdfDoc;
          if (!doc) return;
          const pdfPage   = await doc.getPage(pageNum);
          const vp0       = pdfPage.getViewport({ scale: 1 });
          const scale     = THUMB_W / vp0.width;
          const vp        = pdfPage.getViewport({ scale });
          const offscreen = new OffscreenCanvas(Math.round(vp.width), Math.round(vp.height));
          const ctx       = offscreen.getContext('2d') as OffscreenCanvasRenderingContext2D;
          await pdfPage.render({ canvasContext: ctx, viewport: vp, intent: 'display' }).promise;
          pdfPage.cleanup();
          bm = offscreen.transferToImageBitmap();
        }

        if (bm && !cancelled) { setCachedBitmap(adapterKey, pageNum, bm); paint(bm); }
      } catch (_) {}
    }, 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [pageNum, adapterKey, paint]);

  return (
    <div
      onClick={onClick}
      style={{
        display:       'flex',
        flexDirection: 'column',
        width:         '100%',
        padding:       '10px 18px',   // exactly same as SingleDoc ThumbnailItem
        background:    isActive ? '#dbeafe' : 'transparent',
        borderLeft:    `2px solid ${isActive ? (cat?.color ?? '#2563eb') : 'transparent'}`,
        borderBottom:  '0.5px solid rgba(0,0,0,.05)',
        cursor:        'pointer',
        transition:    'background 0.1s',
        flexShrink:    0,
      }}
    >
      {/* Canvas wrapper — data-thumb-page for IntersectionObserver */}
      <div
        data-thumb-page={pageNum}
        style={{
          width:        '100%',
          maxWidth:     122,   // match SingleDoc: 160px sidebar - 36px padding - 2px borders
          margin:       '0 auto',  // centre within the padded row
          borderRadius: 4,
          overflow:     'hidden',
          border:       `1px solid ${isActive ? (cat?.color ?? '#2563eb') : '#dde3ea'}`,
          background:   '#fff',
          marginBottom: 6,
          position:     'relative',
          minHeight:    20,
        }}
      >
        {cat?.color && (
          <span style={{
            position: 'absolute', left: 0, top: 0, bottom: 0, width: 2,
            background: resolveCatColor(cat.color ?? '#888').dot, zIndex: 1,
          }} />
        )}
        <canvas ref={canvasRef} style={{ width: '100%', display: 'block', minHeight: 20 }} />
        {/* Page number badge — top left, same as SingleDoc */}
        <div style={{
          position:   'absolute', top: 3, left: 4,
          fontSize:   9, fontWeight: 600, color: '#fff',
          background: 'rgba(30,40,60,.65)', borderRadius: 3,
          padding:    '1px 4px', lineHeight: 1.4, pointerEvents: 'none',
        }}>
          {pageNum}
        </div>
      </div>

    </div>
  );
}

// ── Doc thumbnail row (mode:single) ──────────────────────────────────────────

function DocThumbRow({ doc, isActive, cat, onClick }: {
  doc: { id: string; name: string };
  isActive: boolean;
  cat: ResolvedCategory | undefined;
  onClick: () => void;
}) {
  return (
    <div onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '5px 8px 5px 10px',
      borderLeft: `3px solid ${isActive ? (cat?.color ?? '#1a7fd4') : 'transparent'}`,
      borderBottom: '0.5px solid rgba(0,0,0,.05)',
      background: isActive ? '#ddeeff' : undefined,
      cursor: 'pointer', transition: 'background 0.1s',
    }}>
      <div style={{
        width: 32, height: 42, background: '#fff', borderRadius: 2,
        border: '0.5px solid #ccc', flexShrink: 0, overflow: 'hidden',
        position: 'relative', display: 'flex', flexDirection: 'column',
        gap: 2, padding: '4px 4px 3px',
      }}>
        <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 2.5, background: cat?.color ?? '#888' }} />
        {[65,100,50,100,75,55].map((w,i) => (
          <div key={i} style={{ height: 2.5, borderRadius: 1, background: i===0?'#c5cdd6':'#e0e4e8', width:`${w}%` }} />
        ))}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 9.5, fontWeight: 500, color: '#1a2a3a', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{doc.name}</div>
        <div style={{ fontSize: 8, color: '#6a7a8a', marginTop: 2 }}>{cat?.label ?? ''}</div>
      </div>

    </div>
  );
}

// ── Main sidebar ──────────────────────────────────────────────────────────────

export interface MultiDocSidebarProps {
  state: MultiDocState;
  isLoading: boolean;
  loadError: string | null;
  adapter?: unknown; // accepted but not used — layout uses compact rows not canvas thumbnails
  onSelectDoc: (docId: string, page?: number) => void;
  onSelectPage: (page: number) => void;
  onClose?: () => void;
}

export function MultiDocSidebar({ state, isLoading, loadError, onSelectDoc, onSelectPage, onClose }: MultiDocSidebarProps) {
  const [tab, setTab] = useState<'thumb'|'outline'>('thumb');
  // Track which category sections are collapsed (none by default — all open)
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(new Set());
  const toggleCat = (catId: string) => setCollapsedCats(s => {
    const n = new Set(s); n.has(catId) ? n.delete(catId) : n.add(catId); return n;
  });

  const { documents, categories, activeDocId, activePage, mode } = state;

  // Build adapter cache key reactively — updates when doc switches
  const adAdapter      = useAppStore(s => s.adapter);
  const isSplitScreen         = useAppStore(s => s.isSplitScreen);
  const hasReclassification   = useAppStore(s => s.hasReclassification);
  const originalDocuments     = useAppStore(s => s.originalDocuments);
  const adFileName  = useAppStore(s => s.fileName);
  const adFileSize  = useAppStore(s => s.file?.size ?? 0);
  const adPageCount = useAppStore(s => s.adapter?.pageCount ?? 0);
  const adapterKey  = adAdapter
    ? `${adAdapter.constructor.name}:${adFileName}:${adFileSize}:${adPageCount}`
    : '';

  // Keep showing previous doc during load — no blank flash
  const lastLoadedDocId = { current: activeDocId };

  const catById   = Object.fromEntries(categories.map(c => [c.id, c]));
  const activeDoc = documents.find(d => d.id === activeDocId);
  const activeIdx = activeDocId ? documents.findIndex(d => d.id === activeDocId) : -1;

  // mode:single — group docs by CONSECUTIVE runs of same category
  // e.g. [inv, inv, decl, decl, inv] → 3 groups: inv(2), decl(2), inv(1)
  // NOT merged into one inv group — each consecutive run = own accordion
  interface ConsecutiveGroup {
    catId: string;
    docs: typeof documents;
    groupKey: string;  // unique key: catId + group index
  }
  const consecutiveGroups: ConsecutiveGroup[] = [];
  if (isSinglePage(mode)) {
    documents.forEach((d, idx) => {
      const cid = d.categoryId ?? '__none__';
      const last = consecutiveGroups[consecutiveGroups.length - 1];
      if (last && last.catId === cid) {
        last.docs.push(d);
      } else {
        consecutiveGroups.push({
          catId: cid,
          docs: [d],
          groupKey: `${cid}__${consecutiveGroups.length}`,
        });
      }
    });
  }

  // mode:multi thumbnail tab — each pageCategories entry = its own accordion group
  // Preserves order from pageCategories array; same category can appear multiple times
  interface MultiPageGroup {
    catId:    string;
    pages:    number[];
    groupKey: string;   // unique: catId + position index
  }
  const multiPageGroups: MultiPageGroup[] = [];
  const OTHERS_KEY = '__others__';
  if (isMultiPage(mode) && activeDoc?.pageCategories) {
    activeDoc.pageCategories.forEach((pc, idx) => {
      multiPageGroups.push({
        catId:    pc.category,
        pages:    [...pc.pages],           // preserve parent-defined order
        groupKey: `${pc.category}__${idx}`,
      });
    });
    // Collect pages not in any entry → Others
    const totalPages = activeDoc.totalPages ?? 0;
    if (totalPages > 0) {
      const allListedPages = new Set<number>();
      activeDoc.pageCategories.forEach(pc => pc.pages.forEach(p => allListedPages.add(p)));
      const others: number[] = [];
      for (let p = 1; p <= totalPages; p++) {
        if (!allListedPages.has(p)) others.push(p);
      }
      if (others.length) multiPageGroups.push({ catId: OTHERS_KEY, pages: others, groupKey: OTHERS_KEY });
    }
  }

  const pageCatMap = (isMultiPage(mode) && activeDoc?.pageCategories)
    ? buildPageCatMap(activeDoc.pageCategories)
    : new Map<number,string>();

  const [retriggerState, setRetriggerState] = useState<'idle'|'success'|'done'>('idle');
  useEffect(() => {
    // Register doDiscard so App.tsx Reset popup "Yes, reset" can trigger it
    (window as any).__doccapture_doDiscard = handleDiscard;

    (window as any).__doccapture_retriggerSuccess = () => {
      setRetriggerState('success');
      setTimeout(() => setRetriggerState('done'), 2000);
    };
    // Reset bar to idle — called when SM_RECLASSIFY brings back new data
    // so the bar reappears even if it was previously in 'done' state
    (window as any).__doccapture_resetRetriggerBar = () => {
      setRetriggerState('idle');
    };
    return () => {
      delete (window as any).__doccapture_retriggerSuccess;
      delete (window as any).__doccapture_resetRetriggerBar;
      delete (window as any).__doccapture_doDiscard;
    };
  }, []);

  // When hasReclassification becomes true (SM sent new data),
  // reset retriggerState so the bar becomes visible again.
  useEffect(() => {
    if (hasReclassification) {
      setRetriggerState('idle');
    }
  }, [hasReclassification]);

  const handleDiscard = () => {
    const st = useAppStore.getState();

    // MultiDoc: restore originalDocuments via global updateDocuments
    if (st.originalDocuments?.length) {
      (window as any).__doccapture_updateDocuments?.(st.originalDocuments);
    }

    // SingleDoc fallback: restore originalCategories
    const origCats = st.originalCategories;
    if (origCats) {
      st.setCategories(origCats as any);
    }

    st.setHasReclassification(false);
    window.parent.postMessage({
      type:       'DISCARD_CLICKED',
      fileName:   st.fileName,
      page:       st.currentPage,
      pageCount:  st.pageCount,
      categories: origCats ?? st.categories,
      docId:      state?.activeDocId,
      mode:       state?.mode,
    }, '*');
    setRetriggerState('done');
  };

  const handleRetrigger = () => {
    (window as any).__doccapture_openRetriggerConfirm?.();
  };



  return (
    <div style={{ width: 196, flexShrink: 0, display: 'flex', flexDirection: 'column', background: '#eef2f7', borderRight: '1px solid #c8d4e0', height: '100%', position: 'relative' }}>

      {/* Header */}
      <div style={{ padding: '8px 10px 6px', borderBottom: '0.5px solid #d0d9e8', background: '#eef2f7', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ fontSize: 13, color: '#111827', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {isMultiPage(mode) && activeDoc ? activeDoc.name : 'Documents'}
          </div>
          {/* X close button — commented out, not needed in embedded mode */}
          {/* {onClose && (
            <button onClick={onClose} title="Exit multi-doc mode"
              style={{ background: 'transparent', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px', flexShrink: 0 }}
            >✕</button>
          )} */}
        </div>
        <div style={{ fontSize: 10, color: '#374151', fontWeight: 500, marginTop: 2 }}>
          {isMultiPage(mode)
            ? `Doc ${activeIdx+1} of ${documents.length} · ${activeDoc?.totalPages ?? 0} pages`
            : `${documents.length} docs · ${new Set(documents.map((d: any) => d.categoryId).filter(Boolean)).size} categories`}
        </div>
      </div>

      {/* Prev / Next doc — mode:multi only */}
      {isMultiPage(mode) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 8px', borderBottom: '0.5px solid #d0d9e8', background: '#eef2f7', flexShrink: 0 }}>
          <button
            disabled={activeIdx <= 0}
            onClick={() => { const p=documents[activeIdx-1]; if(p) onSelectDoc(p.id, p.pageCategories?.[0]?.pages?.[0] ?? 1); }}
            style={{ background:'#dce6f0', border:'0.5px solid #c0cfe0', color:'#374151', borderRadius:5, width:28, height:26, cursor:'pointer', fontSize:16, display:'flex', alignItems:'center', justifyContent:'center', opacity:activeIdx<=0?.3:1 }}
          >‹</button>
          <div style={{ flex:1, textAlign:'center', fontSize:11, color:'#111827', fontWeight:600, background:'#e0eaf5', borderRadius:4, padding:'3px 0' }}>
            {activeIdx>=0?`${activeIdx+1} / ${documents.length}`:`— / ${documents.length}`}
          </div>
          <button
            disabled={activeIdx>=documents.length-1}
            onClick={() => { const n=documents[activeIdx+1]; if(n) onSelectDoc(n.id, n.pageCategories?.[0]?.pages?.[0] ?? 1); }}
            style={{ background:'#dce6f0', border:'0.5px solid #c0cfe0', color:'#374151', borderRadius:5, width:28, height:26, cursor:'pointer', fontSize:16, display:'flex', alignItems:'center', justifyContent:'center', opacity:activeIdx>=documents.length-1?.3:1 }}
          >›</button>
        </div>
      )}

      {/* Tabs — mode:multi only */}
      {isMultiPage(mode) && (
        <div style={{ display: 'flex', borderBottom: '0.5px solid #d0d9e8', flexShrink: 0, background: '#eef2f7' }}>
          {(['thumb','outline'] as const).map(t => (
            <div key={t} onClick={() => setTab(t)} style={{
              flex:1, padding:'6px 0', fontSize:10, fontWeight:500,
              color: tab===t?'#1a5fa0':'#6b7280',
              textAlign:'center', cursor:'pointer',
              borderBottom: tab===t?'2px solid #1a7fd4':'2px solid transparent',
              transition:'color 0.12s',
            }}>{t==='thumb'?'Thumbnails':'Documents'}</div>
          ))}
        </div>
      )}

      {/* Loading / error — overlay style so no layout shift */}
      <div style={{ flex:1, overflowY:'auto', background:'#f2f4f6', position:'relative' }}>

        {isLoading && (
          <div style={{ position:'absolute', inset:0, zIndex:20, background:'rgba(242,244,246,0.8)', display:'flex', alignItems:'center', justifyContent:'center' }}>
            <div style={{ width:18, height:18, borderRadius:'50%', border:'2px solid #d0d9e8', borderTopColor:'#1a7fd4', animation:'spin 0.7s linear infinite' }} />
          </div>
        )}
        {loadError && (
          <div style={{ padding:'8px 10px', fontSize:10, color:'#f87171', borderBottom:'0.5px solid #2a2020' }}>{loadError}</div>
        )}

        {/* ── SINGLE: compact doc list — consecutive runs of same category ── */}
        {isSinglePage(mode) && consecutiveGroups.map(grp => {
          const cat = catById[grp.catId] ?? { id: grp.catId, label: grp.catId, color: 'gray' };
          const catDocs = grp.docs;
          if (!catDocs.length) return null;
          return (
            <div key={grp.groupKey}>
              {/* Accordion header */}
              <button
                onClick={() => toggleCat(grp.groupKey)}
                style={{
                  width:'100%', display:'flex', alignItems:'center', gap:6,
                  padding:'7px 10px 6px 8px', cursor:'pointer', userSelect:'none',
                  background: resolveCatColor(cat.color).bg,
                  border:'none', borderLeft:`4px solid ${resolveCatColor(cat.color).border}`,
                  borderBottom:'0.5px solid rgba(0,0,0,.15)', textAlign:'left',
                  position:'sticky', top:0, zIndex:10, outline:'none',
                }}>
                <span style={{
                  display:'flex', flexShrink:0, color: resolveCatColor(cat.color).text,
                  transform: collapsedCats.has(grp.groupKey) ? 'rotate(0deg)' : 'rotate(90deg)',
                  transition:'transform 0.18s ease',
                }}>
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M3 2l4 3-4 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </span>
                <span style={{ width:7, height:7, borderRadius:'50%', background:'rgba(255,255,255,0.6)', flexShrink:0 }} />
                <span style={{ fontSize:11, fontWeight:500, color: resolveCatColor(cat.color).text, flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                  {cat.label}
                </span>
                <span style={{ fontSize:10, padding:'1px 6px', borderRadius:10, background: resolveCatColor(cat.color).badgeBg, color: resolveCatColor(cat.color).badgeText, fontWeight:500, flexShrink:0 }}>
                  {catDocs.length}
                </span>
              </button>
              {!collapsedCats.has(grp.groupKey) && catDocs.map(d => (
                <DocThumbRow key={d.id} doc={d} isActive={d.id===activeDocId} cat={cat} onClick={() => onSelectDoc(d.id, 1)} />
              ))}
            </div>
          );
        })}

        {/* ── MULTI thumbnail tab: each pageCategories entry = own accordion ── */}
        {isMultiPage(mode) && tab === 'thumb' && (
          activeDocId ? (
            <>
              {multiPageGroups.filter(g => g.catId !== OTHERS_KEY).map(grp => {
                const cat = catById[grp.catId] ?? { id: grp.catId, label: grp.catId, color: 'gray' };
                const pages = grp.pages;
                if (!pages?.length) return null;
                return (
                  <div key={grp.groupKey}>
                    <button
                      onClick={() => toggleCat(grp.groupKey)}
                      style={{
                        width:'100%', display:'flex', alignItems:'center', gap:6,
                        padding:'7px 10px 6px 8px', cursor:'pointer', userSelect:'none',
                        background: resolveCatColor(cat.color).bg,
                        border:'none', borderLeft:`4px solid ${resolveCatColor(cat.color).border}`,
                        borderBottom:'0.5px solid rgba(0,0,0,.15)', textAlign:'left',
                        position:'sticky', top:0, zIndex:10, outline:'none',
                      }}>
                      <span style={{
                        display:'flex', flexShrink:0, color: resolveCatColor(cat.color).text,
                        transform: collapsedCats.has(grp.groupKey) ? 'rotate(0deg)' : 'rotate(90deg)',
                        transition:'transform 0.18s ease',
                      }}>
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                          <path d="M3 2l4 3-4 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </span>
                      <span style={{ width:7, height:7, borderRadius:'50%', background: resolveCatColor(cat.color).dot, flexShrink:0 }} />
                      <span style={{ fontSize:11, fontWeight:500, color: resolveCatColor(cat.color).text, flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        {cat.label}
                      </span>
                      <span style={{ fontSize:10, padding:'1px 6px', borderRadius:10, background: resolveCatColor(cat.color).badgeBg, color: resolveCatColor(cat.color).badgeText, fontWeight:500, flexShrink:0 }}>
                        {pages.length} pg
                      </span>
                    </button>
                    {!collapsedCats.has(grp.groupKey) && pages.map(pg => {
                      const catId = pageCatMap.get(pg);
                      return (
                        <PageThumbRow
                          key={pg}
                          pageNum={pg}
                          isActive={pg === activePage}
                          cat={catId ? catById[catId] : undefined}
                          onClick={() => onSelectPage(pg)}
                          adapterKey={adapterKey}
                        />
                      );
                    })}
                  </div>
                );
              })}
              {/* Others — pages not listed in any category */}
              {multiPageGroups.find(g => g.catId === OTHERS_KEY)?.pages?.length ? (() => {
                const pages = multiPageGroups.find(g => g.catId === OTHERS_KEY)!.pages;
                const key = OTHERS_KEY;
                return (
                  <div key={OTHERS_KEY}>
                    <button
                      onClick={() => toggleCat(key)}
                      style={{
                        width:'100%', display:'flex', alignItems:'center', gap:6,
                        padding:'7px 10px 6px 8px', cursor:'pointer', userSelect:'none',
                        background: '#4b5563',
                        border:'none', borderLeft:'4px solid #4b5563',
                        borderBottom:'0.5px solid rgba(0,0,0,.15)', textAlign:'left',
                        position:'sticky', top:0, zIndex:10, outline:'none',
                      }}>
                      <span style={{
                        display:'flex', flexShrink:0, color:'rgba(255,255,255,.9)',
                        transform: collapsedCats.has(key) ? 'rotate(0deg)' : 'rotate(90deg)',
                        transition:'transform 0.18s ease',
                      }}>
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                          <path d="M3 2l4 3-4 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </span>
                      <span style={{ width:7, height:7, borderRadius:'50%', background:'rgba(255,255,255,0.6)', flexShrink:0 }} />
                      <span style={{ fontSize:11, fontWeight:500, color:'#fff', flex:1 }}>Others</span>
                      <span style={{ fontSize:10, padding:'1px 6px', borderRadius:10, background:'rgba(255,255,255,0.22)', color:'#ffffff', fontWeight:500, flexShrink:0 }}>
                        {pages.length} pg
                      </span>
                    </button>
                    {!collapsedCats.has(key) && pages.map(pg => (
                      <PageThumbRow
                        key={pg}
                        pageNum={pg}
                        isActive={pg === activePage}
                        cat={undefined}
                        onClick={() => onSelectPage(pg)}
                        adapterKey={adapterKey}
                      />
                    ))}
                  </div>
                );
              })() : null}
            </>
          ) : (
            <div style={{ padding:'16px 10px', fontSize:10, color:'#6b7280', textAlign:'center' }}>Select a document to view pages</div>
          )
        )}

        {/* ── MULTI outline tab ── */}
        {isMultiPage(mode) && tab === 'outline' && (
          <MultiDocOutline state={state} onSelectDoc={onSelectDoc} onSelectPage={onSelectPage} />
        )}
      </div>

      {/* ── Retrigger bar ─────────────────────────────────────────────────── */}
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
