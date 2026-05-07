/* mm-analytics.js
 * Lightweight, consent-gated, GDPR-aware client analytics.
 * Writes events directly to Supabase (anon key, INSERT-only RLS).
 * Include on any page:
 *   <script src="/mm-analytics.js" defer></script>
 *
 * After /api/public-config runs, this picks up window.SUPABASE_URL and
 * window.SUPABASE_ANON_KEY automatically. Until consent is granted,
 * window.MM.track() is a no-op and ipapi.co is not called.
 */
(function () {
  if (window.MM && window.MM._init) return;
  window.MM = window.MM || {};
  MM._init = true;
  MM.consent = null;
  MM.uid = null;
  MM.geo = {};
  MM.variant = 'a';

  // ── consent state ────────────────────────────────────────────────────────
  try { MM.consent = localStorage.getItem('mm_consent'); } catch (e) {}

  function getOrCreateUid() {
    try {
      let u = localStorage.getItem('mm_uid');
      if (!u) { u = 'u_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); localStorage.setItem('mm_uid', u); }
      return u;
    } catch (e) { return 'u_anon'; }
  }

  function detectDevice() {
    var w = (screen && screen.width) || 0;
    if (w < 600) return 'mobile';
    if (w < 1024) return 'tablet';
    return 'desktop';
  }

  // ── tracker (no-op until consent granted) ────────────────────────────────
  MM.track = function () {};

  function activate() {
    MM.uid = getOrCreateUid();
    // Geo lookup (consent-gated since IP is personal data)
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, 2000);
    fetch('https://ipapi.co/json/', { signal: ctrl.signal })
      .then(function (r) { return r.json(); })
      .then(function (g) { clearTimeout(t); MM.geo = { country: g.country_name || '', city: g.city || '' }; MM.track('page_view', { meta: { entry: true } }); })
      .catch(function () { clearTimeout(t); MM.track('page_view', { meta: { entry: true } }); });

    MM.track = function (action, opts) {
      try {
        opts = opts || {};
        if (!window.SUPABASE_URL || !window.SUPABASE_ANON_KEY) return;
        var body = {
          uid: MM.uid,
          page: location.pathname,
          variant: MM.variant,
          action: action,
          label: opts.label != null ? String(opts.label).slice(0, 200) : null,
          value: opts.value != null ? Number(opts.value) : null,
          meta: opts.meta || null,
          scan_id: opts.scan_id || null,
          referrer: document.referrer || null,
          user_agent: navigator.userAgent,
          device: detectDevice(),
          screen_width: (screen && screen.width) || null,
          country: MM.geo.country || null,
          city: MM.geo.city || null,
        };
        fetch(window.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/events', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': window.SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + window.SUPABASE_ANON_KEY,
            'Prefer': 'return=minimal',
          },
          body: JSON.stringify(body),
          keepalive: true,
        }).catch(function () {});
      } catch (e) {}
    };
  }

  if (MM.consent === 'accepted') activate();

  // ── consent control (used by the cookie banner) ──────────────────────────
  MM.setConsent = function (val) {
    try { localStorage.setItem('mm_consent', val); } catch (e) {}
    MM.consent = val;
    var b = document.getElementById('mm-cookie'); if (b) b.style.display = 'none';
    if (val === 'accepted') { activate(); MM.track('button_click', { label: 'cookie_accept' }); }
  };
  MM.openConsent = function () { var b = document.getElementById('mm-cookie'); if (b) b.style.display = 'flex'; };

  // ── auto-inject cookie banner if consent not yet decided ─────────────────
  function injectBanner() {
    if (MM.consent !== null) return;
    if (document.getElementById('mm-cookie')) return;
    var div = document.createElement('div');
    div.id = 'mm-cookie';
    div.setAttribute('role', 'dialog');
    div.setAttribute('aria-label', 'Cookie consent');
    div.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;background:#131313;color:#f0ede8;border:1px solid rgba(255,255,255,.13);border-radius:14px;padding:18px;box-shadow:0 8px 32px rgba(0,0,0,.4);font-family:-apple-system,BlinkMacSystemFont,Segoe UI,system-ui,sans-serif;display:flex;flex-direction:column;gap:12px;max-width:560px;margin:0 auto';
    div.innerHTML =
      '<div style="font-family:Bebas Neue,sans-serif;font-size:22px;line-height:1;letter-spacing:.02em">Cookies &amp; Tracking</div>' +
      '<div style="font-size:13px;line-height:1.5;color:rgba(240,237,232,.78)">We use technically necessary storage to keep you logged in and enforce daily scan limits - always on (§ 25 (2) TTDSG). With your consent, we also use anonymous analytics (page views, button clicks) and an IP-based geo lookup to improve the product. Withdraw any time in our <a href="/idea#privacy" style="color:#FF5C00;text-decoration:underline">privacy policy</a>.</div>' +
      '<div style="display:flex;flex-direction:column;gap:8px">' +
        '<button onclick="MM.setConsent(\'accepted\')" style="background:#FF5C00;color:#fff;border:none;border-radius:8px;padding:13px 18px;font-size:14px;font-weight:700;cursor:pointer;min-height:44px">Accept analytics</button>' +
        '<button onclick="MM.setConsent(\'declined\')" style="background:transparent;color:#f0ede8;border:1px solid rgba(255,255,255,.18);border-radius:8px;padding:13px 18px;font-size:14px;font-weight:600;cursor:pointer;min-height:44px">Decline - only essentials</button>' +
      '</div>';
    document.body.appendChild(div);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectBanner);
  } else {
    injectBanner();
  }
})();
