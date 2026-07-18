export const DEFAULT_BROWSER_HOUR_CENTS = 10;

export const DEFAULT_CREDIT_PACKAGES = Object.freeze([
  { amountCents: 1000, label: '$10' },
  { amountCents: 2500, label: '$25' },
  { amountCents: 5000, label: '$50' },
  { amountCents: 10000, label: '$100' },
]);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function usd(cents) {
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

export function pricingPage({
  signedIn = false,
  browserHourCents = DEFAULT_BROWSER_HOUR_CENTS,
  creditPackages = DEFAULT_CREDIT_PACKAGES,
} = {}) {
  const accountHref = signedIn ? '/#billing' : '/';
  const accountLabel = signedIn ? 'Open billing' : 'Sign in';
  const packageCards = creditPackages.map((item, index) => {
    const browserHours = Math.floor(item.amountCents / browserHourCents);
    return `
          <article class="credit-pack${index === 1 ? ' is-popular' : ''}">
            ${index === 1 ? '<span class="popular-label">Good starting point</span>' : ''}
            <div>
              <span class="pack-label">Add to balance</span>
              <strong>${escapeHtml(item.label)}</strong>
            </div>
            <span class="pack-hours">≈ ${escapeHtml(browserHours)} browser hours</span>
            <a href="${accountHref}">${signedIn ? 'Choose in billing' : 'Sign in to add credit'} <span aria-hidden="true">→</span></a>
          </article>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Simple pay-as-you-go pricing for persistent WebBrain cloud browsers.">
  <link rel="icon" type="image/png" href="https://webbrain.one/logo-github.png">
  <title>Pricing · WebBrain Cloud</title>
  <style>
    :root {
      --ink: #2c1810;
      --muted: #6b5b47;
      --paper: #fffdf8;
      --canvas: #f7f1e6;
      --soft: #ede2cb;
      --line: rgba(89,55,25,.16);
      --violet: #5b52e8;
      --violet-dark: #4940ce;
      --violet-wash: rgba(91,82,232,.09);
      --green: #2d8866;
      --shadow: rgba(89,55,25,.11);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; background: var(--canvas); color: var(--ink); font-family: "Avenir Next", Avenir, "Segoe UI", sans-serif; line-height: 1.55; }
    a:focus-visible { outline: 3px solid rgba(91,82,232,.24); outline-offset: 3px; }
    nav { position: sticky; top: 0; z-index: 10; border-bottom: 1px solid var(--line); background: rgba(247,241,230,.88); backdrop-filter: blur(18px); }
    .nav-inner { max-width: 1160px; min-height: 70px; margin: 0 auto; padding: 12px 24px; display: flex; align-items: center; justify-content: space-between; gap: 20px; }
    .brand { display: inline-flex; align-items: center; gap: 10px; color: var(--violet); font-size: 19px; font-weight: 800; text-decoration: none; }
    .brand img { width: 30px; height: 30px; border-radius: 8px; box-shadow: 0 7px 20px rgba(91,82,232,.18); }
    .brand-domain { color: #756ac7; font-weight: 500; }
    .nav-actions { display: flex; align-items: center; gap: 15px; }
    .nav-actions a { color: var(--muted); font-size: 13px; font-weight: 700; text-decoration: none; }
    .nav-actions .account-link { padding: 8px 13px; border: 1px solid var(--violet); border-radius: 8px; background: var(--violet); color: white; }
    .nav-actions .account-link:hover { background: var(--violet-dark); }
    main { overflow: hidden; }
    .hero { position: relative; max-width: 1160px; margin: 0 auto; padding: 108px 24px 78px; }
    .hero::after { content: ''; position: absolute; z-index: -1; width: 620px; height: 620px; top: -280px; right: -140px; border-radius: 50%; background: radial-gradient(circle, rgba(91,82,232,.18), transparent 68%); filter: blur(28px); }
    .eyebrow { margin: 0 0 18px; color: var(--violet); font-size: 11px; font-weight: 850; letter-spacing: .14em; text-transform: uppercase; }
    h1 { max-width: 880px; margin: 0; font-family: Charter, "Iowan Old Style", "Palatino Linotype", serif; font-size: clamp(52px, 8vw, 92px); font-weight: 600; letter-spacing: -.055em; line-height: .96; }
    h1 em { color: var(--violet); font-style: normal; }
    .hero-bottom { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: end; gap: 56px; margin-top: 40px; }
    .hero-copy { max-width: 590px; margin: 0; color: var(--muted); font-size: 18px; }
    .rate-ticket { position: relative; min-width: 292px; padding: 22px 22px 19px; border: 1px solid var(--line); border-radius: 4px; background: var(--paper); box-shadow: 14px 16px 0 var(--soft); transform: rotate(-1.2deg); }
    .rate-ticket::before, .rate-ticket::after { content: ''; position: absolute; left: -1px; width: calc(100% + 2px); height: 7px; background: radial-gradient(circle at 4px -1px, transparent 4px, var(--paper) 4.5px) 0 0 / 12px 7px repeat-x; }
    .rate-ticket::before { top: -1px; transform: rotate(180deg); }
    .rate-ticket::after { bottom: -1px; }
    .ticket-label { display: block; color: var(--muted); font: 700 10px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .12em; text-transform: uppercase; }
    .ticket-rate { display: flex; align-items: baseline; gap: 8px; margin: 9px 0 7px; }
    .ticket-rate strong { font: 750 48px/.95 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: -.07em; }
    .ticket-rate span { color: var(--muted); font-size: 13px; font-weight: 700; }
    .rate-ticket p { margin: 0; padding-top: 11px; border-top: 1px dashed var(--line); color: var(--muted); font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .included { border-block: 1px solid var(--line); background: rgba(255,253,248,.54); }
    .included-inner { max-width: 1160px; margin: 0 auto; padding: 25px 24px; display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 20px; }
    .included-item { display: grid; grid-template-columns: auto 1fr; align-items: start; gap: 10px; color: var(--muted); font-size: 12px; }
    .included-item span:first-child { width: 19px; height: 19px; display: grid; place-items: center; border-radius: 50%; background: rgba(45,136,102,.11); color: var(--green); font-size: 11px; font-weight: 900; }
    .credits { max-width: 1160px; margin: 0 auto; padding: 88px 24px 96px; }
    .section-heading { display: grid; grid-template-columns: minmax(0,1fr) minmax(280px,420px); align-items: end; gap: 40px; margin-bottom: 34px; }
    h2 { margin: 0; font-family: Charter, "Iowan Old Style", "Palatino Linotype", serif; font-size: clamp(38px, 5vw, 58px); font-weight: 600; letter-spacing: -.04em; line-height: 1; }
    .section-heading p { margin: 0; color: var(--muted); font-size: 14px; }
    .credit-grid { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 12px; }
    .credit-pack { position: relative; min-height: 228px; padding: 22px; display: flex; flex-direction: column; justify-content: space-between; border: 1px solid var(--line); border-radius: 14px; background: rgba(255,253,248,.82); box-shadow: 0 12px 30px rgba(89,55,25,.05); }
    .credit-pack.is-popular { border-color: rgba(91,82,232,.42); background: var(--paper); box-shadow: 0 18px 42px rgba(91,82,232,.12); }
    .popular-label { position: absolute; top: 14px; right: 14px; padding: 4px 7px; border-radius: 999px; background: var(--violet-wash); color: var(--violet); font-size: 9px; font-weight: 850; letter-spacing: .05em; text-transform: uppercase; }
    .pack-label { display: block; margin-bottom: 8px; color: var(--muted); font-size: 10px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; }
    .credit-pack strong { display: block; font: 750 36px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: -.06em; }
    .pack-hours { color: var(--muted); font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .credit-pack a { display: flex; align-items: center; justify-content: space-between; color: var(--violet); font-size: 12px; font-weight: 800; text-decoration: none; }
    .credit-pack a:hover { color: var(--violet-dark); }
    .pricing-note { margin: 18px 0 0; color: var(--muted); font-size: 12px; }
    .principle { max-width: 1160px; margin: 0 auto 96px; padding: 0 24px; }
    .principle-card { padding: 42px; display: grid; grid-template-columns: minmax(0,.9fr) minmax(0,1.1fr); gap: 70px; border-radius: 18px; background: #251c17; color: #fff8ed; box-shadow: 0 26px 60px rgba(44,24,16,.18); }
    .principle-card h2 { font-size: clamp(34px, 4vw, 52px); }
    .principle-copy { display: grid; gap: 18px; }
    .principle-copy p { margin: 0; color: #cfc0ad; font-size: 14px; }
    .principle-copy a { width: fit-content; padding: 10px 14px; border-radius: 8px; background: #6d62ee; color: white; font-size: 13px; font-weight: 800; text-decoration: none; }
    footer { border-top: 1px solid var(--line); }
    .footer-inner { max-width: 1160px; margin: 0 auto; padding: 25px 24px; display: flex; align-items: center; justify-content: space-between; gap: 20px; color: var(--muted); font-size: 12px; }
    .footer-inner a { color: var(--violet); font-weight: 750; text-decoration: none; }
    @media (max-width: 880px) {
      .hero { padding-top: 72px; }
      .hero-bottom, .section-heading, .principle-card { grid-template-columns: 1fr; }
      .rate-ticket { width: min(100%, 340px); }
      .included-inner, .credit-grid { grid-template-columns: repeat(2, minmax(0,1fr)); }
      .principle-card { gap: 28px; }
    }
    @media (max-width: 560px) {
      .nav-inner, .hero, .credits, .principle { padding-inline: 17px; }
      .brand-domain, .nav-docs { display: none; }
      h1 { font-size: clamp(46px, 15vw, 66px); }
      .hero-bottom { gap: 32px; }
      .included-inner, .credit-grid { grid-template-columns: 1fr; }
      .included-inner { padding-inline: 17px; }
      .credit-pack { min-height: 190px; }
      .principle-card { padding: 28px 24px; }
      .footer-inner { align-items: flex-start; flex-direction: column; padding-inline: 17px; }
    }
    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
    }
  </style>
</head>
<body>
  <nav>
    <div class="nav-inner">
      <a class="brand" href="/">
        <img src="https://webbrain.one/logo-github.png" alt=""> WebBrain<span class="brand-domain">.cloud</span>
      </a>
      <div class="nav-actions">
        <a class="nav-docs" href="/docs">API docs</a>
        <a class="account-link" href="${accountHref}">${accountLabel}</a>
      </div>
    </div>
  </nav>
  <main>
    <section class="hero">
      <p class="eyebrow">Pay as you go · no plan to choose</p>
      <h1>A real cloud browser, billed only while it <em>works.</em></h1>
      <div class="hero-bottom">
        <p class="hero-copy">Keep a private browser profile in the cloud, connect visually, or run it through the API. Add credit when you need it and see the balance before you start.</p>
        <aside class="rate-ticket" aria-label="Active browser hourly rate">
          <span class="ticket-label">Active browser time</span>
          <div class="ticket-rate"><strong>${escapeHtml(usd(browserHourCents))}</strong><span>/ hour</span></div>
          <p>1 USD credit = ${escapeHtml(Math.floor(100 / browserHourCents))} active browser hours</p>
        </aside>
      </div>
    </section>
    <section class="included" aria-label="Included with active browser time">
      <div class="included-inner">
        <div class="included-item"><span>✓</span><span>Private 2 vCPU / 4 GiB cloud browser</span></div>
        <div class="included-item"><span>✓</span><span>Persistent browser profile and sign-ins</span></div>
        <div class="included-item"><span>✓</span><span>Visible noVNC access and browser API</span></div>
        <div class="included-item"><span>✓</span><span>Standard automation overhead included</span></div>
      </div>
    </section>
    <section class="credits" id="credits">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Credit packs</p>
          <h2>Top up the balance, not a subscription.</h2>
        </div>
        <p>Every pack uses the same rate. Larger amounts simply mean fewer checkout trips; there is no hidden tier or feature gate.</p>
      </div>
      <div class="credit-grid">
        ${packageCards}
      </div>
      <p class="pricing-note">Browser-hour estimates use today’s ${escapeHtml(usd(browserHourCents))} active-hour rate. The dashboard remains the source of truth for your current balance and recorded usage.</p>
    </section>
    <section class="principle">
      <div class="principle-card">
        <h2>Pause the browser. Keep the profile.</h2>
        <div class="principle-copy">
          <p>Resumable browsers are designed to stop compute when you are done while preserving the profile you return to. Billing should follow that same mental model: running time is visible, stored identity is durable.</p>
          <a href="${accountHref}">${signedIn ? 'Open your billing page' : 'Sign in to WebBrain Cloud'} →</a>
        </div>
      </div>
    </section>
  </main>
  <footer>
    <div class="footer-inner">
      <span>WebBrain Cloud · private browsers for humans and agents</span>
      <span><a href="/">Dashboard</a> · <a href="/docs">API documentation</a></span>
    </div>
  </footer>
</body>
</html>`;
}
