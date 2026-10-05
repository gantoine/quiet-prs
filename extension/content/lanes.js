(function () {
  'use strict';

  const api = globalThis.browser || globalThis.chrome;
  const lanes = globalThis.PRLanes;
  if (!api || !lanes) return;

  if (document.documentElement.dataset.prlanesRunning) return;
  document.documentElement.dataset.prlanesRunning = '1';

  const SWITCHES = ['bots', 'events'];
  const KEYS = { b: 'bots', e: 'events' };
  const DEFAULTS = lanes.DEFAULTS;

  const sync = api.storage.sync || api.storage.local;
  const local = api.storage.local || api.storage.sync;

  let settings = Object.assign({}, DEFAULTS);
  let rules;
  let rulesRevision = 1;
  let hide;
  let bar = null;
  let barToggles = null;
  let targets = null;
  let scanHandle = 0;
  let placeHandle = 0;
  let lastTarget = null;
  let fitted = null;
  let lastUrl = location.href;

  const STICKY_HEADER_SELECTOR = '[class*="stickyHeader" i], .gh-header-sticky, [data-testid*="sticky-header"]';
  const ISSUE_STICKY_ROW_SELECTOR = '[data-testid="issue-metadata-sticky"] [class*="stickyContent"]';
  const HEADER_SELECTOR = '[class*="PullRequestHeader"], [class*="PageHeader-PageHeader"], .gh-header-show';
  const HEADER_SLOT_SELECTOR = '[class*="PageHeader-TitleArea"], .gh-header-title';
  const TAB_NAV_SELECTOR = 'nav[class*="TabNav"], nav.tabnav-tabs, .tabnav-tabs';
  const STATE_SELECTOR = '[data-testid="header-state"], .gh-header-meta .State';
  const STATE_ROW_SELECTOR = '[class*="HeaderMetadata-module__metadataContent"], [class*="metadataContent"], .gh-header-meta';
  const DIFFSTAT_SELECTOR = '[class*="PullRequestHeader-module__rightContentWrapper"]';
  const COMMENT_ACTIONS_SELECTOR = '.timeline-comment-actions, [data-testid="comment-header-right-side-items"]';
  const COMMENT_HEADER_SELECTOR = '.timeline-comment-header, .review-comment-header, [data-testid="comment-header"]';


  const STRIP_CLASS = 'prlanes-strip';
  const STRIP_CHILD_SELECTOR = `:scope > .${STRIP_CLASS}`;
  const TOGGLE_CLASS = 'prlanes-toggle';
  const HIDE_CLASS = 'prlanes-hide';
  const FIT_CLASS = 'prlanes-fit';
  const TABLE_TAGS = /^(table|thead|tbody|tfoot|tr)$/i;
  const NOBODY = { human: 'someone', bot: 'a bot' };

  const read = (area, defaults) => Promise.resolve().then(() => area.get(defaults)).catch(() => defaults);
  const write = (area, values) => Promise.resolve().then(() => area.set(values)).catch(() => {});

  function isThreadPage() {
    return /^\/[^/]+\/[^/]+\/(pull|issues)\/\d+/.test(location.pathname);
  }

  function stateKey() {
    const match = location.pathname.match(/^\/([^/]+)\/([^/]+)\/(pull|issues)\/\d+/);
    return match ? `hide:${match[1]}/${match[2]}` : 'hide:unknown';
  }

  function defaultState() {
    return { bots: Boolean(settings.defaultHideBots), events: Boolean(settings.defaultHideEvents) };
  }

  function normalizeState(value) {
    const source = value && typeof value === 'object' ? value : {};
    const fallback = defaultState();
    const state = {};
    for (const name of SWITCHES) state[name] = name in source ? Boolean(source[name]) : fallback[name];
    return state;
  }

  // A bot comment you have hidden still leaves a mark: one line you can click to bring them back.
  function strippable(row) {
    return (
      settings.collapseBots &&
      row.dataset.prlanesForm === 'comment' &&
      row.dataset.prlanesPin !== '1' &&
      !TABLE_TAGS.test(row.tagName)
    );
  }

  function botComment(row) {
    return strippable(row) && row.dataset.prlanesActor === 'bot';
  }

  // The button sets the default; a strip or a Hide of your own overrides it for that run alone.
  function wantsOpen(leader) {
    const want = leader.dataset.prlanesWant;
    return want ? want === 'open' : !hide.bots;
  }

  function collectTargets() {
    if (targets && targets.every((target) => target.root.isConnected)) return targets;

    const found = [];
    const timeline = lanes.findTimelineRoot(document);
    if (timeline) found.push({ root: timeline, rowsOf: lanes.timelineRows });
    const files = lanes.findFilesRoot(document);
    if (files) found.push({ root: files, rowsOf: lanes.threadRows });

    const reviewers = lanes.findReviewersRoot(document);
    if (reviewers) found.push({ root: reviewers, rowsOf: lanes.reviewerRows, classify: lanes.classifyReviewer });

    targets = found.length ? found : null;
    return found;
  }

  function setData(element, key, value) {
    if (element.dataset[key] !== value) element.dataset[key] = value;
  }

  function setText(element, value) {
    if (element.textContent !== value) element.textContent = value;
  }

  function setAttr(element, name, value) {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  }

  function buildStrip(row, kind) {
    const face = kind.avatar
      ? make('img', { class: 'prlanes-strip-face', src: kind.avatar, alt: '' })
      : make('span', { class: 'prlanes-strip-face' }, [icon(kind.actor)]);

    return make('button', {
      type: 'button',
      class: STRIP_CLASS,
      title: 'Show this comment'
    }, [
      face,
      make('span', { class: 'prlanes-strip-who' }, [kind.login || NOBODY[kind.actor]]),
      make('span', { class: 'prlanes-strip-preview' }, [lanes.commentPreview(row)]),
      make('span', { class: 'prlanes-strip-more' }),
      make('span', { class: 'prlanes-strip-hint' }, ['Show'])
    ]);
  }

  // Expanded, the way back sits with the comment's own actions, by the edit pencil and the
  // kebab. A row with no actions takes it in its header, and one with no header at the top.
  function placeHide(row, control) {
    const actions = row.querySelector(COMMENT_ACTIONS_SELECTOR);
    const header = actions ? null : row.querySelector(COMMENT_HEADER_SELECTOR);

    if (actions) {
      if (control.parentElement !== actions) actions.insertBefore(control, actions.firstChild);
    } else if (header) {
      if (control.parentElement !== header) header.appendChild(control);
    } else if (control.parentElement !== row) {
      row.insertBefore(control, row.firstChild);
    }
    control.classList.toggle('prlanes-hide--header', Boolean(actions || header));
  }

  function fillStrip(row, kind) {
    const existing = row.querySelector(STRIP_CHILD_SELECTOR);
    if (existing) existing.remove();
    const control = row.querySelector(`.${HIDE_CLASS}`);
    if (control) control.remove();
    if (!botComment(row)) return;
    row.prepend(buildStrip(row, kind));
    row.prepend(make('button', { type: 'button', class: HIDE_CLASS, title: 'Hide these comments' }, ['Hide']));
  }

  // Back-to-back comments from the same bot are one thing to read, so they are one thing to fold.
  function foldRuns(rows) {
    let index = 0;

    while (index < rows.length) {
      const leader = rows[index];
      if (!botComment(leader)) {
        delete leader.dataset.prlanesFold;
        index += 1;
        continue;
      }

      const login = leader.dataset.prlanesLogin || '';
      let end = index + 1;
      while (end < rows.length && botComment(rows[end]) && (rows[end].dataset.prlanesLogin || '') === login) end += 1;

      const run = end - index;
      const open = wantsOpen(leader);

      setData(leader, 'prlanesFold', open ? 'open' : 'strip');
      setText(leader.querySelector('.prlanes-strip-more'), run > 1 ? `+${run - 1} more` : '');
      const control = leader.querySelector(`.${HIDE_CLASS}`);
      if (control) {
        setAttr(control, 'title', run > 1 ? `Hide these ${run} comments` : 'Hide this comment');
        if (open) placeHide(leader, control);
      }

      for (let step = index + 1; step < end; step += 1) {
        setData(rows[step], 'prlanesFold', open ? 'with' : 'gone');
        delete rows[step].dataset.prlanesWant;
      }

      index = end;
    }
  }

  function classifyRows(target) {
    const revision = String(rulesRevision);
    const counts = { bots: 0, events: 0 };

    const rows = target.rowsOf(target.root);

    for (const row of rows) {
      if (row.dataset.prlanesRev !== revision) {
        const kind = (target.classify || lanes.classifyRow)(row, rules);
        setData(row, 'prlanesActor', kind.actor);
        setData(row, 'prlanesForm', kind.form);
        setData(row, 'prlanesRev', revision);
        if (kind.login) setData(row, 'prlanesLogin', kind.login);
        else delete row.dataset.prlanesLogin;
        if (lanes.isPrBody(row)) setData(row, 'prlanesPin', '1');
        else delete row.dataset.prlanesPin;
        fillStrip(row, kind);
      }

      const form = row.dataset.prlanesForm;
      if (row.dataset.prlanesPin === '1') continue;
      if (form === 'comment' && row.dataset.prlanesActor === 'bot') counts.bots += 1;
      if (form === 'event' || form === 'commit') counts.events += 1;
    }

    foldRuns(rows);

    if (settings.hideResolvedThreads) {
      for (const thread of lanes.resolvableThreads(target.root)) {
        if (lanes.isResolved(thread)) setData(thread, 'prlanesResolved', '1');
        else delete thread.dataset.prlanesResolved;
      }
    }

    setData(target.root, 'prlanesBots', hide.bots ? 'hide' : 'show');
    setData(target.root, 'prlanesEvents', hide.events ? 'hide' : 'show');
    setData(target.root, 'prlanesThreads', settings.hideResolvedThreads ? 'hide' : 'show');

    return counts;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SVG_TAGS = new Set(['svg', 'path', 'circle', 'rect']);

  const ICONS = {
  human: [
    ['circle', {"cx":"8","cy":"4.25","r":"3.25"}],
    ['path', {"d":"M8 9c-3.2 0-5.75 1.9-5.75 4.25 0 .41.34.75.75.75h10c.41 0 .75-.34.75-.75C13.75 10.9 11.2 9 8 9Z"}]
  ],
  bot: [
    ['path', {"d":"M8 1a.75.75 0 0 1 .75.75V3h2.75A2.5 2.5 0 0 1 14 5.5v5a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 2 10.5v-5A2.5 2.5 0 0 1 4.5 3h2.75V1.75A.75.75 0 0 1 8 1Zm-2.25 5.5a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Zm4.5 0a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z"}]
  ],
  events: [
    ['path', {"d":"M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"}]
  ],
  gear: [
    ['path', {"d":"M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.039.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.103-.302c-.066-.019-.176-.011-.299.071a4.909 4.909 0 0 1-.668.386c-.133.066-.194.158-.212.224l-.288 1.107c-.17.645-.716 1.195-1.459 1.259a8.147 8.147 0 0 1-1.402 0c-.743-.064-1.289-.614-1.459-1.259l-.288-1.107c-.018-.066-.079-.158-.212-.224a4.958 4.958 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.364-1.891l.814-.806c.049-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.039-.246-.088-.294l-.814-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.103.302c.066.019.176.011.299-.071.214-.143.437-.272.668-.386.133-.066.194-.158.212-.224L5.84 1.29c.17-.645.716-1.195 1.459-1.259A8.094 8.094 0 0 1 8 0Zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.045-.22.312-.412.644-.573.99-.014.031-.021.11.059.19l.815.806c.411.406.562.957.53 1.456a4.709 4.709 0 0 0 0 .582c.032.499-.119 1.05-.53 1.456l-.815.806c-.08.08-.073.159-.059.19.161.346.353.677.573.989.02.03.086.076.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.161.107.328.204.501.29.449.222.851.628.998 1.189l.289 1.105c.029.11.101.143.137.146a6.6 6.6 0 0 0 1.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.03.175-.016.195-.045.22-.313.411-.644.573-.99.014-.031.021-.11-.059-.19l-.815-.806c-.411-.406-.562-.957-.53-1.456a4.709 4.709 0 0 0 0-.582c-.032-.499.119-1.05.53-1.456l.815-.806c.08-.08.073-.159.059-.19a6.464 6.464 0 0 0-.573-.989c-.02-.03-.086-.076-.195-.046l-1.102.303c-.56.153-1.113.008-1.53-.27a4.44 4.44 0 0 0-.501-.29c-.449-.222-.851-.628-.998-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.146a6.6 6.6 0 0 0-1.142 0ZM11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM9.5 8a1.5 1.5 0 1 0-3.001.001A1.5 1.5 0 0 0 9.5 8Z"}]
  ]
  };

  // The switch is plural, the actor is singular; the robot is the same robot.
  ICONS.bots = ICONS.bot;

  function make(tag, attributes, children) {
    const node = SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
    for (const [name, value] of Object.entries(attributes || {})) node.setAttribute(name, value);
    for (const child of children || []) node.append(child);
    return node;
  }

  function icon(name, className) {
    const attributes = { viewBox: '0 0 16 16', width: '16', height: '16', fill: 'currentColor', 'aria-hidden': 'true' };
    if (className) attributes.class = className;
    return make('svg', attributes, ICONS[name].map(([tag, shape]) => make(tag, shape)));
  }

  // The label is the click, not the state: once the bots are gone the button offers them back.
  function wording(name) {
    return `${hide[name] ? 'Show' : 'Hide'} ${name}`;
  }

  function toggle(name) {
    return make('button', {
      type: 'button',
      class: TOGGLE_CLASS,
      'data-hide': name
    }, [
      make('span', { class: 'prlanes-icon' }, [icon(name)])
    ]);
  }

  function buildBar() {
    const element = make('div', { class: 'prlanes-bar', role: 'group', 'aria-label': 'Quiet this conversation' }, [
      make('div', { class: 'prlanes-toggles' }, [toggle('bots'), toggle('events')]),
      make('a', {
        class: 'prlanes-settings',
        target: '_blank',
        rel: 'noreferrer',
        title: 'Quiet PRs settings',
        'aria-label': 'Quiet PRs settings'
      }, [icon('gear', 'prlanes-gear')])
    ]);

    element.addEventListener('click', (event) => {
      const button = event.target.closest(`.${TOGGLE_CLASS}`);
      if (!button) return;
      event.preventDefault();
      setHide(button.dataset.hide, !hide[button.dataset.hide]);
    });

    const settingsLink = element.querySelector('.prlanes-settings');
    try {
      settingsLink.href = api.runtime.getURL('options/options.html');
    } catch (error) {
      settingsLink.remove();
    }

    barToggles = Array.from(element.querySelectorAll(`.${TOGGLE_CLASS}`));

    return element;
  }

  function visible(element) {
    return Boolean(element) && element.getBoundingClientRect().height > 0;
  }

  function tabStrip() {
    const nav = document.querySelector(TAB_NAV_SELECTOR);
    if (!visible(nav)) return null;
    return nav.firstElementChild || nav;
  }

  // The +/- line count at the far end of the tab row. GitHub floats it right, so the bar
  // leading it sits at the end of the row too, out of the tabs' way.
  function diffstat() {
    const wrapper = document.querySelector(DIFFSTAT_SELECTOR);
    return visible(wrapper) ? wrapper : null;
  }

  // An issue has no diffstat to lead, and its title row is already crowded. The row the
  // Open badge sits in is the one place with room, and it is where the eye is anyway.
  function stateRow() {
    const badge = document.querySelector(STATE_SELECTOR);
    if (!visible(badge)) return null;
    return badge.closest(STATE_ROW_SELECTOR) || badge.parentElement;
  }

  // The issue's sticky header stacks the title over its type and labels, so riding the end
  // of the title line leaves the bar high above the copy button. It sits in the row instead,
  // just before the button, both centred on the whole header.
  function issueStickyRow() {
    const row = document.querySelector(ISSUE_STICKY_ROW_SELECTOR);
    return visible(row) ? row : null;
  }

  function barSlot() {
    const issueRow = issueStickyRow();
    if (issueRow) return { element: issueRow, variant: 'issue', sticky: true, before: issueRow.lastElementChild };

    const sticky = document.querySelector(STICKY_HEADER_SELECTOR);
    if (visible(sticky)) return { element: sticky.querySelector(HEADER_SLOT_SELECTOR) || sticky, variant: 'header', sticky: true, fit: true };

    const diff = diffstat();
    if (diff) return { element: diff, variant: 'diff', lead: true };

    const state = stateRow();
    if (state) return { element: state, variant: 'state' };

    const tabs = tabStrip();
    if (tabs) return { element: tabs, variant: 'tabs' };

    for (const header of document.querySelectorAll(HEADER_SELECTOR)) {
      if (sticky && sticky.contains(header)) continue;
      if (visible(header)) return { element: header.querySelector(HEADER_SLOT_SELECTOR) || header, variant: 'header' };
    }

    return null;
  }

  function queuePlace() {
    if (placeHandle || !lastTarget) return;
    placeHandle = requestAnimationFrame(() => {
      placeHandle = 0;
      if (lastTarget.root.isConnected) placeBar(lastTarget);
    });
  }



  // GitHub holds the sticky title row at 1280px however narrow the window, and the bar rides
  // its far end, off the screen. While the bar is in it, the row fits the window instead.
  function fitTo(element) {
    if (fitted !== element) {
      if (fitted) fitted.classList.remove(FIT_CLASS);
      fitted = element;
    }
    if (element && !element.classList.contains(FIT_CLASS)) element.classList.add(FIT_CLASS);
  }

  function placeBar(target) {
    lastTarget = target;
    if (!bar) bar = buildBar();

    const slot = barSlot();
    const variant = slot ? slot.variant : '';
    bar.classList.toggle('prlanes-bar--header', variant === 'header');
    bar.classList.toggle('prlanes-bar--tabs', variant === 'tabs');
    bar.classList.toggle('prlanes-bar--diff', variant === 'diff');
    bar.classList.toggle('prlanes-bar--state', variant === 'state');
    bar.classList.toggle('prlanes-bar--issue', variant === 'issue');
    bar.classList.toggle('prlanes-bar--sticky', Boolean(slot && slot.sticky));

    fitTo(slot && slot.fit ? slot.element : null);

    if (slot) {
      if (slot.before) {
        if (bar.nextElementSibling !== slot.before) slot.element.insertBefore(bar, slot.before);
      } else if (slot.lead) {
        if (slot.element.firstElementChild !== bar) slot.element.prepend(bar);
      } else if (bar.parentElement !== slot.element) {
        slot.element.appendChild(bar);
      }
      return;
    }

    if (bar.nextElementSibling !== target.root && target.root.parentElement) {
      target.root.parentElement.insertBefore(bar, target.root);
    }
  }

  function updateBar(counts) {
    if (!bar || !bar.isConnected) return;

    for (const button of barToggles) {
      const name = button.dataset.hide;
      const label = wording(name);
      button.classList.toggle('prlanes-toggle--on', hide[name]);
      button.classList.toggle('prlanes-toggle--lit', counts[name] > 0);
      setAttr(button, 'aria-label', label);
      setAttr(button, 'title', `${label} (${name[0].toUpperCase()})`);
    }
  }

  function scan() {
    if (!isThreadPage()) {
      if (bar && bar.isConnected) bar.remove();
      fitTo(null);
      return;
    }

    const found = collectTargets();
    if (!found.length) return;

    const totals = { bots: 0, events: 0 };
    for (const target of found) {
      const counts = classifyRows(target);
      totals.bots += counts.bots;
      totals.events += counts.events;
    }

    placeBar(found[0]);
    updateBar(totals);
  }

  function queueScan() {
    if (location.href !== lastUrl) {
      navigate();
      return;
    }
    if (scanHandle) return;
    scanHandle = setTimeout(() => {
      scanHandle = 0;
      scan();
    }, 100);
  }

  function navigate() {
    lastUrl = location.href;
    targets = null;
    loadState().then((value) => {
      hide = value;
      scan();
    });
  }

  function setHide(name, on) {
    if (SWITCHES.indexOf(name) === -1 || hide[name] === on) return;
    if (name === 'bots') {
      for (const row of document.querySelectorAll('[data-prlanes-want]')) delete row.dataset.prlanesWant;
    }
    hide = Object.assign({}, hide, { [name]: on });
    write(local, { [settings.rememberPerRepo ? stateKey() : 'hide']: hide });
    scan();
  }

  // Strips are built during classification, so changing your mind about them means classifying again.
  const RECLASSIFY_KEYS = lanes.CLASSIFICATION_KEYS.concat(['collapseBots']);

  function invalidateRules() {
    rules = lanes.buildRules(settings);
    rulesRevision += 1;
  }

  // A strip opens the one comment it stands for. The button above it is not involved.
  function onClick(event) {
    const control = event.target.closest && event.target.closest(`.${STRIP_CLASS}, .${HIDE_CLASS}`);
    if (!control) return;

    const leader = control.closest('[data-prlanes-fold]');
    if (!leader) return;

    event.preventDefault();
    event.stopPropagation();
    setData(leader, 'prlanesWant', control.classList.contains(HIDE_CLASS) ? 'shut' : 'open');
    scan();
  }

  function onKeydown(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const name = KEYS[event.key.toLowerCase()];
    if (!name) return;

    const active = document.activeElement;
    if (active && (active.isContentEditable || /^(input|textarea|select)$/i.test(active.tagName))) return;

    event.preventDefault();
    event.stopPropagation();
    setHide(name, !hide[name]);
  }

  async function loadState() {
    const key = settings.rememberPerRepo ? stateKey() : 'hide';
    const stored = await read(local, { [key]: null });
    return normalizeState(stored[key]);
  }

  async function start() {
    settings = Object.assign({}, DEFAULTS, await read(sync, DEFAULTS));
    invalidateRules();
    hide = await loadState();

    scan();

    const observer = new MutationObserver((mutations) => {
      if (!isThreadPage()) return;
      if (bar && mutations.every((mutation) => bar.contains(mutation.target))) return;
      queueScan();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    for (const event of ['turbo:load', 'turbo:render', 'pjax:end', 'popstate', 'pageshow']) {
      window.addEventListener(event, queueScan);
    }

    window.addEventListener('scroll', queuePlace, { passive: true });
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeydown, true);

    if (api.storage.onChanged) {
      api.storage.onChanged.addListener((changes, area) => {
        if (area === 'local') {
          if (!settings.rememberPerRepo && changes.hide) {
            hide = normalizeState(changes.hide.newValue);
            scan();
          }
          return;
        }
        if (area !== 'sync' || !Object.keys(DEFAULTS).some((key) => key in changes)) return;

        read(sync, DEFAULTS).then(async (next) => {
          settings = Object.assign({}, DEFAULTS, next);
          if (RECLASSIFY_KEYS.some((key) => key in changes)) invalidateRules();
          if ('defaultHideBots' in changes || 'defaultHideEvents' in changes) hide = await loadState();
          scan();
        });
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
