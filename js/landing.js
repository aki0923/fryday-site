/*
 * Fryday — script for the static pages (index.html, faq.html, privacy.html).
 * Fills business data from config.js, builds the interactive blocks of the
 * landing page (sauce switcher, Fry Dog list, build-your-box) from the menu,
 * and fills the dynamic answers on the FAQ page. Every block is optional:
 * it only runs if its element exists. Plain ES2017, no optional chaining.
 */
(function () {
  'use strict';

  var F = window.Fryday;
  var el = F.el;

  /* ---------- small helpers ---------- */

  function $(id) { return document.getElementById(id); }

  function each(selector, fn) {
    Array.prototype.forEach.call(document.querySelectorAll(selector), fn);
  }

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  function svgCheck() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', 'M5 12.5l4.5 4.5L19 7.5');
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', '#fff');
    p.setAttribute('stroke-width', '3.2');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
    return svg;
  }

  /* ---------- config-driven fields ---------- */

  function hideRow(node) {
    var row = node.closest('[data-cfg-row]');
    (row || node).hidden = true;
  }

  function telHref(value) {
    return 'tel:+' + F.digits(value).replace(/^0/, '996');
  }

  function fillConfig() {
    each('[data-cfg]', function (node) {
      var key = node.getAttribute('data-cfg');
      var value = F.cfg(key);
      if (!value) {
        var fallback = node.getAttribute('data-cfg-fallback');
        if (fallback !== null) { node.textContent = fallback; return; }
        if (key === 'BRAND') return; // keep the default text in HTML
        hideRow(node);
        return;
      }
      node.textContent = value;
      if (node.hasAttribute('data-cfg-tel')) node.setAttribute('href', telHref(value));
    });

    // A button that calls the number without showing it, e.g. «Позвонить».
    each('[data-cfg-tel-href]', function (node) {
      var value = F.cfg(node.getAttribute('data-cfg-tel-href'));
      if (value) node.setAttribute('href', telHref(value));
      else node.hidden = true;
    });

    each('[data-cfg-href]', function (node) {
      var url = F.cfg(node.getAttribute('data-cfg-href'));
      if (/^https?:\/\//i.test(url)) node.setAttribute('href', url);
      else hideRow(node);
    });

    each('[data-year]', function (node) {
      node.textContent = String(new Date().getFullYear());
    });
  }

  function fillHours(menu) {
    var text = F.hoursText(menu);
    each('[data-hours]', function (node) {
      if (text) {
        node.textContent = text;
      } else if (node.hasAttribute('data-hours-fallback')) {
        node.textContent = node.getAttribute('data-hours-fallback');
      } else {
        var row = node.closest('[data-hours-row]');
        (row || node).hidden = true;
      }
    });
  }

  function fillWhatsApp(menu) {
    var phone = F.waPhone(menu);
    each('[data-wa-greeting]', function (node) {
      if (!phone) { node.hidden = true; return; }
      var text = node.getAttribute('data-wa-greeting') || '';
      node.setAttribute('href', 'https://wa.me/' + phone + (text ? '?text=' + encodeURIComponent(text) : ''));
      node.hidden = false;
    });
  }

  /* ---------- menu helpers ---------- */

  function itemsOf(menu, catId) {
    return menu.items.filter(function (i) { return i.category === catId; });
  }

  // The fries category drives the sauce switcher and the build-your-box block.
  function friesCategory(menu) {
    var byId = menu.categories.filter(function (c) { return c.id === 'fries'; })[0];
    if (byId) return byId;
    return menu.categories.filter(function (c) { return !/hot/i.test(c.id); })[0] || null;
  }

  function dogCategory(menu) {
    return menu.categories.filter(function (c) { return /hot|dog/i.test(c.id); })[0] || null;
  }

  // «Трюфельный Чиз» → «Трюфельный» for the sauce buttons.
  function shortName(title) {
    var s = String(title || '').replace(/\s+чиз\s*$/i, '').trim();
    return s || String(title || '');
  }

  /* ---------- sauce switcher ---------- */

  // Dot colour on the button and the soft tint behind the photo, per sauce.
  var SAUCE_LOOK = {
    fries_classic: ['#E8A93B', '#FFF1D2'],
    fries_double: ['#F2C230', '#FFF4C7'],
    fries_ketchup: ['#D3302A', '#FDE3DF'],
    fries_pesto: ['#5C8A2E', '#E8F2DA'],
    fries_sesame: ['#C8A46A', '#F7EEDD'],
    fries_bbq: ['#6A2D1E', '#F3E1D8'],
    fries_garlic: ['#F1E8CF', '#F8F4E8'],
    fries_truffle: ['#3B3631', '#ECE7E1'],
    fries_chili: ['#E8501F', '#FEE5D9'],
    fries_nut: ['#9C6B3C', '#F4E6D6']
  };
  var DEFAULT_LOOK = ['#E8A93B', '#FFF4D6'];
  var DEFAULT_SAUCE = 'fries_truffle';

  var sauce = { list: [], current: null };

  function looksOf(id) { return SAUCE_LOOK[id] || DEFAULT_LOOK; }

  function showSauce(item, focusChip) {
    sauce.current = item.id;
    var img = $('sauceImg');
    var look = looksOf(item.id);
    var src = F.photoSrc(item);
    if (img && img.getAttribute('src') !== src) {
      img.classList.add('is-swapping');
      img.onload = function () { img.classList.remove('is-swapping'); };
      img.onerror = function () { img.classList.remove('is-swapping'); };
      img.src = src;
    }
    if (img) img.alt = item.title;
    $('sauceTint').style.backgroundColor = look[1];
    $('sauceName').textContent = item.title;
    $('sauceDesc').textContent = item.description || '';
    $('saucePrice').textContent = F.formatPrice(item.price);
    var order = $('sauceOrder');
    order.href = 'order.html#item=' + encodeURIComponent(item.id);
    order.textContent = 'Заказать ' + item.title;

    Array.prototype.forEach.call($('sauceChips').children, function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-id') === item.id ? 'true' : 'false');
      if (focusChip && b.getAttribute('data-id') === item.id) b.focus();
    });
  }

  function saucesLead(items) {
    var lead = $('saucesLead');
    if (!lead || !items.length) return;
    var prices = items.map(function (i) { return i.price; });
    var min = Math.min.apply(null, prices);
    var max = Math.max.apply(null, prices);
    var cheapest = items.filter(function (i) { return i.price === min; });
    var priceText;
    if (min === max) priceText = 'Любой — ' + F.formatPrice(min) + '.';
    else if (cheapest.length === 1 && items.every(function (i) { return i.price === min || i.price === max; })) {
      priceText = cheapest[0].title + ' — ' + F.formatPrice(min) + ', все остальные — ' + F.formatPrice(max) + '.';
    } else priceText = 'Цены — от ' + F.formatPrice(min) + '.';
    var n = items.length;
    lead.textContent = 'Хрустящий картофель, щедрая горка пармезана и ' +
      (n === 1 ? 'фирменный соус' : 'один из ' + n + ' ' + plural(n, 'соуса', 'соусов', 'соусов')) + '. ' + priceText;
  }

  function renderSauces(menu) {
    var section = $('sauces');
    var chips = $('sauceChips');
    if (!section || !chips) return;
    var cat = friesCategory(menu);
    var items = cat ? itemsOf(menu, cat.id) : [];
    section.hidden = items.length === 0;
    if (!items.length) return;

    sauce.list = items;
    chips.textContent = '';
    items.forEach(function (item) {
      var look = looksOf(item.id);
      var b = el('button', {
        type: 'button',
        class: 'l-chip',
        'data-id': item.id,
        'aria-pressed': 'false',
        'aria-label': item.available ? item.title : item.title + ' — нет в наличии',
        disabled: !item.available
      }, [
        el('span', { class: 'l-chip__dot', 'aria-hidden': 'true', style: 'background-color:' + look[0] }),
        shortName(item.title)
      ]);
      b.addEventListener('click', function () { showSauce(item, false); });
      chips.appendChild(b);
    });

    var available = items.filter(function (i) { return i.available; });
    var keep = sauce.current && available.filter(function (i) { return i.id === sauce.current; })[0];
    var preferred = available.filter(function (i) { return i.id === DEFAULT_SAUCE; })[0];
    var first = keep || preferred || available[0] || items[0];
    showSauce(first, false);
    saucesLead(available.length ? available : items);
  }

  /* ---------- Fry Dog ---------- */

  function renderDogs(menu) {
    var section = $('dog');
    var list = $('dogList');
    if (!section || !list) return;
    var cat = dogCategory(menu);
    var items = cat ? itemsOf(menu, cat.id) : [];
    section.hidden = items.length === 0;
    if (!items.length) return;

    if (cat.subtitle) $('dogSlogan').textContent = cat.subtitle;
    var img = $('dogImg');
    if (img) img.src = F.photoSrc(items[0]);

    list.textContent = '';
    items.forEach(function (item) {
      // «Fry Dog с куриной сосиской» → «С куриной сосиской»
      var label = item.title.replace(/^fry\s*dog\s*/i, '');
      label = label ? label.charAt(0).toUpperCase() + label.slice(1) : item.title;
      var row = item.available
        ? el('a', { class: 'l-dog__variant', href: 'order.html#item=' + encodeURIComponent(item.id), 'aria-label': 'Заказать ' + item.title + ', ' + F.formatPrice(item.price) }, [
          el('span', null, label), el('span', { class: 'pill' }, F.formatPrice(item.price))
        ])
        : el('span', { class: 'l-dog__variant is-off' }, [
          el('span', null, label), el('span', { class: 'l-dog__off' }, 'Нет в наличии')
        ]);
      list.appendChild(el('li', null, row));
    });
  }

  /* ---------- build your box ---------- */

  // Where the chosen toppings land around the fries, in order of choosing.
  var SLOTS = [
    { l: '3%', t: '7%', r: '-8deg' },
    { l: '79%', t: '4%', r: '10deg' },
    { l: '82%', t: '52%', r: '-6deg' },
    { l: '1%', t: '57%', r: '7deg' },
    { l: '42%', t: '-3%', r: '4deg' },
    { l: '64%', t: '79%', r: '-10deg' },
    { l: '19%', t: '81%', r: '8deg' }
  ];
  var DEFAULT_PICKS = ['top_parmesan', 'top_jalapeno'];

  var box = { base: null, options: [], picked: null };

  function boxPick(id) {
    var i = box.picked.indexOf(id);
    if (i === -1) box.picked.push(id); else box.picked.splice(i, 1);
    paintBox();
  }

  function paintBox() {
    var base = box.base;
    var byId = {};
    box.options.forEach(function (o) { byId[o.id] = o; });

    var bubbles = $('boxBubbles');
    bubbles.textContent = '';
    box.picked.forEach(function (id, i) {
      var o = byId[id];
      if (!o) return;
      var s = SLOTS[i % SLOTS.length];
      bubbles.appendChild(el('div', {
        class: 'l-bubble',
        style: 'left:' + s.l + ';top:' + s.t + ';--r:' + s.r
      }, F.makeImg(o, { option: true, alt: o.title })));
    });

    Array.prototype.forEach.call($('boxTops').children, function (b) {
      b.setAttribute('aria-pressed', box.picked.indexOf(b.getAttribute('data-id')) !== -1 ? 'true' : 'false');
    });

    var n = box.picked.length;
    var sum = base.price;
    box.picked.forEach(function (id) { if (byId[id]) sum += byId[id].price; });
    $('boxLabel').textContent = base.title + (n ? ' + ' + n + ' ' + plural(n, 'топпинг', 'топпинга', 'топпингов') : '');
    $('boxPrice').textContent = F.formatPrice(sum);
    $('boxReset').hidden = n === 0;
    $('boxOrder').href = 'order.html#item=' + encodeURIComponent(base.id) +
      (n ? '&opts=' + box.picked.map(encodeURIComponent).join(',') : '');
  }

  function renderBox(menu) {
    var section = $('box');
    var tops = $('boxTops');
    if (!section || !tops) return;
    var cat = friesCategory(menu);
    var fries = cat ? itemsOf(menu, cat.id).filter(function (i) { return i.available; }) : [];
    var base = fries.filter(function (i) { return i.id === 'fries_classic'; })[0] || fries[0];
    var options = base ? menu.options.filter(function (o) {
      return o.available && o.appliesTo.indexOf(base.id) !== -1;
    }) : [];
    section.hidden = !base || !options.length;
    if (section.hidden) return;

    box.base = base;
    box.options = options;
    var ids = options.map(function (o) { return o.id; });
    if (box.picked === null) {
      box.picked = DEFAULT_PICKS.filter(function (id) { return ids.indexOf(id) !== -1; });
    } else {
      box.picked = box.picked.filter(function (id) { return ids.indexOf(id) !== -1; });
    }

    var baseImg = $('boxBase');
    baseImg.src = F.photoSrc(base);
    baseImg.alt = base.title;

    tops.textContent = '';
    options.forEach(function (o) {
      var b = el('button', { type: 'button', class: 'l-top', 'data-id': o.id, 'aria-pressed': 'false', 'aria-label': o.title + ', +' + F.formatPrice(o.price) }, [
        F.makeImg(o, { option: true, alt: '' }),
        el('span', { class: 'l-top__name' }, o.title),
        el('span', { class: 'pill pill--sm' }, '+' + F.formatPrice(o.price)),
        el('span', { class: 'l-top__check', 'aria-hidden': 'true' }, svgCheck())
      ]);
      b.addEventListener('click', function () { boxPick(o.id); });
      tops.appendChild(b);
    });

    var prices = options.map(function (o) { return o.price; });
    var min = Math.min.apply(null, prices), max = Math.max.apply(null, prices);
    $('boxLead').textContent = 'Нажимай на миски — топпинг сразу окажется на картошке. ' +
      (min === max ? 'Каждый +' + F.formatPrice(min) : 'Каждый — от +' + F.formatPrice(min)) + ', сочетай как хочешь.';

    paintBox();
  }

  /* ---------- numbers in the copy ---------- */

  function fillCounts(menu) {
    var cat = friesCategory(menu);
    var sauces = cat ? itemsOf(menu, cat.id).length : 0;
    var toppings = menu.options.length;
    each('[data-count="sauces"]', function (n) {
      n.textContent = sauces + ' ' + plural(sauces, 'соус', 'соуса', 'соусов');
    });
    each('[data-count="sauces-with"]', function (n) {
      n.textContent = sauces + ' ' + plural(sauces, 'соусом', 'соусами', 'соусами');
    });
    each('[data-count="toppings"]', function (n) {
      n.textContent = toppings + ' ' + plural(toppings, 'топпинг', 'топпинга', 'топпингов');
    });
    var prices = menu.items.filter(function (i) { return i.available; }).map(function (i) { return i.price; });
    if (prices.length) {
      var min = F.formatPrice(Math.min.apply(null, prices));
      each('[data-min-price]', function (n) { n.textContent = min; });
    }
  }

  function showLandingError() {
    var root = $('sauceBlock');
    if (!root) return;
    root.textContent = '';
    var retry = el('button', { class: 'btn btn--secondary', type: 'button' }, 'Попробовать снова');
    retry.addEventListener('click', function () { location.reload(); });
    root.appendChild(el('div', { class: 'state-box' }, [
      el('p', null, 'Не удалось загрузить меню. Проверьте интернет.'),
      retry
    ]));
  }

  /* ---------- FAQ dynamic answers ---------- */

  function priceRange(list) {
    var prices = list.filter(function (x) { return x.available; }).map(function (x) { return x.price; });
    if (!prices.length) prices = list.map(function (x) { return x.price; });
    if (!prices.length) return '';
    var min = Math.min.apply(null, prices);
    var max = Math.max.apply(null, prices);
    return min === max ? F.formatPrice(min) : 'от ' + F.formatPrice(min);
  }

  function setFaq(key, text) {
    if (!text) return;
    each('[data-faq="' + key + '"]', function (node) { node.textContent = text; });
  }

  function fillFaq(menu) {
    if (!document.querySelector('[data-faq]')) return;

    setFaq('assortment', menu.categories.map(function (cat) {
      var n = itemsOf(menu, cat.id).length;
      return cat.title.toLowerCase() + ' (' + n + ' ' + plural(n, 'вид', 'вида', 'видов') + ')';
    }).join(', '));

    var lines = menu.categories.map(function (cat) {
      return cat.title + ' — ' + priceRange(itemsOf(menu, cat.id));
    });
    if (menu.options.length) lines.push('топпинги — ' + priceRange(menu.options));
    setFaq('prices', lines.join('; '));

    setFaq('lead', String(menu.leadMinutes));

    setFaq('days', menu.maxDaysAhead === 0 ? 'на сегодня'
      : menu.maxDaysAhead === 1 ? 'на сегодня или на завтра'
      : 'на ближайшие ' + (menu.maxDaysAhead + 1) + ' ' + plural(menu.maxDaysAhead + 1, 'день', 'дня', 'дней'));
  }

  /* ---------- boot ---------- */

  function loadAll(force) {
    var needsMenu = $('sauceChips') || document.querySelector('[data-faq]') ||
      document.querySelector('[data-hours]') || document.querySelector('[data-wa-greeting]');
    if (!needsMenu) return;

    F.loadMenu({ force: !!force }).then(function (res) {
      var menu = res.menu;
      renderSauces(menu);
      renderDogs(menu);
      renderBox(menu);
      fillCounts(menu);
      fillHours(menu);
      fillWhatsApp(menu);
      fillFaq(menu);
      var notice = $('landingNotice');
      if (notice) {
        notice.hidden = !F.isOutdated(res.source);
        notice.textContent = 'Не удалось обновить меню — цены могут быть неактуальны.';
      }
    }).catch(function () {
      showLandingError();
      fillHours(null);
      fillWhatsApp(null);
    });
  }

  var reset = $('boxReset');
  if (reset) reset.addEventListener('click', function () {
    if (!box.base) return;
    box.picked = [];
    paintBox();
  });

  fillConfig();
  fillWhatsApp(null);
  loadAll(false);

  // Back/forward cache: refresh data that may have changed while the page was hidden.
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) loadAll(false);
  });
})();
