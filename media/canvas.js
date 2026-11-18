// Webview do Terminal Fly: canvas infinito com cartões de terminal (xterm.js).
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const S = Object.assign({ changeColor: 'Change color', rename: 'Double-click to rename', close: 'Close terminal' }, window.TF_STRINGS || {});
  const viewport = document.getElementById('viewport');
  const world = document.getElementById('world');
  const zoomLabel = document.getElementById('zoom-label');
  const hint = document.getElementById('hint');

  // Cores dos cartões, puxadas da paleta do Freeform.
  const COLORS = ['#8E7627', '#2F7597', '#3E7D4C', '#8F3F66', '#5F4B9B', '#9A5530', '#4B5563'];
  const MIN_Z = 0.15;
  const MAX_Z = 2.5;
  const GRID = 24;
  const MIN_W = 260;
  const MIN_H = 150;

  let cam = { x: 0, y: 0, z: 1 };
  let config = {
    fontFamily: 'Menlo, Monaco, monospace', fontSize: 12, lineHeight: 1, cursorBlink: true,
    macOptionIsMeta: false, scrollback: 5000, wheelBehavior: 'pan', defaultWidth: 680, defaultHeight: 400,
  };
  /** @type {Map<string, any>} */
  const cards = new Map();
  let topZ = 1;
  let focusedId = null;
  let counter = 0;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const uid = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // ---------------------------------------------------------------- tema
  function cssVar(name) {
    return getComputedStyle(document.body).getPropertyValue(name).trim() || undefined;
  }
  function readTheme() {
    const v = (n) => cssVar('--vscode-terminal-' + n);
    const bg = v('background') || cssVar('--vscode-panel-background') || cssVar('--vscode-editor-background');
    return {
      background: bg,
      foreground: v('foreground') || cssVar('--vscode-editor-foreground'),
      cursor: cssVar('--vscode-terminalCursor-foreground') || v('foreground'),
      cursorAccent: cssVar('--vscode-terminalCursor-background') || bg,
      selectionBackground: v('selectionBackground') || cssVar('--vscode-editor-selectionBackground'),
      black: v('ansiBlack'), red: v('ansiRed'), green: v('ansiGreen'), yellow: v('ansiYellow'),
      blue: v('ansiBlue'), magenta: v('ansiMagenta'), cyan: v('ansiCyan'), white: v('ansiWhite'),
      brightBlack: v('ansiBrightBlack'), brightRed: v('ansiBrightRed'), brightGreen: v('ansiBrightGreen'),
      brightYellow: v('ansiBrightYellow'), brightBlue: v('ansiBrightBlue'), brightMagenta: v('ansiBrightMagenta'),
      brightCyan: v('ansiBrightCyan'), brightWhite: v('ansiBrightWhite'),
    };
  }
  function setTheme() {
    theme = readTheme();
    document.documentElement.style.setProperty('--term-bg', theme.background || '#1e1e1e');
  }
  let theme;
  setTheme();
  new MutationObserver(() => {
    setTheme();
    for (const c of cards.values()) c.term.options.theme = theme;
  }).observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });

  // ---------------------------------------------------------------- câmera
  let fontRaf = 0;
  function applyCamera() {
    world.style.setProperty('--z', String(cam.z));
    const g = GRID * cam.z;
    viewport.style.backgroundSize = `${g}px ${g}px`;
    viewport.style.backgroundPosition = `${cam.x}px ${cam.y}px`;
    for (const c of cards.values()) layoutCard(c);
    zoomLabel.textContent = Math.round(cam.z * 100) + '%';
    if (!fontRaf) {
      fontRaf = requestAnimationFrame(() => {
        fontRaf = 0;
        // Zoom muda só o tamanho da fonte: colunas/linhas do shell ficam iguais.
        const fs = Math.max(1, config.fontSize * cam.z);
        for (const c of cards.values()) {
          if (c.term.options.fontSize !== fs) c.term.options.fontSize = fs;
        }
      });
    }
    saveSoon();
  }

  function zoomAt(clientX, clientY, factor) {
    const r = viewport.getBoundingClientRect();
    const px = clientX - r.left;
    const py = clientY - r.top;
    const nz = clamp(cam.z * factor, MIN_Z, MAX_Z);
    const wx = (px - cam.x) / cam.z;
    const wy = (py - cam.y) / cam.z;
    cam.x = px - wx * nz;
    cam.y = py - wy * nz;
    cam.z = nz;
    applyCamera();
  }
  function zoomCenter(factor) {
    const r = viewport.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
  }

  function animate(fn) {
    world.classList.add('animating');
    fn();
    clearTimeout(animate.t);
    animate.t = setTimeout(() => {
      world.classList.remove('animating');
      for (const c of cards.values()) fitCard(c);
    }, 320);
  }

  // ---------------------------------------------------------------- cartões
  function layoutCard(c) {
    const s = c.el.style;
    s.left = c.x * cam.z + cam.x + 'px';
    s.top = c.y * cam.z + cam.y + 'px';
    s.width = c.w * cam.z + 'px';
    s.height = c.h * cam.z + 'px';
    s.zIndex = String(c.zi);
  }

  function fitCard(c) {
    try { c.fit.fit(); } catch (_) { /* cartão invisível */ }
  }

  function bringToFront(c) {
    if (c.zi !== topZ) c.zi = ++topZ;
    c.el.style.zIndex = String(c.zi);
    if (focusedId !== c.id) {
      const prev = cards.get(focusedId);
      if (prev) prev.el.classList.remove('focused');
      focusedId = c.id;
      c.el.classList.add('focused');
    }
  }

  function overlaps(x, y, w, h) {
    for (const c of cards.values()) {
      if (Math.abs(c.x - x) < 24 && Math.abs(c.y - y) < 24) return true;
    }
    return false;
  }

  function viewportCenterWorld() {
    const r = viewport.getBoundingClientRect();
    return { x: (r.width / 2 - cam.x) / cam.z, y: (r.height / 2 - cam.y) / cam.z };
  }

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html) e.innerHTML = html;
    return e;
  }

  function createCard(opts = {}) {
    counter++;
    const w = opts.w || config.defaultWidth;
    const h = opts.h || config.defaultHeight;
    let x = opts.x;
    let y = opts.y;
    if (x === undefined || y === undefined) {
      const ctr = viewportCenterWorld();
      x = Math.round(ctr.x - w / 2);
      y = Math.round(ctr.y - h / 2);
      for (let i = 0; i < 30 && overlaps(x, y, w, h); i++) { x += 36; y += 36; }
    }
    const c = {
      id: opts.id || uid(),
      x, y, w, h,
      title: opts.title || `Terminal ${counter}`,
      customTitle: !!opts.customTitle,
      color: opts.color || COLORS[(counter - 1) % COLORS.length],
      zi: ++topZ,
    };

    const root = el('div', 'card');
    root.style.setProperty('--card-color', c.color);
    const bar = el('div', 'titlebar');
    const dot = el('span', 'dot');
    dot.title = S.changeColor;
    const title = el('span', 'title');
    title.textContent = c.title;
    title.title = S.rename;
    const btnClose = el('button', '', '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>');
    btnClose.title = S.close;
    bar.append(dot, title, btnClose);
    const body = el('div', 'body');
    const termEl = el('div', 'term');
    body.appendChild(termEl);
    root.append(bar, body);
    for (const d of ['e', 'w', 's', 'se', 'sw']) {
      const h2 = el('div', 'rz rz-' + d);
      h2.dataset.dir = d;
      root.appendChild(h2);
    }
    world.appendChild(root);
    c.el = root;
    c.titleEl = title;
    layoutCard(c);

    const term = new Terminal({
      fontFamily: config.fontFamily,
      fontSize: Math.max(1, config.fontSize * cam.z),
      lineHeight: config.lineHeight,
      cursorBlink: config.cursorBlink,
      macOptionIsMeta: config.macOptionIsMeta,
      scrollback: config.scrollback,
      allowProposedApi: true,
      theme,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    if (window.WebLinksAddon) {
      term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => vscode.postMessage({ type: 'openLink', uri })));
    }
    term.open(termEl);
    setupKeys(term);
    c.term = term;
    c.fit = fit;
    cards.set(c.id, c);

    term.onData((data) => vscode.postMessage({ type: 'input', id: c.id, data }));
    term.onResize(({ cols, rows }) => vscode.postMessage({ type: 'resize', id: c.id, cols, rows }));
    term.onTitleChange((t) => {
      if (!c.customTitle && t) { c.title = t; title.textContent = t; }
    });
    term.textarea && term.textarea.addEventListener('focus', () => bringToFront(c));

    // ----- interações do cartão
    root.addEventListener('pointerdown', () => bringToFront(c), true);

    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button') || e.target === dot || title.isContentEditable) return;
      e.preventDefault();
      const ox = c.x, oy = c.y;
      root.classList.add('dragging');
      drag(bar, e, (dx, dy) => {
        c.x = ox + dx / cam.z;
        c.y = oy + dy / cam.z;
        layoutCard(c);
      }, () => {
        root.classList.remove('dragging');
        saveSoon();
        term.focus();
      });
    });

    dot.addEventListener('click', () => {
      const i = COLORS.indexOf(c.color);
      c.color = COLORS[(i + 1) % COLORS.length];
      root.style.setProperty('--card-color', c.color);
      saveSoon();
    });

    title.addEventListener('dblclick', () => {
      title.contentEditable = 'true';
      title.focus();
      document.getSelection().selectAllChildren(title);
    });
    const commitTitle = () => {
      if (!title.isContentEditable) return;
      title.contentEditable = 'false';
      const t = title.textContent.trim();
      if (t) { c.title = t; c.customTitle = true; } else { title.textContent = c.title; }
      saveSoon();
      term.focus();
    };
    title.addEventListener('blur', commitTitle);
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitTitle(); }
      if (e.key === 'Escape') { title.textContent = c.title; commitTitle(); }
      e.stopPropagation();
    });

    btnClose.addEventListener('click', () => closeCard(c.id, true));

    root.querySelectorAll('.rz').forEach((handle) => {
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const dir = handle.dataset.dir;
        const o = { x: c.x, y: c.y, w: c.w, h: c.h };
        let raf = 0;
        drag(handle, e, (dx, dy) => {
          dx /= cam.z; dy /= cam.z;
          if (dir.includes('e')) c.w = Math.max(MIN_W, o.w + dx);
          if (dir.includes('s')) c.h = Math.max(MIN_H, o.h + dy);
          if (dir.includes('w')) {
            c.w = Math.max(MIN_W, o.w - dx);
            c.x = o.x + (o.w - c.w);
          }
          layoutCard(c);
          if (!raf) raf = requestAnimationFrame(() => { raf = 0; fitCard(c); });
        }, () => { fitCard(c); saveSoon(); term.focus(); });
      });
    });

    requestAnimationFrame(() => {
      fitCard(c);
      vscode.postMessage({ type: 'create', id: c.id, cols: term.cols, rows: term.rows });
      if (opts.focus !== false) { bringToFront(c); term.focus(); }
    });
    saveSoon();
    return c;
  }

  function closeCard(id, kill) {
    const c = cards.get(id);
    if (!c) return;
    if (kill) vscode.postMessage({ type: 'kill', id });
    c.term.dispose();
    c.el.remove();
    cards.delete(id);
    if (focusedId === id) focusedId = null;
    saveSoon();
  }

  // ---------------------------------------------------------------- teclado
  // Dentro de um webview, o VS Code recebe todas as teclas (Cmd+K vira início de
  // atalho de duas teclas, Ctrl+R abre "Recentes" etc.). Aqui imitamos o terminal
  // integrado: atalhos de terminal ficam no shell; só os globais vão pro VS Code.
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  // Atalhos que o terminal integrado do VS Code trata ele mesmo.
  function localAction(e, term) {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    // Shift+Enter: quebra de linha sem enviar. Manda ESC+CR (Meta+Enter), que é o
    // que CLIs como Claude Code e Codex entendem como "nova linha", e no zsh
    // insere uma quebra literal no comando.
    if (k === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      return () => term.input('\x1b\r');
    }
    if (isMac) {
      if (e.metaKey && !e.ctrlKey && !e.altKey) {
        if (k === 'k' && !e.shiftKey) return () => term.clear();
        if (k === 'a' && !e.shiftKey) return () => term.selectAll();
        if (k === 'ArrowLeft') return () => term.input('\x01');   // início da linha
        if (k === 'ArrowRight') return () => term.input('\x05');  // fim da linha
        if (k === 'Backspace') return () => term.input('\x15');   // apaga até o início
        if (k === 'ArrowUp' && !e.shiftKey) return () => term.scrollToTop();
        if (k === 'ArrowDown' && !e.shiftKey) return () => term.scrollToBottom();
      }
      if (e.altKey && !e.metaKey && !e.ctrlKey && !config.macOptionIsMeta) {
        if (k === 'ArrowLeft') return () => term.input('\x1bb');  // palavra anterior
        if (k === 'ArrowRight') return () => term.input('\x1bf'); // próxima palavra
        if (k === 'Backspace') return () => term.input('\x17');   // apaga palavra
      }
    } else if (e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.shiftKey && k === 'a') return () => term.selectAll();
      if (!e.shiftKey && k === 'Backspace') return () => term.input('\x17');
      if (!e.shiftKey && k === 'ArrowLeft') return () => term.input('\x1bb');
      if (!e.shiftKey && k === 'ArrowRight') return () => term.input('\x1bf');
    }
    return null;
  }

  // Atalhos que devem continuar indo pro VS Code (paleta, busca de arquivo,
  // trocar de aba, salvar...). Todo o resto fica no terminal.
  function goesToVSCode(e) {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === 'F1') return true;
    if (e.ctrlKey && (k === '`' || k === 'Tab')) return true;
    if (isMac) {
      if (!e.metaKey) return false;          // Ctrl/Option + tecla: shell
      if (k === 'c' || k === 'v' || k === 'x') return true; // copiar/colar nativos
      return true;                           // demais Cmd+…: VS Code
    }
    if (!e.ctrlKey || e.altKey) return false;
    if (e.shiftKey) return !['c', 'v'].includes(k); // Ctrl+Shift+P etc.
    return ['p', ',', 'v'].includes(k);       // Ctrl+P, Ctrl+, e colar
  }

  function setupKeys(term) {
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const act = localAction(e, term);
      if (act) {
        e.preventDefault();
        act();
        return false;
      }
      // No Mac, xterm ignora Cmd+tecla; deixamos o VS Code cuidar.
      if (isMac && e.metaKey) return false;
      return true;
    });
    // Roda depois do xterm (mesmo elemento, registrado depois) e impede que a
    // tecla suba até o listener do VS Code.
    const stop = (e) => {
      if (localAction(e, term) || !goesToVSCode(e)) e.stopPropagation();
    };
    term.textarea.addEventListener('keydown', stop);
    term.textarea.addEventListener('keyup', stop);
  }

  // Arraste genérico com pointer capture.
  function drag(target, e, onMove, onEnd) {
    const sx = e.clientX, sy = e.clientY;
    const pid = e.pointerId;
    try { target.setPointerCapture(pid); } catch (_) { /* ignore */ }
    const move = (ev) => onMove(ev.clientX - sx, ev.clientY - sy, ev);
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      try { target.releasePointerCapture(pid); } catch (_) { /* ignore */ }
      onEnd && onEnd();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  // ---------------------------------------------------------------- canvas
  const isBackground = (t) => t === viewport || t === world;

  viewport.addEventListener('pointerdown', (e) => {
    const middle = e.button === 1;
    if (!(middle || (e.button === 0 && isBackground(e.target)))) return;
    e.preventDefault();
    hideHint();
    const ox = cam.x, oy = cam.y;
    viewport.classList.add('panning');
    drag(viewport, e, (dx, dy) => {
      cam.x = ox + dx;
      cam.y = oy + dy;
      applyCamera();
    }, () => viewport.classList.remove('panning'));
  });

  viewport.addEventListener('dblclick', (e) => {
    if (!isBackground(e.target)) return;
    const r = viewport.getBoundingClientRect();
    const wx = (e.clientX - r.left - cam.x) / cam.z;
    const wy = (e.clientY - r.top - cam.y) / cam.z;
    createCard({ x: Math.round(wx - config.defaultWidth / 2), y: Math.round(wy - 14) });
  });

  // Capture: o xterm consome wheel; aqui decidimos antes dele.
  viewport.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      // pinça no trackpad chega como ctrl+wheel
      e.preventDefault();
      e.stopPropagation();
      hideHint();
      const d = clamp(e.deltaY * (e.deltaMode === 1 ? 16 : 1), -60, 60);
      zoomAt(e.clientX, e.clientY, Math.exp(-d * 0.006));
      return;
    }
    if (e.target.closest && e.target.closest('.term')) return; // rolar o terminal
    e.preventDefault();
    hideHint();
    if (config.wheelBehavior === 'zoom' && !e.shiftKey) {
      // modo zoom: a rodinha aproxima/afasta (Shift + rodinha ainda move)
      const d = clamp((e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 33 : 1), -100, 100);
      zoomAt(e.clientX, e.clientY, Math.exp(-d * 0.0025));
      return;
    }
    const k = e.deltaMode === 1 ? 16 : 1;
    const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
    const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
    cam.x -= dx * k;
    cam.y -= dy * k;
    applyCamera();
  }, { passive: false, capture: true });

  window.addEventListener('resize', () => applyCamera());

  // ---------------------------------------------------------------- ações
  function bounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of cards.values()) {
      minX = Math.min(minX, c.x); minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x + c.w); maxY = Math.max(maxY, c.y + c.h);
    }
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  }

  function fitAll() {
    if (!cards.size) return;
    const b = bounds();
    const r = viewport.getBoundingClientRect();
    const padX = 48, padTop = 72, padBottom = 64;
    const z = clamp(Math.min((r.width - padX * 2) / b.w, (r.height - padTop - padBottom) / b.h), MIN_Z, 1.25);
    animate(() => {
      cam.z = z;
      cam.x = (r.width - b.w * z) / 2 - b.minX * z;
      cam.y = padTop + (r.height - padTop - padBottom - b.h * z) / 2 - b.minY * z;
      applyCamera();
    });
  }

  function tile() {
    if (!cards.size) return;
    const list = [...cards.values()].sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const r = viewport.getBoundingClientRect();
    const n = list.length;
    const cols = Math.max(1, Math.round(Math.sqrt(n * (r.width / Math.max(1, r.height)) * (config.defaultHeight / config.defaultWidth))));
    const gap = 32;
    const w = config.defaultWidth, h = config.defaultHeight;
    const start = list.reduce((a, c) => ({ x: Math.min(a.x, c.x), y: Math.min(a.y, c.y) }), { x: Infinity, y: Infinity });
    animate(() => {
      list.forEach((c, i) => {
        c.x = start.x + (i % cols) * (w + gap);
        c.y = start.y + Math.floor(i / cols) * (h + gap);
        c.w = w; c.h = h;
        layoutCard(c);
      });
    });
    setTimeout(fitAll, 340);
    saveSoon();
  }

  function newTerminal() { hideHint(); createCard(); }

  document.getElementById('btn-new').addEventListener('click', newTerminal);
  document.getElementById('btn-fit').addEventListener('click', fitAll);
  document.getElementById('btn-tile').addEventListener('click', tile);
  document.getElementById('btn-zoom-in').addEventListener('click', () => animate(() => zoomCenter(1.25)));
  document.getElementById('btn-zoom-out').addEventListener('click', () => animate(() => zoomCenter(0.8)));
  zoomLabel.addEventListener('click', () => animate(() => zoomCenter(1 / cam.z)));

  // ---------------------------------------------------------------- menu do scroll
  const btnSettings = document.getElementById('btn-settings');
  const menu = document.getElementById('settings-menu');
  function syncMenu() {
    menu.querySelectorAll('.menu-item').forEach((b) => {
      const on = b.dataset.wheel === config.wheelBehavior;
      b.classList.toggle('checked', on);
      b.setAttribute('aria-checked', String(on));
    });
    btnSettings.classList.toggle('active', config.wheelBehavior === 'zoom');
  }
  function closeMenu() { menu.hidden = true; }
  btnSettings.addEventListener('click', (e) => {
    e.stopPropagation();
    syncMenu();
    menu.hidden = !menu.hidden;
  });
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.menu-item');
    if (!item) return;
    config.wheelBehavior = item.dataset.wheel;
    syncMenu();
    vscode.postMessage({ type: 'setWheel', value: config.wheelBehavior });
    setTimeout(closeMenu, 120);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !btnSettings.contains(e.target)) closeMenu();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  function hideHint() { hint.classList.add('hidden'); }
  setTimeout(hideHint, 7000);

  // ---------------------------------------------------------------- persistência
  let saveT = 0;
  function serialize() {
    return {
      cam: { ...cam },
      counter,
      cards: [...cards.values()]
        .sort((a, b) => a.zi - b.zi)
        .map(({ x, y, w, h, title, customTitle, color }) => ({ x, y, w, h, title, customTitle, color })),
    };
  }
  function saveSoon() {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      const layout = serialize();
      vscode.setState(layout);
      vscode.postMessage({ type: 'layout', layout });
    }, 300);
  }

  // ---------------------------------------------------------------- mensagens
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'init': {
        config = Object.assign(config, m.config || {});
        syncMenu();
        const layout = m.layout || vscode.getState();
        if (layout && layout.cam) cam = { x: layout.cam.x, y: layout.cam.y, z: clamp(layout.cam.z || 1, MIN_Z, MAX_Z) };
        else {
          const r = viewport.getBoundingClientRect();
          cam = { x: 0, y: 0, z: 1 };
          cam.x = r.width / 2; cam.y = r.height / 2;
        }
        applyCamera();
        if (layout && layout.cards && layout.cards.length) {
          layout.cards.forEach((c, i) => createCard(Object.assign({}, c, { focus: i === layout.cards.length - 1 })));
          counter = Math.max(counter, layout.counter || 0);
        } else {
          createCard();
        }
        break;
      }
      case 'config': {
        config = Object.assign(config, m.config || {});
        syncMenu();
        for (const c of cards.values()) {
          c.term.options.fontFamily = config.fontFamily;
          c.term.options.lineHeight = config.lineHeight;
          c.term.options.fontSize = Math.max(1, config.fontSize * cam.z);
          fitCard(c);
        }
        break;
      }
      case 'data': {
        const c = cards.get(m.id);
        if (c) c.term.write(m.data);
        break;
      }
      case 'exit': {
        // Igual ao VS Code: digitou `exit`, o cartão fecha.
        closeCard(m.id, false);
        break;
      }
      case 'command': {
        if (m.name === 'new') newTerminal();
        else if (m.name === 'fitAll') fitAll();
        else if (m.name === 'tile') tile();
        break;
      }
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
