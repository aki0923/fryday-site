/*
 * Fryday — shared core used by every page.
 * Safe storage, config access, menu loading with a 10-minute cache and a
 * static fallback, price formatting, photo resolution and tiny DOM helpers.
 * Exposes window.Fryday. No dependencies, ES2017, no optional chaining
 * (older Android WebViews inside WhatsApp).
 */
(function () {
  'use strict';

  var PLACEHOLDER = 'ВСТАВЬТЕ_СЮДА';
  var MENU_CACHE_KEY = 'fryday_menu_v1';
  var MENU_CACHE_TTL = 10 * 60 * 1000;
  var MENU_TIMEOUT = 10000;
  var FALLBACK_URL = 'data/menu-fallback.json';
  var CURRENCY = 'с'; // Cyrillic «с», written right after the number: 319с

  /* ---------- storage (every call can throw inside in-app browsers) ---------- */

  function makeStore(kind) {
    function area() {
      try { return window[kind]; } catch (e) { return null; }
    }
    return {
      get: function (key) {
        try {
          var a = area();
          if (!a) return null;
          var raw = a.getItem(key);
          return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
      },
      set: function (key, value) {
        try {
          var a = area();
          if (!a) return false;
          a.setItem(key, JSON.stringify(value));
          return true;
        } catch (e) { return false; }
      },
      remove: function (key) {
        try {
          var a = area();
          if (a) a.removeItem(key);
        } catch (e) { /* ignore */ }
      }
    };
  }

  var store = makeStore('localStorage');
  var session = makeStore('sessionStorage');

  /* ---------- config ---------- */

  // Returns the config value, or '' when it is missing or still a placeholder.
  function cfg(key) {
    var c = window.FRYDAY_CONFIG || {};
    var v = c[key];
    if (v === undefined || v === null) return '';
    v = String(v).trim();
    if (!v || v.indexOf(PLACEHOLDER) !== -1) return '';
    return v;
  }

  /* ---------- formatting ---------- */

  function formatPrice(n) {
    var v = Math.round(Number(n) || 0);
    return String(v) + CURRENCY;
  }

  function hm(str) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(str || '').trim());
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }

  function hoursText(menu) {
    var fromCfg = cfg('HOURS_TEXT');
    if (fromCfg) return fromCfg;
    if (!menu || !menu.hours) return '';
    return 'Ежедневно с ' + menu.hours.open + ' до ' + menu.hours.close;
  }

  function digits(s) {
    return String(s || '').replace(/\D+/g, '');
  }

  // WhatsApp number: config first, then the one from the menu sheet.
  function waPhone(menu) {
    var p = digits(cfg('WA_PHONE'));
    if (p.length >= 10 && p.length <= 15) return p;
    p = digits(menu && menu.waPhone);
    if (p.length >= 10 && p.length <= 15) return p;
    return '';
  }

  /* ---------- photos ---------- */

  var PLACEHOLDER_IMG = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 120">' +
    '<ellipse cx="80" cy="70" rx="58" ry="30" fill="#F4E2B7"/>' +
    '<ellipse cx="80" cy="64" rx="40" ry="18" fill="#FFFAE7"/>' +
    '<circle cx="80" cy="60" r="7" fill="#F4E2B7"/></svg>'
  );

  // Photo resolution rule (contract §3.1): explicit URL, else img/items/<id>.webp, else placeholder.
  function photoSrc(entity) {
    var p = entity && typeof entity.photo === 'string' ? entity.photo.trim() : '';
    if (p) return p;
    return 'img/items/' + encodeURIComponent(String(entity && entity.id || '')) + '.webp';
  }

  // Intrinsic sizes of the shipped photo set, so layout does not jump while loading.
  function photoDims(entity, isOption) {
    var id = String(entity && entity.id || '');
    var cat = String(entity && entity.category || '');
    if (isOption || id.indexOf('top_') === 0) return { w: 500, h: 500 };
    if (cat === 'hotdogs' || id.indexOf('hotdog') === 0) return { w: 900, h: 900 };
    return { w: 900, h: 530 };
  }

  function makeImg(entity, opts) {
    opts = opts || {};
    var d = photoDims(entity, opts.option);
    var img = document.createElement('img');
    img.className = opts.className || '';
    img.alt = opts.alt !== undefined ? opts.alt : String(entity.title || '');
    img.width = d.w;
    img.height = d.h;
    img.decoding = 'async';
    if (opts.eager) {
      img.loading = 'eager';
    } else {
      img.loading = 'lazy';
    }
    img.addEventListener('error', function onErr() {
      img.removeEventListener('error', onErr);
      img.classList.add('is-placeholder');
      img.src = PLACEHOLDER_IMG;
    });
    img.src = photoSrc(entity);
    return img;
  }

  /* ---------- DOM helper ---------- */

  function el(tag, props, kids) {
    var n = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === undefined || v === null || v === false) return;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.indexOf('on') === 0 && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? '' : String(v));
      });
    }
    if (kids) {
      (Array.isArray(kids) ? kids : [kids]).forEach(function (c) {
        if (c === null || c === undefined || c === false) return;
        n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
      });
    }
    return n;
  }

  /* ---------- network ---------- */

  // fetch with an AbortSignal-based timeout; works on WebViews without AbortSignal.timeout.
  function fetchTimeout(url, init, ms) {
    init = init || {};
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = null;
    if (ctrl) {
      init.signal = ctrl.signal;
      timer = setTimeout(function () { ctrl.abort(); }, ms);
    }
    return fetch(url, init).then(function (res) {
      if (timer) clearTimeout(timer);
      return res;
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function fetchJSON(url, ms, init) {
    return fetchTimeout(url, init || { method: 'GET', redirect: 'follow' }, ms).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    }).then(function (text) {
      return JSON.parse(text);
    });
  }

  /* ---------- menu ---------- */

  function byOrder(a, b) { return a.order - b.order; }

  function str(v) { return v === undefined || v === null ? '' : String(v); }

  function clampInt(v, def, min, max) {
    var n = parseInt(v, 10);
    if (isNaN(n)) n = def;
    return Math.min(max, Math.max(min, n));
  }

  // Turns whatever the API returns into a predictable shape. Throws if unusable.
  function normalize(raw) {
    if (!raw || raw.ok !== true || !Array.isArray(raw.items)) throw new Error('bad menu');

    var items = raw.items.filter(function (i) { return i && i.id; }).map(function (i) {
      return {
        id: str(i.id),
        category: str(i.category),
        title: str(i.title),
        description: str(i.description),
        price: Number(i.price) || 0,
        available: i.available !== false,
        order: Number(i.order) || 0,
        photo: typeof i.photo === 'string' ? i.photo : ''
      };
    }).sort(byOrder);

    var categories = (Array.isArray(raw.categories) ? raw.categories : []).filter(function (c) {
      return c && c.id;
    }).map(function (c) {
      return { id: str(c.id), title: str(c.title) || str(c.id), subtitle: str(c.subtitle), order: Number(c.order) || 0 };
    }).sort(byOrder);

    // Items pointing at a category that is not listed still get shown.
    var known = {};
    categories.forEach(function (c) { known[c.id] = true; });
    items.forEach(function (i) {
      if (!known[i.category]) {
        known[i.category] = true;
        categories.push({ id: i.category, title: 'Ещё', subtitle: '', order: 9999 });
      }
    });
    // Drop empty categories.
    categories = categories.filter(function (c) {
      return items.some(function (i) { return i.category === c.id; });
    });

    var options = (Array.isArray(raw.options) ? raw.options : []).filter(function (o) {
      return o && o.id;
    }).map(function (o) {
      return {
        id: str(o.id),
        kind: str(o.kind),
        title: str(o.title),
        price: Number(o.price) || 0,
        appliesTo: Array.isArray(o.appliesTo) ? o.appliesTo.map(str) : [],
        available: o.available !== false,
        order: Number(o.order) || 0,
        photo: typeof o.photo === 'string' ? o.photo : ''
      };
    }).sort(byOrder);

    var hours = raw.hours || {};
    var openStr = hm(hours.open) !== null ? str(hours.open).trim() : '11:00';
    var closeStr = hm(hours.close) !== null ? str(hours.close).trim() : '23:00';

    // VERIFY: "now" is NOT part of the contract. If the backend ever adds a server
    // timestamp under this name, it is used to correct a wrong phone clock; otherwise ignored.
    var serverNow = raw.now ? Date.parse(raw.now) : NaN;

    return {
      updatedAt: str(raw.updatedAt),
      open: raw.open !== false,
      hours: { open: openStr, close: closeStr, tz: str(hours.tz) || 'Asia/Bishkek' },
      leadMinutes: clampInt(raw.leadMinutes, 20, 0, 24 * 60),
      slotMinutes: clampInt(raw.slotMinutes, 15, 5, 120),
      maxDaysAhead: clampInt(raw.maxDaysAhead, 1, 0, 7),
      waPhone: digits(raw.waPhone),
      categories: categories,
      items: items,
      options: options,
      serverNow: isNaN(serverNow) ? null : serverNow
    };
  }

  function menuUrl() {
    var api = cfg('API_URL');
    if (!api) return '';
    // Cache-buster: some in-app WebViews cache GETs aggressively.
    return api + (api.indexOf('?') === -1 ? '?' : '&') + 'action=menu&_=' + Date.now();
  }

  /*
   * load({force}) → Promise<{ menu, source, fetchedAt, clockOffset }>
   * source: 'live'     fresh from the API
   *         'cache'    from localStorage, younger than 10 minutes
   *         'stale'    API failed, older cached copy used     → show "prices may be out of date"
   *         'fallback' API failed, data/menu-fallback.json   → show "prices may be out of date"
   */
  function load(opts) {
    opts = opts || {};
    var cached = store.get(MENU_CACHE_KEY);
    var now = Date.now();

    if (!opts.force && cached && cached.data && cached.ts <= now && now - cached.ts < MENU_CACHE_TTL) {
      try {
        return Promise.resolve({ menu: normalize(cached.data), source: 'cache', fetchedAt: cached.ts, clockOffset: cached.offset || 0 });
      } catch (e) { /* corrupt cache, fall through */ }
    }

    var url = menuUrl();
    var live = url
      ? fetchJSON(url, MENU_TIMEOUT, { method: 'GET', redirect: 'follow', cache: 'no-store' })
      : Promise.reject(new Error('API_URL not configured'));

    return live.then(function (raw) {
      var menu = normalize(raw);
      var ts = Date.now();
      var offset = menu.serverNow ? menu.serverNow - ts : 0;
      store.set(MENU_CACHE_KEY, { ts: ts, data: raw, offset: offset });
      return { menu: menu, source: 'live', fetchedAt: ts, clockOffset: offset };
    }).catch(function () {
      if (cached && cached.data) {
        try {
          return { menu: normalize(cached.data), source: 'stale', fetchedAt: cached.ts, clockOffset: cached.offset || 0 };
        } catch (e) { /* fall through to static file */ }
      }
      return fetchJSON(FALLBACK_URL, 10000).then(function (raw) {
        return { menu: normalize(raw), source: 'fallback', fetchedAt: 0, clockOffset: 0 };
      });
    });
  }

  function isOutdated(source) {
    return source === 'stale' || source === 'fallback';
  }

  window.Fryday = {
    store: store,
    session: session,
    cfg: cfg,
    formatPrice: formatPrice,
    hm: hm,
    hoursText: hoursText,
    digits: digits,
    waPhone: waPhone,
    photoSrc: photoSrc,
    photoDims: photoDims,
    makeImg: makeImg,
    el: el,
    fetchTimeout: fetchTimeout,
    loadMenu: load,
    isOutdated: isOutdated,
    reducedMotion: function () {
      try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
    }
  };
})();
