/*
 * Fryday — script for the static pages (index.html, faq.html, privacy.html).
 * Fills business data from config.js, renders the menu and toppings on the
 * landing page, fills the dynamic answers on the FAQ page, and controls the
 * sticky header. Every block is optional: it only runs if its element exists.
 */
(function () {
  'use strict';

  var F = window.Fryday;
  var el = F.el;

  /* ---------- config-driven fields ---------- */

  function hideRow(node) {
    var row = node.closest('[data-cfg-row]');
    (row || node).hidden = true;
  }

  function fillConfig() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-cfg]'), function (node) {
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
      if (node.hasAttribute('data-cfg-tel')) {
        node.setAttribute('href', 'tel:+' + F.digits(value).replace(/^0/, '996'));
      }
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-cfg-href]'), function (node) {
      var url = F.cfg(node.getAttribute('data-cfg-href'));
      if (/^https?:\/\//i.test(url)) {
        node.setAttribute('href', url);
      } else {
        hideRow(node);
      }
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-year]'), function (node) {
      node.textContent = String(new Date().getFullYear());
    });
  }

  function fillHours(menu) {
    var text = F.hoursText(menu);
    Array.prototype.forEach.call(document.querySelectorAll('[data-hours]'), function (node) {
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
    Array.prototype.forEach.call(document.querySelectorAll('[data-wa-greeting]'), function (node) {
      if (!phone) { node.hidden = true; return; }
      var text = node.getAttribute('data-wa-greeting') || '';
      node.setAttribute('href', 'https://wa.me/' + phone + (text ? '?text=' + encodeURIComponent(text) : ''));
      node.hidden = false;
    });
  }

  /* ---------- sticky header ---------- */

  function setupStickyHeader() {
    var header = document.getElementById('siteHeader');
    var hero = document.getElementById('hero');
    if (!header || !hero) return;
    var links = header.querySelectorAll('a');

    function show(visible) {
      header.classList.toggle('is-visible', visible);
      header.setAttribute('aria-hidden', visible ? 'false' : 'true');
      Array.prototype.forEach.call(links, function (a) {
        if (visible) a.removeAttribute('tabindex'); else a.setAttribute('tabindex', '-1');
      });
    }

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        show(!entries[0].isIntersecting);
      }, { threshold: 0, rootMargin: '-64px 0px 0px 0px' }).observe(hero);
    } else {
      var onScroll = function () { show(window.pageYOffset > hero.offsetHeight - 64); };
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }
  }

  /* ---------- landing menu ---------- */

  function renderLandingMenu(menu) {
    var root = document.getElementById('landingMenu');
    if (!root) return;
    root.textContent = '';

    menu.categories.forEach(function (cat) {
      var items = menu.items.filter(function (i) { return i.category === cat.id; });
      if (!items.length) return;

      root.appendChild(el('h3', { class: 'cat-title', id: 'l-cat-' + cat.id }, cat.title));
      if (cat.subtitle) root.appendChild(el('p', { class: 'cat-sub' }, cat.subtitle));

      var grid = el('div', { class: 'grid' });
      items.forEach(function (item) {
        var foot = el('div', { class: 'card__foot' }, [
          el('span', { class: 'pill' }, F.formatPrice(item.price)),
          item.available
            ? el('a', { class: 'btn btn--primary btn--sm', href: 'order.html#item=' + encodeURIComponent(item.id), 'aria-label': 'Заказать: ' + item.title }, 'Заказать')
            : el('span', { class: 'badge-off' }, 'Нет в наличии')
        ]);
        grid.appendChild(el('article', { class: 'card' + (item.available ? '' : ' is-off') }, [
          F.makeImg(item, { className: 'card__photo', alt: '' }),
          el('h4', { class: 'card__name' }, item.title),
          el('p', { class: 'card__desc' }, item.description),
          foot
        ]));
      });
      root.appendChild(grid);
    });

    if (!root.childNodes.length) {
      root.appendChild(el('div', { class: 'state-box' }, 'Меню скоро появится.'));
    }
  }

  function renderLandingToppings(menu) {
    var section = document.getElementById('toppings');
    var root = document.getElementById('landingToppings');
    if (!section || !root) return;
    root.textContent = '';
    menu.options.forEach(function (opt) {
      root.appendChild(el('div', { class: 'topping' + (opt.available ? '' : ' is-off') }, [
        F.makeImg(opt, { option: true, alt: '' }),
        el('div', { class: 'topping__name' }, opt.title),
        opt.available
          ? el('span', { class: 'pill pill--sm' }, '+' + F.formatPrice(opt.price))
          : el('span', { class: 'badge-off' }, 'Нет в наличии')
      ]));
    });
    section.hidden = menu.options.length === 0;
  }

  function showLandingError() {
    var root = document.getElementById('landingMenu');
    if (!root) return;
    root.textContent = '';
    var retry = el('button', { class: 'btn btn--secondary', type: 'button' }, 'Попробовать снова');
    retry.addEventListener('click', function () {
      root.textContent = '';
      root.appendChild(el('div', { class: 'state-box' }, 'Загружаем меню…'));
      loadAll(true);
    });
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
    Array.prototype.forEach.call(document.querySelectorAll('[data-faq="' + key + '"]'), function (node) {
      node.textContent = text;
    });
  }

  function fillFaq(menu) {
    if (!document.querySelector('[data-faq]')) return;

    setFaq('assortment', menu.categories.map(function (cat) {
      var n = menu.items.filter(function (i) { return i.category === cat.id; }).length;
      return cat.title.toLowerCase() + ' (' + n + ' ' + plural(n, 'вид', 'вида', 'видов') + ')';
    }).join(', '));

    var lines = menu.categories.map(function (cat) {
      return cat.title + ' — ' + priceRange(menu.items.filter(function (i) { return i.category === cat.id; }));
    });
    if (menu.options.length) lines.push('топпинги — ' + priceRange(menu.options));
    setFaq('prices', lines.join('; '));

    setFaq('lead', String(menu.leadMinutes));

    setFaq('days', menu.maxDaysAhead === 0 ? 'на сегодня'
      : menu.maxDaysAhead === 1 ? 'на сегодня или на завтра'
      : 'на ближайшие ' + (menu.maxDaysAhead + 1) + ' ' + plural(menu.maxDaysAhead + 1, 'день', 'дня', 'дней'));
  }

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  /* ---------- boot ---------- */

  function loadAll(force) {
    var needsMenu = document.getElementById('landingMenu') || document.querySelector('[data-faq]') ||
      document.querySelector('[data-hours]') || document.querySelector('[data-wa-greeting]');
    if (!needsMenu) return;

    F.loadMenu({ force: !!force }).then(function (res) {
      var menu = res.menu;
      renderLandingMenu(menu);
      renderLandingToppings(menu);
      fillHours(menu);
      fillWhatsApp(menu);
      fillFaq(menu);
      var notice = document.getElementById('landingNotice');
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

  fillConfig();
  fillWhatsApp(null);
  setupStickyHeader();
  loadAll(false);

  // Back/forward cache: refresh data that may have changed while the page was hidden.
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) loadAll(false);
  });
})();
