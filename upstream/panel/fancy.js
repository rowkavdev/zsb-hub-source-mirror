// Settings > Look > Graphics: Fancy. A moving scene behind the panel, picked under Scene:
//   shards   React Bits' Aero Shards (panel/aero-shards.js, WebGPU): a ribbon of glass shards; push, ring, gather
//   galaxy   React Bits' Galaxy (panel/galaxy.js): layers of twinkling stars; the mouse pushes them, a click warps
//   flux     React Bits' Flux Lines (panel/flux-lines.js): glowing lines in a churning field; the mouse reveals and curls them
//   network  drifting points linked by lines; the mouse joins in and pulls them closer
// A scene that can't run here (no WebGPU or WebGL2) falls back: shards -> galaxy -> network.
// plus React Bits' Border Glow on cards, rows and buttons, following the mouse. The motion and glow on the page itself is CSS under
// html[data-graphics="fancy"] in panel.css. Everything stops while the window is hidden; with the system's
// reduce-motion setting the scene is drawn once and stays still. Simple (the default) costs nothing.
// Colours come from the look (--white is the accent). Loaded as window.ZSBFancy; panel.js calls ZSBFancy.set(on, scene).
(function (root) {
    const doc = root.document;
    if (!doc) return;
    const reduce = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
    const FPS = 30, TAU = Math.PI * 2;
    let on = false, sceneId = 'shards', scene = null, canvas = null, ctx = null, raf = 0, last = 0, prev = 0;
    let w = 0, h = 0, dpr = 1, mx = -1, my = -1, C = null, start = 0;

    // No GPU (a VPS desktop): WebGL is missing or runs on the CPU. Then all of Fancy stays off, the background and the
    // glows alike: drawn on the CPU they keep it busy (measured on a 4-core VPS). panel.js shows Simple and says why.
    let gpuless = null;
    function noGpu() {
        if (gpuless === null) {
            const probe = doc.createElement('canvas').getContext('webgl2');
            const info = probe && probe.getExtension('WEBGL_debug_renderer_info');
            const renderer = info ? String(probe.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
            gpuless = !probe || /swiftshader|llvmpipe|softpipe|basic render|software/i.test(renderer);
            const lose = probe && probe.getExtension('WEBGL_lose_context');
            if (lose) lose.loseContext();
        }
        return gpuless;
    }

    // --- colours -------------------------------------------------------------
    const prop = (k) => getComputedStyle(doc.documentElement).getPropertyValue(k).trim();
    function rgb(c) {
        const m = /^#([0-9a-f]{6})$/i.exec(c);
        if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
        const n = /rgba?\(([^)]+)\)/.exec(c);
        return n ? n[1].split(',').slice(0, 3).map(Number) : [255, 255, 255];
    }
    // The accent turned round the colour wheel by `deg` (a grey accent gets violet and teal instead).
    function turn(c, deg) {
        let [r, g, b] = c.map(v => v / 255);
        const mx_ = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx_ + mn) / 2, d = mx_ - mn;
        if (d < 0.08) return deg > 0 ? [167, 139, 250] : [45, 212, 191];
        const s = d / (1 - Math.abs(2 * l - 1));
        let hh = mx_ === r ? ((g - b) / d) % 6 : mx_ === g ? (b - r) / d + 2 : (r - g) / d + 4;
        hh = ((hh * 60 + deg) % 360 + 360) % 360;
        const k = (n) => { const q = (n + hh / 30) % 12; return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(q - 3, 9 - q, 1)); };
        return [k(0), k(8), k(4)].map(v => Math.round(v * 255));
    }
    function readColors() {
        const accent = rgb(prop('--white') || '#ffffff');
        const light = doc.documentElement.dataset.look === 'light';
        C = { accent, a2: turn(accent, 50), a3: turn(accent, -60), text: rgb(prop('--text') || '#f4f4f5'), light, k: light ? 0.55 : 1 };
        // the border glow's colours (panel.css)
        const st = doc.documentElement.style;
        [accent, C.a2, C.a3].forEach((c, i) => st.setProperty('--glow-' + (i + 1), `rgb(${c.join(' ')})`));
    }
    const rgbOf = (c) => `rgb(${c.join(',')})`;
    const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a))})`;
    const glow = (on_) => { ctx.globalCompositeOperation = on_ && !C.light ? 'lighter' : 'source-over'; };

    // --- scenes ----------------------------------------------------------------
    const SCENES = {
        shards: {
            // React Bits' Aero Shards (panel/aero-shards.js, with its licence): a ribbon of glass shards flying past;
            // the mouse pushes them aside and tilts the view, a click on the background sends out a ring, holding the
            // button gathers them. Drawn with WebGPU; it reads the mouse itself.
            gpu: true,
            init() {},
            setup(canvas) {
                const A = root.ZSBAeroShards;
                if (!A || !A.supported()) return false;
                this.fx = A.create(canvas, this.options(), () => broken('shards'));
                return !!this.fx;
            },
            options() { return { shardColor: rgbOf(C.accent), accentColor: rgbOf(C.a2), lightMode: C.light, dpr: 1.5 }; },
            draw() {
                const key = rgbOf(C.accent) + C.light;
                if (key !== this.key) { this.key = key; this.fx.set(this.options()); }
                this.fx.tick(performance.now());
            },
        },
        galaxy: {
            // React Bits' Galaxy (panel/galaxy.js, with its licence): flying through layers of twinkling stars; the
            // mouse pushes stars away, a click on the background is a burst of warp speed.
            gl: true,
            init() {},
            setup(gl) { this.fx = root.ZSBGalaxy && root.ZSBGalaxy.create(gl); return !!this.fx; },
            down() { if (this.fx && !reduce.matches) this.fx.warp(); },
            draw(t, dt) {
                // their starColors: stars in the accent and its neighbour, with some left white; Plain keeps their white stars
                const grey = Math.max(...C.accent) - Math.min(...C.accent) < 20;
                const stars = grey ? [] : [C.accent, C.a2, C.accent, [255, 255, 255]].map(c => c.map(v => v / 255));
                this.fx.frame(dt, mx >= 0 ? { x: mx / w, y: 1 - my / h } : null, C.light, stars);
            },
        },
        network: {
            init() {
                const n = Math.round(Math.min(110, Math.max(45, w * h / 14000)));
                this.p = Array.from({ length: n }, () => ({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - 0.5) * 22, vy: (Math.random() - 0.5) * 22 }));
            },
            draw(t, dt) {
                const LINK = 150, p = this.p;
                for (const q of p) {
                    if (mx >= 0) { const dx = mx - q.x, dy = my - q.y, d = Math.hypot(dx, dy); if (d < 220 && d > 1) { q.vx += dx / d * 30 * dt; q.vy += dy / d * 30 * dt; } }
                    const sp = Math.hypot(q.vx, q.vy); if (sp > 40) { q.vx *= 40 / sp; q.vy *= 40 / sp; }
                    q.x += q.vx * dt; q.y += q.vy * dt;
                    if (q.x < 0 || q.x > w) q.vx *= -1;
                    if (q.y < 0 || q.y > h) q.vy *= -1;
                    q.x = Math.max(0, Math.min(w, q.x)); q.y = Math.max(0, Math.min(h, q.y));
                }
                glow(true);
                ctx.lineWidth = 1;
                for (let i = 0; i < p.length; i++) {
                    for (let j = i + 1; j < p.length; j++) {
                        const d = Math.hypot(p[i].x - p[j].x, p[i].y - p[j].y);
                        if (d > LINK) continue;
                        ctx.strokeStyle = rgba(C.accent, (1 - d / LINK) * 0.35 * C.k);
                        ctx.beginPath(); ctx.moveTo(p[i].x, p[i].y); ctx.lineTo(p[j].x, p[j].y); ctx.stroke();
                    }
                    if (mx >= 0) {
                        const d = Math.hypot(p[i].x - mx, p[i].y - my);
                        if (d < 220) { ctx.strokeStyle = rgba(C.a2, (1 - d / 220) * 0.6 * C.k); ctx.beginPath(); ctx.moveTo(p[i].x, p[i].y); ctx.lineTo(mx, my); ctx.stroke(); }
                    }
                }
                for (const q of p) {
                    const pulse = 1.6 + Math.sin(t * 2 + q.x * 0.05) * 0.6;
                    ctx.fillStyle = rgba(C.accent, 0.12 * C.k); ctx.beginPath(); ctx.arc(q.x, q.y, pulse * 3.2, 0, TAU); ctx.fill();
                    ctx.fillStyle = rgba(C.text, 0.75 * C.k); ctx.beginPath(); ctx.arc(q.x, q.y, pulse, 0, TAU); ctx.fill();
                }
                glow(false);
            },
        },
        flux: {
            // React Bits' Flux Lines (panel/flux-lines.js, with its licence): glowing lines tracing a churning field;
            // the mouse is a magnet that reveals and curls them, and a click sets off a swirl. Drawn on the GPU.
            gl: true,
            init() {},
            setup(gl) { this.fx = root.ZSBFluxLines && root.ZSBFluxLines.create(gl); return !!this.fx; },
            down(x, y) { if (this.fx && !reduce.matches) this.fx.swirlAt(x * dpr, (h - y) * dpr); },
            draw(t, dt) {
                const grey = Math.max(...C.accent) - Math.min(...C.accent) < 20;
                const cols = (grey ? [C.accent, C.accent, C.accent] : [C.accent, C.a2, C.accent]).map(c => c.map(v => v / 255));
                this.fx.frame(dt, mx >= 0 ? { x: mx * dpr, y: (h - my) * dpr } : null, cols, C.light, dpr);
            },
        },
    };

    // --- loop ------------------------------------------------------------------
    // Two canvases: a 2D one for most scenes and a WebGL2 one for shader scenes; only the one in use is on the page.
    let c2d = null, cgl = null, gl = null, cgpu = null;
    // A scene that can't run here (no WebGL2 / WebGPU) gives way to the next one that can.
    const FALLBACK = { shards: 'galaxy', galaxy: 'network', flux: 'network' };
    function broken(id) {
        SCENES[id].broken = true;
        if (sceneId === id && on) { sceneId = FALLBACK[id] || 'network'; scene = SCENES[sceneId]; useCanvas(); kick(); }
    }
    function useCanvas() {
        if (scene.broken) { sceneId = FALLBACK[sceneId] || 'network'; scene = SCENES[sceneId]; return useCanvas(); }
        if (scene.gpu) {
            if (!cgpu) cgpu = doc.createElement('canvas');
            if (!scene.ready && !(scene.ready = scene.setup(cgpu))) { scene.broken = true; return useCanvas(); }
        } else if (scene.gl) {
            if (!cgl) {
                cgl = doc.createElement('canvas');
                gl = cgl.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
            }
            if (!gl || !scene.ready && !(scene.ready = scene.setup(gl))) { scene.broken = true; return useCanvas(); }
        } else if (!c2d) {
            c2d = doc.createElement('canvas');
            ctx = c2d.getContext('2d');
        }
        const want = scene.gpu ? cgpu : scene.gl ? cgl : c2d;
        if (canvas !== want) { if (canvas) canvas.remove(); canvas = want; canvas.className = 'fancy-bg'; canvas.setAttribute('aria-hidden', 'true'); }
        if (on && !canvas.isConnected) doc.body.prepend(canvas);
        size();
    }
    function size() {
        dpr = Math.min(root.devicePixelRatio || 1, 1.5);
        w = root.innerWidth; h = root.innerHeight;
        if (!scene.gpu) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }   // Shards sizes its own
        if (!scene.gl && !scene.gpu) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        scene.init();
    }
    function frame(now) {
        raf = 0;
        if (!on || doc.hidden) return;
        if (now - last >= 1000 / FPS - 2) {
            const dt = prev ? Math.min(0.1, (now - prev) / 1000) : 1 / FPS;
            prev = last = now;
            if (!scene.gl && !scene.gpu) { ctx.globalCompositeOperation = 'source-over'; ctx.clearRect(0, 0, w, h); }
            scene.draw((now - start) / 1000, reduce.matches ? 0 : dt);
        }
        if (!reduce.matches) raf = root.requestAnimationFrame(frame);
    }
    const kick = () => { if (on && !raf && !doc.hidden) raf = root.requestAnimationFrame(frame); };

    // Border glow on cards, rows and buttons: React Bits' Border Glow (MIT + Commons Clause, Copyright (c) 2026 David Haz),
    // done for the whole page at once. For the one under the mouse (and the card or row around a button) this sets
    // --edge (0 at the middle, 100 at the edge) and --angle (towards the mouse), and moves an .fx-edge glow into it;
    // panel.css draws the coloured border (::before), the tint near the edge (::after) and the glow from those.
    const GLOW = '.card, .row, .stat, .pcard, .phero, .steps div, button';
    const edges = [0, 1].map(() => { const s = doc.createElement('span'); s.className = 'fx-edge'; s.setAttribute('aria-hidden', 'true'); return s; });
    function edgeOn(el, i, x, y) {
        const r = el.getBoundingClientRect(), cx = r.width / 2, cy = r.height / 2, dx = x - r.left - cx, dy = y - r.top - cy;
        const kx = dx ? cx / Math.abs(dx) : Infinity, ky = dy ? cy / Math.abs(dy) : Infinity;
        const edge = Math.min(Math.max(1 / Math.min(kx, ky), 0), 1);
        let angle = dx || dy ? Math.atan2(dy, dx) * 180 / Math.PI + 90 : 0;
        if (angle < 0) angle += 360;
        el.style.setProperty('--edge', (edge * 100).toFixed(1));
        el.style.setProperty('--angle', angle.toFixed(1) + 'deg');
        if (edges[i].parentNode !== el) el.appendChild(edges[i]);
    }
    let litQueued = false, litEv = null;
    function onMove(e) {
        mx = e.clientX; my = e.clientY;
        if (reduce.matches) kick();
        litEv = e;
        if (litQueued) return;
        litQueued = true;
        root.requestAnimationFrame(() => {
            litQueued = false;
            const t = litEv.target, inner = t && t.closest && t.closest(GLOW);
            const outer = inner && inner.parentElement && inner.parentElement.closest(GLOW);
            if (inner) edgeOn(inner, 0, litEv.clientX, litEv.clientY); else edges[0].remove();
            if (outer) edgeOn(outer, 1, litEv.clientX, litEv.clientY); else edges[1].remove();
        });
    }
    function onLeave() { mx = my = -1; if (reduce.matches) kick(); }
    // A press on the panel itself (cards, rows, menus, controls) is not a press on the background.
    const QUIET = 'a, button, input, textarea, select, label, [role="button"], .card, .row, .stat, .pcard, .phero, .kv, table, .menu, .modal, .tour-box, .top, .tabs';
    function onDown(e) {
        if (!scene.down || e.button !== 0 || (e.target && e.target.closest && e.target.closest(QUIET))) return;
        scene.down(e.clientX, e.clientY); kick();
    }
    function onResize() { size(); last = prev = 0; kick(); }
    function onVis() { if (!doc.hidden) { last = prev = 0; kick(); } }

    function set(want, id) {
        want = !!want && !noGpu();
        const nextId = SCENES[id] ? id : 'shards';
        if (want && on) {
            readColors();
            if (nextId !== sceneId) { sceneId = nextId; scene = SCENES[sceneId]; useCanvas(); }
            last = prev = 0; kick();
            return;
        }
        if (want === on) return;
        on = want;
        if (on) {
            start = start || performance.now();
            sceneId = nextId; scene = SCENES[sceneId];
            readColors(); useCanvas();
            root.addEventListener('pointermove', onMove, { passive: true });
            root.addEventListener('pointerdown', onDown, { passive: true });
            doc.documentElement.addEventListener('pointerleave', onLeave);
            root.addEventListener('resize', onResize);
            doc.addEventListener('visibilitychange', onVis);
            if (reduce.addEventListener) reduce.addEventListener('change', onResize);
            last = prev = 0; kick();
        } else {
            if (raf) root.cancelAnimationFrame(raf);
            raf = 0;
            if (canvas) canvas.remove();
            edges.forEach(s => s.remove());
            root.removeEventListener('pointermove', onMove);
            root.removeEventListener('pointerdown', onDown);
            doc.documentElement.removeEventListener('pointerleave', onLeave);
            root.removeEventListener('resize', onResize);
            doc.removeEventListener('visibilitychange', onVis);
            if (reduce.removeEventListener) reduce.removeEventListener('change', onResize);
        }
    }

    root.ZSBFancy = { set, SCENES: Object.keys(SCENES), get on() { return on; }, get noGpu() { return noGpu(); }, get scene() { return sceneId; } };
})(typeof window !== 'undefined' ? window : this);
