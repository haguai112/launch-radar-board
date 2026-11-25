// Launch Radar dashboard: renders window.RADAR (written by main.ts beside
// dashboard/) as a sortable, filterable board with a detail view per
// protocol. No network, no framework: every byte shown comes from data.js.
(function () {
  'use strict';
  var DATA = window.RADAR;
  var app = document.getElementById('app');
  if (!DATA || !app) return;

  function money(usd) {
    if (usd >= 1e9) return '$' + (usd / 1e9).toFixed(2) + 'B';
    if (usd >= 1e6) return '$' + (usd / 1e6).toFixed(1) + 'M';
    if (usd >= 1e3) return '$' + (usd / 1e3).toFixed(0) + 'K';
    return '$' + usd;
  }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Header stats and the model statement.
  var totalTvl = DATA.rows.reduce(function (s, r) { return s + r.tvl_usd; }, 0);
  var stats = [
    [String(DATA.rows.length), 'protocols boarded'],
    [String(DATA.watchlist_size), 'on the watchlist'],
    [money(totalTvl), 'combined TVL tracked'],
    [DATA.as_of, 'snapshot date'],
  ];
  var statsBox = document.getElementById('stats');
  stats.forEach(function (pair) {
    var box = el('div', 'stat');
    box.appendChild(el('b', null, pair[0]));
    box.appendChild(el('span', null, pair[1]));
    statsBox.appendChild(box);
  });
  document.getElementById('model-note').textContent = 'How the board is built: ' + DATA.model_note;

  function parseHash() {
    var hash = window.location.hash.replace(/^#\/?/, '');
    var parts = hash.split('?');
    var params = {};
    if (parts[1]) parts[1].split('&').forEach(function (kv) {
      var pair = kv.split('=');
      params[decodeURIComponent(pair[0])] = decodeURIComponent(pair[1] || '');
    });
    return { path: parts[0] || '', params: params };
  }

  function boardView(params) {
    app.textContent = '';
    var controls = el('div', 'controls');
    var search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Search name or slug';
    search.value = params.q || '';
    var cat = document.createElement('select');
    var cats = [];
    DATA.rows.forEach(function (r) { if (r.category && cats.indexOf(r.category) === -1) cats.push(r.category); });
    cats.sort();
    cat.appendChild(new Option('All categories', ''));
    cats.forEach(function (c) { cat.appendChild(new Option(c, c)); });
    cat.value = params.cat || '';
    var watchLabel = el('label');
    var watch = document.createElement('input');
    watch.type = 'checkbox';
    watch.checked = params.watch === '1';
    watchLabel.appendChild(watch);
    watchLabel.appendChild(document.createTextNode('Watchlist only'));
    var sort = document.createElement('select');
    [['value', 'Sort: implied value'], ['tvl', 'Sort: TVL'], ['growth', 'Sort: 7d growth'], ['odds', 'Sort: launch odds']]
      .forEach(function (pair) { sort.appendChild(new Option(pair[1], pair[0])); });
    sort.value = params.sort || 'value';
    var count = el('span', 'count');
    controls.appendChild(search); controls.appendChild(cat); controls.appendChild(watchLabel);
    controls.appendChild(sort); controls.appendChild(count);
    app.appendChild(controls);
    var tableWrap = el('div');
    app.appendChild(tableWrap);

    function currentRows() {
      var rows = DATA.rows.filter(function (r) {
        if (watch.checked && !r.watchlist) return false;
        if (cat.value && r.category !== cat.value) return false;
        if (search.value) {
          var needle = search.value.toLowerCase();
          if (r.name.toLowerCase().indexOf(needle) === -1 && r.slug.indexOf(needle) === -1) return false;
        }
        return true;
      });
      var key = sort.value;
      rows.sort(function (a, b) {
        if (key === 'tvl') return b.tvl_usd - a.tvl_usd;
        if (key === 'growth') return (b.change_7d || -999) - (a.change_7d || -999);
        if (key === 'odds') return b.launch_odds_pct - a.launch_odds_pct;
        return a.rank - b.rank;
      });
      return rows;
    }

    function render() {
      var rows = currentRows();
      count.textContent = rows.length + ' shown';
      tableWrap.textContent = '';
      var table = el('table');
      var head = el('tr');
      ['#', 'Protocol', 'Category', 'TVL', '7d', 'Peer x', 'Implied value', 'Launch odds'].forEach(function (h, i) {
        head.appendChild(el('th', i >= 3 ? 'num' : null, h));
      });
      table.appendChild(head);
      rows.slice(0, 120).forEach(function (r) {
        var tr = el('tr', 'row');
        tr.appendChild(el('td', 'num', String(r.rank)));
        var nameCell = el('td');
        nameCell.appendChild(el('span', 'name', r.name));
        if (r.watchlist) nameCell.appendChild(el('span', 'badge', 'watchlist'));
        tr.appendChild(nameCell);
        tr.appendChild(el('td', 'cat', r.category || '-'));
        tr.appendChild(el('td', 'num', money(r.tvl_usd)));
        var growth = el('td', 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down'),
          r.change_7d === null ? '-' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(1) + '%');
        tr.appendChild(growth);
        tr.appendChild(el('td', 'num', r.multiple.toFixed(2)));
        tr.appendChild(el('td', 'num value', money(r.implied_value_usd)));
        var odds = el('td', 'odds');
        odds.appendChild(el('span', 'num', r.launch_odds_pct + '%'));
        var bar = el('div', 'oddsbar');
        var fill = document.createElement('i');
        fill.style.width = r.launch_odds_pct + '%';
        bar.appendChild(fill);
        odds.appendChild(bar);
        tr.appendChild(odds);
        tr.addEventListener('click', function () { window.location.hash = '#/p/' + r.slug; });
        table.appendChild(tr);
      });
      tableWrap.appendChild(table);
    }
    [search, cat, watch, sort].forEach(function (input) {
      input.addEventListener('input', render);
      input.addEventListener('change', render);
    });
    render();
    app.setAttribute('aria-busy', 'false');
  }

  function detailView(slug) {
    var row = null;
    DATA.rows.forEach(function (r) { if (r.slug === slug) row = r; });
    if (!row) { boardView({}); return; }
    app.textContent = '';
    var back = el('button', 'back', 'Back to the board');
    back.addEventListener('click', function () { window.location.hash = '#/'; });
    app.appendChild(back);
    var head = el('div', 'detail-head');
    head.appendChild(el('h1', null, row.name));
    if (row.watchlist) head.appendChild(el('span', 'badge', 'on the snapshot watchlist'));
    head.appendChild(el('span', 'cat', (row.category || 'Uncategorised') + ' - rank #' + row.rank + ' of ' + DATA.rows.length));
    app.appendChild(head);
    var cards = el('div', 'cards');
    [
      [money(row.implied_value_usd), 'implied launch value'],
      [money(row.tvl_usd), 'TVL in snapshot'],
      [row.multiple.toFixed(2) + 'x', 'category peer multiple'],
      [row.launch_odds_pct + '%', 'launch odds (model)'],
      [row.change_7d === null ? '-' : (row.change_7d >= 0 ? '+' : '') + row.change_7d.toFixed(1) + '%', 'TVL change, 7 days'],
      [row.years_live === null ? 'unknown' : row.years_live.toFixed(1) + ' yrs', 'live with no token'],
      [row.chains.slice(0, 4).join(', ') || '-', 'chains'],
      [row.listed_at || '-', 'tracked since'],
    ].forEach(function (pair) {
      var box = el('div', 'stat');
      box.appendChild(el('b', null, pair[0]));
      box.appendChild(el('span', null, pair[1]));
      cards.appendChild(box);
    });
    app.appendChild(cards);
    var steps = el('div', 'steps');
    steps.appendChild(el('h2', null, 'How to farm ' + row.name));
    var list = document.createElement('ol');
    row.farm_steps.forEach(function (step) { list.appendChild(el('li', null, step)); });
    steps.appendChild(list);
    app.appendChild(steps);
    app.setAttribute('aria-busy', 'false');
  }

  function route() {
    var parsed = parseHash();
    if (parsed.path.indexOf('p/') === 0) detailView(parsed.path.slice(2));
    else boardView(parsed.params);
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);
  route();
})();
