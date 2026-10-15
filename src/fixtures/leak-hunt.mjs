// Test material: hunting a secret string in captured output.
// `needles(secret)` lists every encoded form of the secret worth looking for;
// `findLeaks(cap, list)` says where in a capture any of them turned up (kind and place only, never the text around it).
// A capture is { items: [{ kind, where, text }], counts }; `newCap` and `addItem` build one.

export function needles(secret) {
  const out = new Map();
  const add = (name, value) => { if (value && value.length >= 12) out.set(value, name); };
  add('raw', secret);
  add('lower-case', secret.toLowerCase());
  add('url-encoded', encodeURIComponent(secret));
  add('form-encoded', new URLSearchParams({ a: secret }).toString().slice(2));
  add('hex', Buffer.from(secret, 'utf8').toString('hex'));
  // base64 at the three byte alignments, middle part only (the edges depend on neighbouring bytes)
  for (let k = 0; k < 3; k += 1) {
    const b = Buffer.from('x'.repeat(k) + secret, 'utf8').toString('base64').replace(/=+$/, '');
    const core = b.slice(k === 0 ? 0 : k === 1 ? 2 : 3, b.length - 3);
    add(`base64 (alignment ${k})`, core);
    add(`base64url (alignment ${k})`, core.replace(/\+/g, '-').replace(/\//g, '_'));
  }
  return out;
}

export function newCap() {
  return { items: [], counts: { responses: 0, logs: 0, formTokens: 0, files: 0, rejections: 0, outbound: 0 } };
}

export function addItem(cap, kind, where, text) {
  cap.items.push({ kind, where, text: String(text) });
}

// Where a needle is found: kind and place only, never the text around it.
export function findLeaks(cap, list) {
  const found = [];
  const seen = new Set();
  for (const it of cap.items) {
    for (const [value, name] of list) {
      if (it.text.includes(value)) {
        const key = `${name}|${it.kind}|${it.where}`;
        if (!seen.has(key)) { seen.add(key); found.push({ form: name, kind: it.kind, where: it.where }); }
      }
    }
  }
  return found;
}
