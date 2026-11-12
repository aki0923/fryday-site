/*
 * Fryday — order page: menu, cart, bottom sheets, pickup slots, phone input,
 * Turnstile, order submission per the CONTRACT, confirmation screen.
 * Plain ES2017, no optional chaining. Every storage call goes through
 * Fryday.store / Fryday.session (try/catch inside).
 */
(function () {
  'use strict';

  var F = window.Fryday;
  var el = F.el;

  var CART_KEY = 'fryday_cart_v1';
  var CUSTOMER_KEY = 'fryday_customer_v1';
  var DRAFT_KEY = 'fryday_draft_v1';
  var MAX_QTY = 20;
  var POST_TIMEOUT = 15000;
  var TOKEN_WAIT = 25000;
  var PLACED_TTL = 6 * 60 * 60 * 1000;
  var GENERIC_ERROR = 'Не удалось отправить заказ. Проверьте интернет и попробуйте ещё раз.';
  var MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

  var state = {
    menu: null,
    source: '',
    clockOffset: 0,
    menuSig: '',
    itemsById: {},
    optionsById: {},
    cart: null,
    slots: [],      // times on the minute-button grid (TIME_STEP_MINUTES)
    asap: null,     // today's «как можно скорее» time, or null when today is over
    submitting: false,
    sheet: null,
    sheetSeq: 0,
    returnFocus: null,
    closeOpts: null,
    sheetItem: null,
    sheetQty: 1,
    sheetOpts: [],
    cartNotice: '',
    invalidTimeCount: 0,
    confirmShown: false,
    chipsObserver: null
  };

  function $(id) { return document.getElementById(id); }

  var dom = {
    app: $('app'),
    orderView: $('orderView'),
    confirmView: $('confirmView'),
    chips: $('chips'),
    chipsRow: $('chipsRow'),
    menuRoot: $('menuRoot'),
    notice: $('menuNotice'),
    closed: $('closedBanner'),
    cartBar: $('cartBar'),
    cartBarBtn: $('cartBarBtn'),
    cartBarCount: $('cartBarCount'),
    cartBarTotal: $('cartBarTotal'),
    sheets: { item: $('itemSheet'), cart: $('cartSheet'), checkout: $('checkoutSheet') },
    itemTitle: $('itemSheetTitle'),
    itemBody: $('itemSheetBody'),
    itemFoot: $('itemSheetFoot'),
    cartBody: $('cartSheetBody'),
    cartFoot: $('cartSheetFoot'),
    form: $('checkoutForm'),
    summary: $('checkoutSummary'),
    name: $('name'),
    phone: $('phone'),
    readyAt: $('readyAt'),
    comment: $('comment'),
    consent: $('consent'),
    website: $('website'),
    formError: $('formError'),
    submitBtn: $('submitBtn'),
    submitSpinner: $('submitSpinner'),
    submitLabel: $('submitLabel')
  };

  var live = el('div', { class: 'visually-hidden', 'aria-live': 'polite', id: 'live' });
  document.body.appendChild(live);

  function announce(text) {
    live.textContent = '';
    setTimeout(function () { live.textContent = text; }, 50);
  }

  /* =====================================================================
   * Utilities
   * ===================================================================== */

  function uuid() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    } catch (e) { /* not a secure context */ }
    var b = new Uint8Array(16);
    try {
      window.crypto.getRandomValues(b);
    } catch (e) {
      for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = [];
    for (var j = 0; j < 16; j++) h.push((b[j] + 0x100).toString(16).slice(1));
    return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' + h.slice(6, 8).join('') + '-' +
      h.slice(8, 10).join('') + '-' + h.slice(10, 16).join('');
  }

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function safeId(s) { return String(s).replace(/[^\w-]/g, '_'); }

  function apiUrl() { return F.cfg('API_URL'); }

  /* =====================================================================
   * Time & slots. Times are handled as "wall minutes": minutes since epoch
   * of the local Asia/Bishkek clock, treated as if it were UTC. This makes
   * slot maths independent of the phone's own time zone.
   * ===================================================================== */

  function wallNow(menu) {
    var nowMs = Date.now() + (state.clockOffset || 0);
    var p = null;
    try {
      var fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: menu.hours.tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      });
      var parts = {};
      fmt.formatToParts(new Date(nowMs)).forEach(function (x) { parts[x.type] = x.value; });
      p = { y: +parts.year, mo: +parts.month, d: +parts.day, h: (+parts.hour) % 24, mi: +parts.minute, s: +parts.second || 0 };
      if (isNaN(p.y + p.mo + p.d + p.h + p.mi)) p = null;
    } catch (e) { p = null; }
    if (!p) {
      // VERIFY: fallback for WebViews without Intl time zones assumes UTC+6 (Asia/Bishkek, no DST).
      var d = new Date(nowMs + 6 * 3600 * 1000);
      p = { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
    }
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) / 60000;
  }

  // VERIFY: last slot is strictly before closing time (23:00 close → last slot 22:45).
  // The backend must use the same rule or it will answer invalid_time for the last slot.
  // step / lead default to the backend's slotMinutes / leadMinutes.
  function buildSlots(menu, step, lead) {
    var nowW = wallNow(menu);
    var earliest = nowW + (lead === undefined ? menu.leadMinutes : lead);
    step = step || menu.slotMinutes;
    var openM = F.hm(menu.hours.open);
    var closeM = F.hm(menu.hours.close);
    if (openM === null || closeM === null) return [];
    if (closeM <= openM) closeM += 1440; // closes after midnight
    var today = Math.floor(nowW / 1440) * 1440;
    var lastDay = today + menu.maxDaysAhead * 1440;
    var out = [];
    for (var base = today - 1440; base <= lastDay; base += 1440) {
      var to = base + closeM;
      var t = Math.ceil(Math.max(base + openM, earliest) / step) * step;
      for (; t < to; t += step) {
        if (Math.floor(t / 1440) * 1440 > lastDay) break;
        if (t >= earliest) out.push(t);
      }
    }
    return out;
  }

  function cfgMinutes(key) {
    var n = parseInt(F.cfg(key), 10);
    return isNaN(n) || n <= 0 ? null : n;
  }

  // «Как можно скорее» = now + ASAP_MINUTES (config.js), rounded up to the backend's grid.
  // Never sooner than the backend's leadMinutes, or it would refuse the order.
  function asapLead(menu) {
    return Math.max(menu.leadMinutes, cfgMinutes('ASAP_MINUTES') || menu.leadMinutes);
  }

  // Step of the minute buttons (config TIME_STEP_MINUTES, e.g. 20 → :00 :20 :40).
  // It must sit on the backend's grid (slotMinutes), otherwise the backend's own step is used.
  function pickStep(menu) {
    var s = cfgMinutes('TIME_STEP_MINUTES') || menu.slotMinutes;
    return s % menu.slotMinutes === 0 ? s : menu.slotMinutes;
  }

  function hasAnyTime() { return state.slots.length > 0 || state.asap !== null; }

  // Every value the hidden #readyAt may hold right now.
  function allowedTimes() { return state.asap !== null ? state.slots.concat([state.asap]) : state.slots; }

  function toReadyAt(t) {
    var d = new Date(t * 60000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) +
      'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
  }

  function fromReadyAt(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000;
  }

  function slotLabel(t) {
    var nowW = state.menu ? wallNow(state.menu) : Date.now() / 60000;
    var diff = Math.floor(t / 1440) - Math.floor(nowW / 1440);
    var d = new Date(t * 60000);
    var day;
    if (diff === 0) day = 'сегодня';
    else if (diff === 1) day = 'завтра';
    else if (diff === 2) day = 'послезавтра';
    else day = d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
    return day + ', ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
  }

  function labelForReadyAt(s) {
    var t = fromReadyAt(s);
    return t === null ? String(s || '') : slotLabel(t);
  }

  /* =====================================================================
   * Time picker: day → "as soon as possible", or hour → minute.
   * The slots themselves still come from buildSlots(); the picker only
   * writes the chosen one into the hidden #readyAt input, so validation
   * and the order request keep their exact format.
   * ===================================================================== */

  var WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

  // mode: 'asap' follows the earliest slot as the clock moves; 'exact' is a time the person picked.
  var tp = { mode: null, day: null, value: null };

  var tpDom = {
    field: $('fTime'),
    days: $('tpDays'),
    closed: $('tpClosed'),
    asap: $('tpAsap'),
    asapSub: $('tpAsapSub'),
    or: $('tpOr'),
    hoursWrap: $('tpHoursWrap'),
    hours: $('tpHours'),
    minsWrap: $('tpMinsWrap'),
    mins: $('tpMins'),
    summary: $('tpSummary'),
    summaryText: $('tpSummaryText')
  };

  function dayOf(t) { return Math.floor(t / 1440) * 1440; }
  function hourOf(t) { return Math.floor((t - dayOf(t)) / 60); }
  function hhmm(t) { var d = new Date(t * 60000); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); }
  function nowWall() { return state.menu ? wallNow(state.menu) : Date.now() / 60000; }

  function dayWord(dayStart) {
    var diff = Math.round((dayStart - dayOf(nowWall())) / 1440);
    if (diff === 0) return 'сегодня';
    if (diff === 1) return 'завтра';
    if (diff === 2) return 'послезавтра';
    var d = new Date(dayStart * 60000);
    return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
  }

  function dayDate(dayStart) {
    var d = new Date(dayStart * 60000);
    return WEEKDAYS[d.getUTCDay()] + ', ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
  }

  function inMinutes(min) {
    min = Math.max(1, Math.round(min));
    if (min < 60) return min + ' мин';
    var h = Math.floor(min / 60), m = min % 60;
    return h + ' ч' + (m ? ' ' + m + ' мин' : '');
  }

  // Today plus maxDaysAhead days, each with its bookable slots.
  function tpDays() {
    var start = dayOf(nowWall());
    var n = state.menu ? state.menu.maxDaysAhead : 0;
    var out = [];
    for (var i = 0; i <= n; i++) {
      var ds = start + i * 1440;
      var slots = state.slots.filter(function (t) { return dayOf(t) === ds; });
      // A day can be booked if it has minute-grid times, or (today) an «as soon as possible» time.
      out.push({ start: ds, index: i, slots: slots, open: slots.length > 0 || (i === 0 && state.asap !== null) });
    }
    return out;
  }

  // Every slot of that day's opening hours, so past hours can be shown greyed out.
  function dayGrid(day) {
    var m = state.menu;
    var openM = F.hm(m.hours.open);
    var closeM = F.hm(m.hours.close);
    var step = pickStep(m);
    var grid = [];
    if (openM !== null && closeM !== null && closeM > openM) {
      for (var t = Math.ceil((day.start + openM) / step) * step; t < day.start + closeM; t += step) grid.push(t);
    }
    day.slots.forEach(function (t) { if (grid.indexOf(t) === -1) grid.push(t); });
    grid.sort(function (a, b) { return a - b; });
    return grid;
  }

  function setTime(mode, day, t) {
    tp = { mode: mode, day: day, value: t };
    dom.readyAt.value = t === null ? '' : toReadyAt(t);
  }

  function afterPick() {
    clearFieldError('fTime', 'timeErr');
    renderTimePicker();
  }

  function pickDay(day) {
    if (day.index === 0 && state.asap !== null) setTime('asap', day.start, state.asap);
    else setTime(null, day.start, null);
    afterPick();
  }

  function pickHour(day, h) {
    var first = day.slots.filter(function (t) { return hourOf(t) === h; })[0];
    if (first === undefined) return;
    setTime('exact', day.start, first);
    afterPick();
  }

  function pickMinute(day, t) {
    setTime('exact', day.start, t);
    afterPick();
  }

  function tpButton(cls, label, pressed, disabled, onClick, aria) {
    var b = el('button', {
      type: 'button',
      class: 'tp-btn ' + cls,
      'aria-pressed': pressed ? 'true' : 'false',
      'aria-label': aria || null,
      disabled: !!disabled
    }, label);
    if (!disabled) b.addEventListener('click', onClick);
    return b;
  }

  function renderTimePicker() {
    var days = state.menu && hasAnyTime() ? tpDays() : [];
    var bookable = days.filter(function (d) { return d.open; });
    tpDom.days.textContent = '';
    tpDom.hours.textContent = '';
    tpDom.mins.textContent = '';

    if (!bookable.length) {
      tpDom.days.hidden = true;
      tpDom.closed.hidden = true;
      tpDom.asap.hidden = true;
      tpDom.or.hidden = true;
      tpDom.hoursWrap.hidden = true;
      tpDom.minsWrap.hidden = true;
      tpDom.summary.hidden = true;
      return;
    }

    var today = days[0];
    var current = days.filter(function (d) { return d.start === tp.day && d.open; })[0] || bookable[0];

    // Days
    tpDom.days.hidden = false;
    tpDom.days.style.gridTemplateColumns = 'repeat(' + Math.min(days.length, 3) + ', minmax(0, 1fr))';
    days.forEach(function (d) {
      var off = !d.open;
      var word = dayWord(d.start);
      var sub = off ? (d.index === 0 ? 'уже не успеем' : 'нет времени') : (d.index < 2 ? dayDate(d.start) : WEEKDAYS[new Date(d.start * 60000).getUTCDay()]);
      tpDom.days.appendChild(tpButton('tp-day', [
        el('span', { class: 'tp-day__name' }, word.charAt(0).toUpperCase() + word.slice(1)),
        el('span', { class: 'tp-day__sub' }, sub)
      ], d.start === current.start, off, function () { pickDay(d); }));
    });

    tpDom.closed.hidden = today.open;
    tpDom.closed.textContent = 'Сегодня уже не успеем приготовить — выберите время на ' + (days[1] && days[1].open ? 'завтра' : 'другой день') + '.';

    // As soon as possible (today only)
    var showAsap = current.index === 0 && state.asap !== null;
    tpDom.asap.hidden = !showAsap;
    tpDom.or.hidden = !showAsap;
    if (showAsap) {
      var first = state.asap;
      tpDom.asap.setAttribute('aria-pressed', tp.mode === 'asap' ? 'true' : 'false');
      tpDom.asapSub.textContent = 'будет готово к ' + hhmm(first) + ' · через ' + inMinutes(first - nowWall());
    }

    // Hours
    var grid = dayGrid(current);
    var hours = [];
    grid.forEach(function (t) { var h = hourOf(t); if (hours.indexOf(h) === -1) hours.push(h); });
    var chosenHour = tp.mode === 'exact' && tp.value !== null && dayOf(tp.value) === current.start ? hourOf(tp.value) : null;
    tpDom.hoursWrap.hidden = false;
    hours.forEach(function (h) {
      var open = current.slots.some(function (t) { return hourOf(t) === h; });
      tpDom.hours.appendChild(tpButton('tp-hour', String(h), h === chosenHour, !open,
        function () { pickHour(current, h); }, 'Час ' + h + (open ? '' : ', время прошло')));
    });

    // Minutes of the chosen hour
    tpDom.minsWrap.hidden = chosenHour === null;
    if (chosenHour !== null) {
      var inHour = grid.filter(function (t) { return hourOf(t) === chosenHour; });
      tpDom.mins.style.gridTemplateColumns = 'repeat(' + Math.min(inHour.length, 4) + ', minmax(0, 1fr))';
      inHour.forEach(function (t) {
        var ok = current.slots.indexOf(t) !== -1;
        tpDom.mins.appendChild(tpButton('tp-min', hhmm(t), t === tp.value, !ok, function () { pickMinute(current, t); }));
      });
    }

    // Summary
    tpDom.summary.hidden = false;
    tpDom.summary.classList.toggle('is-set', tp.value !== null);
    tpDom.summaryText.textContent = tp.value !== null
      ? 'Будет готово ' + dayWord(dayOf(tp.value)) + ' к ' + hhmm(tp.value)
      : 'Выберите час — минуты подставим сами';
  }

  tpDom.asap.addEventListener('click', function () {
    if (state.asap === null) return;
    setTime('asap', dayOf(state.asap), state.asap);
    afterPick();
  });

  // Focus the picker after an error: the selected button, else the first one that can be pressed.
  function focusTimePicker() {
    var buttons = Array.prototype.filter.call(tpDom.field.querySelectorAll('button'), function (b) {
      return !b.disabled && b.offsetParent !== null;
    });
    var pressed = buttons.filter(function (b) { return b.getAttribute('aria-pressed') === 'true'; });
    var target = pressed[pressed.length - 1] || buttons[0];
    if (target) target.focus();
  }

  /* =====================================================================
   * Cart
   * ===================================================================== */

  function newCart() {
    return { lines: [], clientKey: uuid(), attempted: false, placed: null };
  }

  function lineKey(id, options) {
    return id + '|' + options.slice().sort().join(',');
  }

  function loadCart() {
    var c = F.store.get(CART_KEY);
    if (!c || !Array.isArray(c.lines)) return newCart();
    var lines = [];
    var seen = {};
    c.lines.forEach(function (l) {
      if (!l || !l.id) return;
      var opts = Array.isArray(l.options) ? l.options.map(String).filter(function (o, i, a) { return o && a.indexOf(o) === i; }).sort() : [];
      var qty = Math.min(MAX_QTY, Math.max(1, parseInt(l.qty, 10) || 1));
      var k = lineKey(String(l.id), opts);
      if (seen[k]) { seen[k].qty = Math.min(MAX_QTY, seen[k].qty + qty); return; }
      var line = { id: String(l.id), qty: qty, options: opts };
      seen[k] = line;
      lines.push(line);
    });
    var placed = c.placed && c.placed.at && Date.now() - c.placed.at < PLACED_TTL ? c.placed : null;
    return {
      lines: lines,
      clientKey: typeof c.clientKey === 'string' && c.clientKey ? c.clientKey : uuid(),
      attempted: !!c.attempted,
      placed: placed
    };
  }

  function saveCart() { F.store.set(CART_KEY, state.cart); }

  function cartSig(cart) {
    return JSON.stringify((cart || state.cart).lines.map(function (l) { return [l.id, l.qty, l.options]; }));
  }

  // Any change to the cart contents after a submit attempt makes it a new cart,
  // so it gets a new clientKey (the old key may already be bound to an order).
  function mutateCart(fn) {
    fn(state.cart);
    state.cart.lines = state.cart.lines.filter(function (l) { return l.qty > 0; });
    if (state.cart.attempted || state.cart.placed) {
      state.cart.clientKey = uuid();
      state.cart.attempted = false;
      state.cart.placed = null;
    }
    saveCart();
    renderCartBar();
  }

  function addLine(id, qty, options) {
    var opts = options.slice().sort();
    mutateCart(function (cart) {
      var k = lineKey(id, opts);
      for (var i = 0; i < cart.lines.length; i++) {
        if (lineKey(cart.lines[i].id, cart.lines[i].options) === k) {
          cart.lines[i].qty = Math.min(MAX_QTY, cart.lines[i].qty + qty);
          return;
        }
      }
      cart.lines.push({ id: id, qty: qty, options: opts });
    });
  }

  function unitPrice(line) {
    var item = state.itemsById[line.id];
    if (!item) return null;
    var sum = item.price;
    line.options.forEach(function (oid) {
      var o = state.optionsById[oid];
      if (o) sum += o.price;
    });
    return sum;
  }

  function linePrice(line) {
    var u = unitPrice(line);
    return u === null ? null : u * line.qty;
  }

  function cartTotals() {
    var count = 0, total = 0;
    state.cart.lines.forEach(function (l) {
      count += l.qty;
      var p = linePrice(l);
      if (p !== null) total += p;
    });
    return { count: count, total: total };
  }

  function lineProblem(line) {
    var item = state.itemsById[line.id];
    if (!item) return 'Эта позиция больше не продаётся — удалите её.';
    if (!item.available) return 'Сейчас нет в наличии — удалите позицию.';
    return '';
  }

  function cartHasProblems() {
    return state.cart.lines.some(function (l) { return !!lineProblem(l); });
  }

  // Drops toppings that no longer exist / no longer apply / ran out. Items stay and get flagged.
  function sanitizeCart() {
    if (!state.menu || state.submitting) return; // never change the cart mid-submit
    var changed = false;
    var dropped = [];
    var lines = state.cart.lines.map(function (l) {
      var keep = l.options.filter(function (oid) {
        var o = state.optionsById[oid];
        var ok = o && o.available && o.appliesTo.indexOf(l.id) !== -1;
        if (!ok) {
          changed = true;
          if (o && dropped.indexOf(o.title) === -1) dropped.push(o.title);
        }
        return ok;
      });
      return { id: l.id, qty: l.qty, options: keep };
    });
    if (!changed) return;
    // Merge lines that became identical.
    var merged = [];
    var byKey = {};
    lines.forEach(function (l) {
      var k = lineKey(l.id, l.options);
      if (byKey[k]) { byKey[k].qty = Math.min(MAX_QTY, byKey[k].qty + l.qty); return; }
      byKey[k] = l;
      merged.push(l);
    });
    mutateCart(function (cart) { cart.lines = merged; });
    state.cartNotice = dropped.length
      ? 'Закончились топпинги: ' + dropped.join(', ') + '. Мы убрали их из корзины.'
      : 'Некоторые топпинги больше недоступны — мы убрали их из корзины.';
  }

  /* =====================================================================
   * Menu
   * ===================================================================== */

  function setMenu(res) {
    state.menu = res.menu;
    state.source = res.source;
    state.clockOffset = res.clockOffset || 0;
    state.itemsById = {};
    state.optionsById = {};
    res.menu.items.forEach(function (i) { state.itemsById[i.id] = i; });
    res.menu.options.forEach(function (o) { state.optionsById[o.id] = o; });
  }

  function refreshMenu(force) {
    return F.loadMenu({ force: !!force }).then(function (res) {
      setMenu(res);
      var sig = JSON.stringify([res.menu.open, res.menu.hours, res.menu.categories, res.menu.items, res.menu.options]);
      if (sig !== state.menuSig) {
        state.menuSig = sig;
        renderMenu();
      }
      applyMenuState();
      sanitizeCart();
      renderCartBar();
      if (state.sheet === 'cart') renderCartSheet();
      if (state.sheet === 'item' && state.sheetItem) {
        var fresh = state.itemsById[state.sheetItem.id];
        if (fresh) { state.sheetItem = fresh; renderItemSheet(); }
      }
      if (state.sheet === 'checkout') { rebuildSlots(true); renderCheckoutSummary(); }
      return res;
    }).catch(function () {
      if (!state.menu) showMenuError();
      return null;
    });
  }

  function applyMenuState() {
    var m = state.menu;
    if (!m) return;

    dom.notice.textContent = '';
    if (F.isOutdated(state.source)) {
      var again = el('button', { class: 'link-btn', type: 'button' }, 'Обновить');
      again.addEventListener('click', function () { refreshMenu(true); });
      dom.notice.appendChild(document.createTextNode('Не удалось обновить меню — цены могут быть неактуальны. '));
      dom.notice.appendChild(again);
      dom.notice.hidden = false;
    } else {
      dom.notice.hidden = true;
    }

    if (!m.open) {
      dom.closed.textContent = '';
      dom.closed.appendChild(el('strong', null, 'Сейчас мы не принимаем предзаказы'));
      var hours = F.hoursText(m);
      dom.closed.appendChild(document.createTextNode(hours ? 'Часы работы: ' + hours + '. Меню можно посмотреть.' : 'Меню можно посмотреть.'));
      dom.closed.hidden = false;
    } else {
      dom.closed.hidden = true;
    }
  }

  function showMenuError() {
    dom.menuRoot.textContent = '';
    var retry = el('button', { class: 'btn btn--secondary', type: 'button' }, 'Попробовать снова');
    retry.addEventListener('click', function () {
      dom.menuRoot.textContent = '';
      dom.menuRoot.appendChild(el('div', { class: 'state-box' }, 'Загружаем меню…'));
      refreshMenu(true);
    });
    dom.menuRoot.appendChild(el('div', { class: 'state-box' }, [
      el('p', null, 'Не удалось загрузить меню. Проверьте интернет и попробуйте снова.'),
      retry
    ]));
  }

  function renderMenu() {
    var m = state.menu;
    dom.menuRoot.textContent = '';
    dom.chipsRow.textContent = '';

    m.categories.forEach(function (cat) {
      var items = m.items.filter(function (i) { return i.category === cat.id; });
      if (!items.length) return;
      var sid = 'cat-' + safeId(cat.id);

      var chip = el('button', { class: 'chip', type: 'button', 'data-target': sid }, cat.title);
      dom.chipsRow.appendChild(chip);

      var list = el('div', { class: 'olist' });
      items.forEach(function (item) {
        var action;
        if (!item.available) {
          action = el('span', { class: 'badge-off' }, 'Нет в наличии');
        } else if (!m.open) {
          action = el('button', { class: 'btn btn--secondary btn--sm', type: 'button', 'aria-label': 'Подробнее: ' + item.title }, 'Подробнее');
        } else {
          action = el('button', { class: 'btn btn--primary btn--sm', type: 'button', 'aria-label': 'Добавить: ' + item.title }, 'Добавить');
        }
        list.appendChild(el('article', { class: 'ocard' + (item.available ? '' : ' is-off'), 'data-item': item.id }, [
          F.makeImg(item, { className: 'ocard__photo', alt: '' }),
          el('div', { class: 'ocard__body' }, [
            el('h3', { class: 'ocard__name' }, item.title),
            el('p', { class: 'ocard__desc' }, item.description),
            el('div', { class: 'ocard__foot' }, [
              el('span', { class: 'pill' }, F.formatPrice(item.price)),
              action
            ])
          ])
        ]));
      });

      var section = el('section', { class: 'menu-cat', id: sid, 'aria-labelledby': sid + '-h' }, [
        el('h2', { id: sid + '-h' }, cat.title),
        cat.subtitle ? el('p', { class: 'cat-sub' }, cat.subtitle) : null,
        list
      ]);
      dom.menuRoot.appendChild(section);
    });

    if (!dom.menuRoot.childNodes.length) {
      dom.menuRoot.appendChild(el('div', { class: 'state-box' }, 'Меню скоро появится.'));
    }

    dom.chips.hidden = dom.chipsRow.childNodes.length < 2;
    observeChips();
  }

  function chipsOffset() {
    var bar = document.querySelector('.topbar');
    var h = bar ? bar.offsetHeight : 56;
    if (!dom.chips.hidden) h += dom.chips.offsetHeight;
    return h + 8;
  }

  function scrollToSection(sid) {
    var target = document.getElementById(sid);
    if (!target) return;
    var y = target.getBoundingClientRect().top + window.pageYOffset - chipsOffset();
    try {
      window.scrollTo({ top: y, behavior: F.reducedMotion() ? 'auto' : 'smooth' });
    } catch (e) {
      window.scrollTo(0, y);
    }
  }

  function setActiveChip(sid) {
    Array.prototype.forEach.call(dom.chipsRow.children, function (c) {
      var on = c.getAttribute('data-target') === sid;
      c.classList.toggle('is-active', on);
      if (on) {
        c.setAttribute('aria-current', 'true');
        var row = dom.chipsRow;
        var left = c.offsetLeft - (row.clientWidth - c.offsetWidth) / 2;
        row.scrollLeft = Math.max(0, left);
      } else {
        c.removeAttribute('aria-current');
      }
    });
  }

  function observeChips() {
    if (state.chipsObserver) state.chipsObserver.disconnect();
    if (!('IntersectionObserver' in window) || dom.chips.hidden) return;
    var visible = {};
    state.chipsObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { visible[e.target.id] = e.isIntersecting; });
      var sections = dom.menuRoot.querySelectorAll('.menu-cat');
      for (var i = 0; i < sections.length; i++) {
        if (visible[sections[i].id]) { setActiveChip(sections[i].id); return; }
      }
    }, { rootMargin: '-130px 0px -55% 0px' });
    Array.prototype.forEach.call(dom.menuRoot.querySelectorAll('.menu-cat'), function (s) {
      state.chipsObserver.observe(s);
    });
    var first = dom.chipsRow.firstChild;
    if (first) setActiveChip(first.getAttribute('data-target'));
  }

  /* =====================================================================
   * Bottom sheets: history-aware (Android back closes the sheet),
   * focus trap, ESC, background made inert.
   * ===================================================================== */

  function historySheet() {
    try { return history.state && history.state.frydaySheet ? history.state.frydaySheet : null; } catch (e) { return null; }
  }

  function pushHistory(name) {
    try { history.pushState({ frydaySheet: name }, ''); } catch (e) { /* ignore */ }
  }

  function replaceHistory(name) {
    try { history.replaceState(name ? { frydaySheet: name } : null, ''); } catch (e) { /* ignore */ }
  }

  function setBackgroundInert(on) {
    if (on) {
      dom.app.setAttribute('aria-hidden', 'true');
      dom.app.inert = true;
      document.documentElement.classList.add('is-locked');
    } else {
      dom.app.removeAttribute('aria-hidden');
      dom.app.inert = false;
      document.documentElement.classList.remove('is-locked');
    }
  }

  function openSheet(name) {
    var node = dom.sheets[name];
    if (!node) return;
    state.sheetSeq++;
    if (state.sheet === name) return;
    if (state.sheet) {
      var prev = dom.sheets[state.sheet];
      prev.classList.remove('is-open');
      prev.hidden = true;
      if (historySheet()) replaceHistory(name); else pushHistory(name);
    } else {
      state.returnFocus = document.activeElement;
      pushHistory(name);
    }
    state.sheet = name;
    node.hidden = false;
    setBackgroundInert(true);
    var body = node.querySelector('.sheet__body');
    if (body) body.scrollTop = 0;
    void node.offsetHeight; // reflow so the slide-in transition runs
    node.classList.add('is-open');
    var panel = node.querySelector('.sheet__panel');
    try { panel.focus({ preventScroll: true }); } catch (e) { panel.focus(); }
  }

  function closeSheet(opts) {
    if (!state.sheet) return;
    state.closeOpts = opts || {};
    if (historySheet()) {
      var seq = state.sheetSeq;
      try { history.back(); } catch (e) { finishClose(); return; }
      // Safety net: some WebViews do not fire popstate reliably.
      setTimeout(function () {
        if (state.sheet && state.sheetSeq === seq) finishClose();
      }, 600);
    } else {
      finishClose();
    }
  }

  function finishClose() {
    var name = state.sheet;
    if (!name) return;
    state.sheet = null;
    var node = dom.sheets[name];
    node.classList.remove('is-open');
    setBackgroundInert(false);
    setTimeout(function () {
      if (state.sheet !== name) node.hidden = true;
    }, F.reducedMotion() ? 0 : 280);

    var opts = state.closeOpts || {};
    state.closeOpts = null;
    var target = state.returnFocus;
    state.returnFocus = null;
    if (opts.focus !== false && target && document.body.contains(target) && target.getClientRects().length) {
      try { target.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
    if (name === 'cart') state.cartNotice = '';
  }

  window.addEventListener('popstate', function (e) {
    var s = e.state && e.state.frydaySheet;
    if (state.sheet && !s) finishClose();
  });

  function focusables(root) {
    var sel = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';
    return Array.prototype.filter.call(root.querySelectorAll(sel), function (n) {
      if (n.getAttribute('tabindex') === '-1') return false;
      if (n.closest('.hp')) return false;
      return n.getClientRects().length > 0;
    });
  }

  document.addEventListener('keydown', function (e) {
    if (!state.sheet) return;
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      closeSheet();
      return;
    }
    if (e.key !== 'Tab') return;
    var panel = dom.sheets[state.sheet].querySelector('.sheet__panel');
    var list = focusables(panel);
    if (!list.length) { e.preventDefault(); panel.focus(); return; }
    var first = list[0], last = list[list.length - 1];
    var active = document.activeElement;
    if (e.shiftKey && (active === first || active === panel || !panel.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  });

  Object.keys(dom.sheets).forEach(function (name) {
    dom.sheets[name].addEventListener('click', function (e) {
      if (e.target.closest('[data-close]')) closeSheet();
    });
  });

  /* =====================================================================
   * Item sheet
   * ===================================================================== */

  function applicableOptions(item) {
    return state.menu.options.filter(function (o) { return o.appliesTo.indexOf(item.id) !== -1; });
  }

  function itemSheetTotal() {
    var item = state.sheetItem;
    var sum = item.price;
    state.sheetOpts.forEach(function (oid) {
      var o = state.optionsById[oid];
      if (o) sum += o.price;
    });
    return sum * state.sheetQty;
  }

  function makeStepper(value, onChange, opts) {
    opts = opts || {};
    var minus = el('button', { type: 'button', 'aria-label': 'Меньше', 'data-focus-key': opts.key ? opts.key + ':minus' : null }, '−');
    var out = el('output', { 'aria-live': 'polite' }, String(value));
    var plus = el('button', { type: 'button', 'aria-label': 'Больше', 'data-focus-key': opts.key ? opts.key + ':plus' : null }, '+');
    minus.disabled = value <= 1;
    plus.disabled = value >= MAX_QTY;
    minus.addEventListener('click', function () { if (value > 1) onChange(value - 1); });
    plus.addEventListener('click', function () { if (value < MAX_QTY) onChange(value + 1); });
    return el('div', { class: 'stepper', role: 'group', 'aria-label': opts.label || 'Количество' }, [minus, out, plus]);
  }

  // presetOpts: topping ids to pre-tick (from a deep link); unknown or unavailable ones are dropped.
  function openItem(itemId, presetOpts) {
    var item = state.itemsById[itemId];
    if (!item || !item.available) return;
    state.sheetItem = item;
    state.sheetQty = 1;
    var allowed = applicableOptions(item).filter(function (o) { return o.available; }).map(function (o) { return o.id; });
    state.sheetOpts = (presetOpts || []).filter(function (oid, i, arr) {
      return allowed.indexOf(oid) !== -1 && arr.indexOf(oid) === i;
    });
    renderItemSheet();
    openSheet('item');
  }

  function renderItemSheet() {
    var item = state.sheetItem;
    var m = state.menu;
    dom.itemTitle.textContent = item.title;
    dom.itemBody.textContent = '';

    dom.itemBody.appendChild(F.makeImg(item, { className: 'sheet-photo', alt: item.title, eager: true }));
    if (item.description) dom.itemBody.appendChild(el('p', { class: 'sheet-desc' }, item.description));

    var stepperHolder = el('div');
    dom.itemBody.appendChild(el('div', { class: 'row-between' }, [
      el('span', { class: 'pill pill--lg' }, F.formatPrice(item.price)),
      stepperHolder
    ]));

    var opts = applicableOptions(item);
    var addBtn = el('button', { class: 'btn btn--primary btn--block btn--lg', type: 'button' });

    function refreshTotal() {
      var canAdd = m.open && item.available;
      addBtn.disabled = !canAdd;
      addBtn.textContent = canAdd
        ? 'Добавить в корзину · ' + F.formatPrice(itemSheetTotal())
        : (item.available ? 'Сейчас заказы не принимаются' : 'Нет в наличии');
    }

    function renderStepper() {
      stepperHolder.textContent = '';
      stepperHolder.appendChild(makeStepper(state.sheetQty, function (v) {
        state.sheetQty = v;
        renderStepper();
        refreshTotal();
        var btns = stepperHolder.querySelectorAll('button');
        var focusBtn = v >= MAX_QTY ? btns[0] : v <= 1 ? btns[1] : null;
        if (focusBtn) focusBtn.focus();
      }));
    }
    renderStepper();

    if (opts.length) {
      var fs = el('fieldset', { class: 'opts' }, [el('legend', null, 'Топпинги')]);
      opts.forEach(function (o) {
        var cb = el('input', { type: 'checkbox', value: o.id, 'aria-label': o.title + ', ' + F.formatPrice(o.price) });
        cb.checked = state.sheetOpts.indexOf(o.id) !== -1;
        cb.disabled = !o.available;
        cb.addEventListener('change', function () {
          var i = state.sheetOpts.indexOf(o.id);
          if (cb.checked && i === -1) state.sheetOpts.push(o.id);
          if (!cb.checked && i !== -1) state.sheetOpts.splice(i, 1);
          refreshTotal();
        });
        fs.appendChild(el('label', { class: 'opt' + (o.available ? '' : ' is-off') }, [
          F.makeImg(o, { option: true, alt: '' }),
          el('span', { class: 'opt__name' }, o.title),
          o.available
            ? el('span', { class: 'pill pill--sm' }, '+' + F.formatPrice(o.price))
            : el('span', { class: 'badge-off' }, 'нет'),
          cb
        ]));
      });
      dom.itemBody.appendChild(fs);
    }

    addBtn.addEventListener('click', function () {
      if (!m.open || !item.available) return;
      addLine(item.id, state.sheetQty, state.sheetOpts);
      announce('Добавлено в корзину: ' + item.title);
      closeSheet();
    });
    dom.itemFoot.textContent = '';
    dom.itemFoot.appendChild(addBtn);
    refreshTotal();
  }

  /* =====================================================================
   * Cart bar & cart sheet
   * ===================================================================== */

  function renderCartBar() {
    if (!state.menu || state.confirmShown) { dom.cartBar.hidden = true; return; }
    var t = cartTotals();
    dom.cartBar.hidden = t.count === 0;
    dom.cartBarCount.textContent = 'Корзина · ' + t.count + ' шт.';
    dom.cartBarTotal.textContent = F.formatPrice(t.total);
    dom.cartBarBtn.setAttribute('aria-label', 'Открыть корзину: ' + t.count + ' ' + plural(t.count, 'позиция', 'позиции', 'позиций') + ', ' + F.formatPrice(t.total));
  }

  function renderCartSheet() {
    var focusKey = document.activeElement && document.activeElement.getAttribute
      ? document.activeElement.getAttribute('data-focus-key') : null;

    dom.cartBody.textContent = '';
    dom.cartFoot.textContent = '';

    if (state.cartNotice) dom.cartBody.appendChild(el('div', { class: 'notice', role: 'status' }, state.cartNotice));

    if (!state.cart.lines.length) {
      var back = el('button', { class: 'btn btn--secondary btn--block', type: 'button' }, 'Перейти к меню');
      back.addEventListener('click', function () { closeSheet(); });
      dom.cartBody.appendChild(el('div', { class: 'state-box' }, [el('p', null, 'Корзина пуста.'), back]));
      return;
    }

    state.cart.lines.forEach(function (line, idx) {
      var item = state.itemsById[line.id];
      var problem = lineProblem(line);
      var key = 'l' + idx + ':' + lineKey(line.id, line.options);
      var optNames = line.options.map(function (oid) {
        var o = state.optionsById[oid];
        return o ? o.title : oid;
      });
      var price = linePrice(line);

      var remove = el('button', { class: 'link-btn', type: 'button', 'data-focus-key': key + ':rm', 'aria-label': 'Удалить: ' + (item ? item.title : line.id) }, 'Удалить');
      remove.addEventListener('click', function () {
        mutateCart(function (cart) { cart.lines.splice(idx, 1); });
        renderCartSheet();
        announce('Позиция удалена');
        if (!state.cart.lines.length) {
          var btn = dom.cartBody.querySelector('button');
          if (btn) btn.focus();
        }
      });

      var stepper = makeStepper(line.qty, function (v) {
        mutateCart(function (cart) { cart.lines[idx].qty = v; });
        renderCartSheet();
      }, { key: key, label: 'Количество: ' + (item ? item.title : '') });
      if (problem) Array.prototype.forEach.call(stepper.querySelectorAll('button'), function (b) { b.disabled = true; });

      dom.cartBody.appendChild(el('div', { class: 'cart-line' + (problem ? ' has-problem' : '') }, [
        el('p', { class: 'cart-line__name' }, item ? item.title : 'Позиция недоступна'),
        optNames.length ? el('p', { class: 'cart-line__opts' }, '+ ' + optNames.join(', ')) : null,
        problem ? el('p', { class: 'cart-line__problem' }, problem) : null,
        el('div', { class: 'row-between' }, [
          stepper,
          price !== null ? el('span', { class: 'pill' }, F.formatPrice(price)) : null
        ]),
        remove
      ]));
    });

    var t = cartTotals();
    var problems = cartHasProblems();
    var go = el('button', { class: 'btn btn--primary btn--block btn--lg', type: 'button' }, 'Оформить заказ');
    go.disabled = problems || !state.menu.open;
    go.addEventListener('click', openCheckout);

    dom.cartFoot.appendChild(el('div', { class: 'cart-total' }, [el('span', null, 'Итого'), el('span', { class: 'pill pill--lg' }, F.formatPrice(t.total))]));
    if (problems) dom.cartFoot.appendChild(el('p', { class: 'field__error' }, 'Удалите недоступные позиции, чтобы продолжить.'));
    if (!state.menu.open) dom.cartFoot.appendChild(el('p', { class: 'field__error' }, 'Сейчас мы не принимаем предзаказы.'));
    dom.cartFoot.appendChild(go);

    if (focusKey) {
      var again = dom.sheets.cart.querySelector('[data-focus-key="' + focusKey.replace(/"/g, '\\"') + '"]');
      if (again && !again.disabled) again.focus();
      else {
        var panel = dom.sheets.cart.querySelector('.sheet__panel');
        if (panel) panel.focus();
      }
    }
  }

  /* =====================================================================
   * Checkout: phone, slots, validation
   * ===================================================================== */

  function phoneNational(raw) {
    var d = F.digits(raw);
    if (d.indexOf('996') === 0) d = d.slice(3);
    else if (d.charAt(0) === '0') d = d.slice(1);
    return d.replace(/^0+/, '');
  }

  // Accepts +996XXXXXXXXX, 996XXXXXXXXX, 0XXXXXXXXX (and 9 bare digits). Returns '' if invalid.
  function normalizePhone(raw) {
    var n = phoneNational(raw);
    return /^[1-9]\d{8}$/.test(n) ? '+996' + n : '';
  }

  function formatPhone(nat) {
    var s = '+996';
    if (nat.length) s += ' ' + nat.slice(0, 3);
    if (nat.length > 3) s += ' ' + nat.slice(3, 6);
    if (nat.length > 6) s += ' ' + nat.slice(6, 9);
    return s;
  }

  dom.phone.addEventListener('focus', function () {
    if (!dom.phone.value) dom.phone.value = '+996 ';
  });

  dom.phone.addEventListener('input', function (e) {
    clearFieldError('fPhone', 'phoneErr');
    if (e.inputType && e.inputType.indexOf('delete') === 0) return; // let people delete freely
    var raw = dom.phone.value;
    var d = F.digits(raw);
    if ('996'.indexOf(d) === 0) return; // '', '9', '99', '996' — still typing the code
    var caretAtEnd = dom.phone.selectionStart === null || dom.phone.selectionStart >= raw.length;
    if (!caretAtEnd) return;
    var next = formatPhone(phoneNational(raw).slice(0, 9));
    if (next !== raw) {
      dom.phone.value = next;
      try { dom.phone.setSelectionRange(next.length, next.length); } catch (err) { /* ignore */ }
    }
    saveCustomer();
  });

  dom.phone.addEventListener('blur', function () {
    var nat = phoneNational(dom.phone.value).slice(0, 9);
    if (!nat) { dom.phone.value = ''; saveCustomer(); return; }
    dom.phone.value = formatPhone(nat);
    saveCustomer();
    if (!normalizePhone(dom.phone.value)) {
      setFieldError('fPhone', 'phoneErr', 'Введите номер полностью: +996 и 9 цифр, например +996 705 515 151.');
    }
  });

  dom.name.addEventListener('input', function () { clearFieldError('fName', 'nameErr'); saveCustomer(); });
  dom.comment.addEventListener('input', function () { F.session.set(DRAFT_KEY, { comment: dom.comment.value }); });
  dom.consent.addEventListener('change', function () { clearFieldError('fConsent', 'consentErr'); });

  function saveCustomer() {
    F.store.set(CUSTOMER_KEY, { name: dom.name.value.trim(), phone: dom.phone.value.trim() });
  }

  function restoreCustomer() {
    var c = F.store.get(CUSTOMER_KEY);
    if (c) {
      if (!dom.name.value && typeof c.name === 'string') dom.name.value = c.name;
      if (!dom.phone.value && typeof c.phone === 'string') dom.phone.value = c.phone;
    }
    var d = F.session.get(DRAFT_KEY);
    if (d && !dom.comment.value && typeof d.comment === 'string') dom.comment.value = d.comment;
  }

  function setFieldError(fieldId, errId, msg) {
    var f = $(fieldId), e = $(errId);
    if (f) f.classList.add('is-invalid');
    if (e) { e.textContent = msg; e.hidden = false; }
    var input = f ? f.querySelector('input, select, textarea') : null;
    if (input) input.setAttribute('aria-invalid', 'true');
  }

  function clearFieldError(fieldId, errId) {
    var f = $(fieldId), e = $(errId);
    if (f) f.classList.remove('is-invalid');
    if (e) { e.textContent = ''; e.hidden = true; }
    var input = f ? f.querySelector('input, select, textarea') : null;
    if (input) input.removeAttribute('aria-invalid');
  }

  function showFormError(msg) {
    dom.formError.textContent = msg;
    dom.formError.hidden = false;
  }

  function hideFormError() {
    dom.formError.textContent = '';
    dom.formError.hidden = true;
  }

  var NO_SLOTS_MSG = 'Сейчас нельзя выбрать время готовности. Загляните позже — в часы работы.';

  function rebuildSlots(keepSelection) {
    var prev = keepSelection ? dom.readyAt.value : '';
    var prevT = fromReadyAt(prev);
    var m = state.menu;
    // Minute buttons: TIME_STEP_MINUTES grid, never sooner than «как можно скорее».
    state.slots = m ? buildSlots(m, pickStep(m), asapLead(m)) : [];
    // «Как можно скорее»: the first time on the backend's own grid, today only.
    var fastest = m ? buildSlots(m, m.slotMinutes, asapLead(m)) : [];
    state.asap = fastest.length && dayOf(fastest[0]) === dayOf(wallNow(m)) ? fastest[0] : null;

    if (!hasAnyTime()) {
      setTime(null, null, null);
      renderTimePicker();
      setFieldError('fTime', 'timeErr', NO_SLOTS_MSG);
      updateSubmitState();
      return;
    }

    var days = tpDays();
    var today = days[0];
    var bookable = days.filter(function (d) { return d.open; });

    if (keepSelection && tp.mode === 'asap' && state.asap !== null) {
      setTime('asap', today.start, state.asap);              // "as soon as possible" moves with the clock
    } else if (keepSelection && tp.mode === 'exact' && prevT !== null && state.slots.indexOf(prevT) !== -1) {
      setTime('exact', dayOf(prevT), prevT);                  // a picked time that is still bookable stays
    } else if (state.asap !== null) {
      setTime('asap', today.start, state.asap);              // default: as soon as possible
    } else {
      var keepDay = keepSelection && bookable.some(function (d) { return d.start === tp.day; });
      setTime(null, keepDay ? tp.day : bookable[0].start, null);  // closed for today: the person picks a time
    }

    var errBox = $('timeErr');
    if ((prev && dom.readyAt.value !== prev) || (errBox && errBox.textContent === NO_SLOTS_MSG)) {
      clearFieldError('fTime', 'timeErr');
    }
    renderTimePicker();
    updateSubmitState();
  }

  function renderCheckoutSummary() {
    var t = cartTotals();
    dom.summary.textContent = '';
    dom.summary.appendChild(document.createTextNode(t.count + ' ' + plural(t.count, 'позиция', 'позиции', 'позиций') + ' · Итого '));
    dom.summary.appendChild(el('span', { class: 'pill pill--sm' }, F.formatPrice(t.total)));
  }

  function updateSubmitState() {
    if (state.submitting) return;
    var blocked = !state.menu || !state.menu.open || !hasAnyTime() || !state.cart.lines.length || cartHasProblems();
    dom.submitBtn.disabled = blocked;
  }

  function setBusy(on, label) {
    dom.submitSpinner.hidden = !on;
    dom.submitLabel.textContent = on ? (label || 'Отправляем…') : 'Оформить заказ';
    if (on) {
      dom.submitBtn.disabled = true;
      dom.submitBtn.setAttribute('aria-busy', 'true');
    } else {
      dom.submitBtn.removeAttribute('aria-busy');
      updateSubmitState();
    }
  }

  function openCheckout() {
    if (!state.cart.lines.length || cartHasProblems() || !state.menu.open) return;
    restoreCustomer();
    hideFormError();
    rebuildSlots(true);
    renderCheckoutSummary();
    openSheet('checkout');
    ensureTurnstile();
  }

  function validateForm() {
    var firstBad = null;
    var name = dom.name.value.trim().replace(/\s+/g, ' ');
    if (name.length < 2 || !/[A-Za-zА-Яа-яЁёҢңӨөҮү]/.test(name)) {
      setFieldError('fName', 'nameErr', 'Введите имя — хотя бы 2 буквы.');
      firstBad = firstBad || dom.name;
    }
    var phone = normalizePhone(dom.phone.value);
    if (!phone) {
      setFieldError('fPhone', 'phoneErr', 'Введите номер в формате +996 XXX XXX XXX.');
      firstBad = firstBad || dom.phone;
    }
    if (tp.mode === 'asap') rebuildSlots(true); // the earliest slot may have moved since the form opened
    var readyAt = dom.readyAt.value;
    var valid = allowedTimes().map(toReadyAt);
    if (!readyAt) {
      if (hasAnyTime()) setFieldError('fTime', 'timeErr', 'Выберите время готовности.');
      firstBad = firstBad || { focus: focusTimePicker };
    } else if (valid.indexOf(readyAt) === -1) {
      rebuildSlots(false);
      if (hasAnyTime()) setFieldError('fTime', 'timeErr', 'Это время уже прошло — выберите другое.');
      firstBad = firstBad || { focus: focusTimePicker };
    }
    if (!dom.consent.checked) {
      setFieldError('fConsent', 'consentErr', 'Отметьте согласие — без него мы не сможем принять заказ.');
      firstBad = firstBad || dom.consent;
    }
    if (firstBad) {
      firstBad.focus();
      return null;
    }
    return { name: name, phone: phone, readyAt: dom.readyAt.value };
  }

  /* =====================================================================
   * Turnstile (explicit render, interaction-only appearance)
   * ===================================================================== */

  var ts = { ready: false, id: null, token: '', waiters: [] };

  window.frydayTurnstileReady = function () {
    ts.ready = true;
    if (state.sheet === 'checkout') ensureTurnstile();
  };

  function siteKey() { return F.cfg('TURNSTILE_SITE_KEY'); }

  function deliverToken(token) {
    if (ts.waiters.length) ts.waiters.shift()(token);
    else ts.token = token;
  }

  function ensureTurnstile() {
    if (!siteKey() || ts.id !== null || !window.turnstile) return;
    try {
      // VERIFY: options "appearance", "size: flexible" and "language" per current Turnstile docs.
      ts.id = window.turnstile.render('#turnstileBox', {
        sitekey: siteKey(),
        action: 'order',
        language: 'ru',
        theme: 'light',
        size: 'flexible',
        appearance: 'interaction-only',
        callback: deliverToken,
        'expired-callback': function () { ts.token = ''; },
        'timeout-callback': function () { ts.token = ''; },
        'error-callback': function () { ts.token = ''; }
      });
    } catch (e) {
      ts.id = null;
    }
  }

  // Resolves with a fresh, unused token, or '' if none arrives in time (the server decides then).
  function takeToken() {
    if (!siteKey()) return Promise.resolve(''); // VERIFY: Turnstile not configured — dev mode only.
    ensureTurnstile();
    if (ts.token) {
      var t = ts.token;
      ts.token = '';
      return Promise.resolve(t);
    }
    return new Promise(function (resolve) {
      var done = false;
      var waiter = function (tok) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(tok);
      };
      var timer = setTimeout(function () {
        done = true;
        var i = ts.waiters.indexOf(waiter);
        if (i !== -1) ts.waiters.splice(i, 1);
        resolve('');
      }, TOKEN_WAIT);
      ts.waiters.push(waiter);
      // The script may have loaded after the sheet opened.
      setTimeout(ensureTurnstile, 0);
    });
  }

  // Tokens are single-use: ask for a new one after every request.
  function resetTurnstile() {
    ts.token = '';
    if (ts.id !== null && window.turnstile) {
      try { window.turnstile.reset(ts.id); } catch (e) { /* ignore */ }
    }
  }

  /* =====================================================================
   * Submit (CONTRACT §3.2 – §3.4)
   * ===================================================================== */

  function buildPayload(v, token) {
    // Key order mirrors the contract. Ids and quantities only — never prices.
    return {
      v: 1,
      name: v.name,
      phone: v.phone,
      readyAt: v.readyAt,
      comment: dom.comment.value.trim().slice(0, 200),
      items: state.cart.lines.map(function (l) {
        return { id: l.id, qty: l.qty, options: l.options.slice() };
      }),
      consent: true,
      clientKey: state.cart.clientKey,
      turnstileToken: token,
      website: dom.website.value
    };
  }

  function postOrder(body) {
    // text/plain keeps this a "simple" CORS request: Apps Script cannot answer a preflight.
    // VERIFY: Apps Script answers POST with a 302 to script.googleusercontent.com; fetch follows it
    // and the final response carries Access-Control-Allow-Origin: *.
    return F.fetchTimeout(apiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: body,
      redirect: 'follow'
    }, POST_TIMEOUT).then(function (res) {
      return res.text().then(function (text) {
        try {
          return JSON.parse(text);
        } catch (e) {
          var bad = new Error('bad response');
          bad.kind = 'bad_response';
          throw bad;
        }
      });
    }, function () {
      var net = new Error('network');
      net.kind = 'network';
      throw net;
    });
  }

  // One automatic retry on network failure (incl. 15 s timeout). Same clientKey, fresh token.
  async function sendOrder(v) {
    var lastErr = null;
    for (var attempt = 0; attempt < 2; attempt++) {
      setBusy(true, 'Проверка…');
      var token = await takeToken();
      setBusy(true, attempt === 0 ? 'Отправляем…' : 'Ещё попытка…');
      var payload = buildPayload(v, token);
      try {
        var data = await postOrder(JSON.stringify(payload));
        return { data: data, payload: payload };
      } catch (err) {
        lastErr = err;
        resetTurnstile();
        if (!err || err.kind !== 'network') throw err;
      }
    }
    throw lastErr;
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (state.submitting) return; // never submit twice from one tap
    hideFormError();

    if (!state.menu || !state.menu.open) {
      showFormError('Сейчас мы не принимаем предзаказы.');
      return;
    }
    if (!state.cart.lines.length || cartHasProblems()) {
      showFormError('Проверьте корзину: в ней есть недоступные позиции.');
      return;
    }
    if (!apiUrl()) {
      showFormError('Приём заказов на сайте ещё не настроен. Позвоните нам, чтобы сделать заказ.');
      return;
    }
    var v = validateForm();
    if (!v) return;

    state.submitting = true;
    state.cart.attempted = true;
    saveCart();
    saveCustomer();

    var result = null;
    try {
      result = await sendOrder(v);
    } catch (err) {
      state.submitting = false;
      setBusy(false);
      resetTurnstile();
      showFormError(err && err.kind === 'bad_response'
        ? 'Сервер ответил с ошибкой. Попробуйте ещё раз через минуту — повторная отправка не создаст второй заказ.'
        : GENERIC_ERROR);
      return;
    }

    state.submitting = false;
    resetTurnstile();
    var data = result.data;

    if (data && data.ok === true && data.orderNo !== undefined && data.orderNo !== null &&
        typeof data.waUrl === 'string' && /^https:\/\//i.test(data.waUrl)) {
      setBusy(false);
      onSuccess(data, result.payload);
      return;
    }

    setBusy(false);
    if (data && data.ok === false) {
      await onServerError(data);
    } else {
      showFormError(GENERIC_ERROR);
    }
  }

  async function onServerError(data) {
    var code = String(data.error || '');
    var msg = typeof data.message === 'string' && data.message ? data.message : GENERIC_ERROR;

    switch (code) {
      case 'invalid_time':
        // The phone's clock may be wrong: reload the menu and rebuild slots instead of a raw error.
        state.invalidTimeCount++;
        await refreshMenu(true);
        rebuildSlots(false);
        if (hasAnyTime()) {
          setFieldError('fTime', 'timeErr', state.invalidTimeCount > 1
            ? 'Это время снова недоступно. Проверьте, что на телефоне верные дата и время, и выберите время ещё раз.'
            : 'Это время уже недоступно. Выберите другое и нажмите «Оформить заказ» ещё раз.');
        }
        focusTimePicker();
        return;

      case 'invalid_name':
        setFieldError('fName', 'nameErr', msg);
        dom.name.focus();
        return;

      case 'invalid_phone':
        setFieldError('fPhone', 'phoneErr', msg);
        dom.phone.focus();
        return;

      case 'no_consent':
        setFieldError('fConsent', 'consentErr', msg);
        dom.consent.focus();
        return;

      case 'item_unavailable':
      case 'invalid_items':
        await refreshMenu(true);
        state.cartNotice = msg;
        renderCartSheet();
        openSheet('cart');
        return;

      case 'closed':
        await refreshMenu(true);
        showFormError(msg);
        return;

      default: // rate_limited, spam, bad_request, server_error, unknown
        showFormError(msg);
    }
  }

  dom.form.addEventListener('submit', onSubmit);

  /* =====================================================================
   * Confirmation (CONTRACT §3.3, §3.5)
   * ===================================================================== */

  function onSuccess(data, payload) {
    state.invalidTimeCount = 0;
    state.cart.placed = {
      at: Date.now(),
      orderNo: data.orderNo,
      total: typeof data.total === 'number' ? data.total : null,
      waText: typeof data.waText === 'string' ? data.waText : '',
      waUrl: data.waUrl,
      readyAt: payload.readyAt,
      clientKey: payload.clientKey,
      sig: cartSig(),
      dismissed: false
    };
    saveCart();
    F.session.remove(DRAFT_KEY);
    dom.comment.value = '';
    closeSheet({ focus: false });
    showConfirmation(state.cart.placed);
  }

  function sendOpenedBeacon(placed) {
    var url = apiUrl();
    if (!url) return;
    var body = JSON.stringify({ v: 1, action: 'opened', orderNo: placed.orderNo, clientKey: placed.clientKey });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: 'text/plain;charset=utf-8' }))) return;
    } catch (e) { /* fall through */ }
    try {
      fetch(url, { method: 'POST', mode: 'no-cors', keepalive: true, headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body })
        .catch(function () { /* ignore */ });
    } catch (e) { /* ignore */ }
  }

  function copyText(text, ta, btn) {
    function done() {
      btn.textContent = 'Скопировано ✓';
      setTimeout(function () { btn.textContent = 'Скопировать'; }, 2500);
    }
    function fallback() {
      var ok = false;
      try {
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, text.length);
        ok = document.execCommand('copy');
      } catch (e) { ok = false; }
      if (ok) done();
      else btn.textContent = 'Выделите текст и скопируйте вручную';
    }
    try {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, fallback);
        return;
      }
    } catch (e) { /* fall through */ }
    fallback();
  }

  function showConfirmation(placed) {
    var v = dom.confirmView;
    v.textContent = '';

    var wa = el('a', { class: 'btn btn--wa btn--lg btn--block', href: placed.waUrl }, 'Отправить заказ в WhatsApp');
    wa.addEventListener('click', function () {
      // Fire-and-forget; the browser follows the link natively right after this handler.
      sendOpenedBeacon(placed);
      if (state.cart.placed && state.cart.placed.clientKey === placed.clientKey) {
        state.cart = newCart();
        saveCart();
      }
    });

    var ta = el('textarea', { class: 'confirm__text', readonly: true, rows: '8', 'aria-label': 'Текст заказа' });
    ta.value = placed.waText;
    var copy = el('button', { class: 'btn btn--secondary btn--block confirm__copy', type: 'button' }, 'Скопировать');
    copy.addEventListener('click', function () { copyText(placed.waText, ta, copy); });

    var back = el('button', { class: 'link-btn', type: 'button' }, 'Вернуться к меню');
    back.addEventListener('click', function () {
      if (state.cart.placed) {
        state.cart.placed.dismissed = true;
        saveCart();
      }
      hideConfirmation();
    });

    var meta = el('p', { class: 'confirm__meta' }, ['Время готовности: ', el('strong', null, labelForReadyAt(placed.readyAt))]);

    v.appendChild(el('div', { class: 'confirm__check', 'aria-hidden': 'true' }, '✓'));
    v.appendChild(el('h1', { class: 'confirm__no', id: 'confirmTitle' }, 'Заказ №' + placed.orderNo));
    v.appendChild(meta);
    if (placed.total !== null && placed.total !== undefined) {
      v.appendChild(el('p', { class: 'confirm__meta' }, ['Сумма: ', el('span', { class: 'pill pill--lg' }, F.formatPrice(placed.total))]));
    }
    v.appendChild(wa);
    v.appendChild(el('p', { class: 'confirm__note' }, 'Заказ считается оформленным только после того, как вы отправите это сообщение в WhatsApp.'));
    if (placed.waText) {
      v.appendChild(el('p', { class: 'muted' }, 'Если WhatsApp не открылся, скопируйте текст и отправьте его нам сами:'));
      v.appendChild(ta);
      v.appendChild(copy);
    }
    v.appendChild(el('p', { style: 'margin-top:20px' }, back));

    state.confirmShown = true;
    dom.orderView.hidden = true;
    v.hidden = false;
    renderCartBar();
    window.scrollTo(0, 0);
    try { v.focus({ preventScroll: true }); } catch (e) { v.focus(); }
  }

  function hideConfirmation() {
    state.confirmShown = false;
    dom.confirmView.hidden = true;
    dom.confirmView.textContent = '';
    dom.orderView.hidden = false;
    renderCartBar();
    window.scrollTo(0, 0);
  }

  /* =====================================================================
   * Wiring & boot
   * ===================================================================== */

  dom.menuRoot.addEventListener('click', function (e) {
    var card = e.target.closest('[data-item]');
    if (!card || card.classList.contains('is-off')) return;
    openItem(card.getAttribute('data-item'));
  });

  dom.chipsRow.addEventListener('click', function (e) {
    var chip = e.target.closest('[data-target]');
    if (!chip) return;
    setActiveChip(chip.getAttribute('data-target'));
    scrollToSection(chip.getAttribute('data-target'));
  });

  dom.cartBarBtn.addEventListener('click', function () {
    renderCartSheet();
    openSheet('cart');
  });

  // order.html#item=fries_classic&opts=top_parmesan,top_jalapeno → { id, opts }
  function readDeepLink() {
    var m = /^#item=([^&]+)(?:&opts=([^&]*))?$/.exec(location.hash || '');
    if (!m) return null;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
    try {
      return {
        id: decodeURIComponent(m[1]),
        opts: m[2] ? m[2].split(',').map(function (s) { return decodeURIComponent(s); }).filter(Boolean) : []
      };
    } catch (e) { return null; }
  }

  function restorePlaced() {
    var p = state.cart.placed;
    if (p && !p.dismissed && p.sig === cartSig() && p.waUrl) {
      showConfirmation(p);
      return true;
    }
    return false;
  }

  function boot() {
    var brand = F.cfg('BRAND');
    Array.prototype.forEach.call(document.querySelectorAll('[data-brand]'), function (n) { if (brand) n.textContent = brand; });

    if (historySheet()) replaceHistory(null); // reloaded while a sheet was open
    var deepItem = readDeepLink();
    state.cart = loadCart();
    saveCart();

    refreshMenu(false).then(function (res) {
      if (!res) return;
      if (restorePlaced()) return;
      if (deepItem && state.itemsById[deepItem.id]) {
        var card = dom.menuRoot.querySelector('[data-item="' + deepItem.id.replace(/"/g, '') + '"]');
        if (card) card.scrollIntoView({ block: 'center' });
        openItem(deepItem.id, deepItem.opts);
      }
    });
  }

  // Back/forward cache or returning from WhatsApp: re-read state that may be stale.
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    state.cart = loadCart();
    if (state.confirmShown && !state.cart.placed && !state.cart.lines.length) {
      // Order was handed to WhatsApp; keep showing the confirmation.
    } else if (state.confirmShown && (!state.cart.placed || state.cart.placed.dismissed)) {
      hideConfirmation();
    }
    renderCartBar();
    if (state.sheet === 'cart') renderCartSheet();
    if (state.sheet === 'checkout') { rebuildSlots(true); renderCheckoutSummary(); }
    refreshMenu(false);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || !state.menu) return;
    if (state.sheet === 'checkout' && !state.submitting) rebuildSlots(true);
    refreshMenu(false);
  });

  boot();
})();
