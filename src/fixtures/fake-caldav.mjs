// Test material: a fetch stand-in that plays an iCloud-like CalDAV service.
// Self-contained on purpose: it imports nothing from board/.
// Nothing here was observed on a live account; it follows the pinned design.

const ROOT_HOST = 'caldav.icloud.com';
const HOME_HOST = 'p99-caldav.icloud.com';
const PRINCIPAL_PATH = '/123456789/principal/';
const HOME_PATH = '/123456789/calendars/';
const DEFAULT_HOME = `https://${HOME_HOST}:443${HOME_PATH}`;
const BASIC_UTC = /^\d{8}T\d{6}Z$/;

function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cdata(text) {
  return `<![CDATA[${String(text).split(']]>').join(']]]]><![CDATA[>')}]]>`;
}

function calendarPath(index) {
  return `${HOME_PATH}cal-${index + 1}/`;
}

function normalise(value) {
  try {
    const u = new URL(String(value instanceof URL ? value.href : value));
    return { host: u.host, path: u.pathname, ok: u.protocol === 'https:' };
  } catch {
    return { host: '', path: '', ok: false };
  }
}

export function fakeCalDav({ user, password, calendars, extras } = {}) {
  const opts = extras ?? {};
  const prefix = typeof opts.prefix === 'string' && opts.prefix ? opts.prefix : 'D';
  const expected = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  const calls = [];
  const state = {
    fail: null,
    redirect: null,
    home: null,
    calendars: Array.isArray(calendars) ? [...calendars] : [],
  };

  const p = (name) => `${prefix}:${name}`;
  const wrap = (responses) =>
    `<?xml version="1.0" encoding="utf-8"?>\n<${p('multistatus')} xmlns:${prefix}="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${responses.join('')}</${p('multistatus')}>`;
  const response = (href, props) =>
    `<${p('response')}><${p('href')}>${escapeXml(href)}</${p('href')}><${p('propstat')}><${p('prop')}>${props}</${p('prop')}><${p('status')}>HTTP/1.1 200 OK</${p('status')}></${p('propstat')}></${p('response')}>`;
  const xml = (body, status = 207) =>
    new Response(body, { status, headers: { 'content-type': 'application/xml; charset=utf-8' } });

  function principalAnswer() {
    return xml(
      wrap([
        response(
          '/',
          `<${p('current-user-principal')}><${p('href')}>${PRINCIPAL_PATH}</${p('href')}></${p('current-user-principal')}>`,
        ),
      ]),
    );
  }

  function homeAnswer() {
    const home = state.home ?? DEFAULT_HOME;
    return xml(
      wrap([
        response(
          PRINCIPAL_PATH,
          `<C:calendar-home-set><${p('href')}>${escapeXml(home)}</${p('href')}></C:calendar-home-set>`,
        ),
      ]),
    );
  }

  function calendarsAnswer() {
    const set = (comps) =>
      `<C:supported-calendar-component-set>${comps.map((c) => `<C:comp name="${escapeXml(c)}"/>`).join('')}</C:supported-calendar-component-set>`;
    const rows = [
      response(
        HOME_PATH,
        `<${p('displayname')}>Calendars</${p('displayname')}><${p('resourcetype')}><${p('collection')}/></${p('resourcetype')}>`,
      ),
    ];
    state.calendars.forEach((cal, index) => {
      const comps = Array.isArray(cal.components) ? cal.components : ['VEVENT'];
      rows.push(
        response(
          calendarPath(index),
          `<${p('displayname')}>${escapeXml(cal.name)}</${p('displayname')}><${p('resourcetype')}><${p('collection')}/><C:calendar/></${p('resourcetype')}>${set(comps)}`,
        ),
      );
    });
    rows.push(
      response(
        `${HOME_PATH}inbox/`,
        `<${p('displayname')}>inbox</${p('displayname')}><${p('resourcetype')}><${p('collection')}/><C:schedule-inbox/></${p('resourcetype')}>`,
      ),
    );
    rows.push(
      response(
        `${HOME_PATH}reminders/`,
        `<${p('displayname')}>Reminders</${p('displayname')}><${p('resourcetype')}><${p('collection')}/><C:calendar/></${p('resourcetype')}>${set(['VTODO'])}`,
      ),
    );
    return xml(wrap(rows));
  }

  function reportAnswer(index) {
    const cal = state.calendars[index];
    const texts = Array.isArray(cal.ics) ? cal.ics : [];
    const rows = texts.map((text, k) =>
      response(
        `${calendarPath(index)}item-${k + 1}.ics`,
        `<${p('getetag')}>"etag-${index + 1}-${k + 1}"</${p('getetag')}><C:calendar-data>${opts.cdata ? cdata(text) : escapeXml(text)}</C:calendar-data>`,
      ),
    );
    return xml(wrap(rows));
  }

  function identify(method, target) {
    if (!target.ok) return null;
    if (method === 'PROPFIND') {
      if (target.host === ROOT_HOST && target.path === '/') return { step: 'principal' };
      if (target.host === ROOT_HOST && target.path === PRINCIPAL_PATH) return { step: 'home' };
      if (target.host === HOME_HOST && target.path === HOME_PATH) return { step: 'calendars' };
      return null;
    }
    if (method === 'REPORT' && target.host === HOME_HOST) {
      for (let i = 0; i < state.calendars.length; i += 1) {
        if (target.path === calendarPath(i)) return { step: 'report', index: i };
      }
    }
    return null;
  }

  function bodyIsAcceptable(step, body, depth) {
    if (typeof body !== 'string') return false;
    if (step === 'principal') return body.includes('current-user-principal');
    if (step === 'home') return body.includes('calendar-home-set');
    if (step === 'calendars') return depth === '1' && body.includes('displayname');
    if (step === 'report') {
      if (!body.includes('calendar-query') || !body.includes('filter')) return false;
      if (!body.includes('time-range') || !body.includes('calendar-data')) return false;
      const start = /\bstart="([^"]*)"/.exec(body);
      const end = /\bend="([^"]*)"/.exec(body);
      return Boolean(start && end && BASIC_UTC.test(start[1]) && BASIC_UTC.test(end[1]));
    }
    return false;
  }

  function failureAnswer(fail, signal) {
    const status = fail.status;
    if (status === 'network') return Promise.reject(new TypeError('fetch failed'));
    if (status === 'hang') {
      return new Promise((_, reject) => {
        const reason = () => signal?.reason ?? new DOMException('This operation was aborted', 'AbortError');
        if (!signal) return;
        if (signal.aborted) {
          reject(reason());
          return;
        }
        signal.addEventListener('abort', () => reject(reason()), { once: true });
      });
    }
    if (status === 'garbage') return Promise.resolve(xml('<html><body>maintenance</body></html>', 207));
    const code = Number(status);
    const empty = code === 204 || code === 205 || code === 304;
    return Promise.resolve(new Response(empty ? null : 'failure', { status: code }));
  }

  function fetchStandIn(url, init = {}) {
    const method = String(init?.method ?? 'GET').toUpperCase();
    const headers = {};
    for (const [name, value] of new Headers(init?.headers ?? {})) headers[name.toLowerCase()] = value;
    const body = init?.body;
    calls.push({ method, url: String(url instanceof URL ? url.href : url), headers, body });

    if (headers.authorization !== expected) {
      return Promise.resolve(new Response('unauthorized', { status: 401, headers: { 'www-authenticate': 'Basic realm="fake"' } }));
    }
    const found = identify(method, normalise(url));
    if (!found) return Promise.resolve(new Response('not found', { status: 404 }));

    if (state.fail && state.fail.step === found.step) return failureAnswer(state.fail, init?.signal);
    if (state.redirect && state.redirect.step === found.step) {
      return Promise.resolve(new Response(null, { status: 302, headers: { location: state.redirect.location } }));
    }
    if (!bodyIsAcceptable(found.step, body, headers.depth)) {
      return Promise.resolve(new Response('bad request', { status: 400 }));
    }
    if (found.step === 'principal') return Promise.resolve(principalAnswer());
    if (found.step === 'home') return Promise.resolve(homeAnswer());
    if (found.step === 'calendars') return Promise.resolve(calendarsAnswer());
    return Promise.resolve(reportAnswer(found.index));
  }

  return { fetch: fetchStandIn, calls, state };
}
