(function (root) {
  'use strict';

  const DEFAULTS = {
    defaultHideBots: true,
    defaultHideEvents: false,
    collapseBots: true,
    rememberPerRepo: false,
    hideResolvedThreads: false,
    keepBotApprovals: true,
    keepBotChangeRequests: true,
    keepBotReviewComments: false,
    extraBots: '',
    forceHumans: '',
    heuristics: true
  };

  const CLASSIFICATION_KEYS = ['extraBots', 'forceHumans', 'heuristics'];

  const DEFAULT_BOT_LOGINS = [
    'allcontributors',
    'argos-ci',
    'bundlemon',
    'changeset-bot',
    'codecov',
    'codecov-commenter',
    'codspeed-hq',
    'coderabbitai',
    'copilot',
    'copilot-pull-request-reviewer',
    'deepsource-autofix',
    'dependabot',
    'devin-ai-integration',
    'ellipsis-dev',
    'github-actions',
    'github-advanced-security',
    'graphite-app',
    'greptile',
    'greptile-apps',
    'imgbot',
    'lighthouse-ci',
    'max-ai',
    'mergify',
    'netlify',
    'posthog-bot',
    'pre-commit-ci',
    'renovate',
    'semantic-release-bot',
    'sentry-io',
    'size-limit',
    'snyk-bot',
    'socket-security',
    'sonarcloud',
    'sonarqubecloud',
    'sourcery-ai',
    'trunk-io',
    'vercel'
  ];

  const HEURISTIC_PATTERNS = [
    /(^|[-_.])((ci|cd|deploy|build)-?)?bots?$/i,
    /^bot[-_.]/i,
    /(^|[-_.])(app|action|actions|ci|cd)$/i
  ];

  const COMMENT_SELECTOR = [
    '.timeline-comment',
    '.js-comment-container',
    '.review-comment',
    '[data-testid="issue-body"]',
    '[data-testid="comment-viewer-outer-box"]',
    '[data-testid="issue-comment"]',
    '[data-testid="pr-review-comment"]'
  ].join(',');

  const COMMENT_BODY_SELECTOR = '.comment-body, .js-comment-body, [data-testid="markdown-body"]';

  const OWN_SELECTOR = '.prlanes-strip';

  const PREVIEW_LIMIT = 140;

  const AUTHOR_SELECTOR = [
    '.author',
    '[data-testid="avatar-link"]',
    '[data-testid="issue-body-header-author"]',
    '[data-testid="comment-header-author"]',
    '[data-testid="author-link"]'
  ].join(',');

  const AVATAR_SELECTOR = 'img[class*="avatar" i], img[data-component="Avatar"], img[src*="avatars."]';

  const AVATAR_RAIL_SELECTOR = '.TimelineItem-avatar, .timeline-comment-avatar';

  const BADGE_SELECTOR = '.Label, span[class*="Label"], [data-testid="bot-badge"]';

  const BADGE_TEXT = ['bot', 'ai'];

  const APP_HREF = /^\/apps\/([^/?#]+)/;

  const HEADER_SELECTOR = [
    '.timeline-comment-header',
    '.review-comment-header',
    '[data-testid="comment-header"]',
    '[data-testid="issue-body-header"]'
  ].join(',');

  const COMPOSER_SELECTOR = 'textarea, [data-testid="comment-composer"], [data-testid="markdown-editor"]';

  const BOT_PROMPT = /^mention @[a-z0-9-]+ in a comment to make changes to this pull request\.?$/i;

  // GitHub types every timeline event by the octicon in its badge, and tags commit rows with a
  // GraphQL commit id. Either one is enough to know a push when we see it.
  const TIMELINE_BADGE_SELECTOR = ':scope > .TimelineItem-badge, :scope > [class*="TimelineItem-badge"]';
  const COMMIT_ICON_SELECTOR = '.octicon-git-commit';
  const COMMIT_GID = /^C_/;

  // A review row carries a PRR_ id, and its badge says how it ended.
  const REVIEW_GID = /^PRR_/;
  const REVIEW_ICONS = [
    ['approved', '.octicon-check'],
    ['changes', '.octicon-file-diff'],
    ['commented', '.octicon-eye']
  ];

  // A reviewer without write access gets the eye whatever they decided, so the header line has to
  // say it: GitHub writes "suggested changes" where a reviewer who counts "requested changes".
  const REVIEW_WORDS = [
    ['approved', /\bapproved these changes\b/],
    ['changes', /\b(?:requested|suggested) changes\b/]
  ];

  // An approval needs no comment, so its strip says what it did instead.
  const REVIEW_WORDING = { approved: 'approved these changes', changes: 'requested changes', commented: 'reviewed' };

  // Which setting keeps each kind of bot review in view while the bots are hidden.
  const REVIEW_KEEP_SETTINGS = {
    approved: 'keepBotApprovals',
    changes: 'keepBotChangeRequests',
    commented: 'keepBotReviewComments'
  };

  const PR_BODY_SELECTOR = '[data-testid="issue-body"], [id^="issue-"]';
  const PR_BODY_ID = /^issue-\d+$/;

  const TIMELINE_ROOT_SELECTOR = [
    '.js-discussion',
    '[data-testid="issue-viewer-comments-container"]',
    '[data-testid="issue-timeline"]',
    '[data-testid="timeline"]'
  ].join(',');

  const TIMELINE_ITEM_SELECTOR = [
    '.js-timeline-item',
    '.TimelineItem',
    '[data-testid="timeline-item"]',
    '[data-testid="issue-comment"]',
    '[data-testid="issue-timeline-item"]'
  ].join(',');

  const FILES_ROOT_SELECTOR = '#files, [data-testid="diff-view"], .js-diff-progressive-container';

  const RESOLVABLE_THREAD_SELECTOR = '.js-resolvable-timeline-thread-container[data-resolved], review-thread-collapsible[data-resolved], [data-testid="review-thread"][data-resolved]';

  const SIDEBAR_SECTION_SELECTOR = '.js-issue-sidebar-form, [data-testid*="reviewers"], [data-testid="sidebar-reviewers-section"]';

  const REVIEWER_LINK_SELECTOR = 'a[href^="/apps/"], a[data-hovercard-url], a.assignee, a[href^="/orgs/"]';

  const ASSIGNED_SELECTOR = '[data-assignee-name]';

  // A reviewer's status in the sidebar is the same verdict as their review, drawn with a comment
  // bubble where the timeline has an eye. Awaiting a review is a dot, and is no verdict at all.
  const REVIEWER_STATUS_SELECTOR = '.reviewers-status-icon';
  const REVIEWER_ICONS = REVIEW_ICONS.concat([['commented', '.octicon-comment']]);

  const THREAD_SELECTOR = [
    '.js-resolvable-timeline-thread-container',
    '.review-thread-component',
    '[data-testid="review-thread"]',
    'tr.inline-comments'
  ].join(',');

  function normalizeLogin(value) {
    return String(value == null ? '' : value)
      .trim()
      .replace(/^@/, '')
      .replace(/\[bot\]$/i, '')
      .toLowerCase();
  }

  function parseLoginList(value) {
    if (Array.isArray(value)) return value.map(normalizeLogin).filter(Boolean);
    return String(value == null ? '' : value)
      .split(/[\s,]+/)
      .map(normalizeLogin)
      .filter(Boolean);
  }

  // The out-of-the-box list is only worth showing where the name rules would not have got there
  // on their own; the rest is noise on the settings page.
  function botsMissedByHeuristics() {
    return DEFAULT_BOT_LOGINS.filter((login) => !HEURISTIC_PATTERNS.some((pattern) => pattern.test(login)));
  }

  function buildRules(settings) {
    const options = settings || {};
    return {
      bots: new Set(DEFAULT_BOT_LOGINS.concat(parseLoginList(options.extraBots))),
      humans: new Set(parseLoginList(options.forceHumans)),
      heuristics: options.heuristics !== false
    };
  }

  function classifyAuthor(author, rules) {
    const login = normalizeLogin(author && author.login);
    if (login && rules.humans.has(login)) return 'human';
    if (author && (author.suffixedBot || author.appLink)) return 'bot';
    if (login && rules.bots.has(login)) return 'bot';
    if (author && author.appAvatar) return 'bot';
    if (author && author.botBadge) return 'bot';
    if (login && rules.heuristics && HEURISTIC_PATTERNS.some((pattern) => pattern.test(login))) return 'bot';
    return 'human';
  }

  function loginFromHref(href) {
    if (!href) return '';
    try {
      const path = new URL(href, 'https://github.com').pathname;
      const match = path.match(/^\/([^/?#]+)\/?$/);
      return match ? decodeURIComponent(match[1]) : '';
    } catch (error) {
      return '';
    }
  }

  // Every avatar on the byline, not just the first. A comment posted through an app on somebody's
  // account carries both: the account's avatar, and the app's beside it as a child.
  function authoredAvatars(element, header, rail) {
    // The rail first: a lone comment's avatar lives out there, not in its header, and that is
    // where GitHub hangs the app's face beside the account's.
    const candidates = [rail, header, element].filter(Boolean);
    for (const scope of candidates) {
      const found = [];
      for (const image of scope.querySelectorAll(AVATAR_SELECTOR)) {
        if (!image.closest(COMMENT_BODY_SELECTOR) && !image.closest(OWN_SELECTOR)) found.push(image);
      }
      if (found.length) return found;
    }
    return [];
  }

  function isAppAvatar(image) {
    return Boolean(image) && /githubusercontent\.com\/in\//i.test(image.getAttribute('src') || '');
  }

  // Who a link names: the text when it is a login, the /apps/ segment or the path otherwise.
  function loginFromLink(link) {
    const href = link ? link.getAttribute('href') || '' : '';
    const app = href.match(APP_HREF);
    let raw = link ? (link.textContent || '').trim() : '';
    if (link && (!raw || /\s/.test(raw))) raw = (app ? app[1] : loginFromHref(href)) || raw;
    return { raw, app: Boolean(app) };
  }

  // Every bot signal in one place, so the timeline and the reviewers sidebar cannot disagree
  // about the same account. `header` is the scope a badge has to sit in; the sidebar has none.
  function readIdentity(element, link, header, rail) {
    const named = loginFromLink(link);

    let avatars;
    const avatarImages = () => {
      if (avatars === undefined) avatars = authoredAvatars(element, header, rail);
      return avatars;
    };

    let raw = named.raw;
    if (!raw) {
      const [image] = avatarImages();
      raw = image ? (image.getAttribute('alt') || '').trim() : '';
    }

    return {
      login: normalizeLogin(raw),
      suffixedBot: /\[bot\]\s*$/i.test(raw),
      appLink: named.app,
      get avatarSrc() {
        const images = avatarImages();
        // Show the app's face when there is one: that is the thing worth recognising.
        const image = images.find(isAppAvatar) || images[0];
        return image ? image.getAttribute('src') || '' : '';
      },
      get appAvatar() {
        return avatarImages().some(isAppAvatar);
      },
      get botBadge() {
        const scope = header || (link && link.parentElement) || element;
        for (const node of scope.querySelectorAll(BADGE_SELECTOR)) {
          if (BADGE_TEXT.includes((node.textContent || '').trim().toLowerCase())) return true;
        }
        return false;
      }
    };
  }

  function readAuthor(element, rail) {
    const header = element.querySelector(HEADER_SELECTOR);
    const link = (header && header.querySelector(AUTHOR_SELECTOR)) || element.querySelector(AUTHOR_SELECTOR);
    return readIdentity(element, link, header, rail);
  }

  function commentNodes(row) {
    // GitHub nests these: a .js-comment-container wrapping the .timeline-comment it holds. Keep the
    // outer one only, or a single comment reads as several and gets its author read twice.
    const found = Array.from(row.querySelectorAll(COMMENT_SELECTOR));
    if (found.length) return outermost(found, row);
    if (row.matches && row.matches(COMMENT_SELECTOR)) return [row];
    return [];
  }

  function hasCommentBody(row) {
    return Boolean(row.querySelector(COMMENT_BODY_SELECTOR));
  }

  // A review whose threads are still collapsed has no comment body in the page yet, but it is the
  // review: treat it as something somebody said, not as a timeline event to be swept away.
  function carriesComment(row) {
    return hasCommentBody(row) || Boolean(row.querySelector(THREAD_SELECTOR));
  }

  function rowGid(row) {
    return (row.getAttribute && row.getAttribute('data-gid')) || '';
  }

  function timelineBadge(row) {
    const item = row.matches && row.matches('.TimelineItem') ? row : row.querySelector('.TimelineItem');
    return item && item.querySelector(TIMELINE_BADGE_SELECTOR);
  }

  function isCommit(row) {
    if (COMMIT_GID.test(rowGid(row))) return true;

    const badge = timelineBadge(row);
    return Boolean(badge && badge.querySelector(COMMIT_ICON_SELECTOR));
  }

  // The outcome named by whichever of the icons the element draws.
  function iconOutcome(element, icons, fallback) {
    const match = element && icons.find(([, selector]) => element.querySelector(selector));
    return match ? match[0] : fallback;
  }

  // The words beside the reviewer's name, without the name, the timestamp or anything they wrote.
  function reviewWords(badge) {
    const body = badge && badge.parentElement && badge.parentElement.querySelector(':scope > .TimelineItem-body');
    if (!body) return '';
    const line = body.querySelector(':scope > div') || body;
    const said = Array.from(line.childNodes, (node) => (node.nodeType === 3 ? node.textContent : '')).join(' ');
    const match = REVIEW_WORDS.find(([, words]) => words.test(said));
    return match ? match[0] : '';
  }

  function reviewOutcome(row) {
    if (!REVIEW_GID.test(rowGid(row))) return '';

    // A badge this cannot read is still a review, so it counts as the plainest kind.
    const badge = timelineBadge(row);
    const outcome = iconOutcome(badge, REVIEW_ICONS, 'commented');
    return outcome === 'commented' ? reviewWords(badge) || outcome : outcome;
  }

  function isPrBody(row) {
    const node = (row.matches && row.matches(PR_BODY_SELECTOR) && row) || row.querySelector(PR_BODY_SELECTOR);
    if (!node) return false;
    return node.id ? PR_BODY_ID.test(node.id) : true;
  }

  function classifyRow(row, rules) {
    // A review is somebody saying something even when an approval left no comment, so it is
    // never a timeline event.
    const review = reviewOutcome(row);
    if (review || carriesComment(row)) {
      const nodes = commentNodes(row);
      // Only a lone comment owns the row's rail; in a thread each reply carries its own avatar.
      const rail = nodes.length === 1 ? row.querySelector(AVATAR_RAIL_SELECTOR) : null;

      let written = nodes
        .map((node) => ({ node, author: readAuthor(node, rail) }))
        .filter((entry) => entry.author.login);
      if (!written.length) written = [{ node: row, author: readAuthor(row, rail) }];

      const kinds = written.map((entry) => classifyAuthor(entry.author, rules));
      const actor = kinds.includes('human') ? 'human' : 'bot';
      // The face on a collapsed row has to be the author it speaks for, not whoever posted first.
      const spoken = written[kinds.indexOf(actor)];

      return { actor, form: 'comment', review, login: spoken.author.login, avatar: spoken.author.avatarSrc };
    }

    if (row.querySelector(COMPOSER_SELECTOR)) return { actor: 'none', form: 'chrome' };

    // A push belongs to nobody, so hiding bots never takes it: it is how you see what got addressed.
    if (isCommit(row)) return { actor: 'none', form: 'commit' };

    // The "Mention @copilot in a comment to make changes" note has no author of its own, but it
    // belongs to the bot it names, so it goes when the bots go.
    if (BOT_PROMPT.test((row.textContent || '').replace(/\s+/g, ' ').trim())) {
      return { actor: 'bot', form: 'chrome' };
    }

    const author = readAuthor(row);
    if (!author.login) return { actor: 'none', form: 'chrome' };

    return { actor: classifyAuthor(author, rules), form: 'event' };
  }

  function reviewVerdict(review) {
    return REVIEW_WORDING[review] || '';
  }

  function commentPreview(row, review) {
    const body = row.querySelector(COMMENT_BODY_SELECTOR);
    const said = body ? (body.textContent || '').replace(/\s+/g, ' ').trim() : '';
    const text = said || reviewVerdict(review);
    return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT).trimEnd()}\u2026` : text;
  }

  function resolvableThreads(root) {
    return Array.from(root.querySelectorAll(RESOLVABLE_THREAD_SELECTOR));
  }

  function isResolved(thread) {
    return thread.getAttribute('data-resolved') === 'true';
  }

  function findReviewersRoot(scope) {
    for (const section of (scope || document).querySelectorAll(SIDEBAR_SECTION_SELECTOR)) {
      const heading = section.querySelector('h3, summary, [class*="Heading"], [class*="heading"]');
      if (heading && /^\s*reviewers/i.test(heading.textContent || '')) return section;
    }
    return null;
  }

  function reviewerIdentities(element) {
    const links = Array.from(element.querySelectorAll(REVIEWER_LINK_SELECTOR));
    if (element.matches && element.matches(REVIEWER_LINK_SELECTOR)) links.push(element);
    return new Set(links.map((link) => (link.getAttribute('href') || '').split('?')[0]));
  }

  // A reviewer's name is not the whole row: GitHub hangs a review-status icon, a tooltip and
  // sometimes a Request control beside it. Climb until taking one more step would swallow
  // somebody else, so hiding the row takes the lot and leaves no orphans behind.
  function widenToRow(node, root) {
    let row = node;
    let owned = reviewerIdentities(row).size;

    while (row.parentElement && row.parentElement !== root) {
      const parentOwned = reviewerIdentities(row.parentElement).size;
      if (parentOwned !== owned) break;
      row = row.parentElement;
      owned = parentOwned;
    }

    return row;
  }

  function reviewerRows(root) {
    // GitHub marks the reviewers actually on the pull request. Suggestions share the same form and
    // are nobody's review yet, so they are not ours to take away.
    const assigned = Array.from(root.querySelectorAll(ASSIGNED_SELECTOR));
    const seeds = assigned.length ? assigned : Array.from(root.querySelectorAll(REVIEWER_LINK_SELECTOR));
    const rows = new Set(seeds.map((seed) => widenToRow(seed, root)));

    return outermost(Array.from(rows), root);
  }

  function classifyReviewer(row, rules) {
    const author = readIdentity(row, row.querySelector(REVIEWER_LINK_SELECTOR), null);
    const review = iconOutcome(row.querySelector(REVIEWER_STATUS_SELECTOR), REVIEWER_ICONS, '');
    return { actor: classifyAuthor(author, rules), form: 'reviewer', review };
  }

  function outermost(elements, root) {
    const set = new Set(elements);
    return elements.filter((element) => {
      let parent = element.parentElement;
      while (parent && parent !== root) {
        if (set.has(parent)) return false;
        parent = parent.parentElement;
      }
      return true;
    });
  }

  function findTimelineRoot(scope) {
    const doc = scope || document;
    const direct = doc.querySelector(TIMELINE_ROOT_SELECTOR);
    if (direct) return direct;

    const items = doc.querySelectorAll(TIMELINE_ITEM_SELECTOR);
    if (!items.length) return null;

    const tally = new Map();
    for (const item of items) {
      const parent = item.parentElement;
      if (!parent) continue;
      tally.set(parent, (tally.get(parent) || 0) + 1);
    }

    let best = null;
    let bestCount = 0;
    for (const [parent, count] of tally) {
      if (count > bestCount) {
        best = parent;
        bestCount = count;
      }
    }
    return best;
  }

  function findFilesRoot(scope) {
    return (scope || document).querySelector(FILES_ROOT_SELECTOR);
  }

  function timelineRows(root) {
    const items = outermost(Array.from(root.querySelectorAll(TIMELINE_ITEM_SELECTOR)), root);
    if (items.length) return items;
    return Array.from(root.children).filter((node) => node.nodeType === 1);
  }

  function threadRows(root) {
    return outermost(Array.from(root.querySelectorAll(THREAD_SELECTOR)), root);
  }

  root.PRLanes = Object.assign(root.PRLanes || {}, {
    CLASSIFICATION_KEYS,
    DEFAULTS,
    REVIEW_KEEP_SETTINGS,
    botsMissedByHeuristics,
    buildRules,
    classifyAuthor,
    classifyReviewer,
    classifyRow,
    commentPreview,
    findFilesRoot,
    findReviewersRoot,
    isResolved,
    findTimelineRoot,
    isPrBody,
    normalizeLogin,
    parseLoginList,
    resolvableThreads,
    reviewVerdict,
    reviewerRows,
    threadRows,
    timelineRows
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
